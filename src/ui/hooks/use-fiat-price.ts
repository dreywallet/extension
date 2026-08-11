import { useCallback, useEffect, useRef, useState } from 'react';
import type { FiatPriceQuote } from '@drey/core/domain/gateway/contract';
import { useRpc } from './use-rpc';

export const PRICE_POLL_INTERVAL_MS = 60_000;
export const PRICE_MAX_STALE_MS = 600_000;

export function useFiatPrice(enabled: boolean): {
  quote: FiatPriceQuote | null;
  stale: boolean;
  ageMinutes: number;
} {
  const rpc = useRpc();
  const [quote, setQuote] = useState<FiatPriceQuote | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const generation = useRef(0);
  const inFlight = useRef(false);

  const refresh = useCallback(() => {
    if (!enabled || inFlight.current) return;
    const requestGeneration = generation.current;
    inFlight.current = true;
    void rpc('price.quote', {})
      .then((response) => {
        if (generation.current !== requestGeneration || !response.ok || response.result === null) {
          return;
        }
        setQuote((current) =>
          current === null || Date.parse(response.result!.observedAt) >= Date.parse(current.observedAt)
            ? response.result
            : current,
        );
      })
      .finally(() => {
        if (generation.current === requestGeneration) inFlight.current = false;
      });
  }, [enabled, rpc]);

  useEffect(() => {
    generation.current += 1;
    inFlight.current = false;
    if (!enabled) {
      setQuote(null);
      return undefined;
    }
    const update = (): void => {
      if (document.visibilityState === 'hidden') return;
      setNowMs(Date.now());
      refresh();
    };
    update();
    const timer = setInterval(update, PRICE_POLL_INTERVAL_MS);
    const onResume = (): void => {
      if (document.visibilityState !== 'hidden') update();
    };
    window.addEventListener('focus', onResume);
    document.addEventListener('visibilitychange', onResume);
    return () => {
      generation.current += 1;
      inFlight.current = false;
      clearInterval(timer);
      window.removeEventListener('focus', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [enabled, refresh]);

  if (quote === null) return { quote: null, stale: false, ageMinutes: 0 };
  const ageMs = nowMs - Date.parse(quote.observedAt);
  if (!Number.isFinite(ageMs) || ageMs < -30_000 || ageMs > PRICE_MAX_STALE_MS) {
    return { quote: null, stale: false, ageMinutes: 0 };
  }
  return {
    quote,
    stale: quote.quality === 'stale' || nowMs > Date.parse(quote.expiresAt),
    ageMinutes: Math.max(0, Math.floor(ageMs / 60_000)),
  };
}
