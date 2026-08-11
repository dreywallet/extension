/**
 * Live §10.2 home data (balances, wrong-lane states, gating, activity) from
 * the worker's encrypted cache. Refreshes on mount, on scan progress events,
 * and on a slow poll while the surface stays mounted.
 *
 * The popup unmounts the inactive tab, so the last result is held in a
 * module-scoped store for tab switches. A cold popup also hydrates the exact
 * session/account snapshot from the worker while starting the live request;
 * the live result always wins.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isScanProgressEvent,
  isSessionStateChangedEvent,
  isWalletDataChangedEvent,
} from '@drey/core/messaging/events';
import type { WalletHomeResult } from '@drey/core/messaging/ops';
import type { ActiveSessionExpectation } from './use-session';
import { useRpc } from './use-rpc';

export const HOME_POLL_INTERVAL_MS = 15_000;
export const LIVE_SCAN_POLL_INTERVAL_MS = 60_000;

/** Popup-document lifetime only. Keyed by vault, session, and account. */
const store = new Map<string, WalletHomeResult>();

/** Drop every cached home result (lock, session end, or explicit teardown). */
export function clearWalletHomeStore(): void {
  store.clear();
}

export function useWalletHome(
  expectation: ActiveSessionExpectation | null,
  activeAccountId: string | null,
  options: { continuous?: boolean } = {},
): {
  home: WalletHomeResult | null;
  status: 'loading' | 'ready' | 'error';
  refresh: () => void;
} {
  const rpc = useRpc();
  const expectedVaultId = expectation?.expectedVaultId ?? null;
  const expectedSessionId = expectation?.expectedSessionId ?? null;
  const key = `${expectedVaultId}:${expectedSessionId}:${activeAccountId ?? 'none'}`;
  const [home, setHome] = useState<WalletHomeResult | null>(store.get(key) ?? null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    store.has(key) ? 'ready' : 'loading',
  );
  // Request generation: a vault switch changes `expectation`, and a slow
  // response from the previous vault must never land in the new vault's view.
  const generation = useRef(0);
  const homeRequest = useRef({ inFlight: false, queued: false });
  const scanRequest = useRef({ inFlight: false, token: 0 });
  const scanCheckQueued = useRef(false);
  // A session snapshot and the live request start together. If live settles
  // first, a slower storage read must never overwrite it with the prior view.
  const liveSettledGeneration = useRef(0);
  const requestLiveScanRef = useRef<() => void>(() => undefined);
  // A focus/resume request that arrives during a running scan is not lost:
  // one (and only one) follow-up refresh starts when that scan settles.
  const scanFollowupRequested = useRef(false);
  const conflictRecovery = useRef<'idle' | 'resuming' | 'rescanning'>('idle');
  const resumeScheduled = useRef(false);

  const refresh = useCallback(() => {
    if (expectedVaultId === null || expectedSessionId === null || activeAccountId === null) return;
    const requestGeneration = generation.current;
    if (homeRequest.current.inFlight) {
      homeRequest.current.queued = true;
      return;
    }
    homeRequest.current.inFlight = true;
    const run = (): void => {
      void rpc('wallet.home', { accountId: activeAccountId, expectedVaultId, expectedSessionId })
        .then((res) => {
          if (generation.current !== requestGeneration) return;
          liveSettledGeneration.current = requestGeneration;
          if (res.ok) {
            store.set(key, res.result);
            setHome(res.result);
            setStatus('ready');
          } else {
            // Never leave a seeded balance on screen behind an error: Home's
            // retry affordance is gated on `home === null`, so keeping stale
            // numbers would present them as current with no way to recover.
            store.delete(key);
            setHome(null);
            setStatus('error');
          }
        })
        .finally(() => {
          if (generation.current !== requestGeneration) return;
          if (homeRequest.current.queued) {
            homeRequest.current.queued = false;
            run();
          } else {
            homeRequest.current.inFlight = false;
          }
        });
    };
    run();
  }, [activeAccountId, expectedSessionId, expectedVaultId, key, rpc]);

  const requestLiveScan = useCallback(() => {
    if (
      expectedVaultId === null ||
      expectedSessionId === null ||
      document.visibilityState === 'hidden'
    ) return;
    if (scanRequest.current.inFlight) {
      scanCheckQueued.current = true;
      return;
    }
    const requestGeneration = generation.current;
    const token = scanRequest.current.token + 1;
    scanRequest.current = { inFlight: true, token };
    void rpc('scan.status', { expectedVaultId, expectedSessionId })
      .then((res) => {
        if (generation.current !== requestGeneration || !res.ok) return;
        if (res.result.kind === 'interrupted' || res.result.kind === 'failed') {
          return rpc('scan.start', { mode: 'resume', expectedVaultId, expectedSessionId });
        }
        // Never duplicate a running scan, restart a user cancellation, or
        // overwrite an explicit Extended-scan prompt.
        if (res.result.kind === 'running') {
          scanFollowupRequested.current = true;
          return;
        }
        if (res.result.kind !== 'idle' && res.result.kind !== 'completed') return;
        scanFollowupRequested.current = false;
        return rpc('scan.start', { mode: 'refresh', expectedVaultId, expectedSessionId });
      })
      .finally(() => {
        if (scanRequest.current.token !== token) return;
        scanRequest.current.inFlight = false;
        const checkQueued = scanCheckQueued.current;
        scanCheckQueued.current = false;
        if (checkQueued && scanFollowupRequested.current) {
          queueMicrotask(() => requestLiveScanRef.current());
        }
      });
  }, [expectedSessionId, expectedVaultId, rpc]);
  requestLiveScanRef.current = requestLiveScan;

  useEffect(() => {
    generation.current += 1;
    scanRequest.current = { inFlight: false, token: scanRequest.current.token + 1 };
    scanCheckQueued.current = false;
    scanFollowupRequested.current = false;
    conflictRecovery.current = 'idle';
    homeRequest.current = { inFlight: false, queued: false };
    // Seed from the store so a tab switch renders the prior view instead of a
    // loading flash; the refresh below still revalidates it.
    const seeded = store.get(key) ?? null;
    setHome(seeded);
    setStatus(seeded === null ? 'loading' : 'ready');
    if (seeded === null && expectedVaultId !== null && expectedSessionId !== null &&
        activeAccountId !== null) {
      const hydrationGeneration = generation.current;
      void rpc('wallet.home.snapshot', {
        accountId: activeAccountId,
        expectedVaultId,
        expectedSessionId,
      }).then((response) => {
        if (generation.current !== hydrationGeneration ||
            liveSettledGeneration.current === hydrationGeneration ||
            !response.ok || response.result.home === null) return;
        store.set(key, response.result.home);
        setHome(response.result.home);
        setStatus('ready');
      });
    }
    refresh();
    requestLiveScan();
    const continuous = options.continuous !== false;
    const homeTimer = continuous ? setInterval(refresh, HOME_POLL_INTERVAL_MS) : null;
    const scanTimer = continuous ? setInterval(requestLiveScan, LIVE_SCAN_POLL_INTERVAL_MS) : null;
    const onMessage = (message: unknown): void => {
      if (isSessionStateChangedEvent(message)) {
        if (message.locked) clearWalletHomeStore();
        return;
      }
      if (isScanProgressEvent(message)) {
        refresh();
        if (scanFollowupRequested.current) requestLiveScan();
        return;
      }
      if (!isWalletDataChangedEvent(message)) return;
      if (message.reason === 'transaction') {
        refresh();
        requestLiveScan();
      } else if (message.reason === 'utxo') {
        refresh();
      }
    };
    const onResume = (): void => {
      if (document.visibilityState === 'hidden') return;
      if (resumeScheduled.current) return;
      resumeScheduled.current = true;
      queueMicrotask(() => {
        resumeScheduled.current = false;
        refresh();
        requestLiveScan();
      });
    };
    chrome.runtime.onMessage.addListener(onMessage);
    if (continuous) {
      window.addEventListener('focus', onResume);
      document.addEventListener('visibilitychange', onResume);
    }
    return () => {
      if (homeTimer !== null) clearInterval(homeTimer);
      if (scanTimer !== null) clearInterval(scanTimer);
      resumeScheduled.current = false;
      chrome.runtime.onMessage.removeListener(onMessage);
      window.removeEventListener('focus', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [activeAccountId, key, options.continuous, refresh, requestLiveScan]);

  useEffect(() => {
    if (home?.dataGating.state === 'fresh' && home.scan.kind === 'completed') {
      conflictRecovery.current = 'idle';
      return;
    }
    if (home?.dataGating.state !== 'conflicting_sources') return;
    if ((home.scan.kind === 'failed' || home.scan.kind === 'interrupted') &&
        conflictRecovery.current === 'idle') {
      conflictRecovery.current = 'resuming';
      requestLiveScan();
      return;
    }
    if (home.scan.kind === 'completed' && conflictRecovery.current !== 'rescanning') {
      conflictRecovery.current = 'rescanning';
      requestLiveScan();
    }
  }, [home?.dataGating.state, home?.scan.kind, requestLiveScan]);

  return { home, status, refresh };
}
