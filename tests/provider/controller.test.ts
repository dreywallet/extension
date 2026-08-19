import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_SWITCH_COOLDOWN_MS,
  ProviderController,
  type ProviderControllerDeps,
} from '../../src/background/provider-controller';
import type { ProviderAccountView, WalletService } from '../../src/background/wallet-service';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { VaultError } from '@drey/core/domain/vault/errors';
import type { ProviderRuntimePort } from '../../src/provider/bridge';
import type { ProviderAuthority } from '../../src/provider/authority';
import type { PermissionGrantEvent } from '@drey/core/domain/provider/permission-journal';
import { SigHash, Transaction } from '@scure/btc-signer';
import { bytesToBase64, hexToBytes } from '@drey/core/domain/vault/encoding';
import type { ProviderPsbtPlanV3 } from '@drey/core/domain/transactions/provider-psbt';
import { RpcError } from '../../src/background/errors';

beforeAll(() => installTestCryptoProvider());

const authority: ProviderAuthority = {
  origin: 'https://app.example',
  tabId: 7,
  frameId: 0,
  documentId: '123e4567-e89b-42d3-a456-426614174000',
  url: 'https://app.example/wallet',
};

function fakeArea() {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (keys: string | string[]) => Object.fromEntries(
      (Array.isArray(keys) ? keys : [keys]).map((key) => [key, data.get(key)]),
    ),
    set: async (items: Record<string, unknown>) => { for (const [key, value] of Object.entries(items)) data.set(key, value); },
    remove: async (keys: string | string[]) => { for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key); },
  };
}

function fakePort(options: { throwOnPost?: boolean } = {}) {
  let throwOnPost = options.throwOnPost === true;
  const messages: unknown[] = [];
  const messageListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const port: ProviderRuntimePort = {
    postMessage: (message) => {
      if (throwOnPost) throw new Error('disconnected port');
      messages.push(message);
    },
    disconnect: () => { for (const listener of disconnectListeners) listener(); },
    onMessage: {
      addListener: (listener) => messageListeners.add(listener),
      removeListener: (listener) => messageListeners.delete(listener),
    },
    onDisconnect: {
      addListener: (listener) => disconnectListeners.add(listener),
      removeListener: (listener) => disconnectListeners.delete(listener),
    },
  };
  return {
    port,
    messages,
    setThrowOnPost: (value: boolean) => { throwOnPost = value; },
    send: (message: unknown) => { for (const listener of messageListeners) listener(message); },
  };
}

function request(method: string, nonce: string, params?: unknown) {
  return {
    type: 'drey:provider:request', protocolVersion: 1, requestNonce: nonce, method,
    ...(params === undefined ? {} : { params }),
  };
}

function mockService() {
  let locked = false;
  let context: ProviderAccountView = {
    vaultId: 'vault-1', vaultName: 'Primary wallet',
    sessionId: '123e4567-e89b-42d3-a456-426614174001',
    network: 'signet' as const,
    accountId: `acct_signet_${'1'.repeat(64)}`,
    account: 0,
    payment: { address: 'tb1qpaymentaddress', publicKeyHex: `02${'11'.repeat(32)}`, path: "m/84'/1'/0'/0/0" },
    ordinals: { address: 'tb1pordinaladdress', publicKeyHex: `03${'22'.repeat(32)}`, path: "m/86'/1'/0'/0/0" },
  };
  const grants: PermissionGrantEvent[] = [];
  let next = 1;
  const preparedTransfer = (feeRateSatPerVb = 5) => ({
    version: 4 as const,
    planId: 'plan-1', createdAt: 1, expiresAt: 300_001,
    network: 'signet' as const, vaultId: 'vault-1',
    sessionId: '123e4567-e89b-42d3-a456-426614174001', account: 0,
    kind: 'provider_transfer' as const,
    provider: { ...authority, requestNonce: '123e4567-e89b-42d3-a456-426614174035', providerMethod: 'sendTransfer' as const },
    broadcast: true, requiresAdvanced: false, selectedInputIndexes: [0], inputs: [], outputs: [], source: {},
    feeSats: BigInt(feeRateSatPerVb * 100), vsize: 100n,
    // Plans carry the rate per kvB; createProviderPsbtPlan has no per-vB field.
    feeRateSatPerKvB: BigInt(feeRateSatPerVb) * 1000n, rbf: false, protectedSatFlow: [],
    psbtHex: '70736274ff', psbtHash: '11'.repeat(32), analysisHash: '22'.repeat(32),
    transactionCommitmentHash: '44'.repeat(32),
    inscriptionPreviews: {
      transactionCommitmentHash: '44'.repeat(32), analysisHash: '22'.repeat(32),
      psbtHash: '11'.repeat(32), effectSetHash: '55'.repeat(32),
      classificationRevision: 'rev-1', verifiedAtMs: 1, items: [],
    },
    planHash: '33'.repeat(32),
    analysis: {
      inputs: [{
        index: 0,
        txid: 'aa'.repeat(32),
        vout: 0,
        valueSats: BigInt(10_000 + feeRateSatPerVb * 100),
        ownership: 'wallet',
        classification: { primaryClass: 'cardinal_clean' },
        sighash: {
          validEncoding: true,
          committedOutputIndexes: 'all',
        },
      }],
      outputs: [{
        index: 0,
        address: 'tb1qrecipientaddress',
        valueSats: 10_000n,
        ownership: 'external',
        role: 'recipient',
      }],
      warnings: [], hardViolations: [],
      assetEffects: { protectedSatFlow: [], protectedInputIndexes: [], protectedValueExposedToFees: 0n,
        inscriptions: [], effectSetHash: '55'.repeat(32) },
    },
  });
  const service = {
    sessionStatus: vi.fn(async () => ({ locked })),
    providerAccountView: vi.fn(async () => context),
    providerHasPermission: vi.fn(async (_origin: string, categories: string[]) =>
      categories.every((category) => grants.some((grant) => grant.scope.categories.includes(category as never)))),
    providerHasExactPermission: vi.fn(async (origin: string, categories: string[]) => {
      const approved = new Set(grants
        .filter((grant) => grant.scope.origin === origin)
        .flatMap((grant) => grant.scope.categories));
      return approved.size === categories.length && categories.every((category) => approved.has(category as never));
    }),
    providerGrantPermission: vi.fn(async (origin: string, categories: string[]) => {
      const event: PermissionGrantEvent = {
        version: 1, kind: 'grant', eventId: String(next++).padStart(32, '0'),
        resourceId: String(next++).padStart(32, '0'), occurredAtMs: 1,
        scope: { origin, network: 'signet', vaultId: 'vault-1', account: 0, categories: [...categories].sort() as never },
      };
      grants.push(event);
      return event;
    }),
    providerPermissionGrants: vi.fn(async () => grants),
    providerRevokeOrigin: vi.fn(async (origin: string) => {
      let count = 0;
      for (let index = grants.length - 1; index >= 0; index -= 1) {
        if (grants[index]!.scope.origin === origin) { grants.splice(index, 1); count += 1; }
      }
      return count;
    }),
    providerBalanceView: vi.fn(async () => ({ confirmed: '1000', unconfirmed: '0', total: '1000', fresh: true })),
    providerEnsureSpendReady: vi.fn(async () => undefined),
    providerInscriptionsView: vi.fn(async () => []),
    providerSignMessage: vi.fn(), providerPreparePsbt: vi.fn(), providerSignPreparedPsbt: vi.fn(),
    providerRevalidatePreparedPsbt: vi.fn(async () => undefined),
    providerMarkMarketplaceDelivered: vi.fn(async () => undefined),
    providerBroadcastPreparedPsbt: vi.fn(async () => ({
      psbt: 'cHNidP8=',
      txid: '44'.repeat(32),
    })),
    providerPrepareTransfer: vi.fn(async (input: { feeRateSatPerVb?: number }) =>
      preparedTransfer(input.feeRateSatPerVb)),
    providerPrepareOrdinalTransfer: vi.fn(),
    providerReauthenticate: vi.fn(),
    communityVaultSign: vi.fn(),
  };
  return {
    service: service as unknown as WalletService,
    grants,
    setContext: (nextContext: ProviderAccountView) => { context = nextContext; },
    setLocked: (nextLocked: boolean) => { locked = nextLocked; },
  };
}

function harness(area = fakeArea(), evaluatePhishing?: ProviderControllerDeps['evaluatePhishing']) {
  const mock = mockService();
  const open = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const openCommunityVaultSetup = vi.fn(async () => undefined);
  const requestUnlock = vi.fn(async () => true);
  let now = 1_800_000_000_000;
  const controller = new ProviderController({
    service: mock.service, sessionStorage: area, now: () => now,
    requestUnlock, openOrFocusApproval: open, closeApproval: close,
    openCommunityVaultSetup,
    ...(evaluatePhishing ? { evaluatePhishing } : {}),
  });
  return {
    controller,
    mock,
    area,
    open,
    close,
    openCommunityVaultSetup,
    requestUnlock,
    now: () => now,
    advance: (ms: number) => { now += ms; },
  };
}

async function tick(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 0)); }

function flexiblePsbt(): string {
  const tx = new Transaction({ lowR: true });
  tx.addInput({
    txid: 'aa'.repeat(32), index: 0, sighashType: SigHash.SINGLE_ANYONECANPAY,
    witnessUtxo: { script: hexToBytes(`0014${'11'.repeat(20)}`), amount: 10_000n },
  });
  tx.addOutput({ script: hexToBytes(`0014${'22'.repeat(20)}`), amount: 20_000n });
  return bytesToBase64(tx.toPSBT());
}

function mixedBuyerPsbt(): string {
  const tx = Transaction.fromPSBT(Uint8Array.from(Buffer.from(flexiblePsbt(), 'base64')));
  tx.addInput({
    txid: 'bb'.repeat(32), index: 1, sighashType: SigHash.ALL,
    witnessUtxo: { script: hexToBytes(`0014${'33'.repeat(20)}`), amount: 15_000n },
  });
  return bytesToBase64(tx.toPSBT());
}

describe('ProviderController authority, disclosure and approvals', () => {
  it('uses the independent Community Vault owner root for a sale instead of the Spending signer', async () => {
    const h = harness();
    h.mock.service.communityVaultSign = vi.fn(async () => ({
      version: 1 as const,
      psbtHex: '70736274ff',
      psbtHash: '22'.repeat(32),
      approvedOwnerId: 'owner-1',
      addedUnits: [0],
      signedUnits: [0],
      signedOwnerIds: ['owner-1'],
    }));
    const context = {
      version: 1,
      policy: { policyId: '11'.repeat(32) },
      plan: { campaignId: 'campaign-1', spendPlan: { planId: 'sale-plan-1' } },
      preflight: { version: 1 },
    };
    const result = await (h.controller as unknown as {
      executeApproved(pending: unknown, password?: string): Promise<unknown>;
    }).executeApproved({
      state: { authority },
      method: 'signPsbt',
      params: { signInputs: { vault: [0] }, broadcast: false },
      preparedPsbt: { psbtHex: '70736274ff' },
      communityVaultSale: { context, review: { units: [0] } },
      expectedVaultId: 'vault-1',
      expectedSessionId: '123e4567-e89b-42d3-a456-426614174001',
    }, 'owner-password');

    expect(h.mock.service.communityVaultSign).toHaveBeenCalledWith({
      campaignId: 'campaign-1',
      expectedVaultId: 'vault-1',
      expectedSessionId: '123e4567-e89b-42d3-a456-426614174001',
      password: 'owner-password',
      policy: context.policy,
      plan: context.plan.spendPlan,
      psbtHex: '70736274ff',
    });
    expect(h.mock.service.providerSignPreparedPsbt).not.toHaveBeenCalled();
    expect(result).toEqual({ psbt: 'cHNidP8=' });
  });

  it('uses the Spending signer for buyer funding without broadcasting', async () => {
    const h = harness();
    h.mock.service.providerSignPreparedPsbt = vi.fn(async () => ({ psbtBase64: 'cHNidP8=' }));
    const preparedPsbt = { psbtHex: '70736274ff' };
    const result = await (h.controller as unknown as {
      executeApproved(pending: unknown, password?: string): Promise<unknown>;
    }).executeApproved({
      state: { authority },
      method: 'signPsbt',
      params: { signInputs: { payment: [1] }, broadcast: false },
      preparedPsbt,
      communityVaultSaleBuyer: { review: { buyerTotalSats: '102000' } },
    });

    expect(h.mock.service.communityVaultSign).not.toHaveBeenCalled();
    expect(h.mock.service.providerSignPreparedPsbt).toHaveBeenCalledWith(
      preparedPsbt,
      [1],
      expect.any(Function),
    );
    expect(result).toEqual({ psbt: 'cHNidP8=' });
  });
  it('opens Drey for unlock and resumes the original connection request', async () => {
    const h = harness();
    h.mock.setLocked(true);
    let finishUnlock!: (unlocked: boolean) => void;
    h.requestUnlock.mockImplementation(() => new Promise<boolean>((resolve) => {
      finishUnlock = resolve;
    }));
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const nonce = '123e4567-e89b-42d3-a456-426614174113';

    page.send(request('wallet_connect', nonce, null));
    await tick();

    expect(h.requestUnlock).toHaveBeenCalledOnce();
    expect(h.open).not.toHaveBeenCalled();
    expect(page.messages).toEqual([]);

    h.mock.setLocked(false);
    finishUnlock(true);
    await tick();

    expect(h.open).toHaveBeenCalledOnce();
    expect((await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'snapshot',
    })).request).toMatchObject({ requestNonce: nonce, method: 'wallet_connect' });
    expect(page.messages).toEqual([]);
  });

  it('reports user rejection when the unlock window is closed', async () => {
    const h = harness();
    h.mock.setLocked(true);
    h.requestUnlock.mockResolvedValue(false);
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const nonce = '123e4567-e89b-42d3-a456-426614174114';

    page.send(request('wallet_connect', nonce, null));
    await tick();

    expect(page.messages).toContainEqual(expect.objectContaining({
      requestNonce: nonce,
      ok: false,
      error: expect.objectContaining({ data: { dreyCode: 'ERR_USER_REJECTED' } }),
    }));
    expect(h.open).not.toHaveBeenCalled();
  });

  it('silently reconnects only an exact previously approved identity grant', async () => {
    const h = harness(fakeArea(), () => ({
      action: 'allow', listStatus: 'valid', warnings: [],
      origin: {
        asciiOrigin: authority.origin, unicodeOrigin: authority.origin,
        asciiHostname: 'app.example', unicodeHostname: 'app.example', warnings: [],
      },
    }));
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const firstNonce = '123e4567-e89b-42d3-a456-426614174110';
    page.send(request('wallet_connect', firstNonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: firstNonce, approved: true,
    });

    page.messages.length = 0;
    const reconnectNonce = '123e4567-e89b-42d3-a456-426614174111';
    page.send(request('wallet_connect', reconnectNonce, null));
    await tick();
    expect(page.messages).toContainEqual(expect.objectContaining({
      requestNonce: reconnectNonce,
      ok: true,
    }));
    expect((await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'snapshot',
    })).request).toBeNull();

    page.messages.length = 0;
    const broaderNonce = '123e4567-e89b-42d3-a456-426614174112';
    page.send(request('wallet_connect', broaderNonce, {
      permissions: [{
        type: 'account', resourceId: 'account-0', actions: { read: true },
        dataCategories: ['balance'],
      }],
    }));
    await tick();
    expect((await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'snapshot',
    })).request).toMatchObject({ requestNonce: broaderNonce });
    expect(page.messages).toEqual([]);
  });

  it('opens a prefilled Community Vault setup only for the connected document', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const connectNonce = '123e4567-e89b-42d3-a456-426614174150';
    page.send(request('wallet_connect', connectNonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: connectNonce, approved: true,
    });

    page.messages.length = 0;
    page.send(request('drey_openCommunityVault', '123e4567-e89b-42d3-a456-426614174151', {
      campaignId: 'cp_123', ownerId: 'owner_456', label: 'OMB #123',
    }));
    await tick();

    expect(h.openCommunityVaultSetup).toHaveBeenCalledWith({
      campaignId: 'cp_123', ownerId: 'owner_456', label: 'OMB #123',
    });
    expect(page.messages).toContainEqual(expect.objectContaining({ ok: true, result: null }));
  });

  it('holds a queued approval through the worker-enforced switch cooldown', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const firstNonce = '123e4567-e89b-42d3-a456-426614174120';
    const secondNonce = '123e4567-e89b-42d3-a456-426614174121';
    page.send(request('wallet_connect', firstNonce, null));
    page.send(request('wallet_connect', secondNonce, null));
    await tick();

    const first = await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'snapshot',
    });
    expect(first.request).toMatchObject({ requestNonce: firstNonce });
    expect(first.request?.approveAfter).toBe(first.request?.createdAt);
    const second = await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: firstNonce, approved: true,
    });
    expect(second.request).toMatchObject({ requestNonce: secondNonce });
    expect(second.request!.approveAfter - h.now())
      .toBe(APPROVAL_SWITCH_COOLDOWN_MS);

    page.messages.length = 0;
    const early = await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: secondNonce, approved: true,
    });
    expect(early.request?.requestNonce).toBe(secondNonce);
    expect(page.messages).toEqual([]);
    expect(h.mock.service.providerGrantPermission).toHaveBeenCalledTimes(1);

    h.advance(APPROVAL_SWITCH_COOLDOWN_MS - 1);
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: secondNonce, approved: true,
    });
    expect(h.mock.service.providerGrantPermission).toHaveBeenCalledTimes(1);
    h.advance(1);
    const done = await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: secondNonce, approved: true,
    });
    expect(done.request).toBeNull();
    expect(h.mock.service.providerGrantPermission).toHaveBeenCalledTimes(2);
  });

  it('keeps rejection immediate when a queued request becomes active', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const firstNonce = '123e4567-e89b-42d3-a456-426614174122';
    const secondNonce = '123e4567-e89b-42d3-a456-426614174123';
    page.send(request('wallet_connect', firstNonce, null));
    page.send(request('wallet_connect', secondNonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: firstNonce, approved: true,
    });
    page.messages.length = 0;

    const rejected = await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: secondNonce, approved: false,
    });
    expect(rejected.request).toBeNull();
    expect(page.messages).toContainEqual(expect.objectContaining({
      requestNonce: secondNonce,
      ok: false,
      error: expect.objectContaining({ data: { dreyCode: 'ERR_USER_REJECTED' } }),
    }));
  });

  it('replays messages received while the worker composition root initializes', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority, [
      request('wallet_getCurrentPermissions', '123e4567-e89b-42d3-a456-426614174009', null),
    ]);
    await tick();
    expect(page.messages).toEqual([expect.objectContaining({ ok: true, result: [] })]);
  });

  it('does not disclose account data before a document connection', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    page.send(request('wallet_getAccount', '123e4567-e89b-42d3-a456-426614174010', null));
    await tick();
    expect(page.messages).toEqual([expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ data: { dreyCode: 'ERR_NOT_CONNECTED' } }),
    })]);
    expect(JSON.stringify(page.messages)).not.toContain('tb1qpaymentaddress');
  });

  it('rejects an unconnected read before consulting lock-sensitive account state', async () => {
    const h = harness();
    h.mock.service.providerAccountView = vi.fn(async () => {
      throw new Error('locked');
    });
    const page = fakePort();
    h.controller.attach(page.port, authority);

    page.send(request('getBalance', '123e4567-e89b-42d3-a456-426614174106', null));
    await tick();

    expect(h.mock.service.providerAccountView).not.toHaveBeenCalled();
    expect(page.messages).toEqual([expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ data: { dreyCode: 'ERR_NOT_CONNECTED' } }),
    })]);
  });

  it('returns static provider capabilities without reading or unlocking an account', async () => {
    const h = harness();
    h.mock.service.providerAccountView = vi.fn(async () => {
      throw new Error('locked');
    });
    const page = fakePort();
    h.controller.attach(page.port, authority);

    page.send(request('getInfo', '123e4567-e89b-42d3-a456-426614174011', null));
    await tick();

    expect(page.messages).toEqual([expect.objectContaining({
      ok: true,
      result: expect.objectContaining({
        version: '0.12.0',
        platform: 'web',
        supports: ['WBIP001', 'WBIP004'],
        capabilities: ['community-vault-v1', 'community-vault-offers-v1'],
        methods: expect.arrayContaining(['getInfo', 'wallet_connect', 'signPsbt']),
      }),
    })]);
  });

  it('caches the signed phishing decision across bursty approval-free reads', async () => {
    const evaluate = vi.fn(() => ({
      action: 'allow' as const,
      listStatus: 'valid' as const,
      warnings: [],
      origin: {
        asciiOrigin: authority.origin,
        unicodeOrigin: authority.origin,
        asciiHostname: 'app.example',
        unicodeHostname: 'app.example',
        warnings: [],
      },
    }));
    const h = harness(fakeArea(), evaluate);
    const page = fakePort();
    h.controller.attach(page.port, authority);

    page.send(request('getInfo', '123e4567-e89b-42d3-a456-426614174012', null));
    await tick();
    page.send(request('getInfo', '123e4567-e89b-42d3-a456-426614174013', null));
    await tick();
    expect(evaluate).toHaveBeenCalledTimes(1);

    h.advance(60_000);
    page.send(request('getInfo', '123e4567-e89b-42d3-a456-426614174014', null));
    await tick();
    expect(evaluate).toHaveBeenCalledTimes(2);
  });

  it('does not emit account-change timing or addresses to a document that never connected', async () => {
    const h = harness();
    h.mock.grants.push({
      version: 1, kind: 'grant', eventId: '90'.repeat(16), resourceId: '91'.repeat(16), occurredAtMs: 1,
      scope: {
        origin: authority.origin, network: 'signet', vaultId: 'vault-1', account: 0,
        categories: ['account_identity', 'addresses', 'network'],
      },
    });
    const page = fakePort();
    h.controller.attach(page.port, authority);

    await h.controller.accountChanged(`acct_signet_${'1'.repeat(64)}`, 0);

    expect(page.messages).toEqual([]);
  });

  it('sends lifecycle events only to exact connected documents', async () => {
    const h = harness();
    const connected = fakePort();
    const observer = fakePort();
    h.controller.attach(connected.port, authority);
    h.controller.attach(observer.port, {
      ...authority,
      frameId: 9,
      documentId: '123e4567-e89b-42d3-a456-426614174109',
    });
    const connectNonce = '123e4567-e89b-42d3-a456-426614174108';
    connected.send(request('wallet_connect', connectNonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: connectNonce, approved: true,
    });
    connected.messages.length = 0;

    await h.controller.accountChanged(`acct_signet_${'1'.repeat(64)}`, 0);
    expect(connected.messages).toContainEqual(expect.objectContaining({ event: 'accountChange' }));
    expect(observer.messages).toEqual([]);

    connected.messages.length = 0;
    await h.controller.invalidateSession();
    expect(connected.messages).toContainEqual(expect.objectContaining({ event: 'disconnect' }));
    expect(observer.messages).toEqual([]);
  });

  it('filters account-change addresses to the document-approved purpose set', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const nonce = '123e4567-e89b-42d3-a456-426614174105';
    page.send(request('wallet_connect', nonce, { addresses: ['payment'] }));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: nonce, approved: true,
    });
    page.messages.length = 0;

    await h.controller.accountChanged(`acct_signet_${'1'.repeat(64)}`, 0);

    expect(page.messages).toContainEqual(expect.objectContaining({
      event: 'accountChange',
      data: {
        type: 'accountChange',
        addresses: [expect.objectContaining({ purpose: 'payment' })],
      },
    }));
    expect(JSON.stringify(page.messages)).not.toContain('tb1pordinaladdress');
    expect(JSON.stringify(page.messages)).not.toContain(`03${'22'.repeat(32)}`);
  });

  it('maps unknown methods to the stable unsupported-method provider error', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    page.send(request('stx_transferStx', '123e4567-e89b-42d3-a456-426614174007', {}));
    await tick();
    expect(page.messages).toEqual([expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: -32601, data: { dreyCode: 'ERR_UNSUPPORTED_METHOD' } }),
    })]);
  });

  it('fails an unknown flexible marketplace before approval with a stable error', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const connectNonce = '123e4567-e89b-42d3-a456-426614174060';
    page.send(request('wallet_connect', connectNonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve', requestNonce: connectNonce, approved: true,
    });
    page.messages.length = 0;
    page.send(request('signPsbt', '123e4567-e89b-42d3-a456-426614174061', {
      psbt: flexiblePsbt(), signInputs: { tb1qpaymentaddress: [0] }, broadcast: false,
      marketplaceContext: {
        version: 1, marketplaceId: 'future_market', templateVersion: 'v1', action: 'list',
        role: 'seller', assetKind: 'inscription', workflowId: 'future-1', step: 1,
        stepCount: 1, broadcaster: 'site',
      },
    }));
    await tick();
    expect(page.messages).toEqual([expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ data: { dreyCode: 'ERR_UNSUPPORTED_MARKETPLACE' } }),
    })]);
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.mock.service.providerPreparePsbt).not.toHaveBeenCalled();
  });

  it('allows Advanced review when only an unselected external input is flexible', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const connectNonce = '123e4567-e89b-42d3-a456-426614174066';
    page.send(request('wallet_connect', connectNonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve', requestNonce: connectNonce, approved: true,
    });
    const prepared = await h.mock.service.providerPrepareTransfer({
      recipients: [{ address: 'tb1qrecipientaddress', amount: 10_000 }],
      binding: { ...authority, requestNonce: connectNonce, providerMethod: 'sendTransfer' },
    });
    h.mock.service.providerPreparePsbt = vi.fn(async (input) => ({
      ...prepared,
      kind: 'provider_psbt' as const,
      broadcast: false,
      requiresAdvanced: true,
      selectedInputIndexes: [1],
      provider: input.binding,
    }));
    page.send(request('signPsbt', '123e4567-e89b-42d3-a456-426614174067', {
      psbt: mixedBuyerPsbt(), signInputs: { tb1qpaymentaddress: [1] }, broadcast: false,
    }));
    await tick();

    expect(h.mock.service.providerPreparePsbt).toHaveBeenCalledWith(expect.objectContaining({
      selectedInputIndexes: [1],
    }));
    const snapshot = await h.controller.approvalCommand({ type: 'drey:approval', protocolVersion: 1, command: 'snapshot' });
    expect(snapshot.request).toMatchObject({
      method: 'signPsbt', requiresPassword: true, confirmationPhrase: 'SIGN PSBT',
    });
    await h.controller.approvalWindowClosed();
  });

  it('keeps an advanced request open after a mistyped password', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const connectNonce = '123e4567-e89b-42d3-a456-426614174068';
    page.send(request('wallet_connect', connectNonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve', requestNonce: connectNonce, approved: true,
    });
    const prepared = await h.mock.service.providerPrepareTransfer({
      recipients: [{ address: 'tb1qrecipientaddress', amount: 10_000 }],
      binding: { ...authority, requestNonce: connectNonce, providerMethod: 'sendTransfer' },
    });
    h.mock.service.providerPreparePsbt = vi.fn(async (input) => ({
      ...prepared,
      kind: 'provider_psbt' as const,
      broadcast: false,
      requiresAdvanced: true,
      selectedInputIndexes: [1],
      provider: input.binding,
    }));
    const psbtNonce = '123e4567-e89b-42d3-a456-426614174069';
    page.send(request('signPsbt', psbtNonce, {
      psbt: mixedBuyerPsbt(), signInputs: { tb1qpaymentaddress: [1] }, broadcast: false,
    }));
    await tick();
    page.messages.length = 0;
    const resolve = {
      type: 'drey:approval' as const, protocolVersion: 1 as const, command: 'resolve' as const,
      requestNonce: psbtNonce, approved: true, confirmation: 'SIGN PSBT',
    };

    h.mock.service.providerReauthenticate = vi.fn(async () => {
      throw new VaultError('wrong-password');
    });
    const retryable = await h.controller.approvalCommand({ ...resolve, password: 'not-the-right-password' });

    // The page hears nothing and the request keeps its nonce, so the user can
    // simply retype rather than starting over from the dApp.
    expect(page.messages).toEqual([]);
    expect(h.mock.service.providerSignPreparedPsbt).not.toHaveBeenCalled();
    expect(retryable.request).toMatchObject({
      requestNonce: psbtNonce,
      approvalError: expect.stringContaining('password'),
    });

    h.mock.service.providerReauthenticate = vi.fn(async () => undefined);
    h.mock.service.providerSignPreparedPsbt = vi.fn(async () => ({ psbtBase64: 'c3ByaW50' }));
    const done = await h.controller.approvalCommand({ ...resolve, password: 'the-right-password' });

    expect(h.mock.service.providerSignPreparedPsbt).toHaveBeenCalledTimes(1);
    expect(done.request).toBeNull();
    await h.controller.approvalWindowClosed();
  });

  it('terminates the request when reauthentication fails for any other reason', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const connectNonce = '123e4567-e89b-42d3-a456-426614174070';
    page.send(request('wallet_connect', connectNonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve', requestNonce: connectNonce, approved: true,
    });
    const prepared = await h.mock.service.providerPrepareTransfer({
      recipients: [{ address: 'tb1qrecipientaddress', amount: 10_000 }],
      binding: { ...authority, requestNonce: connectNonce, providerMethod: 'sendTransfer' },
    });
    h.mock.service.providerPreparePsbt = vi.fn(async (input) => ({
      ...prepared,
      kind: 'provider_psbt' as const,
      broadcast: false,
      requiresAdvanced: true,
      selectedInputIndexes: [1],
      provider: input.binding,
    }));
    const psbtNonce = '123e4567-e89b-42d3-a456-426614174071';
    page.send(request('signPsbt', psbtNonce, {
      psbt: mixedBuyerPsbt(), signInputs: { tb1qpaymentaddress: [1] }, broadcast: false,
    }));
    await tick();
    page.messages.length = 0;
    // Only a wrong password is ordinary user error. A tampered vault is not, and
    // must not become an unbounded retry against damaged storage.
    h.mock.service.providerReauthenticate = vi.fn(async () => {
      throw new VaultError('tampered');
    });

    const snapshot = await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: psbtNonce, approved: true, confirmation: 'SIGN PSBT', password: 'any-password',
    });

    expect(page.messages).toEqual([expect.objectContaining({ ok: false })]);
    expect(h.mock.service.providerSignPreparedPsbt).not.toHaveBeenCalled();
    expect(snapshot.request).toBeNull();
  });

  it('fails a known marketplace remote template version without activating it', async () => {
    const h = harness();
    const page = fakePort();
    const satflowAuthority = { ...authority, origin: 'https://satflow.com', url: 'https://satflow.com/market' };
    h.controller.attach(page.port, satflowAuthority);
    const connectNonce = '123e4567-e89b-42d3-a456-426614174062';
    page.send(request('wallet_connect', connectNonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve', requestNonce: connectNonce, approved: true,
    });
    page.messages.length = 0;
    page.send(request('signPsbt', '123e4567-e89b-42d3-a456-426614174063', {
      psbt: flexiblePsbt(), signInputs: { tb1qpaymentaddress: [0] }, broadcast: false,
      marketplaceContext: {
        version: 1, marketplaceId: 'satflow', templateVersion: 'remote-v2', action: 'list',
        role: 'seller', assetKind: 'inscription', workflowId: 'wf-new', step: 1, stepCount: 2,
        broadcaster: 'site',
      },
    }));
    await tick();
    expect(page.messages).toEqual([expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ data: { dreyCode: 'ERR_UNSUPPORTED_TEMPLATE' } }),
    })]);
    expect(h.mock.service.providerPreparePsbt).not.toHaveBeenCalled();
  });

  it('keeps an exact pinned marketplace template fixture-only in production routing', async () => {
    const h = harness();
    const page = fakePort();
    const satflowAuthority = { ...authority, origin: 'https://satflow.com', url: 'https://satflow.com/market' };
    h.controller.attach(page.port, satflowAuthority);
    const connectNonce = '123e4567-e89b-42d3-a456-426614174064';
    page.send(request('wallet_connect', connectNonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve', requestNonce: connectNonce, approved: true,
    });
    page.messages.length = 0;
    page.send(request('signPsbt', '123e4567-e89b-42d3-a456-426614174065', {
      psbt: flexiblePsbt(), signInputs: { tb1qpaymentaddress: [0] }, broadcast: false,
      marketplaceContext: {
        version: 1, marketplaceId: 'satflow', templateVersion: 'drey-1', action: 'list',
        role: 'seller', assetKind: 'inscription', workflowId: 'wf-pinned', step: 1, stepCount: 2,
        identifiers: { inscriptionId: `${'11'.repeat(32)}i0` },
        economics: {
          sellerProceedsSats: '20000', payoutAddress: 'bc1qfixtureonlypayout',
        },
        broadcaster: 'site',
      },
    }));
    await tick();
    expect(page.messages).toEqual([expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ data: { dreyCode: 'ERR_UNSUPPORTED_TEMPLATE' } }),
    })]);
    expect(h.mock.service.providerPreparePsbt).not.toHaveBeenCalled();
  });

  it('swallows postMessage failure while cleaning a dead provider port', async () => {
    const h = harness();
    const page = fakePort({ throwOnPost: true });
    h.controller.attach(page.port, authority);
    page.send(request('stx_transferStx', '123e4567-e89b-42d3-a456-426614174006', {}));
    await tick();
    expect(page.messages).toEqual([]);
  });

  it('hard-blocks a signed-list phishing match before unlock or approval', async () => {
    const h = harness(fakeArea(), () => ({
      action: 'block', listStatus: 'valid', warnings: [], blockReason: 'wallet_drainer',
      origin: {
        asciiOrigin: authority.origin, unicodeOrigin: authority.origin,
        asciiHostname: 'app.example', unicodeHostname: 'app.example', warnings: [],
      },
    }));
    const page = fakePort();
    h.controller.attach(page.port, authority);
    page.send(request('wallet_connect', '123e4567-e89b-42d3-a456-426614174009', null));
    await tick();
    expect(page.messages).toEqual([expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ data: { dreyCode: 'ERR_PHISHING_BLOCKED' } }),
    })]);
    expect(h.open).not.toHaveBeenCalled();
    expect(h.mock.service.providerAccountView).not.toHaveBeenCalled();
  });

  it('rejects unsafe BIP322 message bytes as invalid params before approval', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    page.send(request('signMessage', '123e4567-e89b-42d3-a456-426614174008', {
      address: 'tb1qpaymentaddress', message: 'hidden\0control', protocol: 'BIP322',
    }));
    await tick();
    expect(page.messages).toEqual([expect.objectContaining({
      ok: false, error: { code: -32602, message: 'Invalid params' },
    })]);
    expect(h.open).not.toHaveBeenCalled();
    expect(h.mock.service.providerAccountView).not.toHaveBeenCalled();
  });

  it('queues one focused approval and discloses only after approval', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const nonce = '123e4567-e89b-42d3-a456-426614174011';
    page.send(request('wallet_connect', nonce, null));
    await tick();
    expect(h.open).toHaveBeenCalledTimes(1);
    expect(page.messages).toEqual([]);
    const snapshot = await h.controller.approvalCommand({ type: 'drey:approval', protocolVersion: 1, command: 'snapshot' });
    expect(snapshot.request).toMatchObject({ requestNonce: nonce, origin: authority.origin });
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve', requestNonce: nonce, approved: true,
    });
    expect(page.messages).toEqual([expect.objectContaining({ ok: true })]);
    expect(JSON.stringify(page.messages)).toContain('tb1qpaymentaddress');
    expect(h.close).toHaveBeenCalled();
  });

  it('grants only the connect categories and treats approved WBIP permissions as this document connection', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const connectNonce = '123e4567-e89b-42d3-a456-426614174012';
    page.send(request('wallet_connect', connectNonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: connectNonce, approved: true,
    });
    expect(h.mock.grants[0]?.scope.categories).toEqual([
      'account_identity', 'addresses', 'network',
    ]);

    const second = harness();
    const wbipPage = fakePort();
    second.controller.attach(wbipPage.port, authority);
    const permissionNonce = '123e4567-e89b-42d3-a456-426614174013';
    wbipPage.send(request('wallet_requestPermissions', permissionNonce, [{
      type: 'account', resourceId: 'page-supplied-id-is-ignored',
      actions: { read: true }, dataCategories: ['balance'],
    }]));
    await tick();
    await second.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: permissionNonce, approved: true,
    });
    expect(JSON.stringify(wbipPage.messages)).not.toContain('tb1qpaymentaddress');
    wbipPage.send(request('getBalance', '123e4567-e89b-42d3-a456-426614174014', null));
    await tick();
    expect(wbipPage.messages.at(-1)).toEqual(expect.objectContaining({
      ok: true,
      result: { confirmed: '1000', unconfirmed: '0', total: '1000' },
    }));
  });

  it('shows and returns the exact connect purposes and additional requested categories', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const nonce = '123e4567-e89b-42d3-a456-426614174015';
    page.send(request('wallet_connect', nonce, {
      addresses: ['payment'],
      permissions: [{
        type: 'account', resourceId: 'display-hint', actions: { read: true }, dataCategories: ['balance'],
      }],
      network: 'Signet',
    }));
    await tick();

    const before = await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'snapshot',
    });
    expect(before.request?.details).toMatchObject({
      account: 0,
      network: 'signet',
      requested: {
        purposes: ['payment'],
        categories: ['account_identity', 'addresses', 'balance', 'network'],
      },
    });
    expect(before.request?.review).toEqual({
      kind: 'connection',
      walletName: 'Primary wallet',
      account: 0,
      network: 'signet',
      purposes: ['payment'],
      categories: ['account_identity', 'addresses', 'balance', 'network'],
    });
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve', requestNonce: nonce, approved: true,
    });

    expect(h.mock.grants[0]?.scope.categories).toEqual([
      'account_identity', 'addresses', 'balance', 'network',
    ]);
    expect(page.messages[0]).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({
        addresses: [expect.objectContaining({ purpose: 'payment' })],
      }),
    }));
    expect(JSON.stringify(page.messages[0])).not.toContain('tb1pordinaladdress');

    page.messages.length = 0;
    page.send(request('wallet_getAccount', '123e4567-e89b-42d3-a456-426614174016', null));
    await tick();
    expect(page.messages[0]).toEqual(expect.objectContaining({
      ok: true,
      result: expect.objectContaining({
        addresses: [expect.objectContaining({ purpose: 'payment' })],
      }),
    }));
    expect(JSON.stringify(page.messages[0])).not.toContain('tb1pordinaladdress');

    page.send(request('getAddresses', '123e4567-e89b-42d3-a456-426614174017', {
      purposes: ['ordinals'],
    }));
    await tick();
    expect(page.messages.at(-1)).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ data: { dreyCode: 'ERR_NO_ACCOUNT' } }),
    }));

    page.send(request('wallet_connect', '123e4567-e89b-42d3-a456-426614174018', {
      addresses: ['ordinals'],
    }));
    await tick();
    expect((await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'snapshot',
    })).request).toMatchObject({
      requestNonce: '123e4567-e89b-42d3-a456-426614174018',
      review: { purposes: ['ordinals'] },
    });
  });

  it('requires renewed purpose approval in a different document', async () => {
    const h = harness();
    const first = fakePort();
    h.controller.attach(first.port, authority);
    const firstNonce = '123e4567-e89b-42d3-a456-426614174019';
    first.send(request('wallet_connect', firstNonce, { addresses: ['payment'] }));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: firstNonce, approved: true,
    });

    const replacement = fakePort();
    h.controller.attach(replacement.port, {
      ...authority,
      documentId: '123e4567-e89b-42d3-a456-426614174119',
    });
    const replacementNonce = '123e4567-e89b-42d3-a456-426614174020';
    replacement.send(request('wallet_connect', replacementNonce, { addresses: ['payment'] }));
    await tick();

    expect(replacement.messages).toEqual([]);
    expect((await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'snapshot',
    })).request).toMatchObject({ requestNonce: replacementNonce });
  });

  it('enforces per-origin queue bounds and preserves the active request', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    for (let index = 0; index < 6; index += 1) {
      page.send(request('wallet_connect', `123e4567-e89b-42d3-a456-4266141741${index}0`, null));
    }
    await tick();
    expect(page.messages).toContainEqual(expect.objectContaining({
      ok: false, error: expect.objectContaining({ data: { dreyCode: 'ERR_QUEUE_FULL' } }),
    }));
    const snapshot = await h.controller.approvalCommand({ type: 'drey:approval', protocolVersion: 1, command: 'snapshot' });
    expect(snapshot.request?.requestNonce).toBe('123e4567-e89b-42d3-a456-426614174100');
  });

  it('rejects a stale approval when stable account identity changes at the same numeric index', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const nonce = '123e4567-e89b-42d3-a456-426614174020';
    page.send(request('wallet_connect', nonce, null));
    await tick();
    h.mock.setContext({
      ...(await h.mock.service.providerAccountView()),
      accountId: `acct_signet_${'9'.repeat(64)}`,
      account: 0,
    });
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve', requestNonce: nonce, approved: true,
    });
    expect(page.messages).toContainEqual(expect.objectContaining({
      ok: false, error: expect.objectContaining({ data: { dreyCode: 'ERR_STALE_CONTEXT' } }),
    }));
  });

  it('revalidates a queued request before presenting it', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const first = '123e4567-e89b-42d3-a456-426614174021';
    const second = '123e4567-e89b-42d3-a456-426614174022';
    page.send(request('wallet_connect', first, null));
    page.send(request('wallet_connect', second, null));
    await tick();
    h.mock.setContext({
      ...(await h.mock.service.providerAccountView()),
      sessionId: '123e4567-e89b-42d3-a456-426614174098',
    });

    const snapshot = await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve', requestNonce: first, approved: false,
    });

    expect(snapshot.request).toBeNull();
    expect(page.messages).toHaveLength(2);
    expect(page.messages[1]).toEqual(expect.objectContaining({
      ok: false, error: expect.objectContaining({ data: { dreyCode: 'ERR_STALE_CONTEXT' } }),
    }));
  });

  it('serializes duplicate approval commands so one request executes once', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const nonce = '123e4567-e89b-42d3-a456-426614174023';
    page.send(request('wallet_connect', nonce, null));
    await tick();
    const command = {
      type: 'drey:approval' as const, protocolVersion: 1 as const, command: 'resolve' as const,
      requestNonce: nonce, approved: true,
    };

    await Promise.all([
      h.controller.approvalCommand(command),
      h.controller.approvalCommand(command),
    ]);

    expect(h.mock.service.providerGrantPermission).toHaveBeenCalledTimes(1);
    expect(page.messages.filter((message) => (message as { ok?: boolean }).ok)).toHaveLength(1);
  });

  it('drops the request from the queue when the approval window cannot open', async () => {
    const h = harness();
    h.open.mockRejectedValueOnce(new Error('approval popup did not expose an exact window/tab identity'));
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const failed = '123e4567-e89b-42d3-a456-426614174060';
    page.send(request('wallet_connect', failed, null));
    await tick();

    // The page has already been told this request failed, so it must not remain
    // queued: its nonce is gone, so assertPendingLive can never pass, and it
    // would hold a slot against the per-origin and total caps until the TTL.
    expect(page.messages.at(-1)).toMatchObject({ ok: false });
    const stranded = await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'snapshot',
    });
    expect(stranded.request).toBeNull();

    // The next request is admitted and presented normally.
    const next = '123e4567-e89b-42d3-a456-426614174061';
    page.send(request('wallet_connect', next, null));
    await tick();
    const snapshot = await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'snapshot',
    });
    expect(snapshot.request?.requestNonce).toBe(next);
  });

  it('rejects active and waiting requests when the approval window closes', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    page.send(request('wallet_connect', '123e4567-e89b-42d3-a456-426614174030', null));
    page.send(request('wallet_connect', '123e4567-e89b-42d3-a456-426614174031', null));
    await tick();
    await h.controller.approvalWindowClosed();
    expect(page.messages).toHaveLength(2);
    expect(page.messages.every((message) => JSON.stringify(message).includes('ERR_USER_REJECTED'))).toBe(true);
  });

  it('expires active and waiting requests after five minutes', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    page.send(request('wallet_connect', '123e4567-e89b-42d3-a456-426614174032', null));
    page.send(request('wallet_connect', '123e4567-e89b-42d3-a456-426614174033', null));
    await tick();
    h.advance(300_001);
    const snapshot = await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'snapshot',
    });
    expect(snapshot.request).toBeNull();
    expect(page.messages).toHaveLength(2);
    expect(page.messages.every((message) => JSON.stringify(message).includes('ERR_REQUEST_EXPIRED'))).toBe(true);
  });

  it('rebuilds a transfer plan through the worker before exposing an updated fee review', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const connectNonce = '123e4567-e89b-42d3-a456-426614174034';
    page.send(request('wallet_connect', connectNonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: connectNonce, approved: true,
    });
    h.mock.grants[0]!.scope.categories.push('balance');
    const transferNonce = '123e4567-e89b-42d3-a456-426614174035';
    page.send(request('sendTransfer', transferNonce, {
      recipients: [{ address: 'tb1qrecipientaddress', amount: 10_000 }],
    }));
    await tick();

    const snapshot = await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'setFee',
      requestNonce: transferNonce, feeRateSatPerVb: 12,
    });
    expect(h.mock.service.providerPrepareTransfer).toHaveBeenLastCalledWith(expect.objectContaining({
      feeRateSatPerVb: 12,
    }));
    expect(snapshot.request?.details).toMatchObject({ feeSats: '1200', feeRateSatPerVb: '12' });
    expect(snapshot.request?.review).toEqual({
      kind: 'transaction',
      walletName: 'Primary wallet',
      account: 0,
      network: 'signet',
      authorization: 'complete',
      feeSats: '1200',
      walletInputSats: '11200',
      walletOutputSats: '0',
      externalOutputSats: '10000',
      netWalletDebitSats: '11200',
      economicClaims: [],
      outputs: [{
        index: 0,
        address: 'tb1qrecipientaddress',
        valueSats: '10000',
        ownership: 'external',
        role: 'recipient',
        committed: true,
      }],
    });
    expect(snapshot.request?.details).toMatchObject({
      account: 0,
      network: 'signet',
      security: {
        broadcast: true,
        requiresAdvanced: false,
        planHash: '33'.repeat(32),
        analysisHash: '22'.repeat(32),
        psbtHash: '11'.repeat(32),
        hardViolations: [],
        rawPsbtHex: '70736274ff',
      },
    });
    expect(page.messages.some((message) => JSON.stringify(message).includes('10000'))).toBe(false);
    await h.controller.approvalWindowClosed();
  });

  it('keeps structured transfers one-click after fresh approval without password reauthentication', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const connectNonce = '123e4567-e89b-42d3-a456-426614174036';
    page.send(request('wallet_connect', connectNonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: connectNonce, approved: true,
    });
    h.mock.grants[0]!.scope.categories.push('balance');
    const transferNonce = '123e4567-e89b-42d3-a456-426614174037';
    page.send(request('sendTransfer', transferNonce, {
      recipients: [{ address: 'tb1qrecipientaddress', amount: 10_000 }],
    }));
    await tick();
    expect((await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'snapshot',
    })).request).toMatchObject({ requiresPassword: false, confirmationPhrase: null });
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: transferNonce, approved: true,
    });

    expect(h.mock.service.providerReauthenticate).not.toHaveBeenCalled();
    expect(h.mock.service.providerBroadcastPreparedPsbt).toHaveBeenCalledOnce();
    expect(page.messages.at(-1)).toEqual(expect.objectContaining({
      ok: true, result: { txid: '44'.repeat(32) },
    }));
  });

  it('completes provider freshness preflight before planning an immediate transfer', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const connectNonce = '123e4567-e89b-42d3-a456-426614174120';
    page.send(request('wallet_connect', connectNonce, {
      addresses: ['payment'],
      network: 'Signet',
      permissions: [{
        type: 'account', resourceId: 'active', actions: { read: true },
        dataCategories: ['balance'],
      }],
    }));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: connectNonce, approved: true,
    });

    page.send(request('sendTransfer', '123e4567-e89b-42d3-a456-426614174121', {
      recipients: [{ address: 'tb1qrecipientaddress', amount: 100_000 }],
    }));
    await tick();

    expect(h.mock.service.providerEnsureSpendReady).toHaveBeenCalledOnce();
    expect(h.mock.service.providerPrepareTransfer).toHaveBeenCalledWith(expect.objectContaining({
      recipients: [{ address: 'tb1qrecipientaddress', amount: 100_000 }],
    }));
    expect(vi.mocked(h.mock.service.providerEnsureSpendReady).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(h.mock.service.providerPrepareTransfer).mock.invocationCallOrder[0]!);
    expect((await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'snapshot',
    })).request?.method).toBe('sendTransfer');
  });

  it('reports wallet-data staleness before approval without planning or broadcasting', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const connectNonce = '123e4567-e89b-42d3-a456-426614174122';
    page.send(request('wallet_connect', connectNonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: connectNonce, approved: true,
    });
    h.mock.grants[0]!.scope.categories.push('balance');
    vi.mocked(h.mock.service.providerEnsureSpendReady).mockRejectedValueOnce(
      new RpcError('ERR_DATA_STALE', 'spending blocked: index_lag'),
    );
    page.messages.length = 0;

    page.send(request('sendTransfer', '123e4567-e89b-42d3-a456-426614174123', {
      recipients: [{ address: 'tb1qrecipientaddress', amount: 100_000 }],
    }));
    await tick();

    expect(page.messages).toEqual([expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ data: { dreyCode: 'ERR_DATA_STALE' } }),
    })]);
    expect(h.open).toHaveBeenCalledOnce();
    expect(h.mock.service.providerPrepareTransfer).not.toHaveBeenCalled();
    expect(h.mock.service.providerBroadcastPreparedPsbt).not.toHaveBeenCalled();
  });

  it('maps an indeterminate provider broadcast without retrying it', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const connectNonce = '123e4567-e89b-42d3-a456-426614174124';
    page.send(request('wallet_connect', connectNonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: connectNonce, approved: true,
    });
    h.mock.grants[0]!.scope.categories.push('balance');
    vi.mocked(h.mock.service.providerBroadcastPreparedPsbt).mockRejectedValueOnce(
      new RpcError('ERR_BROADCAST_OUTCOME_UNKNOWN', 'manual reconciliation required'),
    );
    const transferNonce = '123e4567-e89b-42d3-a456-426614174125';
    page.send(request('sendTransfer', transferNonce, {
      recipients: [{ address: 'tb1qrecipientaddress', amount: 100_000 }],
    }));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: transferNonce, approved: true,
    });

    expect(page.messages.at(-1)).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ data: { dreyCode: 'ERR_BROADCAST_OUTCOME_UNKNOWN' } }),
    }));
    expect(h.mock.service.providerBroadcastPreparedPsbt).toHaveBeenCalledOnce();
  });

  it('does not replay an accepted transfer when result delivery is lost', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const connectNonce = '123e4567-e89b-42d3-a456-426614174126';
    page.send(request('wallet_connect', connectNonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: connectNonce, approved: true,
    });
    h.mock.grants[0]!.scope.categories.push('balance');
    const transferNonce = '123e4567-e89b-42d3-a456-426614174127';
    page.send(request('sendTransfer', transferNonce, {
      recipients: [{ address: 'tb1qrecipientaddress', amount: 100_000 }],
    }));
    await tick();
    page.setThrowOnPost(true);
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: transferNonce, approved: true,
    });

    expect(h.mock.service.providerBroadcastPreparedPsbt).toHaveBeenCalledOnce();
    const replacement = fakePort();
    h.controller.attach(replacement.port, authority);
    replacement.send(request(
      'wallet_getCurrentPermissions',
      '123e4567-e89b-42d3-a456-426614174128',
      null,
    ));
    await tick();
    expect(h.mock.service.providerBroadcastPreparedPsbt).toHaveBeenCalledOnce();
  });

  it('enforces unavailable-preview acknowledgement in the worker, not only the UI', async () => {
    const h = harness();
    const base = structuredClone(await h.mock.service.providerPrepareTransfer({
      binding: authority as never,
      recipients: [],
    } as never)) as ProviderPsbtPlanV3;
    const inscriptionId = `${'ab'.repeat(32)}i0`;
    const txid = 'cd'.repeat(32);
    const effect = {
      inscriptionId, satpoint: `${txid}:0:0`, outpoint: { txid, vout: 0 },
      inputIndex: 0, inputOffset: 0n, outputIndex: 0, outputOffset: 0n,
      inputOwnership: 'wallet' as const, outputOwnership: 'external' as const,
      movement: 'sent' as const, coLocationGroup: `${txid}:0:0`,
      qualifiedPartialAuthorization: false,
    };
    base.analysis.assetEffects.inscriptions = [effect];
    base.analysis.assetEffects.effectSetHash = '55'.repeat(32);
    if (!base.inscriptionPreviews) throw new Error('preview binding expected');
    base.inscriptionPreviews.items = [{
      metadata: {
        inscriptionId, satpoint: effect.satpoint, outpoint: effect.outpoint,
        classificationRevision: 'rev-1', number: null, contentType: 'text/html',
        contentLength: 10, confirmations: 1, parent: null, delegate: null,
        reinscription: false, cursed: false,
      },
      preview: {
        disposition: 'placeholder', reason: 'active_content', requestedInscriptionId: inscriptionId,
        sourceInscriptionId: inscriptionId, resolvedInscriptionId: inscriptionId,
        delegateInscriptionId: null, sourceContentSha256: '66'.repeat(32),
        declaredMime: 'text/html', declaredContentLength: 10, detectedMime: null,
        detectedFormat: null, sourceContentLength: 10, policyRevision: 'm9p-preview-v2',
        rendererRevision: 'test-v1', pngSha256: null, pngWidth: null,
        pngHeight: null, pngByteLength: null,
      },
    }];
    vi.mocked(h.mock.service.providerPrepareTransfer).mockResolvedValue(base);

    const page = fakePort();
    h.controller.attach(page.port, authority);
    const connectNonce = '123e4567-e89b-42d3-a456-426614174052';
    page.send(request('wallet_connect', connectNonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: connectNonce, approved: true,
    });
    h.mock.grants[0]!.scope.categories.push('balance');

    const firstNonce = '123e4567-e89b-42d3-a456-426614174053';
    page.send(request('sendTransfer', firstNonce, {
      recipients: [{ address: 'tb1qrecipientaddress', amount: 10_000 }],
    }));
    await tick();
    const snapshot = await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'snapshot',
    });
    expect(snapshot.request?.details).toMatchObject({
      effectCount: 1,
      requiresPreviewAcknowledgement: true,
      inscriptions: [{ inscriptionId, preview: { kind: 'placeholder', reason: 'active_content' } }],
    });
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: firstNonce, approved: true,
    });
    expect(h.mock.service.providerBroadcastPreparedPsbt).not.toHaveBeenCalled();
    expect(JSON.stringify(page.messages.at(-1))).toContain('ERR_UNSUPPORTED_BY_ACCOUNT');

    const secondNonce = '123e4567-e89b-42d3-a456-426614174054';
    page.send(request('sendTransfer', secondNonce, {
      recipients: [{ address: 'tb1qrecipientaddress', amount: 10_000 }],
    }));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: secondNonce, approved: true, previewUnavailableAcknowledged: true,
    });
    expect(h.mock.service.providerBroadcastPreparedPsbt).toHaveBeenCalledOnce();
  });

  it('returns permissions only for the active vault/network/account tuple', async () => {
    const h = harness();
    const page = fakePort();
    h.controller.attach(page.port, authority);
    const connectNonce = '123e4567-e89b-42d3-a456-426614174038';
    page.send(request('wallet_connect', connectNonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: connectNonce, approved: true,
    });
    h.mock.grants.push({
      version: 1, kind: 'grant', eventId: '92'.repeat(16), resourceId: '93'.repeat(16), occurredAtMs: 2,
      scope: {
        origin: authority.origin, network: 'signet', vaultId: 'vault-1', account: 1,
        categories: ['balance'],
      },
    });
    page.messages.length = 0;

    page.send(request(
      'wallet_getCurrentPermissions',
      '123e4567-e89b-42d3-a456-426614174039',
      null,
    ));
    await tick();

    expect(JSON.stringify(page.messages)).not.toContain('balance');
    expect(JSON.stringify(page.messages)).not.toContain('93'.repeat(16));
  });

  it.each(['wallet_disconnect', 'wallet_renouncePermissions'] as const)(
    'uses the atomic origin revocation API for %s',
    async (method) => {
      const h = harness();
      const page = fakePort();
      h.controller.attach(page.port, authority);
      const connectNonce = '123e4567-e89b-42d3-a456-426614174042';
      page.send(request('wallet_connect', connectNonce, null));
      await tick();
      await h.controller.approvalCommand({
        type: 'drey:approval', protocolVersion: 1, command: 'resolve',
        requestNonce: connectNonce, approved: true,
      });
      page.messages.length = 0;
      page.send(request(method, '123e4567-e89b-42d3-a456-426614174043', null));
      await tick();

      expect(h.mock.service.providerRevokeOrigin).toHaveBeenCalledWith(authority.origin);
      expect(page.messages[0]).toEqual(expect.objectContaining({
        type: 'drey:provider:event',
        event: 'disconnect',
        data: { type: 'disconnect' },
      }));
      expect(page.messages.at(-1)).toEqual(expect.objectContaining({ ok: true, result: null }));
    },
  );

  it.each(['wallet_disconnect', 'wallet_renouncePermissions'] as const)(
    'makes unconnected %s idempotent without consulting lock-sensitive state',
    async (method) => {
      const h = harness();
      h.mock.service.providerAccountView = vi.fn(async () => {
        throw new Error('locked');
      });
      const page = fakePort();
      h.controller.attach(page.port, authority);

      page.send(request(method, '123e4567-e89b-42d3-a456-426614174117', null));
      await tick();

      expect(page.messages).toEqual([expect.objectContaining({ ok: true, result: null })]);
      expect(h.mock.service.providerAccountView).not.toHaveBeenCalled();
      expect(h.mock.service.providerRevokeOrigin).not.toHaveBeenCalled();
    },
  );

  it('restores a same-document connection after a worker restart', async () => {
    const area = fakeArea();
    const first = harness(area);
    const page = fakePort();
    first.controller.attach(page.port, authority);
    const nonce = '123e4567-e89b-42d3-a456-426614174040';
    page.send(request('wallet_connect', nonce, null));
    await tick();
    await first.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve', requestNonce: nonce, approved: true,
    });

    const second = new ProviderController({
      service: first.mock.service, sessionStorage: area, now: () => 1_800_000_000_100,
      requestUnlock: async () => true,
      openOrFocusApproval: async () => undefined, closeApproval: async () => undefined,
      openCommunityVaultSetup: async () => undefined,
    });
    const reloadedWorkerPort = fakePort();
    second.attach(reloadedWorkerPort.port, authority);
    reloadedWorkerPort.send(request('wallet_getAccount', '123e4567-e89b-42d3-a456-426614174041', null));
    await tick();
    expect(reloadedWorkerPort.messages).toContainEqual(expect.objectContaining({ ok: true }));
  });

  it('cannot restore a pre-lock connection after a lock races worker initialization', async () => {
    const key = 'squirrel:provider:connections:v1';
    const data = new Map<string, unknown>([[key, [{
      origin: authority.origin,
      tabId: authority.tabId,
      frameId: authority.frameId,
      documentId: authority.documentId,
      vaultId: 'vault-1',
      sessionId: '123e4567-e89b-42d3-a456-426614174001',
      accountId: `acct_signet_${'1'.repeat(64)}`,
      account: 0,
      addressPurposes: ['ordinals', 'payment'],
      connectedAt: 1_800_000_000_000,
    }]]]);
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
    const area = {
      data,
      get: async (keys: string | string[]) => {
        const snapshot = Object.fromEntries(
          (Array.isArray(keys) ? keys : [keys]).map((item) => [item, data.get(item)]),
        );
        await loadGate;
        return snapshot;
      },
      set: async (items: Record<string, unknown>) => {
        for (const [item, value] of Object.entries(items)) data.set(item, value);
      },
      remove: async (keys: string | string[]) => {
        for (const item of Array.isArray(keys) ? keys : [keys]) data.delete(item);
      },
    };
    const h = harness(area);
    const page = fakePort();
    h.controller.attach(page.port, authority);

    const invalidated = h.controller.invalidateSession();
    await tick();
    releaseLoad();
    await invalidated;

    page.send(request('wallet_getAccount', '123e4567-e89b-42d3-a456-426614174107', null));
    await tick();
    expect(page.messages.at(-1)).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ data: { dreyCode: 'ERR_NOT_CONNECTED' } }),
    }));
    expect(data.get(key)).toEqual([]);
  });

  it('bounds restored document authority records under hostile frame churn', async () => {
    const key = 'squirrel:provider:connections:v1';
    const records = Array.from({ length: 129 }, (_, index) => ({
      origin: authority.origin,
      tabId: authority.tabId,
      frameId: index,
      documentId: index.toString(16).padStart(32, '0'),
      vaultId: 'vault-1',
      sessionId: '123e4567-e89b-42d3-a456-426614174001',
      accountId: `acct_signet_${'1'.repeat(64)}`,
      account: 0,
      addressPurposes: ['ordinals', 'payment'],
      connectedAt: 1_800_000_000_000 + index,
    }));
    const area = fakeArea();
    area.data.set(key, records);
    const h = harness(area);
    const overflow = fakePort();
    h.controller.attach(overflow.port, {
      ...authority,
      frameId: 128,
      documentId: records[128]!.documentId,
    });

    overflow.send(request('wallet_getAccount', '123e4567-e89b-42d3-a456-426614174118', null));
    await tick();

    expect(overflow.messages.at(-1)).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ data: { dreyCode: 'ERR_NOT_CONNECTED' } }),
    }));
  });

  it('restores a same-document connection after its content-script Port rotates', async () => {
    const h = harness();
    const firstPort = fakePort();
    h.controller.attach(firstPort.port, authority);
    const nonce = '123e4567-e89b-42d3-a456-426614174044';
    firstPort.send(request('wallet_connect', nonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve', requestNonce: nonce, approved: true,
    });

    firstPort.port.disconnect();
    const replacement = fakePort();
    h.controller.attach(replacement.port, authority);
    replacement.send(request('wallet_getAccount', '123e4567-e89b-42d3-a456-426614174045', null));
    await tick();
    expect(replacement.messages).toContainEqual(expect.objectContaining({ ok: true }));
  });

  it('binds a connection to the exact origin, frame, and document lifecycle', async () => {
    const h = harness();
    const top = fakePort();
    h.controller.attach(top.port, authority);
    const connectNonce = '123e4567-e89b-42d3-a456-426614174046';
    top.send(request('wallet_connect', connectNonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: connectNonce, approved: true,
    });

    const variants = [
      { ...authority, frameId: 1, documentId: '123e4567-e89b-42d3-a456-426614174101' },
      { ...authority, documentId: '123e4567-e89b-42d3-a456-426614174102' },
      {
        ...authority,
        origin: 'https://other.example',
        url: 'https://other.example/app',
        documentId: '123e4567-e89b-42d3-a456-426614174103',
      },
    ];
    for (const [index, variant] of variants.entries()) {
      const isolated = fakePort();
      h.controller.attach(isolated.port, variant);
      isolated.send(request(
        'wallet_getAccount',
        `123e4567-e89b-42d3-a456-4266141741${String(index).padStart(2, '0')}`,
        null,
      ));
      await tick();
      expect(isolated.messages.at(-1)).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ data: { dreyCode: 'ERR_NOT_CONNECTED' } }),
      }));
    }
  });

  it('rejects an in-flight frame request when that frame is removed', async () => {
    const h = harness();
    const frame = fakePort();
    const frameAuthority = {
      ...authority,
      frameId: 2,
      documentId: '123e4567-e89b-42d3-a456-426614174104',
    };
    h.controller.attach(frame.port, frameAuthority);
    const nonce = '123e4567-e89b-42d3-a456-426614174047';
    frame.send(request('wallet_connect', nonce, null));
    await tick();
    expect((await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'snapshot',
    })).request?.requestNonce).toBe(nonce);

    frame.port.disconnect();
    await tick();

    // The browser rejects the page-side Promise when the Port disconnects; the
    // dead frame cannot receive a redundant worker error message.
    expect(frame.messages).toHaveLength(0);
    expect((await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'snapshot',
    })).request).toBeNull();
  });

  it('invalidates the exact origin after settings-driven permission revocation', async () => {
    const h = harness();
    const page = fakePort();
    const observer = fakePort();
    h.controller.attach(page.port, authority);
    h.controller.attach(observer.port, {
      ...authority,
      frameId: 10,
      documentId: '123e4567-e89b-42d3-a456-426614174110',
    });
    const connectNonce = '123e4567-e89b-42d3-a456-426614174050';
    page.send(request('wallet_connect', connectNonce, null));
    await tick();
    await h.controller.approvalCommand({
      type: 'drey:approval', protocolVersion: 1, command: 'resolve',
      requestNonce: connectNonce, approved: true,
    });
    page.messages.length = 0;

    await h.controller.permissionsRevoked(authority.origin);
    page.send(request('wallet_getAccount', '123e4567-e89b-42d3-a456-426614174051', null));
    await tick();

    expect(page.messages[0]).toEqual(expect.objectContaining({
      type: 'drey:provider:event', event: 'disconnect',
      data: { type: 'disconnect' },
    }));
    expect(page.messages[1]).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ data: { dreyCode: 'ERR_NOT_CONNECTED' } }),
    }));
    expect(observer.messages).toEqual([]);
    expect(JSON.stringify(page.messages)).not.toContain('tb1qpaymentaddress');
  });
});
