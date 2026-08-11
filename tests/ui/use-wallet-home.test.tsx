/**
 * useWalletHome request-generation guard: a slow wallet.home response from a
 * previous vault/session must never land in the current vault's view, and the
 * view clears immediately when the expectation changes.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
import { useWalletHome } from '../../src/ui/hooks/use-wallet-home';
import type { WalletHomeResult } from '@drey/core/messaging/ops';
import type { ActiveSessionExpectation } from '../../src/ui/hooks/use-session';
import { emitRuntimeMessage, installFakeChrome, Providers } from './fake-rpc';

const VAULT_A: ActiveSessionExpectation = {
  expectedVaultId: 'vault-a',
  expectedSessionId: '00000000-0000-4000-8000-00000000000a',
};
const VAULT_B: ActiveSessionExpectation = {
  expectedVaultId: 'vault-b',
  expectedSessionId: '00000000-0000-4000-8000-00000000000b',
};
const ACCOUNT_ID = `acct_mainnet_${'1'.repeat(64)}`;
const OTHER_ACCOUNT_ID = `acct_mainnet_${'2'.repeat(64)}`;

function homeResult(availableSats: string): WalletHomeResult {
  return {
    accountId: ACCOUNT_ID,
    balances: {
      availableSats,
      protectedSats: '0',
      reservedSats: '0',
      pendingSats: '0',
      frozenSats: '0',
      unavailableCleanSats: '0',
    },
    protectionBreakdown: {
      assetSats: '0',
      awaitingClassificationSats: '0',
      userFrozenSats: '0',
      dustQuarantinedSats: '0',
    },
    collectiblesCount: 0,
    wrongLaneCount: 0,
    dataGating: { state: 'fresh', blockedActions: [] },
    activity: [],
    wrongLane: [],
    lastSyncedAt: null,
    scan: {
      kind: 'idle',
      scanId: null,
      unitsDone: 0,
      unitsTotal: 0,
      currentUnit: null,
      boundaryUnits: [],
      failureReason: null,
    },
  };
}

describe('useWalletHome vault-switch guard', () => {
  it('hydrates the exact session snapshot while live Home revalidates silently', async () => {
    let resolveLive: (value: unknown) => void = () => undefined;
    const live = new Promise((resolve) => { resolveLive = resolve; });
    installFakeChrome({
      'wallet.home.snapshot': () => ({ ok: true, result: { home: homeResult('111') } }),
      'wallet.home': () => live,
    });

    const { result } = renderHook(() => useWalletHome(VAULT_A, ACCOUNT_ID), {
      wrapper: Providers,
    });
    await waitFor(() => expect(result.current.home?.balances.availableSats).toBe('111'));
    expect(result.current.status).toBe('ready');

    resolveLive({ ok: true, result: homeResult('222') });
    await waitFor(() => expect(result.current.home?.balances.availableSats).toBe('222'));
    expect(result.current.status).toBe('ready');
  });

  it('never lets a late snapshot overwrite a live result', async () => {
    let resolveSnapshot: (value: unknown) => void = () => undefined;
    const snapshot = new Promise((resolve) => { resolveSnapshot = resolve; });
    installFakeChrome({
      'wallet.home.snapshot': () => snapshot,
      'wallet.home': () => ({ ok: true, result: homeResult('222') }),
    });

    const { result } = renderHook(() => useWalletHome(VAULT_A, ACCOUNT_ID), {
      wrapper: Providers,
    });
    await waitFor(() => expect(result.current.home?.balances.availableSats).toBe('222'));

    resolveSnapshot({ ok: true, result: { home: homeResult('111') } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.home?.balances.availableSats).toBe('222');
  });

  it('removes a hydrated snapshot when live verification fails', async () => {
    let resolveLive: (value: unknown) => void = () => undefined;
    const live = new Promise((resolve) => { resolveLive = resolve; });
    installFakeChrome({
      'wallet.home.snapshot': () => ({ ok: true, result: { home: homeResult('111') } }),
      'wallet.home': () => live,
    });

    const { result } = renderHook(() => useWalletHome(VAULT_A, ACCOUNT_ID), {
      wrapper: Providers,
    });
    await waitFor(() => expect(result.current.home?.balances.availableSats).toBe('111'));

    resolveLive({ ok: false, code: 'ERR_DATA_STALE' });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.home).toBeNull();
  });

  it('starts a targeted live refresh on mount and visible-window resume', async () => {
    const starts: unknown[] = [];
    let scanKind: WalletHomeResult['scan']['kind'] = 'completed';
    installFakeChrome({
      'wallet.home': () => ({ ok: true, result: homeResult('10000') }),
      'scan.status': () => ({
        ok: true,
        result: {
          ...homeResult('0').scan,
          kind: scanKind,
          scanId: 'scan-1',
        },
      }),
      'scan.start': (payload) => {
        starts.push(payload);
        return { ok: true, result: { scanId: 'scan-2' } };
      },
    });

    renderHook(() => useWalletHome(VAULT_A, ACCOUNT_ID), { wrapper: Providers });
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]).toEqual({ mode: 'refresh', ...VAULT_A });

    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(starts).toHaveLength(2));

    scanKind = 'running';
    act(() => window.dispatchEvent(new Event('focus')));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toHaveLength(2);

    scanKind = 'failed';
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(starts).toHaveLength(3));
    expect(starts[2]).toEqual({ mode: 'resume', ...VAULT_A });

    scanKind = 'interrupted';
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(starts).toHaveLength(4));
    expect(starts[3]).toEqual({ mode: 'resume', ...VAULT_A });

    scanKind = 'awaiting_extend';
    act(() => window.dispatchEvent(new Event('focus')));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toHaveLength(4);
  });

  it('refreshes immediately after wallet mutations without redundant network scans', async () => {
    let homeCalls = 0;
    const starts: unknown[] = [];
    installFakeChrome({
      'wallet.home': () => {
        homeCalls += 1;
        return { ok: true, result: homeResult(String(homeCalls)) };
      },
      'scan.status': () => ({
        ok: true,
        result: { ...homeResult('0').scan, kind: 'completed', scanId: 'scan-1' },
      }),
      'scan.start': (payload) => {
        starts.push(payload);
        return { ok: true, result: { scanId: `scan-${starts.length + 1}` } };
      },
    });

    renderHook(() => useWalletHome(VAULT_A, ACCOUNT_ID), { wrapper: Providers });
    await waitFor(() => {
      expect(homeCalls).toBe(1);
      expect(starts).toHaveLength(1);
    });

    act(() => emitRuntimeMessage({
      type: 'squirrel:wallet-data-changed',
      reason: 'transaction',
    }));
    await waitFor(() => {
      expect(homeCalls).toBe(2);
      expect(starts).toHaveLength(2);
    });

    act(() => emitRuntimeMessage({ type: 'squirrel:wallet-data-changed', reason: 'utxo' }));
    await waitFor(() => expect(homeCalls).toBe(3));
    expect(starts).toHaveLength(2);
  });

  it('coalesces a resume during a running scan into one follow-up refresh', async () => {
    const starts: unknown[] = [];
    let scanKind: WalletHomeResult['scan']['kind'] = 'running';
    installFakeChrome({
      'wallet.home': () => ({ ok: true, result: homeResult('10000') }),
      'scan.status': () => ({
        ok: true,
        result: { ...homeResult('0').scan, kind: scanKind, scanId: 'scan-1' },
      }),
      'scan.start': (payload) => {
        starts.push(payload);
        return { ok: true, result: { scanId: 'scan-2' } };
      },
    });

    renderHook(() => useWalletHome(VAULT_A, ACCOUNT_ID), { wrapper: Providers });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toHaveLength(0);

    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toHaveLength(0);

    scanKind = 'completed';
    act(() => emitRuntimeMessage({ type: 'squirrel:scan-progress' }));
    await waitFor(() => expect(starts).toHaveLength(1));
    expect(starts[0]).toEqual({ mode: 'refresh', ...VAULT_A });

    act(() => emitRuntimeMessage({ type: 'squirrel:scan-progress' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toHaveLength(1);
  });

  it('uses fast local projection polling and a slower visible-only chain fallback', async () => {
    vi.useFakeTimers();
    let homeCalls = 0;
    let scanChecks = 0;
    let scanStarts = 0;
    installFakeChrome({
      'wallet.home': () => {
        homeCalls += 1;
        return { ok: true, result: homeResult(String(homeCalls)) };
      },
      'scan.status': () => {
        scanChecks += 1;
        return {
          ok: true,
          result: { ...homeResult('0').scan, kind: 'completed', scanId: 'scan-1' },
        };
      },
      'scan.start': () => {
        scanStarts += 1;
        return { ok: true, result: { scanId: `scan-${scanStarts + 1}` } };
      },
    });

    renderHook(() => useWalletHome(VAULT_A, ACCOUNT_ID), { wrapper: Providers });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(homeCalls).toBe(1);
    expect(scanChecks).toBe(1);
    expect(scanStarts).toBe(1);

    await act(async () => vi.advanceTimersByTimeAsync(14_999));
    expect(homeCalls).toBe(1);
    expect(scanChecks).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(homeCalls).toBe(2);
    expect(scanChecks).toBe(1);

    await act(async () => vi.advanceTimersByTimeAsync(45_000));
    expect(scanChecks).toBe(2);
    expect(scanStarts).toBe(2);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(scanChecks).toBe(2);
    expect(scanStarts).toBe(2);
  });

  it('does not poll, scan, or react to focus while mounted as a persistent panel', async () => {
    vi.useFakeTimers();
    let homeCalls = 0;
    let scanChecks = 0;
    let scanStarts = 0;
    installFakeChrome({
      'wallet.home': () => {
        homeCalls += 1;
        return { ok: true, result: homeResult(String(homeCalls)) };
      },
      'scan.status': () => {
        scanChecks += 1;
        return {
          ok: true,
          result: { ...homeResult('0').scan, kind: 'completed', scanId: 'scan-1' },
        };
      },
      'scan.start': () => {
        scanStarts += 1;
        return { ok: true, result: { scanId: `scan-${scanStarts}` } };
      },
    });

    renderHook(
      () => useWalletHome(VAULT_A, ACCOUNT_ID, { continuous: false }),
      { wrapper: Providers },
    );
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect({ homeCalls, scanChecks, scanStarts }).toEqual({
      homeCalls: 1, scanChecks: 1, scanStarts: 1,
    });

    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => vi.advanceTimersByTimeAsync(180_000));
    expect({ homeCalls, scanChecks, scanStarts }).toEqual({
      homeCalls: 1, scanChecks: 1, scanStarts: 1,
    });

    act(() => emitRuntimeMessage({ type: 'squirrel:wallet-data-changed', reason: 'utxo' }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(homeCalls).toBe(2);
    expect(scanChecks).toBe(1);
    expect(scanStarts).toBe(1);
  });

  it('immediately retries a completed conflict once without entering a loop', async () => {
    const starts: unknown[] = [];
    let current = {
      ...homeResult('10000'),
      scan: { ...homeResult('0').scan, kind: 'completed' as const, scanId: 'scan-1' },
    };
    installFakeChrome({
      'wallet.home': () => ({ ok: true, result: current }),
      'scan.status': () => ({ ok: true, result: current.scan }),
      'scan.start': (payload) => {
        starts.push(payload);
        return { ok: true, result: { scanId: `scan-${starts.length + 1}` } };
      },
    });

    const { result } = renderHook(() => useWalletHome(VAULT_A, ACCOUNT_ID), { wrapper: Providers });
    await waitFor(() => expect(starts).toHaveLength(1));

    current = {
      ...current,
      dataGating: {
        state: 'conflicting_sources' as const,
        blockedActions: ['native_send' as const],
      },
      scan: { ...current.scan, scanId: 'scan-conflict' },
    };
    act(() => result.current.refresh());
    await waitFor(() => expect(starts).toHaveLength(2));
    expect(starts[1]).toEqual({ mode: 'refresh', ...VAULT_A });

    act(() => result.current.refresh());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toHaveLength(2);
  });

  it('refreshes once when the selected account changes', async () => {
    const starts: unknown[] = [];
    installFakeChrome({
      'wallet.home': () => ({ ok: true, result: homeResult('0') }),
      'scan.status': () => ({
        ok: true,
        result: { ...homeResult('0').scan, kind: 'completed', scanId: 'scan-1' },
      }),
      'scan.start': (payload) => {
        starts.push(payload);
        return { ok: true, result: { scanId: `scan-${starts.length + 1}` } };
      },
    });
    const rendered = renderHook(
      (props: { account: string }) => useWalletHome(VAULT_A, props.account),
      { wrapper: Providers, initialProps: { account: ACCOUNT_ID } },
    );
    await waitFor(() => expect(starts).toHaveLength(1));
    rendered.rerender({ account: OTHER_ACCOUNT_ID });
    await waitFor(() => expect(starts).toHaveLength(2));
    expect(starts[1]).toEqual({ mode: 'refresh', ...VAULT_A });
  });

  it('drops a late response from the previous expectation and clears on switch', async () => {
    let resolveVaultA: (value: unknown) => void = () => undefined;
    const vaultAResponse = new Promise((resolve) => {
      resolveVaultA = resolve;
    });
    installFakeChrome({
      'wallet.home': (payload) => {
        const { expectedVaultId } = payload as { expectedVaultId: string };
        // Vault A's response hangs (slow worker); vault B answers immediately.
        if (expectedVaultId === 'vault-a') return vaultAResponse;
        return { ok: true, result: homeResult('222') };
      },
    });

    const { result, rerender } = renderHook(
      (props: { expectation: ActiveSessionExpectation }) => useWalletHome(props.expectation, ACCOUNT_ID),
      { wrapper: Providers, initialProps: { expectation: VAULT_A } },
    );
    expect(result.current.home).toBeNull();

    rerender({ expectation: VAULT_B });
    await waitFor(() => {
      expect(result.current.home?.balances.availableSats).toBe('222');
    });

    // Vault A's request finally resolves — it must NOT overwrite vault B.
    resolveVaultA({ ok: true, result: homeResult('111') });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current.home?.balances.availableSats).toBe('222');
  });

  it('does not restart loading when an equivalent expectation object is rendered', async () => {
    let calls = 0;
    installFakeChrome({
      'wallet.home': () => {
        calls += 1;
        return { ok: true, result: homeResult('333') };
      },
    });

    const { result, rerender } = renderHook(
      (props: { expectation: ActiveSessionExpectation }) => useWalletHome(props.expectation, ACCOUNT_ID),
      { wrapper: Providers, initialProps: { expectation: { ...VAULT_A } } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));

    rerender({ expectation: { ...VAULT_A } });
    expect(result.current.home?.balances.availableSats).toBe('333');
    expect(result.current.status).toBe('ready');
    expect(calls).toBe(1);
  });

  it('settles in an error state and can be retried', async () => {
    let fail = true;
    installFakeChrome({
      'wallet.home': () =>
        fail
          ? { ok: false, code: 'ERR_INTERNAL' }
          : { ok: true, result: homeResult('444') },
    });

    const { result } = renderHook(() => useWalletHome(VAULT_A, ACCOUNT_ID), { wrapper: Providers });
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.home).toBeNull();

    fail = false;
    result.current.refresh();
    await waitFor(() => expect(result.current.home?.balances.availableSats).toBe('444'));
    expect(result.current.status).toBe('ready');
  });
});
