import { useEffect, useRef } from 'react';
import type { ActiveSessionExpectation } from './use-session';
import { useRpc } from './use-rpc';

export const SESSION_ACTIVITY_THROTTLE_MS = 30_000;

/**
 * Extend the idle window only for real interaction with an unlocked wallet.
 * Passive rendering, polling, focus changes, and background data never call
 * this hook's RPC, so a visible-but-unattended wallet still locks on time.
 */
export function useSessionActivity(expectation: ActiveSessionExpectation | null): void {
  const rpc = useRpc();
  const lastTouchAt = useRef(Number.NEGATIVE_INFINITY);
  const expectedVaultId = expectation?.expectedVaultId ?? null;
  const expectedSessionId = expectation?.expectedSessionId ?? null;

  useEffect(() => {
    lastTouchAt.current = Number.NEGATIVE_INFINITY;
    if (expectedVaultId === null || expectedSessionId === null) return undefined;

    const touch = (): void => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastTouchAt.current < SESSION_ACTIVITY_THROTTLE_MS) return;
      lastTouchAt.current = now;
      void rpc('session.touch', { expectedVaultId, expectedSessionId });
    };

    document.addEventListener('pointerdown', touch, { capture: true, passive: true });
    document.addEventListener('keydown', touch, true);
    document.addEventListener('click', touch, { capture: true, passive: true });
    document.addEventListener('wheel', touch, { capture: true, passive: true });
    return () => {
      document.removeEventListener('pointerdown', touch, true);
      document.removeEventListener('keydown', touch, true);
      document.removeEventListener('click', touch, true);
      document.removeEventListener('wheel', touch, true);
    };
  }, [expectedSessionId, expectedVaultId, rpc]);
}
