import { bip322MessageHash } from '@drey/core/domain/transactions/bip322';
import { base64ToBytes, bytesToBase64, bytesToHex, hexToBytes } from '@drey/core/domain/vault/encoding';
import { RpcError } from './errors';
import { VaultError } from '@drey/core/domain/vault/errors';
import type { WalletService } from './wallet-service';
import {
  evaluatePhishingOrigin,
  type PhishingDecision,
} from '@drey/core/domain/provider/phishing';
import {
  PACKAGED_PHISHING_LIST_BYTES,
  PHISHING_LIST_PUBLIC_KEY_HEX,
} from '@drey/core/domain/provider/packaged-phishing-list';
import type { PermissionDataCategory } from '@drey/core/domain/provider/permission-journal';
import type { StorageArea } from '../adapters/storage/area';
import {
  PROVIDER_BRIDGE_VERSION,
  runtimeProviderRequestSchema,
  type ProviderRuntimePort,
  type RuntimeProviderRequest,
  type RuntimeProviderResponse,
} from '../provider/bridge';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS_ERROR,
  providerError,
  type BridgeJsonRpcError,
} from '@drey/core/provider/errors';
import {
  isProviderMethod,
  normalizeProviderConnectionRequest,
  PROVIDER_METHODS,
  PROVIDER_OPERATIONS,
  providerNetworkResult,
  type AddressPurpose,
  type DataCategory,
  type ProviderConnectParams,
  type ProviderMethod,
} from '@drey/core/provider/registry';
import type { ProviderAuthority } from '../provider/authority';
import type { ApprovalCommand, ApprovalSnapshot } from '../provider/approval';
import {
  providerPsbtPlanPreviews,
  type ProviderPsbtPlanV3,
} from '@drey/core/domain/transactions/provider-psbt';
import {
  approvalInscriptionItems,
  assertPreviewAcknowledged,
  requiresPreviewAcknowledgement,
} from '@drey/core/domain/transactions/inscription-previews';
import { MarketplaceProviderError } from '@drey/core/domain/marketplaces/errors';
import {
  inspectMarketplacePsbt,
  resolveMarketplaceRequest,
  type MarketplacePsbtCandidate,
} from '@drey/core/domain/marketplaces/resolver';
import type { MarketplaceContext, MarketplaceResolution } from '@drey/core/domain/marketplaces/types';
import {
  reviewCommunityVaultAcquisitionProviderRequest,
  type CommunityVaultAcquisitionProviderContextV1,
  type CommunityVaultAcquisitionProviderReviewV1,
} from '@drey/core/domain/community-vault/acquisition-provider';
import { COMMUNITY_VAULT_MAX_PREFLIGHT_AGE_MS } from '@drey/core/domain/community-vault/acquisition-contracts';
import {
  reviewCommunityVaultSaleBuyerProviderRequest,
  reviewCommunityVaultSaleProviderRequest,
  type CommunityVaultSaleBuyerProviderContextV1,
  type CommunityVaultSaleBuyerProviderReviewV1,
  type CommunityVaultSaleProviderContextV1,
  type CommunityVaultSaleProviderReviewV1,
} from '@drey/core/domain/community-vault/sale-provider';
import { COMMUNITY_VAULT_SALE_MAX_PREFLIGHT_AGE_MS } from '@drey/core/domain/community-vault/sale-contracts';

const CONNECTIONS_KEY = 'squirrel:provider:connections:v1';
const REQUEST_TTL_MS = 5 * 60_000;
export const APPROVAL_SWITCH_COOLDOWN_MS = 750;
const MAX_PER_ORIGIN = 5;
const MAX_TOTAL = 10;
const MAX_CONNECTIONS = 128;
const PHISHING_DECISION_CACHE_MS = 60_000;

interface ConnectionRecord {
  origin: string;
  tabId: number;
  frameId: number;
  documentId: string;
  vaultId: string;
  sessionId: string;
  accountId: string;
  account: number;
  addressPurposes: AddressPurpose[];
  connectedAt: number;
}

interface PortState {
  port: ProviderRuntimePort;
  authority: ProviderAuthority;
  alive: boolean;
  nonces: Set<string>;
}

interface PendingApproval {
  state: PortState;
  request: RuntimeProviderRequest;
  method: ProviderMethod;
  params: unknown;
  phishing: PhishingDecision;
  createdAt: number;
  approveAfter: number;
  expectedVaultId: string;
  expectedWalletName: string;
  expectedSessionId: string;
  expectedAccountId: string;
  expectedAccount: number;
  expectedNetwork: 'mainnet' | 'signet';
  approvalGeneration: number;
  contextGeneration: number;
  preparedPsbt?: ProviderPsbtPlanV3;
  marketplace?: {
    context: MarketplaceContext;
    resolution: MarketplaceResolution;
    candidate?: MarketplacePsbtCandidate;
    selectedInputIndexes?: number[];
  };
  communityVaultAcquisition?: {
    context: CommunityVaultAcquisitionProviderContextV1;
    review: CommunityVaultAcquisitionProviderReviewV1;
  };
  communityVaultSale?: {
    context: CommunityVaultSaleProviderContextV1;
    review: CommunityVaultSaleProviderReviewV1;
  };
  communityVaultSaleBuyer?: {
    context: CommunityVaultSaleBuyerProviderContextV1;
    review: CommunityVaultSaleBuyerProviderReviewV1;
  };
  /** §21.1 flexible request without marketplace context; core analysis must prove the listing shape. */
  genericListingCandidate?: boolean;
  approvalError?: string;
}

class ProviderConnectionLimitError extends Error {
  constructor() {
    super('provider connection limit reached');
    this.name = 'ProviderConnectionLimitError';
  }
}

export interface ProviderControllerDeps {
  service: WalletService;
  sessionStorage: StorageArea;
  now: () => number;
  requestUnlock: () => Promise<boolean>;
  openOrFocusApproval: () => Promise<void>;
  closeApproval: () => Promise<void>;
  openCommunityVaultSetup: (input: {
    campaignId: string;
    ownerId: string;
    label?: string;
  }) => Promise<void>;
  approvalChanged?: (snapshot: ApprovalSnapshot) => void;
  evaluatePhishing?: (origin: string) => PhishingDecision;
}

function authorityKey(authority: ProviderAuthority): string | null {
  return authority.documentId === null
    ? null
    : `${authority.origin}|${authority.tabId}|${authority.frameId}|${authority.documentId}`;
}

function mapCategories(categories: readonly DataCategory[]): PermissionDataCategory[] {
  return [...new Set(categories)].sort() as PermissionDataCategory[];
}

function mapRequestedCategories(
  categories: ReadonlyArray<'account' | 'addresses' | 'balance' | 'inscriptions' | 'network'>,
): PermissionDataCategory[] {
  return [...new Set(categories.map((category) => category === 'account' ? 'account_identity' : category))]
    .sort() as PermissionDataCategory[];
}

function providerNetwork(network: 'mainnet' | 'signet'): 'Mainnet' | 'Signet' {
  return network === 'mainnet' ? 'Mainnet' : 'Signet';
}

function providerAddresses(
  account: Awaited<ReturnType<WalletService['providerAccountView']>>,
) {
  return [
    {
      address: account.payment.address,
      publicKey: account.payment.publicKeyHex,
      purpose: 'payment' as const,
      addressType: 'p2wpkh' as const,
      walletType: 'software' as const,
    },
    {
      address: account.ordinals.address,
      publicKey: account.ordinals.publicKeyHex.slice(2),
      purpose: 'ordinals' as const,
      addressType: 'p2tr' as const,
      walletType: 'software' as const,
    },
  ];
}

type ConnectParams = ProviderConnectParams;

export class ProviderController {
  private ports = new Set<PortState>();
  private queue: PendingApproval[] = [];
  private active: PendingApproval | null = null;
  private connections = new Map<string, ConnectionRecord>();
  private ready: Promise<void>;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private preparingTotal = 0;
  private preparingByOrigin = new Map<string, number>();
  private phishingDecisions = new Map<string, { checkedAt: number; decision: PhishingDecision }>();
  private approvalTail: Promise<void> = Promise.resolve();
  private approvalGeneration = 0;
  private contextGeneration = 0;

  constructor(private readonly deps: ProviderControllerDeps) {
    this.ready = this.loadConnections();
  }

  attach(
    port: ProviderRuntimePort,
    authority: ProviderAuthority,
    initialMessages: readonly unknown[] = [],
  ): () => void {
    const state: PortState = { port, authority, alive: true, nonces: new Set() };
    this.ports.add(state);
    const onMessage = (raw: unknown): void => {
      void this.receive(state, raw);
    };
    const disconnect = (): void => {
      if (!state.alive) return;
      state.alive = false;
      this.ports.delete(state);
      void this.withApprovalLock(() => this.rejectWhere(
        (pending) => pending.state === state,
        providerError('ERR_STALE_CONTEXT'),
      ));
      // A same-document History API transition intentionally rotates the Port.
      // Keep the connection bound to its tab/frame/document tuple so the
      // replacement Port can reconnect. A new document gets a new documentId;
      // explicit disconnect, revoke, lock, or session change still clears it.
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(disconnect);
    for (const message of initialMessages) onMessage(message);
    return () => {
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(disconnect);
      disconnect();
    };
  }

  async approvalCommand(command: ApprovalCommand): Promise<ApprovalSnapshot> {
    return this.withApprovalLock(() => this.handleApprovalCommand(command));
  }

  private async handleApprovalCommand(command: ApprovalCommand): Promise<ApprovalSnapshot> {
    await this.ready;
    await this.expireRequests();
    if (command.command === 'snapshot') return this.snapshot();
    if (!this.active || this.active.request.requestNonce !== command.requestNonce) return this.snapshot();
    const pending = this.active;
    if (command.command === 'setFee') {
      try {
        await this.revalidate(pending);
        pending.preparedPsbt = await this.prepareTransaction(pending, command.feeRateSatPerVb);
        delete pending.approvalError;
      } catch {
        pending.approvalError = 'Unable to prepare that fee rate safely.';
      }
      this.publishApproval();
      return this.snapshot();
    }
    if (!command.approved) {
      this.respondError(pending, providerError('ERR_USER_REJECTED'));
      await this.advance();
      return this.snapshot();
    }
    if (this.deps.now() < pending.approveAfter) return this.snapshot();
    try {
      await this.revalidate(pending);
      if (pending.preparedPsbt) {
        const previews = providerPsbtPlanPreviews(pending.preparedPsbt);
        try {
          assertPreviewAcknowledged(previews, command.previewUnavailableAcknowledged);
        } catch (error) {
          throw new RpcError('ERR_UNSAFE_TRANSACTION', (error as Error).message);
        }
      }
      const passwordRequired = pending.preparedPsbt?.requiresAdvanced === true || pending.communityVaultSale !== undefined;
      if (passwordRequired) {
        // Unreachable from the approval surface, which disables Approve until
        // both fields validate. A command that arrives without them did not come
        // from that surface, so it stays terminal.
        if ((pending.preparedPsbt?.requiresAdvanced === true && command.confirmation !== 'SIGN PSBT') || !command.password) {
          throw new RpcError('ERR_WRONG_PASSWORD', 'Transaction password confirmation required');
        }
        try {
          await this.deps.service.providerReauthenticate(command.password);
        } catch (error) {
          if (error instanceof VaultError && error.code === 'wrong-password') {
            // A mistyped password is ordinary user error, not grounds to destroy
            // the request. Terminating it errors the page -- and since VaultError
            // never matches mapError's RpcError branch, it errors it with a bare
            // internal error -- so the dApp must re-request under a new nonce for
            // a user who was actively trying to approve. Surface it here instead,
            // the way setFee surfaces an unusable fee rate, and leave the request
            // active to retry. Nothing is relaxed: the password is still
            // required, the revalidate below still rebinds every authority before
            // execution, and the request TTL still bounds retries.
            pending.approvalError = 'That password is incorrect.';
            this.publishApproval();
            return this.snapshot();
          }
          throw error;
        }
      }
      // Reauthentication touches storage and yields to other lifecycle events.
      // Rebind every authority and permission immediately before execution.
      await this.revalidate(pending);
      const result = await this.executeApproved(pending, command.password);
      const delivered = this.respondResult(pending, result);
      if (delivered && pending.preparedPsbt?.marketplace) {
        await this.deps.service.providerMarkMarketplaceDelivered(pending.preparedPsbt).catch(() => undefined);
      }
    } catch (error) {
      this.respondError(pending,
        pending.marketplace && error instanceof RpcError && error.code === 'ERR_PLAN_CHANGED'
          ? providerError('ERR_MARKETPLACE_STATE_CHANGED')
          : this.mapError(error));
    }
    await this.advance();
    return this.snapshot();
  }

  async approvalWindowClosed(): Promise<void> {
    this.approvalGeneration += 1;
    await this.withApprovalLock(async () => {
      this.clearExpiryTimer();
      this.rejectAll(providerError('ERR_USER_REJECTED'));
    });
  }

  async invalidateSession(): Promise<void> {
    this.contextGeneration += 1;
    // A lock/session change can arrive while an MV3 worker is still restoring
    // session-backed document connections. Let that restore finish before
    // clearing it so a late load cannot resurrect pre-lock authority in memory.
    await this.ready;
    await this.withApprovalLock(async () => {
      const connectedStates = this.connectedPortStates();
      this.connections.clear();
      await this.saveConnections();
      this.rejectAll(providerError('ERR_STALE_CONTEXT'));
      for (const state of connectedStates) {
        this.safePost(state, {
          type: 'drey:provider:event',
          protocolVersion: PROVIDER_BRIDGE_VERSION,
          event: 'disconnect',
          data: { type: 'disconnect' },
        });
      }
    });
  }

  async accountChanged(accountId: string, account: number): Promise<void> {
    this.contextGeneration += 1;
    await this.ready;
    await this.withApprovalLock(async () => {
      await this.rejectWhere(() => true, providerError('ERR_STALE_CONTEXT'));
      const accountView = await this.deps.service.providerAccountView().catch(() => null);
      if (!accountView || accountView.accountId !== accountId || accountView.account !== account) {
        this.connections.clear();
      } else {
        for (const connection of this.connections.values()) {
          connection.accountId = accountId;
          connection.account = account;
        }
      }
      await this.saveConnections();
      for (const state of this.ports) {
        if (!state.alive) continue;
        const connected = accountView ? await this.liveConnection(state, accountView) : false;
        // Provider events are account state. A merely injected document has no
        // authority to observe their timing, even when its origin has a grant
        // that another document used.
        if (!connected) continue;
        const permitted = connected
          ? await this.deps.service.providerHasPermission(state.authority.origin, ['addresses'])
          : false;
        const addresses = permitted && accountView
          ? providerAddresses(accountView).filter((item) =>
              this.hasAddressPurposes(state, [item.purpose]))
          : undefined;
        this.safePost(state, {
          type: 'drey:provider:event',
          protocolVersion: PROVIDER_BRIDGE_VERSION,
          event: 'accountChange',
          data: {
            type: 'accountChange',
            ...(addresses === undefined ? {} : { addresses }),
          },
        });
      }
    });
  }

  async permissionsRevoked(origin: string): Promise<void> {
    this.contextGeneration += 1;
    await this.ready;
    await this.withApprovalLock(async () => {
      await this.rejectWhere(
        (pending) => pending.state.authority.origin === origin,
        providerError('ERR_STALE_CONTEXT'),
      );
      const connectedStates = this.connectedPortStates(origin);
      let changed = false;
      for (const [key, connection] of this.connections) {
        if (connection.origin !== origin) continue;
        this.connections.delete(key);
        changed = true;
      }
      if (changed) await this.saveConnections();
      for (const state of connectedStates) {
        this.safePost(state, {
          type: 'drey:provider:event',
          protocolVersion: PROVIDER_BRIDGE_VERSION,
          event: 'disconnect',
          data: { type: 'disconnect' },
        });
      }
    });
  }

  private async receive(state: PortState, raw: unknown): Promise<void> {
    await this.ready;
    const parsed = runtimeProviderRequestSchema.safeParse(raw);
    if (!parsed.success || !state.alive) return;
    const request = parsed.data;
    if (state.nonces.has(request.requestNonce)) {
      this.postError(state, request.requestNonce, providerError('ERR_STALE_CONTEXT'));
      return;
    }
    state.nonces.add(request.requestNonce);
    if (!isProviderMethod(request.method)) {
      this.postError(state, request.requestNonce, providerError('ERR_UNSUPPORTED_METHOD'));
      state.nonces.delete(request.requestNonce);
      return;
    }
    const method = request.method;
    const spec = PROVIDER_OPERATIONS[method];
    const params = spec.request.safeParse(request.params);
    if (!params.success) {
      this.postError(state, request.requestNonce, INVALID_PARAMS_ERROR);
      state.nonces.delete(request.requestNonce);
      return;
    }
    const phishing = this.phishingDecision(state.authority.origin);
    if (phishing.action === 'block') {
      this.postError(state, request.requestNonce, providerError('ERR_PHISHING_BLOCKED'));
      state.nonces.delete(request.requestNonce);
      return;
    }
    let preparationReserved = false;
    try {
      if (method === 'wallet_disconnect' || method === 'wallet_renouncePermissions') {
        // Both methods are idempotent for an unconnected document. Checking the
        // exact live binding first also prevents their success/error result from
        // becoming a lock-state oracle when the encrypted grant journal cannot
        // be opened. A connected document still performs durable revocation.
        if (!(await this.liveConnection(state))) {
          this.postResult(state, request.requestNonce, null);
          return;
        }
        await this.disconnectOrigin(state.authority.origin);
        this.postResult(state, request.requestNonce, null);
        return;
      }
      if (method === 'wallet_getCurrentPermissions') {
        const account = await this.deps.service.providerAccountView().catch(() => null);
        const connected = account ? await this.liveConnection(state, account) : false;
        this.postResult(state, request.requestNonce,
          connected && account ? await this.permissionResults(state.authority.origin, account) : []);
        return;
      }
      if (method === 'getInfo') {
        this.postResult(state, request.requestNonce, await this.executeRead(method, params.data, state));
        return;
      }
      if (method === 'wallet_connect' && (await this.deps.service.sessionStatus()).locked) {
        if (this.totalPending() + this.preparingTotal >= MAX_TOTAL ||
            this.originPending(state.authority.origin) + this.originPreparing(state.authority.origin) >= MAX_PER_ORIGIN) {
          this.postError(state, request.requestNonce, providerError('ERR_QUEUE_FULL'));
          return;
        }
        const unlockRequestedAt = this.deps.now();
        this.reservePreparation(state.authority.origin);
        preparationReserved = true;
        const unlocked = await this.deps.requestUnlock();
        if (!state.alive) return;
        if (this.deps.now() >= unlockRequestedAt + REQUEST_TTL_MS) {
          this.postError(state, request.requestNonce, providerError('ERR_REQUEST_EXPIRED'));
          return;
        }
        if (!unlocked) {
          this.postError(state, request.requestNonce, providerError('ERR_USER_REJECTED'));
          return;
        }
        this.releasePreparation(state.authority.origin);
        preparationReserved = false;
      }
      // Unconnected read methods must not become a wallet lock-state oracle.
      // Check the exact browser document binding before touching live account
      // state; interactive connect/permission requests remain free to surface
      // an actionable locked error.
      if (spec.requiresConnection && this.connectionFor(state) === null) {
        this.postError(state, request.requestNonce, providerError('ERR_NOT_CONNECTED'));
        return;
      }
      const account = await this.deps.service.providerAccountView();
      if (method === 'wallet_connect') {
        const requestedNetwork = (params.data as ConnectParams)?.network;
        if (requestedNetwork !== undefined && requestedNetwork !== providerNetwork(account.network)) {
          this.postError(state, request.requestNonce, providerError('ERR_UNSUPPORTED_BY_ACCOUNT'));
          return;
        }
        const requested = normalizeProviderConnectionRequest(params.data as ConnectParams);
        if (phishing.action === 'allow' &&
            await this.deps.service.providerHasExactPermission(state.authority.origin, requested.categories) &&
            this.hasAddressPurposes(state, requested.purposes)) {
          await this.connect(state, account, requested.purposes);
          const result = await this.executeRead(
            'wallet_getAccount',
            { purposes: requested.purposes },
            state,
          );
          this.postResult(state, request.requestNonce, result);
          return;
        }
      }
      if (spec.requiresConnection && !(await this.liveConnection(state, account))) {
        this.postError(state, request.requestNonce, providerError('ERR_NOT_CONNECTED'));
        return;
      }
      if (method === 'drey_openCommunityVault') {
        await this.deps.openCommunityVaultSetup(
          params.data as { campaignId: string; ownerId: string; label?: string },
        );
        this.postResult(state, request.requestNonce, null);
        return;
      }
      const required = mapCategories(spec.dataCategories);
      if (method !== 'wallet_connect' && method !== 'wallet_requestPermissions' && required.length > 0 &&
          !(await this.deps.service.providerHasPermission(state.authority.origin, required))) {
        this.postError(state, request.requestNonce, providerError('ERR_NO_ACCOUNT'));
        return;
      }
      if ((method === 'getAddresses' || method === 'getAccounts') &&
          !this.hasAddressPurposes(
            state,
            (params.data as { purposes: AddressPurpose[] }).purposes,
          )) {
        this.postError(state, request.requestNonce, providerError('ERR_NO_ACCOUNT'));
        return;
      }
      if (!spec.requiresFreshApproval) {
        this.postResult(state, request.requestNonce, await this.executeRead(method, params.data, state));
        return;
      }
      if (this.totalPending() + this.preparingTotal >= MAX_TOTAL ||
          this.originPending(state.authority.origin) + this.originPreparing(state.authority.origin) >= MAX_PER_ORIGIN) {
        this.postError(state, request.requestNonce, providerError('ERR_QUEUE_FULL'));
        return;
      }
      this.reservePreparation(state.authority.origin);
      preparationReserved = true;
      const pending: PendingApproval = {
        state,
        request,
        method,
        params: params.data,
        phishing,
        createdAt: this.deps.now(),
        approveAfter: 0,
        expectedVaultId: account.vaultId,
        expectedWalletName: account.vaultName,
        expectedSessionId: account.sessionId,
        expectedAccountId: account.accountId,
        expectedAccount: account.account,
        expectedNetwork: account.network,
        approvalGeneration: this.approvalGeneration,
        contextGeneration: this.contextGeneration,
      };
      if (method === 'signPsbt') {
        const psbtParams = params.data as {
          psbt: string;
          signInputs?: Record<string, number[]>;
          marketplaceContext?: MarketplaceContext;
          communityVaultAcquisitionContext?: CommunityVaultAcquisitionProviderContextV1;
          communityVaultSaleContext?: CommunityVaultSaleProviderContextV1;
          communityVaultSaleBuyerContext?: CommunityVaultSaleBuyerProviderContextV1;
        };
        const candidate = inspectMarketplacePsbt(psbtParams.psbt);
        const selectedInputIndexes = psbtParams.signInputs
          ? Object.values(psbtParams.signInputs).flat()
          : undefined;
        if (psbtParams.communityVaultAcquisitionContext) {
          if (selectedInputIndexes === undefined) {
            throw new RpcError('ERR_INVALID_PAYLOAD', 'Community Vault acquisition inputs are required');
          }
          const review = reviewCommunityVaultAcquisitionProviderRequest({
            context: psbtParams.communityVaultAcquisitionContext,
            psbtHex: bytesToHex(base64ToBytes(psbtParams.psbt)),
            selectedInputIndexes,
            nowMs: String(this.deps.now()),
          });
          pending.communityVaultAcquisition = {
            context: psbtParams.communityVaultAcquisitionContext,
            review,
          };
        }
        if (psbtParams.communityVaultSaleContext) {
          if (psbtParams.communityVaultAcquisitionContext || psbtParams.marketplaceContext ||
              psbtParams.communityVaultSaleBuyerContext) {
            throw new RpcError('ERR_INVALID_PAYLOAD', 'Community Vault contexts cannot be combined');
          }
          if (selectedInputIndexes === undefined) {
            throw new RpcError('ERR_INVALID_PAYLOAD', 'Community Vault sale input is required');
          }
          const review = reviewCommunityVaultSaleProviderRequest({
            context: psbtParams.communityVaultSaleContext,
            psbtHex: bytesToHex(base64ToBytes(psbtParams.psbt)),
            selectedInputIndexes,
            nowMs: String(this.deps.now()),
          });
          pending.communityVaultSale = {
            context: psbtParams.communityVaultSaleContext,
            review,
          };
        }
        if (psbtParams.communityVaultSaleBuyerContext) {
          if (psbtParams.communityVaultAcquisitionContext || psbtParams.marketplaceContext ||
              psbtParams.communityVaultSaleContext) {
            throw new RpcError('ERR_INVALID_PAYLOAD', 'Community Vault contexts cannot be combined');
          }
          if (selectedInputIndexes === undefined) {
            throw new RpcError('ERR_INVALID_PAYLOAD', 'Community Vault buyer inputs are required');
          }
          const review = reviewCommunityVaultSaleBuyerProviderRequest({
            context: psbtParams.communityVaultSaleBuyerContext,
            psbtHex: bytesToHex(base64ToBytes(psbtParams.psbt)),
            selectedInputIndexes,
            nowMs: String(this.deps.now()),
          });
          pending.communityVaultSaleBuyer = {
            context: psbtParams.communityVaultSaleBuyerContext,
            review,
          };
        }
        const resolution = resolveMarketplaceRequest({
          origin: state.authority.origin,
          network: account.network,
          method: 'signPsbt',
          candidate,
          ...(selectedInputIndexes === undefined ? {} : { selectedInputIndexes }),
          ...(psbtParams.marketplaceContext === undefined ? {} : { context: psbtParams.marketplaceContext }),
        });
        const selectedFlexible = selectedInputIndexes === undefined
          ? candidate.flexible
          : candidate.flexibleInputIndexes.some((index) => selectedInputIndexes.includes(index));
        if (resolution.status !== 'recognized' && psbtParams.marketplaceContext !== undefined) {
          throw new MarketplaceProviderError(
            resolution.status === 'unknown_marketplace' ? 'ERR_UNSUPPORTED_MARKETPLACE' : 'ERR_UNSUPPORTED_TEMPLATE',
            resolution.reason,
          );
        }
        if (resolution.status !== 'recognized' && selectedFlexible) {
          // §21.1 generic listing: without marketplace context, a flexible
          // request proceeds to core analysis, which rejects every flexible
          // shape except the proven listing invariants (wallet-owned payout at
          // or above the listed value, no value loss, no rare-sat/unsupported
          // inputs, no script path).
          pending.genericListingCandidate = true;
        }
        if (resolution.status === 'recognized' && psbtParams.marketplaceContext) {
          pending.marketplace = {
            context: psbtParams.marketplaceContext,
            resolution,
            candidate,
            ...(selectedInputIndexes
              ? { selectedInputIndexes }
              : {}),
          };
        }
      } else if (method === 'signMessage') {
        const messageParams = params.data as { marketplaceContext?: MarketplaceContext };
        if (messageParams.marketplaceContext) {
          const resolution = resolveMarketplaceRequest({
            origin: state.authority.origin,
            network: account.network,
            method: 'signMessage',
            context: messageParams.marketplaceContext,
          });
          if (resolution.status !== 'recognized') {
            throw new MarketplaceProviderError(
              resolution.status === 'unknown_marketplace' ? 'ERR_UNSUPPORTED_MARKETPLACE' : 'ERR_UNSUPPORTED_TEMPLATE',
              resolution.reason,
            );
          }
          pending.marketplace = { context: messageParams.marketplaceContext, resolution };
        }
      }
      if (method === 'sendTransfer') {
        this.assertPreparationLive(pending);
        await this.deps.service.providerEnsureSpendReady({
          expectedVaultId: pending.expectedVaultId,
          expectedSessionId: pending.expectedSessionId,
          expectedAccountId: pending.expectedAccountId,
          expectedAccount: pending.expectedAccount,
        }, () => this.assertPreparationLive(pending));
        this.assertPreparationLive(pending);
      }
      if (method === 'signPsbt' || method === 'sendTransfer' || method === 'ord_sendInscriptions') {
        pending.preparedPsbt = await this.prepareTransaction(pending);
        this.assertPreparationLive(pending);
      }
      await this.withApprovalLock(async () => {
        this.assertPreparationLive(pending);
        this.queue.push(pending);
        this.releasePreparation(state.authority.origin);
        preparationReserved = false;
        try {
          await this.ensureApproval();
        } catch (error) {
          // Opening the approval window can fail (no exact window/tab identity).
          // The catch below then errors the page, so this request must not stay
          // queued: its nonce is already gone, so assertPendingLive can never
          // pass, and leaving it would show an unusable request and hold a slot
          // against the per-origin and total caps until the five-minute TTL.
          this.queue = this.queue.filter((item) => item !== pending);
          if (this.active === pending) this.active = null;
          throw error;
        }
      });
    } catch (error) {
      if (preparationReserved) this.releasePreparation(state.authority.origin);
      const marketplaceContext = method === 'signPsbt' && params.data && typeof params.data === 'object' &&
        'marketplaceContext' in params.data;
      this.postError(state, request.requestNonce,
        marketplaceContext && error instanceof RpcError && error.code === 'ERR_PLAN_CHANGED'
          ? providerError('ERR_MARKETPLACE_STATE_CHANGED')
          : this.mapError(error));
    } finally {
      if (!this.isPending(request.requestNonce)) state.nonces.delete(request.requestNonce);
    }
  }

  private async executeRead(method: ProviderMethod, params: unknown, state: PortState): Promise<unknown> {
    if (method === 'getInfo') {
      return {
        version: __EXTENSION_VERSION__,
        platform: 'web',
        methods: [...PROVIDER_METHODS],
        supports: ['WBIP001', 'WBIP004'],
        capabilities: ['community-vault-v1', 'community-vault-offers-v1'],
      };
    }
    const origin = state.authority.origin;
    const account = await this.deps.service.providerAccountView();
    const network = providerNetworkResult(providerNetwork(account.network));
    const addresses = providerAddresses(account);
    switch (method) {
      case 'wallet_getAccount':
        return {
          id: (await this.permissionResults(origin, account))[0]?.resourceId ?? '',
          addresses: addresses.filter((item) => this.hasAddressPurposes(state, [item.purpose])),
          walletType: 'software',
          network,
        };
      case 'wallet_getNetwork': return network;
      case 'getAddresses': {
        const purposes = (params as { purposes: Array<'payment' | 'ordinals'> }).purposes;
        return { addresses: addresses.filter((item) => purposes.includes(item.purpose)), network };
      }
      case 'getAccounts': {
        const purposes = (params as { purposes: Array<'payment' | 'ordinals'> }).purposes;
        return addresses.filter((item) => purposes.includes(item.purpose));
      }
      case 'getBalance': {
        const balance = await this.deps.service.providerBalanceView();
        if (!balance.fresh) throw new RpcError('ERR_DATA_STALE', 'balance cache is stale');
        return { confirmed: balance.confirmed, unconfirmed: balance.unconfirmed, total: balance.total };
      }
      case 'ord_getInscriptions': {
        const page = params as { offset: number; limit: number };
        const rows = await this.deps.service.providerInscriptionsView();
        return {
          total: rows.length,
          limit: page.limit,
          offset: page.offset,
          inscriptions: rows.slice(page.offset, page.offset + page.limit).map((item) => ({
            inscriptionId: item.id,
            ...(item.number === undefined ? {} : { inscriptionNumber: String(item.number) }),
            satpoint: item.satpoint,
            address: item.address,
            output: item.output,
            valueSats: item.postage,
          })),
        };
      }
      default: throw new Error('unexpected immediate provider operation');
    }
  }

  private async executeApproved(pending: PendingApproval, password?: string): Promise<unknown> {
    const origin = pending.state.authority.origin;
    if (pending.method === 'wallet_connect') {
      const requested = normalizeProviderConnectionRequest(pending.params as ConnectParams);
      await this.deps.service.providerGrantPermission(origin, requested.categories);
      const account = await this.deps.service.providerAccountView();
      await this.connect(pending.state, account, requested.purposes);
      const base = await this.executeRead(
        'wallet_getAccount',
        { purposes: requested.purposes },
        pending.state,
      ) as Record<string, unknown>;
      return base;
    }
    if (pending.method === 'wallet_requestPermissions') {
      const requested = pending.params as Array<{
        dataCategories?: Array<'account' | 'addresses' | 'balance' | 'inscriptions' | 'network'>;
        type: 'account' | 'wallet';
      }>;
      const categories = requested.flatMap((item) => item.dataCategories ??
        (item.type === 'account' ? ['account', 'addresses', 'balance', 'inscriptions'] as const : ['network'] as const));
      await this.deps.service.providerGrantPermission(origin, mapRequestedCategories(categories));
      const account = await this.deps.service.providerAccountView();
      await this.connect(
        pending.state,
        account,
        categories.includes('addresses')
          ? ['ordinals', 'payment']
          : this.connectionFor(pending.state)?.addressPurposes ?? [],
      );
      return this.permissionResults(origin, account);
    }
    if (pending.method === 'signMessage') {
      const params = pending.params as { address: string; message: string };
      const account = await this.deps.service.providerAccountView();
      const kind = params.address === account.payment.address
        ? 'payment'
        : params.address === account.ordinals.address
          ? 'ordinals'
          : null;
      if (!kind) throw new RpcError('ERR_UNSAFE_TRANSACTION', 'address is not the active account');
      const signed = await this.deps.service.providerSignMessage(
        params.message,
        kind,
        () => this.assertPendingLive(pending),
      );
      return {
        signature: signed.signature,
        messageHash: bytesToHex(bip322MessageHash(new TextEncoder().encode(params.message))),
        address: signed.address,
        protocol: 'BIP322',
      };
    }
    if (pending.method === 'signPsbt') {
      if (!pending.preparedPsbt) throw new RpcError('ERR_PLAN_CHANGED', 'prepared PSBT missing');
      const params = pending.params as { signInputs?: Record<string, number[]>; broadcast?: boolean };
      const indexes = params.signInputs ? Object.values(params.signInputs).flat() : undefined;
      if (pending.communityVaultSale) {
        if (params.broadcast === true) {
          throw new RpcError('ERR_UNSAFE_TRANSACTION', 'Community Vault approvals never broadcast');
        }
        if (!password) throw new RpcError('ERR_WRONG_PASSWORD', 'Community Vault password required');
        const context = pending.communityVaultSale.context;
        const signed = await this.deps.service.communityVaultSign({
          campaignId: context.plan.campaignId,
          expectedVaultId: pending.expectedVaultId,
          expectedSessionId: pending.expectedSessionId,
          password,
          policy: context.policy,
          plan: context.plan.spendPlan,
          psbtHex: pending.preparedPsbt.psbtHex,
        });
        return { psbt: bytesToBase64(hexToBytes(signed.psbtHex)) };
      }
      if (params.broadcast === true) {
        return this.deps.service.providerBroadcastPreparedPsbt(
          pending.preparedPsbt,
          indexes,
          () => this.assertPendingLive(pending),
        );
      }
      const signed = await this.deps.service.providerSignPreparedPsbt(
        pending.preparedPsbt,
        indexes,
        () => this.assertPendingLive(pending),
      );
      return { psbt: signed.psbtBase64 };
    }
    if (pending.method === 'sendTransfer') {
      if (!pending.preparedPsbt) throw new RpcError('ERR_PLAN_CHANGED', 'prepared transfer missing');
      const broadcast = await this.deps.service.providerBroadcastPreparedPsbt(
        pending.preparedPsbt,
        undefined,
        () => this.assertPendingLive(pending),
      );
      return { txid: broadcast.txid };
    }
    if (pending.method === 'ord_sendInscriptions') {
      if (!pending.preparedPsbt) throw new RpcError('ERR_PLAN_CHANGED', 'prepared ordinal transfer missing');
      const broadcast = await this.deps.service.providerBroadcastPreparedPsbt(
        pending.preparedPsbt,
        undefined,
        () => this.assertPendingLive(pending),
      );
      return { txid: broadcast.txid };
    }
    throw new RpcError('ERR_UNSAFE_TRANSACTION', 'provider transaction method is not available');
  }

  private async revalidate(pending: PendingApproval): Promise<void> {
    this.assertPendingLive(pending);
    const account = await this.deps.service.providerAccountView();
    this.assertPendingLive(pending);
    if (account.vaultId !== pending.expectedVaultId || account.vaultName !== pending.expectedWalletName ||
        account.sessionId !== pending.expectedSessionId ||
        account.accountId !== pending.expectedAccountId ||
        account.account !== pending.expectedAccount || account.network !== pending.expectedNetwork) {
      throw new RpcError('ERR_PLAN_CHANGED', 'provider context changed');
    }
    if (pending.method === 'wallet_connect') {
      const requestedNetwork = (pending.params as ConnectParams)?.network;
      if (requestedNetwork !== undefined && requestedNetwork !== providerNetwork(account.network)) {
        throw new RpcError('ERR_PLAN_CHANGED', 'requested provider network changed');
      }
    }
    if (PROVIDER_OPERATIONS[pending.method].requiresConnection && !(await this.liveConnection(pending.state, account))) {
      throw new RpcError('ERR_PLAN_CHANGED', 'provider connection changed');
    }
    const required = mapCategories(PROVIDER_OPERATIONS[pending.method].dataCategories);
    if (pending.method !== 'wallet_connect' && pending.method !== 'wallet_requestPermissions' && required.length > 0 &&
        !(await this.deps.service.providerHasPermission(pending.state.authority.origin, required))) {
      throw new RpcError('ERR_PLAN_CHANGED', 'provider permission changed');
    }
    if (pending.preparedPsbt) {
      await this.deps.service.providerRevalidatePreparedPsbt(pending.preparedPsbt);
      this.assertPendingLive(pending);
    }
  }

  /** Synchronous guard used while work is not yet visible in the approval queue. */
  private assertPreparationLive(pending: PendingApproval): void {
    if (pending.approvalGeneration !== this.approvalGeneration ||
        pending.contextGeneration !== this.contextGeneration ||
        !pending.state.alive ||
        !pending.state.nonces.has(pending.request.requestNonce)) {
      throw new RpcError('ERR_PLAN_CHANGED', 'provider preparation authority changed');
    }
    if (this.deps.now() >= pending.createdAt + REQUEST_TTL_MS) {
      throw new RpcError('ERR_PLAN_EXPIRED', 'provider request expired');
    }
  }

  /** Synchronous guard used at the innermost signing/broadcast boundary. */
  private assertPendingLive(pending: PendingApproval): void {
    if (pending.approvalGeneration !== this.approvalGeneration ||
        pending.contextGeneration !== this.contextGeneration ||
        this.active !== pending ||
        !pending.state.alive ||
        !pending.state.nonces.has(pending.request.requestNonce)) {
      throw new RpcError('ERR_PLAN_CHANGED', 'provider authority changed');
    }
    if (this.deps.now() >= pending.createdAt + REQUEST_TTL_MS) {
      throw new RpcError('ERR_PLAN_EXPIRED', 'provider request expired');
    }
  }

  private snapshot(): ApprovalSnapshot {
    const pending = this.active;
    let inscriptionReview: {
      effectCount: number;
      inscriptions: ReturnType<typeof approvalInscriptionItems>;
      requiresPreviewAcknowledgement: boolean;
    } | null = null;
    if (pending?.preparedPsbt) {
      try {
        const previews = providerPsbtPlanPreviews(pending.preparedPsbt);
        const inscriptions = approvalInscriptionItems(pending.preparedPsbt.analysis, previews);
        inscriptionReview = {
          effectCount: inscriptions.length,
          inscriptions,
          requiresPreviewAcknowledgement: requiresPreviewAcknowledgement(previews),
        };
      } catch {
        // A promised preview that is unavailable is a hard approval error, not
        // a reason to silently drop the inscription rows.
        pending.approvalError = 'Signed inscription previews are unavailable.';
      }
    }
    /**
     * An output is committed only when every input's sighash covers it.
     * SIGHASH_NONE commits to no output and SIGHASH_SINGLE to a single index, so
     * anything else can still be changed after signing. The review must not
     * present those outputs as fixed. With no inputs at all there is nothing to
     * commit, and `[].every()` would otherwise report the strongest claim the
     * review can make; both PSBT parsers reject an empty transaction, so the
     * length check only keeps the default fail-closed.
     */
    const analysisInputs = pending?.preparedPsbt?.analysis.inputs ?? [];
    const outputCommitted = (index: number): boolean =>
      analysisInputs.length > 0 &&
      analysisInputs.every((input) =>
        input.sighash.validEncoding &&
        (input.sighash.committedOutputIndexes === 'all' ||
          input.sighash.committedOutputIndexes.includes(index)));
    const review = pending?.preparedPsbt
      ? (() => {
          const walletInputSats = pending.preparedPsbt.analysis.inputs
            .filter((item) => item.ownership === 'wallet')
            .reduce((total, item) => total + item.valueSats, 0n);
          const walletOutputSats = pending.preparedPsbt.analysis.outputs
            .filter((item) => item.ownership === 'wallet')
            .reduce((total, item) => total + item.valueSats, 0n);
          const externalOutputSats = pending.preparedPsbt.analysis.outputs
            .filter((item) => item.ownership === 'external')
            .reduce((total, item) => total + item.valueSats, 0n);
          const outputs = pending.preparedPsbt.analysis.outputs.map((item) => ({
            index: item.index,
            address: item.address,
            valueSats: item.valueSats.toString(),
            ownership: item.ownership,
            role: item.role,
            committed: outputCommitted(item.index),
          }));
          const economics = pending.marketplace?.context.economics;
          const economicClaims = economics === undefined
            ? pending.preparedPsbt.communityVaultAcquisition
              ? [{
                  kind: 'buyer_total' as const,
                  valueSats: pending.preparedPsbt.communityVaultAcquisition.cashDueSats,
                }]
              : pending.preparedPsbt.communityVaultSale
                ? [{
                    kind: 'guaranteed_proceeds' as const,
                    valueSats: pending.preparedPsbt.communityVaultSale.ownerPayoutSats,
                  }]
                : pending.preparedPsbt.communityVaultSaleBuyer
                  ? [{
                      kind: 'buyer_total' as const,
                      valueSats: pending.preparedPsbt.communityVaultSaleBuyer.buyerTotalSats,
                    }]
                : []
            : [
                ...(economics.totalSats === undefined
                  ? []
                  : [{ kind: 'buyer_total' as const, valueSats: economics.totalSats }]),
                ...(economics.sellerProceedsSats === undefined
                  ? []
                  : [{
                      kind: 'guaranteed_proceeds' as const,
                      valueSats: economics.sellerProceedsSats,
                    }]),
                ...(economics.marketplaceFeeSats === undefined
                  ? []
                  : [{
                      kind: 'marketplace_fee' as const,
                      valueSats: economics.marketplaceFeeSats,
                    }]),
                ...(economics.royaltySats === undefined
                  ? []
                  : [{ kind: 'creator_royalty' as const, valueSats: economics.royaltySats }]),
                ...(economics.minerFeeSats === undefined
                  ? []
                  : [{ kind: 'miner_fee' as const, valueSats: economics.minerFeeSats }]),
              ];
          return {
            kind: 'transaction' as const,
            walletName: pending.expectedWalletName,
            account: pending.expectedAccount,
            network: pending.expectedNetwork,
            authorization: outputs.every((output) => output.committed)
              ? 'complete' as const
              : 'partial' as const,
            feeSats: pending.preparedPsbt.feeSats.toString(),
            walletInputSats: walletInputSats.toString(),
            walletOutputSats: walletOutputSats.toString(),
            externalOutputSats: externalOutputSats.toString(),
            netWalletDebitSats: (walletInputSats - walletOutputSats).toString(),
            economicClaims,
            outputs,
          };
        })()
      : pending?.method === 'signMessage'
        ? {
            kind: 'message' as const,
            walletName: pending.expectedWalletName,
            account: pending.expectedAccount,
            network: pending.expectedNetwork,
            address: (pending.params as { address: string }).address,
            message: (pending.params as { message: string }).message,
          }
        : pending
          ? (() => {
              const requested = pending.method === 'wallet_connect'
                ? normalizeProviderConnectionRequest(pending.params as ConnectParams)
                : {
                    categories: mapRequestedCategories(
                      (pending.params as Array<{
                        dataCategories?: Array<'account' | 'addresses' | 'balance' | 'inscriptions' | 'network'>;
                        type: 'account' | 'wallet';
                      }>).flatMap((item) => item.dataCategories ??
                        (item.type === 'account'
                          ? ['account', 'addresses', 'balance', 'inscriptions'] as const
                          : ['network'] as const)),
                    ),
                    purposes: (pending.params as Array<{
                      dataCategories?: Array<'account' | 'addresses' | 'balance' | 'inscriptions' | 'network'>;
                      type: 'account' | 'wallet';
                    }>).some((item) => (item.dataCategories ??
                      (item.type === 'account'
                        ? ['account', 'addresses', 'balance', 'inscriptions'] as const
                        : ['network'] as const)).includes('addresses'))
                      ? ['ordinals', 'payment'] as AddressPurpose[]
                      : [] as AddressPurpose[],
                  };
              return {
                kind: 'connection' as const,
                walletName: pending.expectedWalletName,
                account: pending.expectedAccount,
                network: pending.expectedNetwork,
                categories: requested.categories,
                purposes: requested.purposes,
              };
            })()
          : null;
    return {
      type: 'drey:approval:snapshot',
      protocolVersion: PROVIDER_BRIDGE_VERSION,
      request: pending ? {
        requestNonce: pending.request.requestNonce,
        method: pending.method,
        origin: pending.state.authority.origin,
        unicodeOrigin: pending.phishing.origin.unicodeOrigin,
        warnings: [...pending.phishing.warnings],
        createdAt: pending.createdAt,
        expiresAt: pending.createdAt + REQUEST_TTL_MS,
        approveAfter: pending.approveAfter,
        review: review!,
        details: pending.preparedPsbt
          ? {
              account: pending.preparedPsbt.account,
              network: pending.preparedPsbt.network,
              authority: {
                tabId: pending.state.authority.tabId,
                frameId: pending.state.authority.frameId,
                documentId: pending.state.authority.documentId,
              },
              feeSats: pending.preparedPsbt.feeSats.toString(),
              feeRateSatPerVb: (Number(pending.preparedPsbt.feeRateSatPerKvB) / 1000).toString(),
              vsize: pending.preparedPsbt.vsize.toString(),
              rbf: pending.preparedPsbt.rbf,
              security: {
                broadcast: pending.preparedPsbt.broadcast,
                requiresAdvanced: pending.preparedPsbt.requiresAdvanced,
                planHash: pending.preparedPsbt.planHash,
                analysisHash: pending.preparedPsbt.analysisHash,
                psbtHash: pending.preparedPsbt.psbtHash,
                hardViolations: pending.preparedPsbt.analysis.hardViolations,
                protectedInputIndexes: pending.preparedPsbt.analysis.assetEffects.protectedInputIndexes,
                protectedValueExposedToFees:
                  pending.preparedPsbt.analysis.assetEffects.protectedValueExposedToFees.toString(),
                rawPsbtHex: pending.preparedPsbt.psbtHex,
              },
              inputs: pending.preparedPsbt.analysis.inputs.map((item) => ({
                index: item.index,
                outpoint: `${item.txid}:${item.vout}`,
                valueSats: item.valueSats.toString(),
                ownership: item.ownership,
                classification: item.classification.primaryClass,
                sighash: item.sighash,
              })),
              outputs: pending.preparedPsbt.analysis.outputs.map((item) => ({
                index: item.index,
                address: item.address,
                valueSats: item.valueSats.toString(),
                ownership: item.ownership,
                role: item.role,
                committed: outputCommitted(item.index),
              })),
              warnings: pending.preparedPsbt.analysis.warnings,
              ...(inscriptionReview ?? {
                effectCount: pending.preparedPsbt.analysis.assetEffects.inscriptions?.length ?? 0,
                inscriptions: [],
                requiresPreviewAcknowledgement: false,
              }),
              ...(pending.marketplace ? { marketplace: {
                status: pending.marketplace.resolution.status,
                id: pending.marketplace.resolution.marketplaceId,
                name: pending.marketplace.resolution.displayName,
                templateId: pending.marketplace.resolution.templateId,
                templateVersion: pending.marketplace.resolution.templateVersion,
                action: pending.marketplace.context.action,
                role: pending.marketplace.context.role,
                assetKind: pending.marketplace.context.assetKind,
                step: pending.marketplace.context.step,
                stepCount: pending.marketplace.context.stepCount,
                economics: pending.marketplace.context.economics ?? null,
                identifiers: pending.marketplace.context.identifiers ?? null,
                expiresAt: pending.marketplace.context.expiresAt ?? null,
                broadcaster: pending.marketplace.context.broadcaster,
                flexible: pending.marketplace.resolution.flexible,
              } } : {}),
              ...(pending.preparedPsbt.communityVaultAcquisition ? {
                communityVaultAcquisition: pending.preparedPsbt.communityVaultAcquisition,
              } : {}),
              ...(pending.preparedPsbt.communityVaultSale ? {
                communityVaultSale: pending.preparedPsbt.communityVaultSale,
              } : {}),
              ...(pending.preparedPsbt.communityVaultSaleBuyer ? {
                communityVaultSaleBuyer: pending.preparedPsbt.communityVaultSaleBuyer,
              } : {}),
            }
          : {
              account: pending.expectedAccount,
              network: pending.expectedNetwork,
              authority: {
                tabId: pending.state.authority.tabId,
                frameId: pending.state.authority.frameId,
                documentId: pending.state.authority.documentId,
              },
              request: pending.params,
              ...(pending.method === 'wallet_connect'
                ? { requested: normalizeProviderConnectionRequest(pending.params as ConnectParams) }
                : {}),
              ...(pending.marketplace ? { marketplace: {
                status: pending.marketplace.resolution.status,
                id: pending.marketplace.resolution.marketplaceId,
                name: pending.marketplace.resolution.displayName,
                templateId: pending.marketplace.resolution.templateId,
                templateVersion: pending.marketplace.resolution.templateVersion,
                action: pending.marketplace.context.action,
                role: pending.marketplace.context.role,
                assetKind: pending.marketplace.context.assetKind,
                step: pending.marketplace.context.step,
                stepCount: pending.marketplace.context.stepCount,
                economics: pending.marketplace.context.economics ?? null,
                identifiers: pending.marketplace.context.identifiers ?? null,
                expiresAt: pending.marketplace.context.expiresAt ?? null,
                broadcaster: pending.marketplace.context.broadcaster,
                flexible: pending.marketplace.resolution.flexible,
              } } : {}),
            },
        requiresPassword: pending.preparedPsbt?.requiresAdvanced === true || pending.communityVaultSale !== undefined,
        confirmationPhrase: pending.preparedPsbt?.requiresAdvanced === true ? 'SIGN PSBT' : null,
        approvalError: pending.approvalError ?? null,
      } : null,
    };
  }

  private async prepareTransaction(pending: PendingApproval, feeRateSatPerVb?: number): Promise<ProviderPsbtPlanV3> {
    const authority = pending.state.authority;
    const common = {
      origin: authority.origin,
      tabId: authority.tabId,
      frameId: authority.frameId,
      documentId: authority.documentId,
      requestNonce: pending.request.requestNonce,
    };
    if (pending.method === 'signPsbt') {
      if (feeRateSatPerVb !== undefined) throw new RpcError('ERR_INVALID_PAYLOAD', 'PSBT fee is immutable');
      const params = pending.params as { psbt: string; signInputs?: Record<string, number[]>; broadcast?: boolean };
      const selectedInputIndexes = params.signInputs ? Object.values(params.signInputs).flat() : undefined;
      const community = pending.communityVaultAcquisition;
      const sale = pending.communityVaultSale;
      const buyer = pending.communityVaultSaleBuyer;
      return this.deps.service.providerPreparePsbt({
        psbtBase64: params.psbt,
        binding: { ...common, providerMethod: 'signPsbt' },
        broadcast: params.broadcast === true,
        ...(selectedInputIndexes === undefined ? {} : { selectedInputIndexes }),
        ...(community === undefined ? {} : {
          kind: 'community_vault_acquisition' as const,
          communityVaultAcquisition: community.review,
          expiresAt: Math.min(
            Number(community.context.plan.expiresAtMs),
            Number(community.context.preflight.verifiedAtMs) + COMMUNITY_VAULT_MAX_PREFLIGHT_AGE_MS,
          ),
          protectedSatFlow: [{
            inputIndex: community.context.plan.assetInputIndex,
            inputOffset: BigInt(community.context.plan.inscriptionInputOffsetSats),
            outputIndex: community.context.plan.vaultOutputIndex,
            outputOffset: BigInt(community.context.plan.inscriptionOutputOffsetSats),
            inscriptionId: community.context.plan.inscriptionId,
          }],
        }),
        ...(sale === undefined ? {} : {
          kind: 'community_vault_sale' as const,
          communityVaultSale: sale.review,
          expiresAt: Math.min(
            Number(sale.context.plan.expiresAtMs),
            Number(sale.context.preflight.verifiedAtMs) + COMMUNITY_VAULT_SALE_MAX_PREFLIGHT_AGE_MS,
          ),
          protectedSatFlow: [{
            inputIndex: sale.context.plan.spendPlan.ordinalRoute.inputIndex,
            inputOffset: BigInt(sale.context.plan.spendPlan.ordinalRoute.inputOffsetSats),
            outputIndex: sale.context.plan.spendPlan.ordinalRoute.outputIndex,
            outputOffset: BigInt(sale.context.plan.spendPlan.ordinalRoute.outputOffsetSats),
            inscriptionId: sale.context.plan.inscriptionId,
          }],
        }),
        ...(buyer === undefined ? {} : {
          kind: 'community_vault_sale' as const,
          communityVaultSaleBuyer: buyer.review,
          expiresAt: Math.min(
            Number(buyer.context.plan.expiresAtMs),
            Number(buyer.context.preflight.verifiedAtMs) + COMMUNITY_VAULT_SALE_MAX_PREFLIGHT_AGE_MS,
          ),
          protectedSatFlow: [{
            inputIndex: buyer.context.plan.spendPlan.ordinalRoute.inputIndex,
            inputOffset: BigInt(buyer.context.plan.spendPlan.ordinalRoute.inputOffsetSats),
            outputIndex: buyer.context.plan.spendPlan.ordinalRoute.outputIndex,
            outputOffset: BigInt(buyer.context.plan.spendPlan.ordinalRoute.outputOffsetSats),
            inscriptionId: buyer.context.plan.inscriptionId,
          }],
        }),
        ...(pending.marketplace === undefined ? {} : {
          marketplace: {
            context: pending.marketplace.context,
            resolution: pending.marketplace.resolution,
            ...(pending.marketplace.selectedInputIndexes === undefined
              ? {}
              : { selectedInputIndexes: pending.marketplace.selectedInputIndexes }),
          },
        }),
      });
    }
    if (pending.method === 'sendTransfer') {
      const params = pending.params as { recipients: Array<{ address: string; amount: number }> };
      return this.deps.service.providerPrepareTransfer({
        recipients: params.recipients,
        binding: { ...common, providerMethod: 'sendTransfer' },
        ...(feeRateSatPerVb === undefined ? {} : { feeRateSatPerVb }),
      });
    }
    if (pending.method === 'ord_sendInscriptions') {
      const params = pending.params as { transfers: [{ address: string; inscriptionId: string }] };
      return this.deps.service.providerPrepareOrdinalTransfer({
        ...params.transfers[0],
        binding: { ...common, providerMethod: 'ord_sendInscriptions' },
        ...(feeRateSatPerVb === undefined ? {} : { feeRateSatPerVb }),
      });
    }
    throw new RpcError('ERR_INVALID_PAYLOAD', 'request has no fee control');
  }

  private async ensureApproval(): Promise<void> {
    await this.activateNext(false);
    this.scheduleExpiry();
    this.publishApproval();
    if (this.active) await this.deps.openOrFocusApproval();
  }

  private async advance(): Promise<void> {
    this.clearExpiryTimer();
    if (this.active) this.active.state.nonces.delete(this.active.request.requestNonce);
    this.active = null;
    await this.activateNext(true);
    this.scheduleExpiry();
    this.publishApproval();
    if (this.active) await this.deps.openOrFocusApproval();
    else await this.deps.closeApproval();
  }

  private async expireRequests(): Promise<void> {
    const now = this.deps.now();
    let changed = false;
    let protectedTransition = false;
    if (this.active && now >= this.active.createdAt + REQUEST_TTL_MS) {
      this.respondError(this.active, providerError('ERR_REQUEST_EXPIRED'));
      this.active = null;
      changed = true;
      protectedTransition = true;
    }
    const waiting: PendingApproval[] = [];
    for (const pending of this.queue) {
      if (now >= pending.createdAt + REQUEST_TTL_MS) {
        this.respondError(pending, providerError('ERR_REQUEST_EXPIRED'));
        changed = true;
      } else {
        waiting.push(pending);
      }
    }
    this.queue = waiting;
    await this.activateNext(protectedTransition);
    this.clearExpiryTimer();
    this.scheduleExpiry();
    if (!changed) return;
    this.publishApproval();
    if (this.active) await this.deps.openOrFocusApproval();
    else await this.deps.closeApproval();
  }

  private scheduleExpiry(): void {
    if (!this.active || this.expiryTimer !== null) return;
    const nonce = this.active.request.requestNonce;
    const delay = Math.max(0, this.active.createdAt + REQUEST_TTL_MS - this.deps.now());
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null;
      if (this.active?.request.requestNonce !== nonce) return;
      void this.withApprovalLock(() => this.expireRequests());
    }, delay);
  }

  private clearExpiryTimer(): void {
    if (this.expiryTimer === null) return;
    clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
  }

  private async rejectWhere(
    predicate: (pending: PendingApproval) => boolean,
    error: BridgeJsonRpcError,
  ): Promise<void> {
    let protectedTransition = false;
    if (this.active && predicate(this.active)) {
      this.respondError(this.active, error);
      this.active = null;
      protectedTransition = true;
    }
    const keep: PendingApproval[] = [];
    for (const pending of this.queue) {
      if (predicate(pending)) this.respondError(pending, error);
      else keep.push(pending);
    }
    this.queue = keep;
    await this.activateNext(protectedTransition);
    this.clearExpiryTimer();
    this.scheduleExpiry();
    this.publishApproval();
  }

  private rejectAll(error: BridgeJsonRpcError): void {
    if (this.active) this.respondError(this.active, error);
    for (const pending of this.queue) this.respondError(pending, error);
    this.active = null;
    this.queue = [];
    this.clearExpiryTimer();
    this.publishApproval();
  }

  /** Revalidate every waiting request immediately before it becomes visible. */
  private async activateNext(protectedTransition: boolean): Promise<void> {
    while (!this.active) {
      const candidate = this.queue.shift();
      if (!candidate) return;
      this.active = candidate;
      try {
        await this.revalidate(candidate);
        candidate.approveAfter = protectedTransition
          ? this.deps.now() + APPROVAL_SWITCH_COOLDOWN_MS
          : this.deps.now();
      } catch (error) {
        this.respondError(candidate, this.mapError(error));
        this.active = null;
      }
    }
  }

  private withApprovalLock<T>(work: () => Promise<T>): Promise<T> {
    const result = this.approvalTail.then(work, work);
    this.approvalTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private publishApproval(): void {
    this.deps.approvalChanged?.(this.snapshot());
  }

  private respondResult(pending: PendingApproval, result: unknown): boolean {
    const parsed = PROVIDER_OPERATIONS[pending.method].response.safeParse(result);
    if (!parsed.success) {
      this.respondError(pending, INTERNAL_ERROR);
      return false;
    }
    return this.postResult(pending.state, pending.request.requestNonce, parsed.data);
  }

  private respondError(pending: PendingApproval, error: BridgeJsonRpcError): void {
    this.postError(pending.state, pending.request.requestNonce, error);
    pending.state.nonces.delete(pending.request.requestNonce);
  }

  private postResult(state: PortState, nonce: string, result: unknown): boolean {
    const delivered = this.safePost(state, { type: 'drey:provider:response', protocolVersion: PROVIDER_BRIDGE_VERSION,
      requestNonce: nonce, ok: true, result } satisfies RuntimeProviderResponse);
    state.nonces.delete(nonce);
    return delivered;
  }

  private postError(state: PortState, nonce: string, error: BridgeJsonRpcError): void {
    this.safePost(state, { type: 'drey:provider:response', protocolVersion: PROVIDER_BRIDGE_VERSION,
      requestNonce: nonce, ok: false, error } satisfies RuntimeProviderResponse);
    state.nonces.delete(nonce);
  }

  private safePost(state: PortState, message: unknown): boolean {
    if (!state.alive) return false;
    try {
      state.port.postMessage(message);
      return true;
    } catch {
      state.alive = false;
      this.ports.delete(state);
      return false;
    }
  }

  private mapError(error: unknown): BridgeJsonRpcError {
    if (error instanceof ProviderConnectionLimitError) return providerError('ERR_QUEUE_FULL');
    if (error instanceof MarketplaceProviderError) return providerError(error.providerCode);
    if (error instanceof RpcError) {
      if (error.code === 'ERR_INVALID_PAYLOAD') return INVALID_PARAMS_ERROR;
      if (error.code === 'ERR_LOCKED') return providerError('ERR_LOCKED');
      if (error.code === 'ERR_PLAN_EXPIRED') return providerError('ERR_REQUEST_EXPIRED');
      if (error.code === 'ERR_PLAN_CHANGED') return providerError('ERR_STALE_CONTEXT');
      if (error.code === 'ERR_DATA_STALE') return providerError('ERR_DATA_STALE');
      if (error.code === 'ERR_BROADCAST_OUTCOME_UNKNOWN') {
        return providerError('ERR_BROADCAST_OUTCOME_UNKNOWN');
      }
      if (error.code === 'ERR_WRONG_PASSWORD') return providerError('ERR_USER_REJECTED');
      if (error.code === 'ERR_UNSAFE_TRANSACTION' || error.code === 'ERR_INSUFFICIENT_FUNDS') {
        return providerError('ERR_UNSUPPORTED_BY_ACCOUNT');
      }
    }
    return INTERNAL_ERROR;
  }

  private phishingDecision(origin: string): PhishingDecision {
    const now = this.deps.now();
    const cached = this.phishingDecisions.get(origin);
    if (cached && now >= cached.checkedAt && now - cached.checkedAt < PHISHING_DECISION_CACHE_MS) {
      return cached.decision;
    }
    const decision = this.deps.evaluatePhishing?.(origin) ?? evaluatePhishingOrigin({
      origin,
      listBodyBytes: PACKAGED_PHISHING_LIST_BYTES,
      publicKeyHex: PHISHING_LIST_PUBLIC_KEY_HEX,
      nowMs: now,
      protectedHostnames: ['drey.com', 'squirrelsystems.net'],
    });
    this.phishingDecisions.set(origin, { checkedAt: now, decision });
    return decision;
  }

  private totalPending(): number { return this.queue.length + (this.active ? 1 : 0); }
  private originPreparing(origin: string): number { return this.preparingByOrigin.get(origin) ?? 0; }
  private reservePreparation(origin: string): void {
    this.preparingTotal += 1;
    this.preparingByOrigin.set(origin, this.originPreparing(origin) + 1);
  }
  private releasePreparation(origin: string): void {
    const current = this.originPreparing(origin);
    if (current <= 0) return;
    this.preparingTotal -= 1;
    if (current === 1) this.preparingByOrigin.delete(origin);
    else this.preparingByOrigin.set(origin, current - 1);
  }
  private originPending(origin: string): number {
    return this.queue.filter((item) => item.state.authority.origin === origin).length +
      (this.active?.state.authority.origin === origin ? 1 : 0);
  }
  private isPending(nonce: string): boolean {
    return this.active?.request.requestNonce === nonce || this.queue.some((item) => item.request.requestNonce === nonce);
  }

  private async connect(
    state: PortState,
    account: Awaited<ReturnType<WalletService['providerAccountView']>>,
    addressPurposes: readonly AddressPurpose[],
  ): Promise<void> {
    const key = authorityKey(state.authority);
    if (key === null) return;
    // A replacement document in one browser frame can never use the prior
    // document ID. Remove that unreachable authority before inserting the new
    // exact binding, then prune other records with no live Port. This preserves
    // same-document/MV3 reconnect while bounding hostile iframe churn.
    for (const [existingKey, connection] of this.connections) {
      if (existingKey !== key && connection.tabId === state.authority.tabId &&
          connection.frameId === state.authority.frameId) this.connections.delete(existingKey);
    }
    if (!this.connections.has(key) && this.connections.size >= MAX_CONNECTIONS) {
      const liveKeys = new Set([...this.ports].flatMap((portState) => {
        const liveKey = portState.alive ? authorityKey(portState.authority) : null;
        return liveKey === null ? [] : [liveKey];
      }));
      const stale = [...this.connections.entries()]
        .filter(([existingKey]) => !liveKeys.has(existingKey))
        .sort((left, right) => left[1].connectedAt - right[1].connectedAt);
      for (const [staleKey] of stale) {
        this.connections.delete(staleKey);
        if (this.connections.size < MAX_CONNECTIONS) break;
      }
    }
    if (!this.connections.has(key) && this.connections.size >= MAX_CONNECTIONS) {
      throw new ProviderConnectionLimitError();
    }
    this.connections.set(key, {
      origin: state.authority.origin, tabId: state.authority.tabId, frameId: state.authority.frameId,
      documentId: state.authority.documentId, vaultId: account.vaultId, sessionId: account.sessionId,
      accountId: account.accountId, account: account.account,
      addressPurposes: [...new Set(addressPurposes)].sort(),
      connectedAt: this.deps.now(),
    });
    await this.saveConnections();
  }

  private connectionFor(state: PortState): ConnectionRecord | null {
    const key = authorityKey(state.authority);
    return key === null ? null : this.connections.get(key) ?? null;
  }

  private hasAddressPurposes(state: PortState, requested: readonly AddressPurpose[]): boolean {
    const approved = new Set(this.connectionFor(state)?.addressPurposes ?? []);
    return requested.every((purpose) => approved.has(purpose));
  }

  private async liveConnection(
    state: PortState,
    account?: Awaited<ReturnType<WalletService['providerAccountView']>>,
  ): Promise<boolean> {
    const key = authorityKey(state.authority);
    if (key === null) return false;
    const connection = this.connections.get(key);
    if (!connection) return false;
    const live = account ?? await this.deps.service.providerAccountView().catch(() => null);
    if (!live || connection.vaultId !== live.vaultId || connection.sessionId !== live.sessionId ||
        connection.accountId !== live.accountId || connection.account !== live.account) {
      this.connections.delete(key);
      await this.saveConnections();
      return false;
    }
    return true;
  }

  private async disconnectOrigin(origin: string): Promise<void> {
    const connectedStates = this.connectedPortStates(origin);
    await this.deps.service.providerRevokeOrigin(origin);
    for (const [key, connection] of this.connections) if (connection.origin === origin) this.connections.delete(key);
    await this.saveConnections();
    await this.withApprovalLock(() => this.rejectWhere(
        (pending) => pending.state.authority.origin === origin,
        providerError('ERR_STALE_CONTEXT'),
      ));
    for (const state of connectedStates) {
      this.safePost(state, {
        type: 'drey:provider:event',
        protocolVersion: PROVIDER_BRIDGE_VERSION,
        event: 'disconnect',
        data: { type: 'disconnect' },
      });
    }
  }

  private async permissionResults(
    origin: string,
    account: Awaited<ReturnType<WalletService['providerAccountView']>>,
  ): Promise<Array<Record<string, unknown>>> {
    const grants = (await this.deps.service.providerPermissionGrants()).filter((grant) =>
      grant.scope.origin === origin &&
      grant.scope.network === account.network &&
      grant.scope.vaultId === account.vaultId &&
      grant.scope.account === account.account);
    const accountCategories = new Set<'account' | 'addresses' | 'balance' | 'inscriptions'>();
    let resourceId = '';
    let network = false;
    for (const grant of grants) {
      for (const category of grant.scope.categories) {
        if (category === 'network') network = true;
        else {
          resourceId ||= grant.resourceId;
          accountCategories.add(category === 'account_identity' ? 'account' : category);
        }
      }
    }
    const result: Array<Record<string, unknown>> = [];
    if (accountCategories.size > 0) result.push({
      type: 'account', resourceId, clientId: origin, actions: { read: true },
      dataCategories: [...accountCategories].sort(),
    });
    if (network) result.push({
      type: 'wallet', resourceId: 'wallet', clientId: origin,
      actions: { readNetwork: true }, dataCategories: ['network'],
    });
    return result;
  }

  /** Ports with an exact browser-derived document connection, never mere discovery. */
  private connectedPortStates(origin?: string): PortState[] {
    return [...this.ports].filter((state) => {
      if (!state.alive || (origin !== undefined && state.authority.origin !== origin)) return false;
      const key = authorityKey(state.authority);
      return key !== null && this.connections.has(key);
    });
  }

  private async loadConnections(): Promise<void> {
    const raw = (await this.deps.sessionStorage.get(CONNECTIONS_KEY))[CONNECTIONS_KEY];
    if (!Array.isArray(raw)) return;
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const value = item as Partial<ConnectionRecord>;
      if (typeof value.origin !== 'string' || typeof value.tabId !== 'number' ||
          typeof value.frameId !== 'number' || typeof value.documentId !== 'string' ||
          typeof value.vaultId !== 'string' || typeof value.sessionId !== 'string' ||
          typeof value.accountId !== 'string' ||
          typeof value.account !== 'number' || !Array.isArray(value.addressPurposes) ||
          value.addressPurposes.length > 2 ||
          value.addressPurposes.some((purpose) => purpose !== 'payment' && purpose !== 'ordinals') ||
          new Set(value.addressPurposes).size !== value.addressPurposes.length ||
          typeof value.connectedAt !== 'number' || !Number.isSafeInteger(value.connectedAt) ||
          value.connectedAt < 0) continue;
      const key = `${value.origin}|${value.tabId}|${value.frameId}|${value.documentId}`;
      this.connections.set(key, value as ConnectionRecord);
      if (this.connections.size >= MAX_CONNECTIONS) break;
    }
  }

  private async saveConnections(): Promise<void> {
    await this.deps.sessionStorage.set({ [CONNECTIONS_KEY]: [...this.connections.values()] });
  }
}
