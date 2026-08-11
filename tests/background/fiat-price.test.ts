import { describe, expect, it } from 'vitest';
import type { FiatPriceQuote } from '@drey/core/domain/gateway/contract';
import type { GatewayClient } from '@drey/core/gateway-client';
import { FIAT_PRICE_CACHE_KEY } from '../../src/adapters/gateway/price-cache';
import { PRICE_MIN_REFETCH_MS } from '../../src/background/wallet-service';
import { makeHarness } from './service-helpers';

const now = Date.parse('2026-08-06T12:00:00.000Z');

function priceQuote(): FiatPriceQuote {
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
  };
}

function rig() {
  let calls = 0;
  let failing = false;
  let release: (() => void) | null = null;
  let blocked = false;
  const gateway = {
    endpoint: 'https://gateway.example',
    fetchPrice: async () => {
      calls += 1;
      if (blocked) await new Promise<void>((resolve) => { release = resolve; });
      return failing
        ? { ok: false as const, reason: 'network_error' as const }
        : { ok: true as const, value: priceQuote(), verifiedAtMs: harness.clock.now };
    },
  } as unknown as GatewayClient;
  const harness = makeHarness(now, { network: 'mainnet', gateway });
  return {
    harness,
    calls: () => calls,
    fail: () => { failing = true; },
    block: () => { blocked = true; },
    release: () => { blocked = false; release?.(); },
  };
}

describe('WalletService.fiatPriceQuote', () => {
  it('shares one fetch and survives a worker restart through session storage', async () => {
    const r = rig();
    r.block();
    const pending = [
      r.harness.service.fiatPriceQuote(),
      r.harness.service.fiatPriceQuote(),
      r.harness.service.fiatPriceQuote(),
    ];
    for (let attempt = 0; attempt < 10 && r.calls() === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(r.calls()).toBe(1);
    r.release();
    const values = await Promise.all(pending);
    expect(values[1]).toEqual(values[0]);
    expect(values[2]).toEqual(values[0]);
    expect(r.harness.session.store.has(FIAT_PRICE_CACHE_KEY)).toBe(true);

    const restarted = r.harness.rebuild();
    await expect(restarted.fiatPriceQuote()).resolves.toEqual(values[0]);
    expect(r.calls()).toBe(1);
  });

  it('refetches after the minimum window and falls back to an acceptable cached quote', async () => {
    const r = rig();
    const first = await r.harness.service.fiatPriceQuote();
    r.harness.clock.now += PRICE_MIN_REFETCH_MS + 1;
    r.fail();
    await expect(r.harness.service.fiatPriceQuote()).resolves.toEqual(first);
    expect(r.calls()).toBe(2);
  });

  it('returns null without a mainnet gateway', async () => {
    await expect(makeHarness(now, { network: 'signet' }).service.fiatPriceQuote())
      .resolves.toBeNull();
  });
});
