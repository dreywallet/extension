/** Minimal data-free page facade for the authorized M8 provider surface. */
import { z } from 'zod';
import {
  pageProviderEventSchema,
  pageProviderResponseSchema,
  PROVIDER_BRIDGE_VERSION,
  PROVIDER_REQUEST_TIMEOUT_MS,
  type ProviderEventName,
  type WindowBridgeTarget,
} from './bridge';
import { providerError, DreyProviderError } from '@drey/core/provider/errors';
import {
  isProviderMethod,
  providerNetworkResultSchema,
  PROVIDER_MAX_SIGN_INPUTS,
  PROVIDER_OPERATIONS,
  satsConnectInputToSignSchema,
  type ProviderMethod,
  type ProviderRequest,
  type ProviderResult,
} from '@drey/core/provider/registry';
import {
  createDreyProvider as createCoreDreyProvider,
  type DreyProvider as CoreDreyProvider,
  type DreyRpcResponse,
  type ProviderTransport,
  type ProviderTransportResult,
} from '@drey/core/provider/facade';
import { base64ToBytes, bytesToBase64 } from '@drey/core/domain/vault/encoding';

export * from '@drey/core/provider/facade';

export const BITCOIN_SIGN_PSBT_V2_METHOD = 'bitcoin_signPsbtV2' as const;
const MAX_LEGACY_TRANSACTION_TOKEN_CHARS = 2_100_000;

const legacySignTransactionParamsSchema = z.object({
  network: z.object({
    type: z.enum(['Mainnet', 'Testnet', 'Testnet4', 'Signet', 'Regtest']),
    address: z.string().min(8).max(128).optional(),
  }).strict(),
  message: z.string().max(80),
  psbtBase64: z.string().min(1).max(1_500_000).regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  inputsToSign: z.array(satsConnectInputToSignSchema).min(1).max(2),
  broadcast: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  const addresses = new Set<string>();
  const indexes = new Set<number>();
  for (const selection of value.inputsToSign) {
    if (addresses.has(selection.address)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['inputsToSign'],
        message: 'inputsToSign addresses must be unique',
      });
      return;
    }
    addresses.add(selection.address);
    for (const index of selection.signingIndexes) {
      if (indexes.has(index)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['inputsToSign'],
          message: 'inputsToSign indexes must be unique',
        });
        return;
      }
      indexes.add(index);
    }
  }
  if (indexes.size > PROVIDER_MAX_SIGN_INPUTS) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['inputsToSign'],
      message: `inputsToSign may select at most ${PROVIDER_MAX_SIGN_INPUTS} inputs`,
    });
  }
});

export type LegacySignTransactionParams = z.infer<typeof legacySignTransactionParamsSchema>;
export interface LegacySignTransactionResult {
  psbtBase64: string;
  txId?: string;
}

export interface DreyProvider extends Omit<CoreDreyProvider, 'methods' | 'request'> {
  readonly methods: readonly (ProviderMethod | typeof BITCOIN_SIGN_PSBT_V2_METHOD)[];
  request<M extends ProviderMethod>(
    method: M,
    params: ProviderRequest<M>,
  ): Promise<DreyRpcResponse<ProviderResult<M>>>;
  request(
    method: typeof BITCOIN_SIGN_PSBT_V2_METHOD,
    params: ProviderRequest<'signPsbt'>,
  ): Promise<DreyRpcResponse<ProviderResult<'signPsbt'>>>;
  request(method: string, params?: unknown): Promise<DreyRpcResponse<unknown>>;
  /** Callback-era Sats Connect compatibility. The unsecured token is data, never authority. */
  signTransaction(token: string): Promise<LegacySignTransactionResult>;
}

function invalidLegacyParams(): DreyProviderError {
  return new DreyProviderError({ code: -32602, message: 'Invalid params' });
}

function decodeBase64UrlJson(segment: string, maxBytes: number): unknown {
  if (segment.length === 0 || !/^[A-Za-z0-9_-]+$/u.test(segment)) throw invalidLegacyParams();
  const standard = segment.replace(/-/gu, '+').replace(/_/gu, '/');
  const padded = `${standard}${'='.repeat((4 - standard.length % 4) % 4)}`;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(padded);
  } catch {
    throw invalidLegacyParams();
  }
  const canonical = bytesToBase64(bytes).replace(/=/gu, '').replace(/\+/gu, '-').replace(/\//gu, '_');
  if (canonical !== segment || bytes.length > maxBytes) throw invalidLegacyParams();
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw invalidLegacyParams();
  }
}

/** Decode only the exact unsecured JWT envelope emitted by Sats Connect's legacy helper. */
export function parseSatsConnectTransactionToken(token: string): LegacySignTransactionParams {
  if (typeof token !== 'string' || token.length > MAX_LEGACY_TRANSACTION_TOKEN_CHARS) {
    throw invalidLegacyParams();
  }
  const segments = token.split('.');
  if (segments.length !== 3 || segments[2] !== '') throw invalidLegacyParams();
  const header = decodeBase64UrlJson(segments[0]!, 256);
  if (header === null || typeof header !== 'object' || Array.isArray(header) ||
      Object.keys(header).length !== 2 ||
      (header as Record<string, unknown>)['typ'] !== 'JWT' ||
      (header as Record<string, unknown>)['alg'] !== 'none') {
    throw invalidLegacyParams();
  }
  const parsed = legacySignTransactionParamsSchema.safeParse(
    decodeBase64UrlJson(segments[1]!, 1_600_000),
  );
  if (!parsed.success) throw invalidLegacyParams();
  return parsed.data;
}

interface PendingRequest {
  method: string;
  resolve(value: ProviderTransportResult): void;
  reject(reason: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
}

const MAX_PENDING_PROVIDER_REQUESTS = 32;

export function createWindowProviderTransport(
  target: WindowBridgeTarget,
  targetOrigin: string,
  randomUUID: () => string = () => globalThis.crypto.randomUUID(),
  timeoutMs = PROVIDER_REQUEST_TIMEOUT_MS,
): ProviderTransport {
  const pending = new Map<string, PendingRequest>();
  const listeners: Record<ProviderEventName, Set<(data: never) => void>> = {
    accountChange: new Set(),
    networkChange: new Set(),
    disconnect: new Set(),
  };
  let destroyed = false;

  const onMessage = (event: MessageEvent<unknown>): void => {
    if (event.source !== target || event.origin !== targetOrigin) return;
    const providerEvent = pageProviderEventSchema.safeParse(event.data);
    if (providerEvent.success) {
      for (const listener of listeners[providerEvent.data.event]) {
        listener(providerEvent.data.data as never);
      }
      return;
    }
    const response = pageProviderResponseSchema.safeParse(event.data);
    if (!response.success) return;
    const request = pending.get(response.data.requestId);
    if (!request) return;
    pending.delete(response.data.requestId);
    clearTimeout(request.timeout);
    if (!response.data.ok) {
      request.reject(new DreyProviderError(response.data.error));
      return;
    }
    if (!isProviderMethod(request.method) ||
        !PROVIDER_OPERATIONS[request.method].response.safeParse(response.data.result).success) {
      request.reject(new DreyProviderError({ code: -32603, message: 'Internal error' }));
      return;
    }
    request.resolve({ id: response.data.requestId, result: response.data.result });
  };

  target.addEventListener('message', onMessage);
  return {
    request(method, params) {
      if (destroyed) return Promise.reject(new DreyProviderError(providerError('ERR_STALE_CONTEXT')));
      if (pending.size >= MAX_PENDING_PROVIDER_REQUESTS) {
        return Promise.reject(new DreyProviderError(providerError('ERR_QUEUE_FULL')));
      }
      const requestId = randomUUID();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(requestId) ||
          pending.has(requestId)) {
        return Promise.reject(new DreyProviderError({ code: -32603, message: 'Internal error' }));
      }
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          reject(new DreyProviderError(providerError('ERR_REQUEST_EXPIRED')));
        }, timeoutMs);
        pending.set(requestId, { method, resolve, reject, timeout });
        target.postMessage(
          {
            type: 'drey:provider:request',
            protocolVersion: PROVIDER_BRIDGE_VERSION,
            requestId,
            method,
            ...(params !== undefined ? { params } : {}),
          },
          targetOrigin,
        );
      });
    },
    addListener(event, listener) {
      listeners[event].add(listener as (data: never) => void);
    },
    removeListener(event, listener) {
      listeners[event].delete(listener as (data: never) => void);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      target.removeEventListener('message', onMessage);
      for (const request of pending.values()) {
        clearTimeout(request.timeout);
        request.reject(new DreyProviderError(providerError('ERR_STALE_CONTEXT')));
      }
      pending.clear();
      listeners.accountChange.clear();
      listeners.networkChange.clear();
      listeners.disconnect.clear();
    },
  };
}

/**
 * Add callback-era single-PSBT compatibility and normalize the current V2
 * request alias before either name reaches Core's strict provider registry.
 */
export function createDreyProvider(transport: ProviderTransport): DreyProvider {
  const core = createCoreDreyProvider(transport);
  const methods = Object.freeze([
    ...core.methods,
    BITCOIN_SIGN_PSBT_V2_METHOD,
  ] as const);
  const request = (
    method: string,
    params?: unknown,
  ): Promise<DreyRpcResponse<unknown>> => core.request(
    method === BITCOIN_SIGN_PSBT_V2_METHOD ? 'signPsbt' : method,
    params,
  );
  const signTransaction = async (token: string): Promise<LegacySignTransactionResult> => {
    const payload = parseSatsConnectTransactionToken(token);
    if (payload.network.type !== 'Mainnet' && payload.network.type !== 'Signet') {
      throw new DreyProviderError(providerError('ERR_UNSUPPORTED_BY_ACCOUNT'));
    }
    const activeNetwork = providerNetworkResultSchema.safeParse(
      (await transport.request('wallet_getNetwork', null)).result,
    );
    if (!activeNetwork.success) {
      throw new DreyProviderError({ code: -32603, message: 'Internal error' });
    }
    if (activeNetwork.data.bitcoin.name !== payload.network.type) {
      throw new DreyProviderError(providerError('ERR_UNSUPPORTED_BY_ACCOUNT'));
    }
    const params = {
      psbt: payload.psbtBase64,
      inputsToSign: payload.inputsToSign,
      ...(payload.broadcast === undefined ? {} : { broadcast: payload.broadcast }),
    };
    const validatedParams = PROVIDER_OPERATIONS.signPsbt.request.safeParse(params);
    if (!validatedParams.success) throw invalidLegacyParams();
    const response = await transport.request('signPsbt', validatedParams.data);
    const result = PROVIDER_OPERATIONS.signPsbt.response.safeParse(response.result);
    if (!result.success) {
      throw new DreyProviderError({ code: -32603, message: 'Internal error' });
    }
    return {
      psbtBase64: result.data.psbt,
      ...(result.data.txid === undefined ? {} : { txId: result.data.txid }),
    };
  };
  return Object.freeze({
    isDrey: core.isDrey,
    protocolVersion: core.protocolVersion,
    methods,
    request,
    signTransaction,
    signMultipleTransactions: core.signMultipleTransactions,
    addListener: core.addListener,
  }) as DreyProvider;
}
