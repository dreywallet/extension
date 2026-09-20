import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { isScanProgressEvent, isSessionStateChangedEvent, isWalletDataChangedEvent } from '@drey/core/messaging/events';
import { RUNE_SNAPSHOT_KEY, type RuneListResult } from '../../messaging/rune-ops';
import type { ActiveSessionExpectation } from './use-session';
import { useRpc } from './use-rpc';

const POLL_MS = 10_000;
type Snapshot = { data: RuneListResult | null; failed: boolean; checking: boolean };
type Entry = { snapshot: Snapshot; updatedAt: number; request: Promise<void> | null; queued: boolean; revision: number; listeners: Set<() => void> };
// Display only, for this document and exact unlocked account. Signing always
// obtains fresh evidence in the worker; this store never carries approval data.
const store = new Map<string, Entry>();
const empty = (): Snapshot => ({ data: null, failed: false, checking: true });

export function clearRunesStore(): void {
  for (const entry of store.values()) {
    entry.snapshot = empty();
    for (const listener of entry.listeners) listener();
  }
  store.clear();
}

export function useRunes(props: { expectation: ActiveSessionExpectation; accountId: string }) {
  const rpc = useRpc();
  const { expectedVaultId, expectedSessionId } = props.expectation;
  const accountId = props.accountId;
  const key = JSON.stringify([expectedVaultId, expectedSessionId, accountId]);
  const entry = useMemo(() => {
    let value = store.get(key);
    if (!value) {
      value = { snapshot: empty(), updatedAt: 0, request: null, queued: false, revision: 0, listeners: new Set() };
      store.set(key, value);
    }
    return value;
  }, [key]);
  const subscribe = useCallback((listener: () => void) => {
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }, [entry]);
  const getSnapshot = useCallback(() => entry.snapshot, [entry]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  const refresh = useCallback((force = true): Promise<void> => {
    if (entry.request) { if (force) entry.queued = true; return entry.request; }
    if (store.get(key) !== entry || (!force && Date.now() - entry.updatedAt < POLL_MS)) return Promise.resolve();
    const request = rpc('runes.list', { expectedVaultId, expectedSessionId, accountId }).then((result) => {
      if (store.get(key) !== entry) return;
      const ready = result.ok && result.result.status === 'ready';
      if (ready) entry.revision++;
      entry.snapshot = {
        data: ready ? result.result : entry.snapshot.data,
        failed: !result.ok || result.result.status === 'unavailable',
        checking: result.ok && result.result.status === 'checking',
      };
      entry.updatedAt = Date.now();
      for (const listener of entry.listeners) listener();
    }).finally(() => {
      if (entry.request === request) entry.request = null;
      if (entry.queued && store.get(key) === entry) { entry.queued = false; void refresh(); }
    });
    entry.request = request;
    return request;
  }, [rpc, entry, key, expectedVaultId, expectedSessionId, accountId]);

  useEffect(() => {
    let active = true;
    let hydration = 0;
    const hydrate = async () => {
      const generation = ++hydration;
      const revision = entry.revision;
      const result = await rpc('runes.snapshot', { expectedVaultId, expectedSessionId, accountId });
      if (!active || generation !== hydration || store.get(key) !== entry || entry.revision !== revision || !result.ok || result.result.data?.status !== 'ready') return;
      entry.snapshot = { ...entry.snapshot, data: result.result.data };
      for (const listener of entry.listeners) listener();
    };
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes[RUNE_SNAPSHOT_KEY]?.newValue) void hydrate();
    };
    chrome.storage.onChanged.addListener(onStorage);
    void hydrate();
    void refresh(false);
    const onResume = () => { if (document.visibilityState !== 'hidden') void refresh(false); };
    const timer = setInterval(onResume, POLL_MS);
    const onMessage = (message: unknown) => {
      if (isSessionStateChangedEvent(message)) {
        if (message.locked) clearRunesStore();
      } else if (isScanProgressEvent(message) || isWalletDataChangedEvent(message)) void refresh();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    window.addEventListener('focus', onResume);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      active = false;
      chrome.storage.onChanged.removeListener(onStorage);
      clearInterval(timer);
      chrome.runtime.onMessage.removeListener(onMessage);
      window.removeEventListener('focus', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [refresh, rpc, entry, key, expectedVaultId, expectedSessionId, accountId]);
  return { ...snapshot, refresh };
}
