/** Minimal data-free page facade for the authorized M8 provider surface. */
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
  PROVIDER_OPERATIONS,
} from '@drey/core/provider/registry';
import {
  createDreyProvider,
  type ProviderTransport,
  type ProviderTransportResult,
} from '@drey/core/provider/facade';

export * from '@drey/core/provider/facade';

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

export { createDreyProvider };
