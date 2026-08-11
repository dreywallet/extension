import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreFixturesDir } from '../helpers/core-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { GatewayClient } from '@drey/core/gateway-client';
import { GATEWAY_STATUS_KEY } from '../../src/adapters/gateway/status-cache';
import { GATEWAY_MIN_REFETCH_MS } from '../../src/background/wallet-service';
import { STATUS_STALE_AFTER_MS } from '@drey/core/domain/gateway/status-view';
import { makeHarness } from './service-helpers';

const fixturesDir = join(coreFixturesDir, 'gateway');
const signedTemplate = new Uint8Array(readFileSync(join(fixturesDir, 'status.signed.json')));
const devPublicKeyHex = (
  JSON.parse(readFileSync(join(fixturesDir, 'dev-public-key.json'), 'utf8')) as {
    publicKeyHex: string;
  }
).publicKeyHex;
// Clock base: the fixture's mempoolObservedAt (10 s after its envelope
// timestamp) — the heartbeat is exactly fresh and the signature skew is 10 s.
const fixtureTimestampMs = Date.parse(
  (JSON.parse(new TextDecoder().decode(signedTemplate)) as { mempoolObservedAt: string })
    .mempoolObservedAt,
);

beforeAll(async () => {
  await installTestCryptoProvider();
});

interface FetchScript {
  calls: number;
  respond: () => Promise<Response>;
}

function makeGatewayHarness(opts: { failing?: boolean } = {}) {
  const script: FetchScript = {
    calls: 0,
    respond: async () =>
      opts.failing
        ? new Response('down', { status: 503 })
        : new Response(signedTemplate.slice().buffer, { status: 200 }),
  };
  // The signed fixture's timestamp must be within the skew window of the fake
  // clock, so the harness clock starts at the fixture's own instant. The
  // client lazily closes over the harness clock (declared below, called only
  // after construction) so both tick together.
  const gateway = new GatewayClient({
    fetchFn: async () => {
      script.calls += 1;
      return script.respond();
    },
    baseUrl: 'http://127.0.0.1:8080',
    publicKeyHex: devPublicKeyHex,
    expectedNetwork: 'signet',
    randomNonce: () => 'fixture-nonce-0001',
    now: () => harness.clock.now,
  });
  const harness = makeHarness(fixtureTimestampMs, { gateway });
  return { harness, script, gateway };
}

describe('WalletService.gatewayStatus', () => {
  it('fetches, verifies, caches to session storage, and reports degraded (Standard mode)', async () => {
    const { harness, script } = makeGatewayHarness();
    const view = await harness.service.gatewayStatus();
    expect(script.calls).toBe(1);
    expect(view.state).toBe('degraded');
    expect(view.network).toBe('signet');
    expect(view.mode).toBe('standard_ordinals_safety');
    expect(view.missingProtections).toContain('sat_index');
    expect(harness.session.store.has(GATEWAY_STATUS_KEY)).toBe(true);
  });

  it('answers while locked (§7.5 security checks continue)', async () => {
    const { harness } = makeGatewayHarness();
    expect((await harness.service.sessionStatus()).locked).toBe(true);
    const view = await harness.service.gatewayStatus();
    expect(view.state).toBe('degraded');
  });

  it('skips the network within the min-refetch window and honors forceRefresh', async () => {
    const { harness, script } = makeGatewayHarness();
    await harness.service.gatewayStatus();
    harness.clock.now += GATEWAY_MIN_REFETCH_MS - 1;
    await harness.service.gatewayStatus();
    expect(script.calls).toBe(1);
    await harness.service.gatewayStatus({ forceRefresh: true });
    expect(script.calls).toBe(2);
    harness.clock.now += GATEWAY_MIN_REFETCH_MS + 1;
    await harness.service.gatewayStatus();
    expect(script.calls).toBe(3);
  });

  it('shares one fetch between concurrent callers (single-flight)', async () => {
    const { harness, script } = makeGatewayHarness();
    const [a, b, c] = await Promise.all([
      harness.service.gatewayStatus(),
      harness.service.gatewayStatus(),
      harness.service.gatewayStatus(),
    ]);
    expect(script.calls).toBe(1);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
  });

  it('refetches for forceRefresh arriving during a cache-only status poll', async () => {
    const { harness, script } = makeGatewayHarness();
    await harness.service.gatewayStatus();
    expect(script.calls).toBe(1);

    // Inside the min-refetch window an unforced poll answers from cache without
    // touching the network. A spending path that asked to revalidate must not
    // inherit that run's answer just because it happened to be in flight.
    harness.clock.now += GATEWAY_MIN_REFETCH_MS - 1;
    const poll = harness.service.gatewayStatus();
    const forced = harness.service.gatewayStatus({ forceRefresh: true });
    await Promise.all([poll, forced]);
    expect(script.calls).toBe(2);
  });

  it('shares one refetch between several forceRefresh callers behind a cache-only poll', async () => {
    const { harness, script } = makeGatewayHarness();
    await harness.service.gatewayStatus();
    expect(script.calls).toBe(1);

    // Every forced caller queues behind the same cache-only run, so each learns
    // it was not revalidated at the same moment. Only the first may start the
    // real fetch: the rest join it rather than each paying its own round trip.
    harness.clock.now += GATEWAY_MIN_REFETCH_MS - 1;
    const poll = harness.service.gatewayStatus();
    const forced = [
      harness.service.gatewayStatus({ forceRefresh: true }),
      harness.service.gatewayStatus({ forceRefresh: true }),
      harness.service.gatewayStatus({ forceRefresh: true }),
    ];
    const [, ...forcedViews] = await Promise.all([poll, ...forced]);
    expect(script.calls).toBe(2);
    expect(forcedViews[1]).toEqual(forcedViews[0]);
    expect(forcedViews[2]).toEqual(forcedViews[0]);
  });

  it('shares an in-flight status poll with forceRefresh when that poll reaches the gateway', async () => {
    const { harness, script } = makeGatewayHarness();
    // Past the min-refetch window the poll performs a real fetch, so its result
    // is exactly what a forceRefresh caller wanted. Sharing keeps the send path
    // at one round trip instead of serialising two.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const respond = script.respond;
    script.respond = async () => { await gate; return respond(); };

    const poll = harness.service.gatewayStatus();
    const forced = harness.service.gatewayStatus({ forceRefresh: true });
    release();
    const [pollView, forcedView] = await Promise.all([poll, forced]);
    expect(script.calls).toBe(1);
    expect(forcedView).toEqual(pollView);
  });

  it('keeps the prior verified snapshot when a later fetch fails, then decays to unreachable', async () => {
    const { harness, script } = makeGatewayHarness();
    await harness.service.gatewayStatus();
    script.respond = async () => new Response('down', { status: 503 });

    harness.clock.now += GATEWAY_MIN_REFETCH_MS + 1;
    const survivingView = await harness.service.gatewayStatus();
    // The verified snapshot is still §18.4-fresh: view stays degraded, with
    // the failure recorded.
    expect(survivingView.state).toBe('degraded');
    expect(survivingView.network).toBe('signet');
    expect(survivingView.lastReason).toBe('http');

    harness.clock.now += 30_000;
    // Heartbeat now exceeds 30 s: stale, but last-known data survives.
    const staleView = await harness.service.gatewayStatus();
    expect(staleView.state).toBe('stale');
    expect(staleView.network).toBe('signet');

    harness.clock.now += STATUS_STALE_AFTER_MS + 1;
    const deadView = await harness.service.gatewayStatus();
    expect(deadView.state).toBe('unreachable');
    expect(deadView.tipHeight).toBe(250000);
  });

  it('reports unreachable with the failure reason when nothing was ever verified', async () => {
    const { harness } = makeGatewayHarness({ failing: true });
    const view = await harness.service.gatewayStatus();
    expect(view.state).toBe('unreachable');
    expect(view.lastReason).toBe('http');
    expect(view.network).toBeNull();
  });

  it('survives a worker restart from the session cache without refetching', async () => {
    const { harness, script } = makeGatewayHarness();
    await harness.service.gatewayStatus();
    const restarted = harness.rebuild();
    const view = await restarted.gatewayStatus();
    expect(script.calls).toBe(1);
    expect(view.state).toBe('degraded');
  });

  it('reports unreachable when no gateway is wired at all', async () => {
    const harness = makeHarness();
    const view = await harness.service.gatewayStatus();
    expect(view.state).toBe('unreachable');
    expect(view.lastReason).toBeNull();
  });
});
