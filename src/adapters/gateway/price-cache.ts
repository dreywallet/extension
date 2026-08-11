/**
 * Verified display-only BTC/USD quote in chrome.storage.session.
 *
 * Session storage lets a reopened popup or restarted MV3 worker paint without
 * another round trip, while keeping public market data off durable disk.
 */
import { fiatPriceQuoteSchema, type FiatPriceQuote } from '@drey/core/domain/gateway/contract';
import { z } from 'zod';
import { getJson, setJson, type StorageArea } from '../storage/area';

export const FIAT_PRICE_CACHE_KEY = 'squirrel:fiatPrice';
export const PRICE_MAX_FUTURE_SKEW_MS = 30_000;
export const PRICE_MAX_STALE_MS = 600_000;

const cachedFiatPriceSchema = z.object({
  quote: fiatPriceQuoteSchema,
  fetchedAtMs: z.number().int().nonnegative(),
  endpoint: z.string().min(1),
}).strict();

export interface CachedFiatPrice {
  quote: FiatPriceQuote;
  fetchedAtMs: number;
  endpoint: string;
}

export function isAcceptableFiatPriceQuote(quote: FiatPriceQuote, nowMs: number): boolean {
  const ageMs = nowMs - Date.parse(quote.observedAt);
  return Number.isFinite(ageMs) &&
    ageMs >= -PRICE_MAX_FUTURE_SKEW_MS &&
    ageMs <= PRICE_MAX_STALE_MS;
}

export async function loadCachedPrice(
  session: StorageArea,
  expectedEndpoint: string,
  nowMs: number,
): Promise<CachedFiatPrice | null> {
  const raw = await getJson<unknown>(session, FIAT_PRICE_CACHE_KEY);
  if (raw === undefined) return null;
  const parsed = cachedFiatPriceSchema.safeParse(raw);
  if (!parsed.success || parsed.data.endpoint !== expectedEndpoint ||
      !isAcceptableFiatPriceQuote(parsed.data.quote, nowMs)) {
    await session.remove(FIAT_PRICE_CACHE_KEY);
    return null;
  }
  return parsed.data;
}

export async function saveCachedPrice(
  session: StorageArea,
  cached: CachedFiatPrice,
): Promise<void> {
  await setJson(session, FIAT_PRICE_CACHE_KEY, cachedFiatPriceSchema.parse(cached));
}
