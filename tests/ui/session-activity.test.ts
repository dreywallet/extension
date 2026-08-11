import { createElement, type ReactNode } from 'react';
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcProvider } from '../../src/ui/hooks/use-rpc';
import {
  SESSION_ACTIVITY_THROTTLE_MS,
  useSessionActivity,
} from '../../src/ui/hooks/use-session-activity';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const FIRST = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};
const SECOND = {
  expectedVaultId: 'vault-2',
  expectedSessionId: '00000000-0000-4000-8000-000000000002',
};

function wrapper(props: { children: ReactNode }): ReactNode {
  return createElement(RpcProvider, { sender: 'popup', children: props.children });
}

describe('session user activity', () => {
  it('touches immediately, throttles noisy events, and rebinds to a new session', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const sendMessage = vi.fn(async (message: unknown) => {
      void message;
      return { ok: true, result: { deadline: Date.now() + 60_000 } };
    });
    (globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage } };
    const rendered = renderHook(
      ({ expectation }) => useSessionActivity(expectation),
      { wrapper, initialProps: { expectation: FIRST } },
    );

    fireEvent.pointerDown(document);
    fireEvent.click(document);
    fireEvent.wheel(document);
    await act(async () => undefined);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]?.[0]).toMatchObject({
      sender: 'popup', op: 'session.touch', payload: FIRST,
    });

    act(() => vi.advanceTimersByTime(SESSION_ACTIVITY_THROTTLE_MS - 1));
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    fireEvent.keyDown(document, { key: 'Tab' });
    await act(async () => undefined);
    expect(sendMessage).toHaveBeenCalledTimes(2);

    rendered.rerender({ expectation: SECOND });
    fireEvent.pointerDown(document);
    await act(async () => undefined);
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls[2]?.[0]).toMatchObject({ payload: SECOND });
  });

  it('ignores hidden documents and removes listeners without a live session', async () => {
    const sendMessage = vi.fn(async (message: unknown) => {
      void message;
      return { ok: true, result: { deadline: 1 } };
    });
    (globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage } };
    const visibility = vi.spyOn(document, 'visibilityState', 'get');
    visibility.mockReturnValue('hidden');
    const rendered = renderHook(
      ({ expectation }) => useSessionActivity(expectation),
      { wrapper, initialProps: { expectation: FIRST as typeof FIRST | null } },
    );
    fireEvent.pointerDown(document);
    expect(sendMessage).not.toHaveBeenCalled();

    visibility.mockReturnValue('visible');
    rendered.rerender({ expectation: null });
    fireEvent.keyDown(document, { key: 'Enter' });
    await act(async () => undefined);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
