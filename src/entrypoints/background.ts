/**
 * MV3 service worker — the sole software-wallet authority (spec §5.2).
 *
 * Composition root: install the libsodium CryptoProvider, restrict the session store to trusted
 * contexts, build the chrome-backed storage ports, construct the wallet state
 * machine, arm the session-sweep alarm, and route every validated envelope to
 * the dispatcher. All wallet logic lives in chrome-agnostic modules; only the
 * wiring here touches chrome.*.
 */
import { defineBackground } from 'wxt/utils/define-background';
import { createLibsodiumCryptoProvider } from '../adapters/crypto/libsodium-provider';
import { calibrateArgon2id, makeKdfBenchmark } from '@drey/core/domain/vault/calibrate';
import { setCryptoProvider } from '@drey/core/domain/vault/crypto-provider';
import { webCryptoDeps } from '@drey/core/domain/vault/vault';
import { parseEnvelope } from '@drey/core/messaging/envelope';
import type { StorageArea } from '../adapters/storage/area';
import type { SessionAccessLevel, SessionArea } from '../adapters/session/session-store';
import { GatewayClient } from '@drey/core/gateway-client';
import { IdbWalletCache } from '../adapters/storage/wallet-cache-idb';
import { dispatch } from '../background/dispatch';
import { registerSessionSweep } from '../background/session-alarm';
import { WalletService } from '../background/wallet-service';
import { retryableInit } from '../background/retryable-init';
import { resolveVaultCoordinatorCapability } from '../background/vault-capability';
import {
  SCAN_PROGRESS_EVENT,
  SESSION_STATE_CHANGED_EVENT,
  WALLET_DATA_CHANGED_EVENT,
} from '@drey/core/messaging/events';
import { ProviderController } from '../background/provider-controller';
import {
  deriveTrustedExtensionContext,
  isExpectedApprovalPort,
  parseProviderAuthority,
  providerSessionIdentityChanged,
} from '../provider/authority';
import { PROVIDER_PORT_NAME } from '../provider/bridge';
import { APPROVAL_PORT_NAME, approvalCommandSchema } from '../provider/approval';

const PROVIDER_UNLOCK_TTL_MS = 5 * 60_000;
const APPROVAL_PORT_RECONNECT_GRACE_MS = 100;

function toArea(area: chrome.storage.StorageArea): StorageArea {
  return {
    get: (keys) => area.get(keys),
    set: (items) => area.set(items),
    remove: (keys) => area.remove(keys),
  };
}

function toSessionArea(): SessionArea {
  return {
    ...toArea(chrome.storage.session),
    setAccessLevel: (options: { accessLevel: SessionAccessLevel }) =>
      chrome.storage.session.setAccessLevel({
        accessLevel: options.accessLevel as chrome.storage.AccessLevel,
      }),
  };
}

export default defineBackground(() => {
  let approvalWindowId: number | null = null;
  let approvalTabId: number | null = null;
  let unlockWindowId: number | null = null;
  let unlockCreation: Promise<void> | null = null;
  let unlockTimer: ReturnType<typeof setTimeout> | null = null;
  let unlockAttempt: {
    promise: Promise<boolean>;
    resolve: (unlocked: boolean) => void;
  } | null = null;
  let providerController: ProviderController | null = null;
  let serviceForSessionObservation: WalletService | null = null;
  let observedProviderSession: string | null = null;
  let sessionObservationGeneration = 0;
  let approvalCreation: Promise<void> | null = null;
  let approvalPortDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const approvalPorts = new Set<chrome.runtime.Port>();

  const scheduleApprovalPortDisconnect = (
    expectedWindowId: number | null,
    expectedTabId: number | null,
  ): void => {
    // closeApproval clears both identities before removing the resolved popup.
    // Its later Port disconnect belongs to that completed request and must not
    // be allowed to invalidate a new request whose window is still opening.
    if (expectedWindowId === null || expectedTabId === null) return;
    if (approvalPorts.size > 0) return;
    if (approvalPortDisconnectTimer !== null) clearTimeout(approvalPortDisconnectTimer);
    approvalPortDisconnectTimer = setTimeout(() => {
      approvalPortDisconnectTimer = null;
      if (approvalPorts.size === 0 && approvalWindowId === expectedWindowId &&
          approvalTabId === expectedTabId) {
        void providerController?.approvalWindowClosed();
      }
    }, APPROVAL_PORT_RECONNECT_GRACE_MS);
  };

  const openOrFocusApproval = async (): Promise<void> => {
    if (approvalWindowId !== null && approvalTabId !== null) {
      try {
        await chrome.windows.update(approvalWindowId, { focused: true, drawAttention: true });
        return;
      } catch {
        approvalWindowId = null;
        approvalTabId = null;
      }
    }
    if (approvalCreation !== null) {
      await approvalCreation;
      return;
    }
    // Publish the in-flight promise before Chrome can load approval.html and
    // deliver its Port. A fast popup can connect while windows.create() is
    // still resolving; the Port handler must see this promise so it queues the
    // initial snapshot command until the exact window/tab identity is bound.
    const creation = Promise.resolve().then(async () => {
      const created = await chrome.windows.create({
        url: chrome.runtime.getURL('/approval.html'),
        type: 'popup',
        focused: true,
        width: 420,
        height: 680,
      });
      const windowId = created?.id;
      const tabId = created?.tabs?.[0]?.id ?? (windowId === undefined
        ? undefined
        : (await chrome.tabs.query({ windowId }))[0]?.id);
      if (windowId === undefined || tabId === undefined) {
        if (windowId !== undefined) await chrome.windows.remove(windowId).catch(() => undefined);
        throw new Error('approval popup did not expose an exact window/tab identity');
      }
      approvalWindowId = windowId;
      approvalTabId = tabId;
    });
    approvalCreation = creation;
    try {
      await creation;
    } finally {
      if (approvalCreation === creation) approvalCreation = null;
    }
  };

  const openCommunityVaultSetup = async (input: {
    campaignId: string;
    ownerId: string;
    label?: string;
  }): Promise<void> => {
    const url = new URL(chrome.runtime.getURL('/fullpage.html'));
    url.searchParams.set('communityCampaignId', input.campaignId);
    url.searchParams.set('communityOwnerId', input.ownerId);
    if (input.label) url.searchParams.set('communityLabel', input.label);
    url.hash = '/settings/community-vault';
    await chrome.tabs.create({ url: url.toString(), active: true });
  };

  const closeApproval = async (): Promise<void> => {
    if (approvalPortDisconnectTimer !== null) {
      clearTimeout(approvalPortDisconnectTimer);
      approvalPortDisconnectTimer = null;
    }
    const id = approvalWindowId;
    approvalWindowId = null;
    approvalTabId = null;
    if (id !== null) await chrome.windows.remove(id).catch(() => undefined);
  };

  const finishUnlockAttempt = (unlocked: boolean): void => {
    const attempt = unlockAttempt;
    if (attempt === null) return;
    unlockAttempt = null;
    if (unlockTimer !== null) {
      clearTimeout(unlockTimer);
      unlockTimer = null;
    }
    const id = unlockWindowId;
    unlockWindowId = null;
    attempt.resolve(unlocked);
    if (id !== null) void chrome.windows.remove(id).catch(() => undefined);
  };

  const openOrFocusUnlock = async (): Promise<void> => {
    if (unlockWindowId !== null) {
      try {
        await chrome.windows.update(unlockWindowId, { focused: true, drawAttention: true });
        return;
      } catch {
        unlockWindowId = null;
        finishUnlockAttempt(false);
        return;
      }
    }
    if (unlockCreation !== null) {
      await unlockCreation;
      return;
    }
    const creation = (async () => {
      const created = await chrome.windows.create({
        url: chrome.runtime.getURL('/popup.html?provider=unlock'),
        type: 'popup',
        focused: true,
        width: 420,
        height: 680,
      });
      const windowId = created?.id;
      if (windowId === undefined) throw new Error('unlock popup did not expose a window identity');
      if (unlockAttempt === null) {
        await chrome.windows.remove(windowId).catch(() => undefined);
        return;
      }
      unlockWindowId = windowId;
    })();
    unlockCreation = creation;
    try {
      await creation;
    } finally {
      if (unlockCreation === creation) unlockCreation = null;
    }
  };

  const requestUnlock = async (): Promise<boolean> => {
    if (unlockAttempt !== null) {
      const current = unlockAttempt;
      await openOrFocusUnlock();
      return current.promise;
    }
    let resolveAttempt!: (unlocked: boolean) => void;
    const promise = new Promise<boolean>((resolve) => {
      resolveAttempt = resolve;
    });
    unlockAttempt = { promise, resolve: resolveAttempt };
    unlockTimer = setTimeout(() => finishUnlockAttempt(false), PROVIDER_UNLOCK_TTL_MS);
    try {
      await openOrFocusUnlock();
    } catch {
      finishUnlockAttempt(false);
    }
    return promise;
  };
  // MV3 event listeners must be registered synchronously. Their callbacks wait
  // on the one-time setup promise rather than registering after async work.
  // Everything the callbacks need is behind this one-time async setup.
  const ready = retryableInit(async () => {
    setCryptoProvider(await createLibsodiumCryptoProvider());
    const observeSessionChange = (locked: boolean): void => {
      const generation = ++sessionObservationGeneration;
      if (locked) {
        observedProviderSession = null;
        void providerController?.invalidateSession();
        return;
      }
      finishUnlockAttempt(true);
      const service = serviceForSessionObservation;
      if (service === null) return;
      void service.sessionStatus().then((status) => {
        if (generation !== sessionObservationGeneration) return;
        const next = status.locked || status.activeVaultId === null || status.sessionId === null
          ? null
          : `${status.activeVaultId}:${status.sessionId}`;
        const changed = providerSessionIdentityChanged(observedProviderSession, next);
        observedProviderSession = next;
        if (changed) void providerController?.invalidateSession();
      }).catch(() => undefined);
    };
    // Vault coordinator ops exist only on never-distributed channels
    // (ADR 0007 §8, Workstream C). The capability is composed from two
    // independently derived compile-time constants and stays undefined unless
    // they name one of the three pairings the ADR permits — so a channel table
    // mis-edited into, say, mainnet + full yields a build with no coordinator
    // at all rather than one that quietly downgrades to something plausible.
    const vaultCoordinatorCapability =
      __VAULT_COORDINATOR_ENABLED__ && __VAULT_COORDINATOR_MOVEMENT__ !== 'none' &&
        __GATEWAY_NETWORK__ !== 'regtest'
        ? resolveVaultCoordinatorCapability(__GATEWAY_NETWORK__, __VAULT_COORDINATOR_MOVEMENT__)
        : undefined;
    const service = new WalletService({
      local: toArea(chrome.storage.local),
      session: toSessionArea(),
      vaultDeps: webCryptoDeps(),
      calibrateKdf: () => calibrateArgon2id({ benchmark: makeKdfBenchmark() }),
      newVaultId: () => globalThis.crypto.randomUUID(),
      newSessionId: () => globalThis.crypto.randomUUID(),
      notifySessionChanged: (locked) => {
        void chrome.runtime.sendMessage({ type: SESSION_STATE_CHANGED_EVENT, locked }).catch(() => undefined);
        observeSessionChange(locked);
      },
      notifyScanProgress: () => {
        void chrome.runtime.sendMessage({ type: SCAN_PROGRESS_EVENT }).catch(() => undefined);
      },
      notifyWalletDataChanged: (reason) => {
        void chrome.runtime.sendMessage({ type: WALLET_DATA_CHANGED_EVENT, reason }).catch(() => undefined);
      },
      notifyAccountChanged: (accountId, account) => {
        void providerController?.accountChanged(accountId, account);
      },
      notifyPermissionsRevoked: (origin) => {
        void providerController?.permissionsRevoked(origin);
      },
      // Channel-pinned network (M6): derivation, receive, scanning, and the
      // gateway all share the one build-channel value.
      network: __GATEWAY_NETWORK__,
      // Passkey ops exist only on channels with a pinned manifest key (A0 §1:
      // stable extension ID ⇒ stable WebAuthn RP). Chromium binds an
      // extension caller's effective RP ID to its full serialized origin.
      ...(__PASSKEY_ENROLLMENT_ENABLED__
        ? { passkeyRpOrigin: `chrome-extension://${chrome.runtime.id}` }
        : {}),
      // Vault coordinator ops exist only on never-distributed channels
      // (ADR 0007 §8, Workstream C). The capability is composed from two
      // independently derived compile-time constants and is undefined unless
      // they name one of the three pairings the ADR permits — so a channel
      // table mis-edited into, say, mainnet + full yields a build with no
      // coordinator at all rather than one that quietly downgrades to
      // something plausible.
      ...(vaultCoordinatorCapability === undefined ? {} : { vaultCoordinatorCapability }),
      walletCache: new IdbWalletCache(),
      // Build-channel gateway pinning (spec §18.1). Preview deliberately omits
      // the client entirely: no environment toggle can restore network I/O.
      ...(__LIVE_GATEWAY_ENABLED__ ? { gateway: new GatewayClient({
        fetchFn: globalThis.fetch.bind(globalThis),
        baseUrl: __GATEWAY_URL__,
        publicKeyHex: __GATEWAY_PUBKEY_HEX__,
        expectedNetwork: __GATEWAY_NETWORK__,
        allowedProtocolVersions: __GATEWAY_PROTOCOL_VERSIONS__,
        randomNonce: () => {
          const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
          return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        },
        retryJitterMs: () => {
          const sample = globalThis.crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
          return 250 + (sample % 501);
        },
        now: () => Date.now(),
      }) } : {}),
    });
    providerController = new ProviderController({
      service,
      sessionStorage: toArea(chrome.storage.session),
      now: () => Date.now(),
      requestUnlock,
      openOrFocusApproval,
      closeApproval,
      openCommunityVaultSetup,
      approvalChanged: (snapshot) => {
        for (const port of approvalPorts) {
          try {
            port.postMessage(snapshot);
          } catch {
            port.disconnect();
          }
        }
      },
    });
    await service.init();
    serviceForSessionObservation = service;
    const initialSession = await service.sessionStatus();
    observedProviderSession = initialSession.locked || initialSession.activeVaultId === null ||
        initialSession.sessionId === null
      ? null
      : `${initialSession.activeVaultId}:${initialSession.sessionId}`;
    void service.retryBroadcasts().catch(() => undefined);
    void service.retryProviderBroadcasts().catch(() => undefined);
    return service;
  });

  registerSessionSweep((lockForResume) => ready().then(async (service) => {
    await service.sweepExpired(lockForResume);
    if (!lockForResume) {
      await service.retryBroadcasts();
      await service.retryProviderBroadcasts();
    }
  }));
  chrome.idle.onStateChanged.addListener((state) => {
    if (state === 'locked') void ready().then((service) => service.lock()).catch(() => undefined);
  });

  chrome.windows.onRemoved.addListener((windowId) => {
    if (windowId === unlockWindowId) {
      unlockWindowId = null;
      finishUnlockAttempt(false);
      return;
    }
    if (windowId !== approvalWindowId) return;
    if (approvalPortDisconnectTimer !== null) {
      clearTimeout(approvalPortDisconnectTimer);
      approvalPortDisconnectTimer = null;
    }
    approvalWindowId = null;
    approvalTabId = null;
    void providerController?.approvalWindowClosed();
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name === PROVIDER_PORT_NAME) {
      const parsed = parseProviderAuthority(port.sender, chrome.runtime.id);
      if (!parsed.ok) {
        port.disconnect();
        return;
      }
      // A content script can issue its first request while libsodium/storage
      // initialization is still running. Chrome does not retain Port messages
      // until an onMessage listener exists, so queue a small bounded prefix and
      // replay it once the controller is ready.
      const queuedMessages: unknown[] = [];
      let disconnected = false;
      const queueMessage = (message: unknown): void => {
        if (queuedMessages.length >= 16) {
          port.disconnect();
          return;
        }
        queuedMessages.push(message);
      };
      const queueDisconnect = (): void => {
        disconnected = true;
        port.onMessage.removeListener(queueMessage);
        port.onDisconnect.removeListener(queueDisconnect);
      };
      port.onMessage.addListener(queueMessage);
      port.onDisconnect.addListener(queueDisconnect);
      void ready().then(() => {
        port.onMessage.removeListener(queueMessage);
        port.onDisconnect.removeListener(queueDisconnect);
        if (!disconnected) providerController?.attach(port, parsed.authority, queuedMessages);
      }).catch(() => port.disconnect());
      return;
    }
    if (port.name !== APPROVAL_PORT_NAME ||
        deriveTrustedExtensionContext(port.sender, chrome.runtime.id) !== 'approval') {
      port.disconnect();
      return;
    }
    let accepted = false;
    let disconnected = false;
    const pendingCreation = approvalCreation;
    const queuedMessages: unknown[] = [];
    const handleMessage = (raw: unknown): void => {
      const parsed = approvalCommandSchema.safeParse(raw);
      if (!parsed.success) return;
      void ready()
        .then(() => providerController?.approvalCommand(parsed.data))
        .then((snapshot) => {
          if (!snapshot || disconnected) return;
          try {
            port.postMessage(snapshot);
          } catch {
            port.disconnect();
          }
        }).catch(() => port.disconnect());
    };
    const onMessage = (raw: unknown): void => {
      if (!accepted) {
        // approval.html sends its initial snapshot command immediately after
        // connect. Hold it while windows.create finishes assigning the exact
        // tab/window identity; never process commands before that binding.
        if (queuedMessages.length < 4) queuedMessages.push(raw);
        return;
      }
      handleMessage(raw);
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
      disconnected = true;
      const wasAccepted = approvalPorts.delete(port);
      port.onMessage.removeListener(onMessage);
      if (wasAccepted && approvalPorts.size === 0) {
        // Development React deliberately tears down and recreates effects once.
        // Give the same exact popup one task to reconnect before treating a
        // Port loss as a rejection. A real window close remains immediate in
        // windows.onRemoved above, and a different tab/window cannot pass the
        // exact binding check below.
        scheduleApprovalPortDisconnect(approvalWindowId, approvalTabId);
      } else if (!accepted && pendingCreation !== null) {
        // The first development effect can disconnect before windows.create
        // finishes. Once the exact identity is known, give its replacement
        // Port the same grace as an already accepted connection. A genuine
        // close is still immediate through windows.onRemoved.
        void pendingCreation.then(() => {
          if (isExpectedApprovalPort(
            port.sender,
            chrome.runtime.id,
            approvalWindowId,
            approvalTabId,
          )) scheduleApprovalPortDisconnect(approvalWindowId, approvalTabId);
        }).catch(() => undefined);
      }
    });
    void (pendingCreation ?? Promise.resolve()).then(() => {
      if (disconnected) return;
      if (!isExpectedApprovalPort(
        port.sender,
        chrome.runtime.id,
        approvalWindowId,
        approvalTabId,
      )) {
        port.disconnect();
        return;
      }
      if (approvalPortDisconnectTimer !== null) {
        clearTimeout(approvalPortDisconnectTimer);
        approvalPortDisconnectTimer = null;
      }
      accepted = true;
      approvalPorts.add(port);
      for (const raw of queuedMessages.splice(0)) handleMessage(raw);
    }).catch(() => port.disconnect());
  });

  // Catch a device that was already locked while the worker initialized.
  void ready()
    .then(async (service) => {
      if ((await chrome.idle.queryState(15)) === 'locked') await service.lock();
    })
    .catch(() => undefined);

  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const parsed = parseEnvelope(raw);
    if (!parsed.ok) {
      sendResponse({ ok: false, code: parsed.code });
      return false;
    }
    // Anti-spoofing (spec §5.2, §6.3): only our own extension pages may drive the
    // wallet. Ordinary wallet pages report our extension origin; the approval
    // page is recognized here but the operation registry refuses it because it
    // uses only the exact window/tab-bound Port above. A web content script
    // reports the page's origin and so cannot forge a trusted sender context.
    // (Note: extension pages rendered in a tab DO carry sender.tab, so tab
    // presence is not a valid discriminator.) The content bridge gets its own
    // origin/tab-bound op surface in M8.
    const actualContext = deriveTrustedExtensionContext(sender, chrome.runtime.id);
    if (actualContext === null || actualContext !== parsed.envelope.sender) {
      sendResponse({ ok: false, code: 'ERR_UNAUTHORIZED_CONTEXT' });
      return false;
    }

    ready()
      .then((service) => dispatch(parsed.envelope, service))
      .then((response) => sendResponse(response))
      .catch(() => sendResponse({ ok: false, code: 'ERR_INTERNAL' }));
    return true; // async sendResponse
  });
});
