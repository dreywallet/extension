import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ActivityListResult } from '@drey/core/messaging/ops';
import {
  clearAccountActivityStore,
  useAccountActivity,
} from '../../src/ui/hooks/use-account-activity';
import { emitRuntimeMessage, installFakeChrome, Providers } from './fake-rpc';

afterEach(() => {
  cleanup();
  clearAccountActivityStore();
});

const EXPECTATION = {
  expectedVaultId: 'vault-a',
  expectedSessionId: '00000000-0000-4000-8000-00000000000a',
};
const OTHER_EXPECTATION = {
  expectedVaultId: 'vault-b',
  expectedSessionId: '00000000-0000-4000-8000-00000000000b',
};
const ACCOUNT_ID = `acct_mainnet_${'1'.repeat(64)}`;
const CURSOR = { version: 1 as const, revision: 'a'.repeat(64), offset: 25 };

function item(fill: string): ActivityListResult['items'][number] {
  return {
    txid: fill.repeat(64),
    deltaSats: '1',
    feeSats: null,
    confirmationState: 'confirmed',
    timestamp: '2026-08-01T12:00:00.000Z',
    height: 1,
  };
}

function page(
  items: ActivityListResult['items'],
  nextCursor: ActivityListResult['nextCursor'],
  reset = false,
  historyComplete = true,
): { ok: true; result: ActivityListResult } {
  return {
    ok: true,
    result: { accountId: ACCOUNT_ID, items, nextCursor, reset, historyComplete },
  };
}

describe('useAccountActivity', () => {
  it('retains the persistent partial-history advisory state', async () => {
    installFakeChrome({
      'activity.list': () => page([item('a')], null, false, false),
    });
    const { result } = renderHook(
      () => useAccountActivity(EXPECTATION, ACCOUNT_ID),
      { wrapper: Providers },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.historyComplete).toBe(false);
  });

  it('appends older rows once and preserves them for retry after failure', async () => {
    let calls = 0;
    installFakeChrome({
      'activity.list': () => {
        calls += 1;
        if (calls === 1) return page([item('a')], CURSOR);
        if (calls === 2) return { ok: false, code: 'ERR_INTERNAL' };
        return page([item('a'), item('b')], null);
      },
    });
    const { result } = renderHook(
      () => useAccountActivity(EXPECTATION, ACCOUNT_ID),
      { wrapper: Providers },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.pageError).toBe(true));
    expect(result.current.items?.map((entry) => entry.txid[0])).toEqual(['a']);

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.hasMore).toBe(false));
    expect(result.current.items?.map((entry) => entry.txid[0])).toEqual(['a', 'b']);
  });

  it('replaces rows and announces a stale-cursor reset', async () => {
    let calls = 0;
    installFakeChrome({
      'activity.list': () => {
        calls += 1;
        return calls === 1
          ? page([item('a')], CURSOR)
          : page([item('c')], null, true);
      },
    });
    const { result } = renderHook(
      () => useAccountActivity(EXPECTATION, ACCOUNT_ID),
      { wrapper: Providers },
    );
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.updated).toBe(true));
    expect(result.current.items?.map((entry) => entry.txid[0])).toEqual(['c']);
  });

  it('clears immediately on lock and ignores a late prior-session result', async () => {
    let release: ((value: unknown) => void) | undefined;
    const pending = new Promise((resolve) => { release = resolve; });
    installFakeChrome({
      'activity.list': (payload) =>
        (payload as { expectedVaultId: string }).expectedVaultId === EXPECTATION.expectedVaultId
          ? pending
          : page([], null),
    });
    const { result, rerender } = renderHook(
      ({ expectation }) => useAccountActivity(expectation, ACCOUNT_ID),
      { initialProps: { expectation: EXPECTATION }, wrapper: Providers },
    );

    act(() => emitRuntimeMessage({ type: 'squirrel:session-state-changed', locked: true }));
    expect(result.current.items).toBeNull();
    rerender({ expectation: OTHER_EXPECTATION });
    expect(result.current.items).toBeNull();
    release?.(page([item('a')], null));
    await waitFor(() => expect(result.current.items).toEqual([]));
    expect(result.current.items?.some((entry) => entry.txid === item('a').txid)).toBe(false);
  });
});
