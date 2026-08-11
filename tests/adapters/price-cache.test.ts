import { describe, expect, it } from 'vitest';
import type { FiatPriceQuote } from '@drey/core/domain/gateway/contract';
import {
  FIAT_PRICE_CACHE_KEY,
  PRICE_MAX_STALE_MS,
  loadCachedPrice,
  saveCachedPrice,
} from '../../src/adapters/gateway/price-cache';
import { makeFakeArea } from './fake-area';

const now = Date.parse('2026-08-06T12:00:00.000Z');

export function priceQuote(overrides: Partial<FiatPriceQuote> = {}): FiatPriceQuote {
  return {
    instanceId: 'gateway-1',
    network: 'mainnet',
    protocolVersion: 2,
    requestNonce: 'a'.repeat(32),
    timestamp: new Date(now).toISOString(),
    coreTip: { height: 900000, hash: 'b'.repeat(64) },
    indexTip: { height: 900000, hash: 'b'.repeat(64) },
    classificationRevision: 'mainnet-rev-1',
    capabilities: [],
    signature: 'c'.repeat(128),
    base: 'BTC',
    quote: 'USD',
    priceUsdCentsPerBtc: '10000000',
    observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 120_000).toISOString(),
    quality: 'consensus',
    sourceCount: 3,
    maxDeviationBps: 10,
    ...overrides,
  };
}

describe('fiat price session cache', () => {
  it('round-trips an acceptable quote for the same endpoint', async () => {
    const area = makeFakeArea();
    const cached = {
      quote: priceQuote(), fetchedAtMs: now, endpoint: 'https://gateway.example',
    };
    await saveCachedPrice(area, cached);
    await expect(loadCachedPrice(area, cached.endpoint, now)).resolves.toEqual(cached);
  });

  it('self-repairs malformed, cross-endpoint, and over-age records', async () => {
    const area = makeFakeArea();
    await area.set({ [FIAT_PRICE_CACHE_KEY]: { quote: 'broken' } });
    await expect(loadCachedPrice(area, 'https://gateway.example', now)).resolves.toBeNull();
    expect(area.store.has(FIAT_PRICE_CACHE_KEY)).toBe(false);

    await saveCachedPrice(area, {
      quote: priceQuote(), fetchedAtMs: now, endpoint: 'https://old.example',
    });
    await expect(loadCachedPrice(area, 'https://gateway.example', now)).resolves.toBeNull();
    expect(area.store.has(FIAT_PRICE_CACHE_KEY)).toBe(false);

    await saveCachedPrice(area, {
      quote: priceQuote({ observedAt: new Date(now - PRICE_MAX_STALE_MS - 1).toISOString() }),
      fetchedAtMs: now,
      endpoint: 'https://gateway.example',
    });
    await expect(loadCachedPrice(area, 'https://gateway.example', now)).resolves.toBeNull();
    expect(area.store.has(FIAT_PRICE_CACHE_KEY)).toBe(false);
  });
});
