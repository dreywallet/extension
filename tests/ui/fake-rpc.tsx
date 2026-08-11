/**
 * UI-test harness: installs a fake `chrome` global whose runtime.sendMessage
 * routes envelopes to per-op handlers, so components are exercised through the
 * real typed rpc-client without any worker (or libsodium) in jsdom.
 */
import type { ReactNode } from 'react';
import type { MessageEnvelope } from '@drey/core/messaging/envelope';
import { I18nProvider } from '../../src/ui/i18n';
import { RpcProvider } from '../../src/ui/hooks/use-rpc';
import { clearGalleryDataStore } from '../../src/ui/hooks/use-gallery-data';
import { clearWalletHomeStore } from '../../src/ui/hooks/use-wallet-home';
import { clearActivityPreviewStore } from '../../src/entrypoints/popup/ActivityList';
import { clearAccountActivityStore } from '../../src/ui/hooks/use-account-activity';

type Handler = (payload: unknown) => unknown;
type RuntimeListener = (message: unknown) => void;
type StorageListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string,
) => void;
let runtimeListeners = new Set<RuntimeListener>();
let storageListeners = new Set<StorageListener>();

export function emitRuntimeMessage(message: unknown): void {
  for (const listener of runtimeListeners) listener(message);
}

export function installFakeChrome(handlers: Record<string, Handler>): Map<string, unknown> {
  const storage = new Map<string, unknown>();
  runtimeListeners = new Set();
  storageListeners = new Set();
  // Popup-document-scoped caches must not leak between tests: installing a new
  // fake chrome is the harness equivalent of opening a fresh popup.
  clearGalleryDataStore();
  clearWalletHomeStore();
  clearActivityPreviewStore();
  clearAccountActivityStore();
  const fake = {
    runtime: {
      sendMessage: async (raw: unknown): Promise<unknown> => {
        const envelope = raw as MessageEnvelope;
        const handler = handlers[envelope.op];
        if (!handler && envelope.op === 'activity.list') {
          const homeHandler = handlers['wallet.home'];
          if (!homeHandler) {
            const accountId = (envelope.payload as { accountId: string }).accountId;
            return { ok: true, result: { accountId, items: [], nextCursor: null, reset: false } };
          }
          const homeResponse = await homeHandler(envelope.payload) as {
            ok: boolean;
            result?: { accountId: string; activity: unknown[] };
            code?: string;
          };
          if (!homeResponse.ok || !homeResponse.result) return homeResponse;
          return {
            ok: true,
            result: {
              accountId: homeResponse.result.accountId,
              items: homeResponse.result.activity,
              nextCursor: null,
              reset: false,
            },
          };
        }
        if (!handler) return Promise.resolve({ ok: false, code: 'ERR_UNKNOWN_OPERATION' });
        return handler(envelope.payload);
      },
      getURL: (path: string) => `chrome-extension://test${path}`,
      onMessage: {
        addListener: (listener: RuntimeListener) => runtimeListeners.add(listener),
        removeListener: (listener: RuntimeListener) => runtimeListeners.delete(listener),
      },
    },
    storage: {
      local: {
        get: (key: string) => Promise.resolve({ [key]: storage.get(key) }),
        set: (items: Record<string, unknown>) => {
          const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: storage.get(k), newValue: v };
            storage.set(k, v);
          }
          for (const listener of storageListeners) listener(changes, 'local');
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener: (listener: StorageListener) => storageListeners.add(listener),
        removeListener: (listener: StorageListener) => storageListeners.delete(listener),
      },
    },
    tabs: { create: () => Promise.resolve({}) },
  };
  (globalThis as { chrome?: unknown }).chrome = fake;
  return storage;
}

export function Providers(props: { children: ReactNode }): ReactNode {
  return (
    <RpcProvider sender="popup">
      <I18nProvider initial="en">{props.children}</I18nProvider>
    </RpcProvider>
  );
}
