/**
 * Strict MAIN-world <-> isolated-world <-> worker bridge contracts.
 *
 * The page request ID is correlation only. The isolated bridge generates the
 * request nonce seen by the worker, so page data can never choose or replay a
 * worker request identity. Runtime MessageSender remains the sole authority.
 */
import type { z } from 'zod';
import {
  bridgeJsonRpcErrorSchema,
  INTERNAL_ERROR,
  INVALID_PARAMS_ERROR,
  providerError,
} from '@drey/core/provider/errors';
import {
  isProviderMethod,
  PROVIDER_OPERATIONS,
} from '@drey/core/provider/registry';
import {
  bridgeRequestIdSchema,
  PROVIDER_BRIDGE_VERSION,
  pageProviderRequestSchema,
  runtimeProviderEventSchema,
  runtimeProviderResponseSchema,
  type PageProviderEvent,
  type PageProviderResponse,
  type RuntimeProviderRequest,
} from '@drey/core/provider/bridge-schemas';

// The wire contracts are platform-free and live in @drey/core; re-export the
// full schema surface so extension modules keep one import site.
export * from '@drey/core/provider/bridge-schemas';

export interface ProviderRuntimePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: {
    addListener(listener: (message: unknown) => void): void;
    removeListener(listener: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(listener: () => void): void;
    removeListener(listener: () => void): void;
  };
}

export interface WindowBridgeTarget {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface IsolatedBridgeOptions {
  window: WindowBridgeTarget;
  port: ProviderRuntimePort;
  randomUUID: () => string;
  targetOrigin: string;
}

export interface ReconnectingIsolatedBridgeOptions {
  window: WindowBridgeTarget;
  connectPort: () => ProviderRuntimePort;
  randomUUID: () => string;
  targetOrigin: string;
  scheduleReconnect?: (reconnect: () => void) => void;
}

const MAX_PENDING_PROVIDER_REQUESTS = 32;

function pageError(requestId: string, error: z.infer<typeof bridgeJsonRpcErrorSchema>): PageProviderResponse {
  return {
    type: 'drey:provider:response',
    protocolVersion: PROVIDER_BRIDGE_VERSION,
    requestId,
    ok: false,
    error,
  };
}

/** Attach one isolated-world bridge to one long-lived runtime port. */
export function attachIsolatedBridge(options: IsolatedBridgeOptions): () => void {
  const pending = new Map<string, { pageRequestId: string; method: string }>();
  let stopped = false;

  const postPage = (message: PageProviderResponse | PageProviderEvent): void => {
    options.window.postMessage(message, options.targetOrigin);
  };

  const onWindowMessage = (event: MessageEvent<unknown>): void => {
    if (stopped || event.source !== options.window || event.origin !== options.targetOrigin) return;
    const parsed = pageProviderRequestSchema.safeParse(event.data);
    if (!parsed.success) return;
    const request = parsed.data;
    if (isProviderMethod(request.method)) {
      const params = PROVIDER_OPERATIONS[request.method].request.safeParse(request.params);
      if (!params.success) {
        postPage(pageError(request.requestId, INVALID_PARAMS_ERROR));
        return;
      }
    }
    if (pending.size >= MAX_PENDING_PROVIDER_REQUESTS) {
      postPage(pageError(request.requestId, providerError('ERR_QUEUE_FULL')));
      return;
    }
    const requestNonce = options.randomUUID();
    if (!bridgeRequestIdSchema.safeParse(requestNonce).success || pending.has(requestNonce)) {
      postPage(pageError(request.requestId, INTERNAL_ERROR));
      return;
    }
    pending.set(requestNonce, { pageRequestId: request.requestId, method: request.method });
    options.port.postMessage({
      type: 'drey:provider:request',
      protocolVersion: PROVIDER_BRIDGE_VERSION,
      requestNonce,
      method: request.method,
      ...(request.params !== undefined ? { params: request.params } : {}),
    } satisfies RuntimeProviderRequest);
  };

  const onPortMessage = (raw: unknown): void => {
    if (stopped) return;
    const event = runtimeProviderEventSchema.safeParse(raw);
    if (event.success) {
      postPage(event.data);
      return;
    }
    const parsed = runtimeProviderResponseSchema.safeParse(raw);
    if (!parsed.success) return;
    const request = pending.get(parsed.data.requestNonce);
    if (!request) return;
    pending.delete(parsed.data.requestNonce);

    if (!parsed.data.ok) {
      postPage(pageError(request.pageRequestId, parsed.data.error));
      return;
    }
    if (!isProviderMethod(request.method) ||
        !PROVIDER_OPERATIONS[request.method].response.safeParse(parsed.data.result).success) {
      postPage(pageError(request.pageRequestId, INTERNAL_ERROR));
      return;
    }
    postPage({
      type: 'drey:provider:response',
      protocolVersion: PROVIDER_BRIDGE_VERSION,
      requestId: request.pageRequestId,
      ok: true,
      result: parsed.data.result,
    });
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    for (const request of pending.values()) {
      postPage(pageError(request.pageRequestId, providerError('ERR_STALE_CONTEXT')));
    }
    pending.clear();
    options.window.removeEventListener('message', onWindowMessage);
    options.port.onMessage.removeListener(onPortMessage);
    options.port.onDisconnect.removeListener(stop);
    try {
      options.port.disconnect();
    } catch {
      // The runtime already disconnected; pending callers were still rejected.
    }
  };

  options.window.addEventListener('message', onWindowMessage);
  options.port.onMessage.addListener(onPortMessage);
  options.port.onDisconnect.addListener(stop);
  return stop;
}

/** Keep a same-document bridge usable across MV3 worker restarts. */
export function attachReconnectingIsolatedBridge(options: ReconnectingIsolatedBridgeOptions): () => void {
  let stopped = false;
  let generation = 0;
  let detachCurrent = (): void => undefined;
  const schedule = options.scheduleReconnect ?? ((reconnect: () => void) => queueMicrotask(reconnect));

  const connect = (): void => {
    if (stopped) return;
    const currentGeneration = ++generation;
    const port = options.connectPort();
    const stopBridge = attachIsolatedBridge({
      window: options.window,
      port,
      randomUUID: options.randomUUID,
      targetOrigin: options.targetOrigin,
    });
    const reconnect = (): void => {
      if (stopped || generation !== currentGeneration) return;
      schedule(() => {
        if (!stopped && generation === currentGeneration) connect();
      });
    };
    port.onDisconnect.addListener(reconnect);
    detachCurrent = () => {
      if (generation === currentGeneration) generation += 1;
      port.onDisconnect.removeListener(reconnect);
      stopBridge();
    };
  };

  connect();
  return () => {
    if (stopped) return;
    stopped = true;
    generation += 1;
    detachCurrent();
  };
}
