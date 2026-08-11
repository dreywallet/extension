import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayStatusView } from '@drey/core/domain/gateway/status-view';
import {
  GATEWAY_POLL_INTERVAL_MS,
  GATEWAY_RESUME_RETRY_MS,
  GATEWAY_TRANSIENT_GRACE_MS,
  useGatewayStatus,
} from '../../src/ui/hooks/use-gateway-status';
import { installFakeChrome, Providers } from './fake-rpc';

function gatewayView(
  state: GatewayStatusView['state'],
  overrides: Partial<GatewayStatusView> = {},
): GatewayStatusView {
  return {
    state,
    network: 'mainnet',
    mode: 'full_sat_safety',
    missingProtections: [],
    tipHeight: 959_188,
    verifiedAtMs: Date.now(),
    ageMs: 0,
    lastReason: null,
    walletDataFresh: state === 'connected',
    spendingReady: state === 'connected',
    classificationState: state === 'connected' ? 'active' : 'advancing',
    reorgState: 'clear',
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useGatewayStatus resume refresh', () => {
  it('uses cache-aware routine checks for a persistent panel', async () => {
    const payloads: unknown[] = [];
    installFakeChrome({
      'gateway.status': (payload) => {
        payloads.push(payload);
        return { ok: true, result: gatewayView('connected') };
      },
    });
    renderHook(() => useGatewayStatus({ persistent: true }), { wrapper: Providers });
    await act(async () => { await Promise.resolve(); });
    expect(payloads).toEqual([{ forceRefresh: true }]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GATEWAY_POLL_INTERVAL_MS);
    });
    expect(payloads).toEqual([{ forceRefresh: true }, {}]);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GATEWAY_POLL_INTERVAL_MS);
    });
    expect(payloads).toHaveLength(2);
  });

  it('coalesces focus events and hides a transient unready state that recovers within grace', async () => {
    const payloads: unknown[] = [];
    const states: GatewayStatusView['state'][] = ['connected', 'stale', 'stale', 'connected'];
    installFakeChrome({
      'gateway.status': (payload) => {
        payloads.push(payload);
        return { ok: true, result: gatewayView(states.shift() ?? 'connected') };
      },
    });
    const { result, unmount } = renderHook(() => useGatewayStatus(), { wrapper: Providers });

    await act(async () => { await Promise.resolve(); });
    expect(result.current?.state).toBe('connected');
    expect(payloads).toEqual([{ forceRefresh: true }]);

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current?.state).toBe('connected');
    expect(payloads).toEqual([{ forceRefresh: true }, { forceRefresh: true }]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GATEWAY_RESUME_RETRY_MS);
    });
    expect(result.current?.state).toBe('connected');
    expect(payloads).toEqual([
      { forceRefresh: true },
      { forceRefresh: true },
      { forceRefresh: true },
    ]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GATEWAY_RESUME_RETRY_MS);
    });
    expect(result.current?.state).toBe('connected');
    expect(payloads).toEqual([
      { forceRefresh: true },
      { forceRefresh: true },
      { forceRefresh: true },
      { forceRefresh: true },
    ]);

    unmount();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(GATEWAY_RESUME_RETRY_MS);
    });
    expect(payloads).toHaveLength(4);
  });

  it('publishes sustained normal convergence after ten seconds and keeps retrying', async () => {
    const payloads: unknown[] = [];
    let connected = true;
    installFakeChrome({
      'gateway.status': (payload) => {
        payloads.push(payload);
        const state = connected ? 'connected' : 'read_only';
        connected = false;
        return {
          ok: true,
          result: gatewayView(state, state === 'read_only' ? {
            mode: null,
            walletDataFresh: false,
            spendingReady: false,
            commonTip: false,
            readinessReasons: [
              'classification_revision_mismatch',
              'classification_tip_mismatch',
              'spending_endpoints_unavailable',
              'tip_mismatch',
            ],
          } : {}),
        };
      },
    });
    const { result } = renderHook(() => useGatewayStatus(), { wrapper: Providers });
    await act(async () => { await Promise.resolve(); });
    expect(result.current?.state).toBe('connected');

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current?.state).toBe('connected');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GATEWAY_TRANSIENT_GRACE_MS - 1);
    });
    expect(result.current?.state).toBe('connected');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current?.state).toBe('read_only');
    expect(payloads.length).toBeGreaterThanOrEqual(7);
  });

  it('publishes non-routine stale, blocked, reorg, and conflicting states immediately', async () => {
    const states = [
      gatewayView('stale', {
        walletDataFresh: false,
        commonTip: true,
        classificationState: 'blocked',
        readinessReasons: ['classification_unavailable'],
      }),
      gatewayView('read_only', {
        walletDataFresh: true,
        spendingReady: false,
        commonTip: true,
        classificationState: 'active',
        readinessReasons: ['capacity_low', 'spending_endpoints_unavailable'],
      }),
      gatewayView('unreachable', {
        walletDataFresh: false,
        commonTip: null,
        classificationState: null,
        readinessReasons: ['ord_unavailable'],
      }),
      gatewayView('stale', {
        walletDataFresh: false,
        commonTip: false,
        classificationState: 'reconciling',
        reorgState: 'reconciling',
        readinessReasons: ['reorg_reconciling', 'tip_mismatch'],
      }),
      gatewayView('stale', {
        walletDataFresh: false,
        commonTip: false,
        classificationState: 'advancing',
        lastReason: 'conflicting_sources',
        readinessReasons: ['tip_mismatch'],
      }),
    ];
    installFakeChrome({
      'gateway.status': () => ({ ok: true, result: states.shift() ?? gatewayView('connected') }),
    });
    const { result } = renderHook(() => useGatewayStatus(), { wrapper: Providers });

    await act(async () => { await Promise.resolve(); });
    expect(result.current?.state).toBe('stale');

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current?.state).toBe('read_only');

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current?.state).toBe('unreachable');

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current?.reorgState).toBe('reconciling');

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current?.lastReason).toBe('conflicting_sources');
  });

  it('cancels stale retries while the document remains hidden', async () => {
    const payloads: unknown[] = [];
    installFakeChrome({
      'gateway.status': (payload) => {
        payloads.push(payload);
        return { ok: true, result: gatewayView('stale') };
      },
    });
    renderHook(() => useGatewayStatus(), { wrapper: Providers });
    await act(async () => { await Promise.resolve(); });

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(GATEWAY_RESUME_RETRY_MS);
    });
    expect(payloads).toEqual([{ forceRefresh: true }]);
  });
});
