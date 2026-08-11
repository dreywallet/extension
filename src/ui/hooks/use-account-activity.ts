import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isScanProgressEvent,
  isSessionStateChangedEvent,
  isWalletDataChangedEvent,
} from '@drey/core/messaging/events';
import type { OpResult } from '../../adapters/rpc-client';
import type { ActiveSessionExpectation } from './use-session';
import { useRpc } from './use-rpc';

type ActivityPage = OpResult<'activity.list'>;
type ActivityCursor = NonNullable<ActivityPage['nextCursor']>;
type ActivityItems = ActivityPage['items'];
type LoadState = 'loading' | 'ready' | 'error';

interface StoredActivityPage {
  items: ActivityItems;
  nextCursor: ActivityCursor | null;
}

const store = new Map<string, StoredActivityPage>();

export function clearAccountActivityStore(): void {
  store.clear();
}

export function useAccountActivity(
  expectation: ActiveSessionExpectation,
  accountId: string,
  options: { enabled?: boolean } = {},
): {
  items: ActivityItems | null;
  loadState: LoadState;
  hasMore: boolean;
  loadingOlder: boolean;
  refreshing: boolean;
  pageError: boolean;
  updated: boolean;
  loadOlder: () => void;
  refresh: () => void;
} {
  const rpc = useRpc();
  const enabled = options.enabled !== false;
  const { expectedVaultId, expectedSessionId } = expectation;
  const key = `${expectedVaultId}:${expectedSessionId}:${accountId}`;
  const seeded = store.get(key) ?? null;
  const [items, setItems] = useState<ActivityItems | null>(seeded?.items ?? null);
  const [nextCursor, setNextCursor] = useState<ActivityCursor | null>(
    seeded?.nextCursor ?? null,
  );
  const [loadState, setLoadState] = useState<LoadState>(seeded ? 'ready' : 'loading');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pageError, setPageError] = useState(false);
  const [updated, setUpdated] = useState(false);
  const scopeKey = useRef(key);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const queuedRefresh = useRef(false);
  const requestRef = useRef<(mode: 'replace' | 'append', cursor: ActivityCursor | null) => void>(
    () => undefined,
  );

  const request = useCallback((mode: 'replace' | 'append', cursor: ActivityCursor | null) => {
    if (!enabled) return;
    if (inFlight.current) {
      if (mode === 'replace') queuedRefresh.current = true;
      return;
    }
    const requestGeneration = generation.current;
    inFlight.current = true;
    setPageError(false);
    if (mode === 'append') setLoadingOlder(true);
    else {
      setRefreshing((current) => items !== null || current);
      setUpdated(false);
    }
    void rpc('activity.list', {
      accountId,
      expectedVaultId,
      expectedSessionId,
      cursor,
    }).then((response) => {
      if (generation.current !== requestGeneration) return;
      if (!response.ok || response.result.accountId !== accountId) {
        if (mode === 'replace' && items === null) setLoadState('error');
        else setPageError(true);
        return;
      }
      const replace = mode === 'replace' || response.result.reset;
      setItems((current) => {
        const nextItems = replace
          ? response.result.items
          : [...(current ?? []), ...response.result.items.filter(
              (item) => !(current ?? []).some((existing) => existing.txid === item.txid),
            )];
        store.set(key, { items: nextItems, nextCursor: response.result.nextCursor });
        return nextItems;
      });
      setNextCursor(response.result.nextCursor);
      setUpdated(response.result.reset);
      setLoadState('ready');
    }).finally(() => {
      if (generation.current !== requestGeneration) return;
      inFlight.current = false;
      setLoadingOlder(false);
      setRefreshing(false);
      if (queuedRefresh.current) {
        queuedRefresh.current = false;
        queueMicrotask(() => requestRef.current('replace', null));
      }
    });
  }, [accountId, enabled, expectedSessionId, expectedVaultId, items, key, rpc]);
  requestRef.current = request;

  const refresh = useCallback(() => request('replace', null), [request]);
  const loadOlder = useCallback(() => {
    if (nextCursor !== null) request('append', nextCursor);
  }, [nextCursor, request]);

  useEffect(() => {
    if (scopeKey.current !== key) {
      clearAccountActivityStore();
      scopeKey.current = key;
    }
    generation.current += 1;
    inFlight.current = false;
    queuedRefresh.current = false;
    const current = store.get(key) ?? null;
    setItems(current?.items ?? null);
    setNextCursor(current?.nextCursor ?? null);
    setLoadState(current ? 'ready' : 'loading');
    setLoadingOlder(false);
    setRefreshing(false);
    setPageError(false);
    setUpdated(false);
    if (enabled) requestRef.current('replace', null);

    const onMessage = (message: unknown): void => {
      if (isSessionStateChangedEvent(message)) {
        if (message.locked) {
          clearAccountActivityStore();
          generation.current += 1;
          inFlight.current = false;
          queuedRefresh.current = false;
          setItems(null);
          setNextCursor(null);
          setLoadState('loading');
          setLoadingOlder(false);
          setRefreshing(false);
          setPageError(false);
          setUpdated(false);
        }
        return;
      }
      if (isScanProgressEvent(message)) {
        requestRef.current('replace', null);
        return;
      }
      if (!isWalletDataChangedEvent(message)) return;
      if (message.reason === 'transaction' || message.reason === 'utxo' ||
          message.reason === 'account') {
        requestRef.current('replace', null);
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      generation.current += 1;
      inFlight.current = false;
      queuedRefresh.current = false;
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, [enabled, key]);

  return {
    items: scopeKey.current === key ? items : null,
    loadState: scopeKey.current === key ? loadState : 'loading',
    hasMore: scopeKey.current === key && nextCursor !== null,
    loadingOlder,
    refreshing,
    pageError,
    updated,
    loadOlder,
    refresh,
  };
}
