/**
 * Live gateway status for UI surfaces (spec §10.2, §18.4). Forces a fresh
 * status on mount/resume and re-polls only while the surface stays mounted —
 * popup closed means no polling at all. A visible stale response is retried
 * until the gateway catches up. Staleness itself is computed worker-side at
 * read time, so even a missed poll never presents old data as fresh.
 */
import { useEffect, useRef, useState } from 'react';
import {
  isGatewaySyncing,
  type GatewayStatusView,
} from '@drey/core/domain/gateway/status-view';
import { useRpc } from './use-rpc';

export const GATEWAY_POLL_INTERVAL_MS = 15_000;
export const GATEWAY_RESUME_RETRY_MS = 1_000;
export const GATEWAY_TRANSIENT_GRACE_MS = 10_000;

export function useGatewayStatus(options: { persistent?: boolean } = {}): GatewayStatusView | null {
  const rpc = useRpc();
  const [view, setView] = useState<GatewayStatusView | null>(null);
  const unreadySinceRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let requestGeneration = 0;
    let resumeScheduled = false;
    let freshnessRetry: ReturnType<typeof setTimeout> | null = null;

    const clearFreshnessRetry = () => {
      if (freshnessRetry !== null) clearTimeout(freshnessRetry);
      freshnessRetry = null;
    };
    const tick = (forceRefresh = false, retryUntilFresh = false) => {
      const generation = ++requestGeneration;
      void rpc('gateway.status', forceRefresh ? { forceRefresh: true } : {}).then((res) => {
        if (cancelled || generation !== requestGeneration || !res.ok) return;
        const walletDataUnready =
          res.result.state === 'stale' || res.result.walletDataFresh === false;
        const normalConvergence = isGatewaySyncing(res.result);
        if (normalConvergence) {
          const now = Date.now();
          unreadySinceRef.current ??= now;
          const elapsed = now - unreadySinceRef.current;
          if (elapsed < GATEWAY_TRANSIENT_GRACE_MS &&
              retryUntilFresh && document.visibilityState !== 'hidden') {
            clearFreshnessRetry();
            freshnessRetry = setTimeout(
              () => tick(true, true),
              Math.min(GATEWAY_RESUME_RETRY_MS, GATEWAY_TRANSIENT_GRACE_MS - elapsed),
            );
            return;
          }
        } else {
          // Only routine convergence receives a presentation grace period.
          // Faults and non-routine stale states must surface immediately.
          unreadySinceRef.current = null;
        }
        setView(res.result);
        if (retryUntilFresh && walletDataUnready && document.visibilityState !== 'hidden') {
          clearFreshnessRetry();
          freshnessRetry = setTimeout(
            () => tick(true, true),
            GATEWAY_RESUME_RETRY_MS,
          );
        } else if (!walletDataUnready) {
          clearFreshnessRetry();
        }
      });
    };
    const refreshAfterResume = () => {
      if (document.visibilityState === 'hidden') {
        clearFreshnessRetry();
        return;
      }
      if (resumeScheduled) return;
      // Chrome can emit visibilitychange and focus together. Coalesce that
      // event burst into one forced request after any suspended promise has
      // had a chance to settle.
      resumeScheduled = true;
      queueMicrotask(() => {
        resumeScheduled = false;
        if (!cancelled) tick(true, true);
      });
    };
    tick(true, true);
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      // A persistent panel can exist in several browser windows. Routine reads
      // use the worker's verified cache/min-refetch guard so those documents do
      // not each force their own gateway request. Mount/resume and stale retries
      // remain forced above.
      tick(options.persistent !== true, true);
    }, GATEWAY_POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', refreshAfterResume);
    window.addEventListener('focus', refreshAfterResume);
    return () => {
      cancelled = true;
      requestGeneration += 1;
      clearInterval(timer);
      clearFreshnessRetry();
      unreadySinceRef.current = null;
      document.removeEventListener('visibilitychange', refreshAfterResume);
      window.removeEventListener('focus', refreshAfterResume);
    };
  }, [options.persistent, rpc]);

  return view;
}
