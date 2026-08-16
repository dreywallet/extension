/**
 * Activity thumbnails are rendered by both Home and the Activity tab and were
 * refetched — two sequential gateway calls per row — on every mount. These
 * cover the shared store, its request dedup, and its invalidation.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActivityList,
  clearActivityPreviewStore,
} from '../../src/entrypoints/popup/ActivityList';
import {
  SCAN_PROGRESS_EVENT,
  SESSION_STATE_CHANGED_EVENT,
  WALLET_DATA_CHANGED_EVENT,
} from '@drey/core/messaging/events';
import type { WalletHomeResult } from '@drey/core/messaging/ops';
import { emitRuntimeMessage, installFakeChrome, Providers } from './fake-rpc';

const ACCOUNT_ID = `acct_signet_${'1'.repeat(64)}`;

afterEach(() => {
  cleanup();
  clearActivityPreviewStore();
  vi.useRealTimers();
});

const EXPECTATION = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};

const INSCRIPTION_ID = `${'a'.repeat(64)}i0`;
const PREVIEW_TITLE = `Inert preview for inscription ${INSCRIPTION_ID}`;

function ordinalRow(txid: string): WalletHomeResult['activity'][number] {
  return {
    txid,
    deltaSats: '600',
    feeSats: null,
    confirmationState: 'confirmed',
    actionKind: 'ordinal_receive',
    inscriptionId: INSCRIPTION_ID,
    inscriptionNumber: 1,
    returnedBtcSats: null,
    timestamp: null,
    height: 100,
  };
}

function preview() {
  return {
    ok: true as const,
    result: {
      items: [{
        inscriptionId: INSCRIPTION_ID,
        preview: {
          kind: 'raster' as const,
          rasterBase64: 'AA==',
          pngSha256: 'e'.repeat(64),
          pngWidth: 1,
          pngHeight: 1,
        },
      }],
    },
  };
}

function renderList(activity: WalletHomeResult['activity']) {
  return render(
    <Providers>
      <ActivityList accountId={ACCOUNT_ID} activity={activity} expectation={EXPECTATION} network="signet" />
    </Providers>,
  );
}

describe('activity thumbnail cache', () => {
  it('waits for the viewport, batches exact rows, and then loads an older item', async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    const observed: Element[] = [];
    class FakeIntersectionObserver {
      readonly root = null;
      readonly rootMargin = '';
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) {
        callbacks.push(callback);
      }
      observe(element: Element): void { observed.push(element); }
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
    }
    const original = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;
    const olderId = `${'b'.repeat(64)}i0`;
    const batch = vi.fn((payload: unknown) => {
      const request = payload as { items: Array<{ inscriptionId: string }> };
      return {
        ok: true as const,
        result: {
          items: request.items.map(({ inscriptionId }) => ({
          inscriptionId,
          preview: {
            kind: 'raster' as const,
            rasterBase64: 'AA==',
            pngSha256: 'e'.repeat(64),
            pngWidth: 1,
            pngHeight: 1,
          },
          })),
        },
      };
    });
    installFakeChrome({ 'activity.inscriptionPreviewBatch': batch });
    const first = ordinalRow('a'.repeat(64));
    const duplicate = { ...ordinalRow('b'.repeat(64)), deltaSats: '-600' };
    const older = {
      ...ordinalRow('c'.repeat(64)),
      inscriptionId: olderId,
      inscriptionNumber: 57_650_108,
    };
    renderList([first, duplicate, older]);
    expect(batch).not.toHaveBeenCalled();

    for (let index = 0; index < 2; index += 1) {
      callbacks[index]?.([{
        isIntersecting: true,
        target: observed[index]!,
      } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
    await waitFor(() => expect(batch).toHaveBeenCalledTimes(2));
    expect(batch.mock.calls[0]?.[0]).toMatchObject({
      items: [{ txid: 'a'.repeat(64), inscriptionId: INSCRIPTION_ID }],
    });
    expect(batch.mock.calls[1]?.[0]).toMatchObject({
      items: [{ txid: 'b'.repeat(64), inscriptionId: INSCRIPTION_ID }],
    });

    callbacks[2]?.([{
      isIntersecting: true,
      target: observed[2]!,
    } as IntersectionObserverEntry], {} as IntersectionObserver);
    await waitFor(() => expect(batch).toHaveBeenCalledTimes(3));
    expect(batch.mock.calls[2]?.[0]).toMatchObject({
      items: [{ inscriptionId: olderId }],
    });
    globalThis.IntersectionObserver = original;
  });

  it('shares one request between two lists showing the same row', async () => {
    const inscriptionPreview = vi.fn(preview);
    installFakeChrome({ 'activity.inscriptionPreviewBatch': inscriptionPreview });

    // Home renders a compact list and the Activity tab renders a full one.
    // Mounted together they must issue one request, not one each.
    const row = ordinalRow('a'.repeat(64));
    render(
      <Providers>
        <ActivityList accountId={ACCOUNT_ID} activity={[row]} compact expectation={EXPECTATION} network="signet" />
        <ActivityList accountId={ACCOUNT_ID} activity={[row]} expectation={EXPECTATION} network="signet" />
      </Providers>,
    );

    await waitFor(() => expect(screen.getAllByTitle(PREVIEW_TITLE)).toHaveLength(2));
    expect(inscriptionPreview).toHaveBeenCalledOnce();
  });

  it('does not refetch when the same row remounts during an in-flight request', async () => {
    let release: ((value: ReturnType<typeof preview>) => void) | undefined;
    const pending = new Promise<ReturnType<typeof preview>>((resolve) => {
      release = resolve;
    });
    const inscriptionPreview = vi.fn(() => pending);
    installFakeChrome({ 'activity.inscriptionPreviewBatch': inscriptionPreview });

    const first = renderList([ordinalRow('a'.repeat(64))]);
    await waitFor(() => expect(inscriptionPreview).toHaveBeenCalledOnce());
    first.unmount();
    renderList([ordinalRow('a'.repeat(64))]);

    expect(inscriptionPreview).toHaveBeenCalledOnce();
    release?.(preview());
    await waitFor(() => expect(screen.getByTitle(PREVIEW_TITLE)).toBeInTheDocument());
    expect(inscriptionPreview).toHaveBeenCalledOnce();
  });

  it('does not refetch when the surface remounts', async () => {
    const inscriptionPreview = vi.fn(preview);
    installFakeChrome({ 'activity.inscriptionPreviewBatch': inscriptionPreview });

    const first = renderList([ordinalRow('a'.repeat(64))]);
    await waitFor(() => expect(inscriptionPreview).toHaveBeenCalledOnce());

    // Switching tabs unmounts the list.
    first.unmount();
    renderList([ordinalRow('a'.repeat(64))]);

    // Painted synchronously from the store, so it cannot be a second request.
    expect(screen.getByTitle(PREVIEW_TITLE)).toBeInTheDocument();
    expect(inscriptionPreview).toHaveBeenCalledOnce();
  });

  it('evicts the oldest thumbnail after 64 session entries', async () => {
    const inscriptionPreview = vi.fn((payload: unknown) => {
      const request = payload as { items: Array<{ inscriptionId: string }> };
      return {
        ok: true as const,
        result: { items: request.items.map(({ inscriptionId }) => ({
          inscriptionId,
          preview: {
            kind: 'text' as const,
            textMime: 'text/plain' as const,
            excerpt: 'signed',
            truncated: false,
          },
        })) },
      };
    });
    installFakeChrome({ 'activity.inscriptionPreviewBatch': inscriptionPreview });
    const rows = Array.from({ length: 65 }, (_, index) => {
      const hex = index.toString(16).padStart(64, '0');
      return {
        ...ordinalRow(hex),
        inscriptionId: `${hex}i0`,
        inscriptionNumber: index,
      };
    });
    const first = renderList(rows);
    await waitFor(() => expect(inscriptionPreview.mock.calls.flatMap((call) =>
      (call[0] as { items: unknown[] }).items)).toHaveLength(65));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    first.unmount();

    renderList([rows[0]!]);
    await waitFor(() => expect(inscriptionPreview.mock.calls.flatMap((call) =>
      (call[0] as { items: unknown[] }).items)).toHaveLength(66));
    expect(inscriptionPreview.mock.calls.every((call) =>
      (call[0] as { items: unknown[] }).items.length <= 8)).toBe(true);
  });

  it('does not reuse preview bytes across different transaction bindings', async () => {
    const inscriptionPreview = vi.fn(preview);
    installFakeChrome({ 'activity.inscriptionPreviewBatch': inscriptionPreview });

    const first = renderList([ordinalRow('a'.repeat(64))]);
    await waitFor(() => expect(inscriptionPreview).toHaveBeenCalledOnce());
    first.unmount();

    // An inscription can move. A new transaction therefore requires a new
    // exact worker authorization even when the inscription identity matches.
    renderList([ordinalRow('f'.repeat(64))]);
    await waitFor(() => expect(inscriptionPreview).toHaveBeenCalledTimes(2));
  });

  it('suppresses a preview that completes after the session changes', async () => {
    let settle!: (value: ReturnType<typeof preview>) => void;
    let calls = 0;
    const inscriptionPreview = vi.fn(() => {
      calls += 1;
      if (calls === 1) {
        return new Promise<ReturnType<typeof preview>>((resolve) => { settle = resolve; });
      }
      return {
        ok: true as const,
        result: { items: [{
          inscriptionId: INSCRIPTION_ID,
          preview: { kind: 'placeholder' as const, reason: 'decode_failed' },
        }] },
      };
    });
    installFakeChrome({ 'activity.inscriptionPreviewBatch': inscriptionPreview });
    const rendered = renderList([ordinalRow('a'.repeat(64))]);
    await waitFor(() => expect(inscriptionPreview).toHaveBeenCalledOnce());
    const nextExpectation = { ...EXPECTATION, expectedSessionId: '00000000-0000-4000-8000-000000000002' };
    rendered.rerender(
      <Providers>
        <ActivityList accountId={ACCOUNT_ID} activity={[ordinalRow('a'.repeat(64))]}
          expectation={nextExpectation} network="signet" />
      </Providers>,
    );
    settle(preview());

    await waitFor(() => expect(inscriptionPreview).toHaveBeenCalledTimes(2));
    expect(screen.queryByTitle(PREVIEW_TITLE)).not.toBeInTheDocument();
  });

  it('invalidates the shared store on lock', async () => {
    const inscriptionPreview = vi.fn(preview);
    installFakeChrome({ 'activity.inscriptionPreviewBatch': inscriptionPreview });

    renderList([ordinalRow('a'.repeat(64))]);
    await waitFor(() => expect(inscriptionPreview).toHaveBeenCalledOnce());

    emitRuntimeMessage({ type: SESSION_STATE_CHANGED_EVENT, locked: true });
    await waitFor(() => expect(inscriptionPreview).toHaveBeenCalledTimes(2));
  });

  it.each([
    ['scan progress', { type: SCAN_PROGRESS_EVENT }],
    ['a wallet-data change', { type: WALLET_DATA_CHANGED_EVENT, reason: 'transaction' }],
  ])('does not remount thumbnails on %s', async (_label, event) => {
    const inscriptionPreview = vi.fn(preview);
    installFakeChrome({ 'activity.inscriptionPreviewBatch': inscriptionPreview });

    renderList([ordinalRow('a'.repeat(64))]);
    await waitFor(() =>
      expect(screen.getByTitle(PREVIEW_TITLE)).toBeInTheDocument());

    // Opening the Ordinals tab starts a scan that emits progress repeatedly.
    // Clearing on those events wiped the store and remounted every thumbnail,
    // so the placeholder flashed several times on the way back to Home.
    for (let i = 0; i < 3; i += 1) emitRuntimeMessage(event);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(screen.getByTitle(PREVIEW_TITLE)).toBeInTheDocument();
    expect(inscriptionPreview).toHaveBeenCalledOnce();
  });

  it('does not cache a placeholder, so a transient failure can recover', async () => {
    let raster = false;
    const inscriptionPreview = vi.fn(() => raster
      ? preview()
      : {
          ok: true as const,
          result: {
            items: [{
            inscriptionId: INSCRIPTION_ID,
            preview: { kind: 'placeholder' as const, reason: 'decode_failed' },
            }],
          },
        });
    installFakeChrome({ 'activity.inscriptionPreviewBatch': inscriptionPreview });

    const first = renderList([ordinalRow('a'.repeat(64))]);
    await waitFor(() => expect(inscriptionPreview).toHaveBeenCalledOnce());
    first.unmount();

    raster = true;
    renderList([ordinalRow('a'.repeat(64))]);
    await waitFor(() =>
      expect(screen.getByTitle(PREVIEW_TITLE)).toBeInTheDocument());
  });

  it('recovers from a transient RPC failure without remounting the surface', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let attempts = 0;
    const inscriptionPreview = vi.fn(() => {
      attempts += 1;
      return attempts === 1
        ? {
            ok: false as const,
            error: { code: 'ERR_DATA_STALE' as const, message: 'temporarily unavailable' },
          }
        : preview();
    });
    installFakeChrome({ 'activity.inscriptionPreviewBatch': inscriptionPreview });

    renderList([ordinalRow('a'.repeat(64))]);

    await waitFor(() => expect(inscriptionPreview).toHaveBeenCalledOnce());
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    await waitFor(() => expect(screen.getByTitle(PREVIEW_TITLE)).toBeInTheDocument());
    expect(inscriptionPreview).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent sender authorization rejection', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const inscriptionPreview = vi.fn(() => ({
      ok: false as const,
      code: 'ERR_UNAUTHORIZED_CONTEXT' as const,
    }));
    installFakeChrome({ 'activity.inscriptionPreviewBatch': inscriptionPreview });

    renderList([ordinalRow('a'.repeat(64))]);
    await waitFor(() => expect(inscriptionPreview).toHaveBeenCalledOnce());
    await act(async () => vi.advanceTimersByTimeAsync(1_700));

    expect(inscriptionPreview).toHaveBeenCalledOnce();
  });
});
