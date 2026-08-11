/**
 * A cold popup — first open of the session, or after an MV3 worker restart —
 * has nothing in the module store and would otherwise show an empty grid for
 * the whole life of a multi-MiB signed batch. These cover the paint-ahead that
 * fills that window, and the far more important question of what the user is
 * allowed to DO with pixels that no verified batch has vouched for yet.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Gallery } from '../../src/entrypoints/popup/Gallery';
import type { GalleryData } from '../../src/ui/hooks/use-gallery-data';
import { NOT_REQUESTED, useGalleryData } from '../../src/ui/hooks/use-gallery-data';
import { SESSION_STATE_CHANGED_EVENT } from '@drey/core/messaging/events';
import { GALLERY_PREVIEW_UNAVAILABLE } from '@drey/core/messaging/ops';
import { emitRuntimeMessage, installFakeChrome, Providers } from './fake-rpc';

/**
 * Set to drive `Gallery` with a hand-built hook result for surface-only
 * presentation and authority-gate cases.
 */
let hookOverride: GalleryData | null = null;
vi.mock('../../src/ui/hooks/use-gallery-data', async () => {
  const actual = await vi.importActual<typeof import('../../src/ui/hooks/use-gallery-data')>(
    '../../src/ui/hooks/use-gallery-data',
  );
  return {
    ...actual,
    useGalleryData: (...args: Parameters<typeof actual.useGalleryData>): GalleryData => {
      const real = actual.useGalleryData(...args);
      return hookOverride ?? real;
    },
  };
});

afterEach(() => {
  hookOverride = null;
  cleanup();
});

const EXPECTATION = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};
const ACCOUNT_ID = `acct_mainnet_${'1'.repeat(64)}`;
const OTHER_ACCOUNT_ID = `acct_mainnet_${'2'.repeat(64)}`;

const completedScan = {
  kind: 'completed' as const,
  scanId: 'scan-1',
  unitsDone: 4,
  unitsTotal: 4,
  currentUnit: null,
  boundaryUnits: [],
  failureReason: null,
};

const INSCRIPTION_ID = `${'a'.repeat(64)}i0`;
const SECOND_ID = `${'b'.repeat(64)}i0`;

const raster = {
  kind: 'raster' as const,
  rasterBase64: 'AA==',
  pngSha256: 'e'.repeat(64),
  pngWidth: 1,
  pngHeight: 1,
};

/** The paint-only projection: no action, no mediaAvailable, raster optional. */
function cachedItem(inscriptionId: string, withRaster: boolean) {
  return {
    inscriptionId,
    state: 'visible' as const,
    number: 7,
    contentType: 'image/png',
    contentLength: 68,
    satpoint: `${'c'.repeat(64)}:0:0`,
    outpoint: { txid: 'c'.repeat(64), vout: 0 },
    confirmations: 2,
    parent: null,
    delegate: null,
    reinscription: false,
    cursed: false,
    classificationRevision: 'rev-1',
    rareSats: [],
    display: { title: null, collections: [] },
    ...(withRaster ? { preview: raster } : {}),
  };
}

function freshResult() {
  return {
    accountId: ACCOUNT_ID,
    items: [
      {
        ...cachedItem(INSCRIPTION_ID, true),
        ownership: {
          address: 'bc1ptest',
          lane: 'ordinals' as const,
          role: 'primary' as const,
        },
        preview: raster,
        mediaAvailable: true,
        action: { status: 'available' as const, kind: 'send' as const },
      },
    ],
    attentionItems: [],
    sweepCandidates: [],
    previewsUnavailable: false,
    collectionCatalog: null,
    recoveredAddressCount: 0,
    refreshedAt: 1_752_969_600_000,
  };
}

/** A promise plus the trigger that settles it, for ordering the two reads. */
function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { settle = resolve; });
  return { promise, settle };
}

function install(overrides: Record<string, (payload: unknown) => unknown>) {
  installFakeChrome({
    'scan.status': () => ({ ok: true, result: completedScan }),
    'scan.start': () => ({ ok: true, result: { scanId: 'scan-2' } }),
    'gallery.update': () => ({ ok: true, result: { updated: true } }),
    ...overrides,
  });
}

async function findGalleryArticle(): Promise<HTMLElement> {
  const current = screen.queryByRole('article');
  if (current !== null) return current;
  await waitFor(() => expect(document.querySelector('[data-gallery-collection]')).not.toBeNull());
  fireEvent.click(document.querySelector('[data-gallery-collection]')!);
  return screen.findByRole('article');
}

describe('gallery paint-ahead', () => {
  it('keeps signed titles and collection structure stable while authority refreshes', async () => {
    const collection = {
      slug: 'node-monkes',
      name: 'NodeMonkes',
      kind: 'parent' as const,
      rootInscriptionIds: [`${'d'.repeat(64)}i0`],
    };
    const cached = {
      ...cachedItem(INSCRIPTION_ID, true),
      display: {
        title: { text: 'NodeMonke #7', source: 'ord_properties' as const },
        collections: [collection],
      },
    };
    const batch = deferred<unknown>();
    install({
      'gallery.list': () => batch.promise,
      'gallery.cached': () => ({
        ok: true,
        result: { accountId: ACCOUNT_ID, hit: true, items: [cached], cachedAt: 5 },
      }),
    });

    render(
      <Providers>
        <Gallery expectation={EXPECTATION} account={0} accountId={ACCOUNT_ID} onReceive={() => undefined} />
      </Providers>,
    );

    const cachedArticle = await findGalleryArticle();
    expect(screen.getByRole('heading', { name: 'NodeMonkes' })).toBeInTheDocument();
    expect(screen.getByText('NodeMonke #7')).toBeInTheDocument();

    batch.settle({
      ok: true,
      result: {
        ...freshResult(),
        items: [{
          ...freshResult().items[0],
          display: cached.display,
        }],
        collectionCatalog: {
          source: 'TheWizardsOfOrd/ordinals-collections',
          revision: 'e'.repeat(40),
          sha256: 'f'.repeat(64),
          galleryIndexStatus: 'ready',
        },
      },
    });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    expect(screen.getByRole('article')).toBe(cachedArticle);
    expect(screen.getByRole('heading', { name: 'NodeMonkes' })).toBeInTheDocument();
    expect(screen.getAllByText('NodeMonke #7').length).toBeGreaterThan(0);
  });

  it('paints cached pixels before the signed batch lands', async () => {
    const batch = deferred<unknown>();
    const galleryList = vi.fn(() => batch.promise);
    install({
      'gallery.list': galleryList,
      'gallery.cached': () => ({
        ok: true,
        result: { accountId: ACCOUNT_ID, hit: true, items: [cachedItem(INSCRIPTION_ID, true)], cachedAt: 5 },
      }),
    });

    const { result } = renderHook(() => useGalleryData(EXPECTATION, ACCOUNT_ID), { wrapper: Providers });

    await waitFor(() => expect(result.current.authority).toBe('cached'));
    expect(result.current.result?.items).toHaveLength(1);
    // The batch it is racing has not answered yet — that is the entire point.
    expect(galleryList).toHaveBeenCalledOnce();

    batch.settle({ ok: true, result: freshResult() });
    await waitFor(() => expect(result.current.authority).toBe('fresh'));
  });

  it('hands the cached grid no authority at all', async () => {
    install({
      'gallery.list': () => new Promise(() => undefined),
      'gallery.cached': () => ({
        ok: true,
        result: {
          accountId: ACCOUNT_ID,
          hit: true,
          items: [cachedItem(INSCRIPTION_ID, true), cachedItem(SECOND_ID, false)],
          cachedAt: 5,
        },
      }),
    });

    const { result } = renderHook(() => useGalleryData(EXPECTATION, ACCOUNT_ID), { wrapper: Providers });
    await waitFor(() => expect(result.current.authority).toBe('cached'));

    for (const item of result.current.result?.items ?? []) {
      expect(item.action).toEqual({
        status: 'blocked', kind: 'send', reason: 'stale_classification',
      });
      expect(item.mediaAvailable).toBe(false);
    }
    // Neither authority list can be reconstructed from pixels, so both are empty.
    expect(result.current.result?.attentionItems).toEqual([]);
    expect(result.current.result?.sweepCandidates).toEqual([]);
    // A card with no cached raster rejoins the ordinary lazy path.
    const second = result.current.result?.items.find((i) => i.inscriptionId === SECOND_ID);
    expect(second?.preview).toEqual({ kind: 'placeholder', reason: NOT_REQUESTED });
  });

  it('keeps the viewer reachable on an item painted from cache', async () => {
    // The cached raster satisfies LazyCard, so this item is never re-requested
    // and the batch that skipped it is the last word on it. Pinning the
    // hydration's deliberate mediaAvailable:false onto it would strand the
    // viewer affordance for as long as the popup stays open.
    const batch = deferred<unknown>();
    install({
      'gallery.list': () => batch.promise,
      'gallery.cached': () => ({
        ok: true,
        result: { accountId: ACCOUNT_ID, hit: true, items: [cachedItem(INSCRIPTION_ID, true)], cachedAt: 5 },
      }),
    });

    const { result } = renderHook(() => useGalleryData(EXPECTATION, ACCOUNT_ID), { wrapper: Providers });
    // The cached raster has to be on screen before the batch answers, or there
    // is nothing for the merge to carry forward and the test proves nothing.
    await waitFor(() => expect(result.current.authority).toBe('cached'));

    batch.settle({
      ok: true,
      result: {
        accountId: ACCOUNT_ID,
        items: [{
          ...cachedItem(INSCRIPTION_ID, false),
          ownership: {
            address: 'bc1ptest',
            lane: 'ordinals' as const,
            role: 'primary' as const,
          },
          preview: { kind: 'placeholder' as const, reason: NOT_REQUESTED },
          mediaAvailable: true,
          action: { status: 'available' as const, kind: 'send' as const },
        }],
        attentionItems: [],
        sweepCandidates: [],
        refreshedAt: 1,
      },
    });
    await waitFor(() => expect(result.current.authority).toBe('fresh'));

    const item = result.current.result?.items[0];
    expect(item?.preview.kind).toBe('raster');
    expect(item?.mediaAvailable).toBe(true);
  });

  it('never lets a late cached read overwrite a verified batch', async () => {
    const cached = deferred<unknown>();
    install({
      'gallery.list': () => ({ ok: true, result: freshResult() }),
      'gallery.cached': () => cached.promise,
    });

    const { result } = renderHook(() => useGalleryData(EXPECTATION, ACCOUNT_ID), { wrapper: Providers });
    // 'fresh' is also the initial value, so waiting on it would pass before the
    // batch had landed and prove nothing. Wait for the batch itself.
    await waitFor(() => expect(result.current.result).not.toBeNull());
    expect(result.current.authority).toBe('fresh');
    expect(result.current.result?.items[0]?.action.status).toBe('available');

    cached.settle({
      ok: true,
      result: { accountId: ACCOUNT_ID, hit: true, items: [cachedItem(INSCRIPTION_ID, true)], cachedAt: 5 },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Pixels lost the race and must stay lost.
    expect(result.current.authority).toBe('fresh');
    expect(result.current.result?.items[0]?.action.status).toBe('available');
  });

  it('keeps the hydration out of the module store', async () => {
    const galleryList = vi.fn(() => new Promise(() => undefined));
    const galleryCached = vi.fn(() => ({
      ok: true,
      result: { accountId: ACCOUNT_ID, hit: true, items: [cachedItem(INSCRIPTION_ID, true)], cachedAt: 5 },
    }));
    install({ 'gallery.list': galleryList, 'gallery.cached': galleryCached });

    const first = renderHook(() => useGalleryData(EXPECTATION, ACCOUNT_ID), { wrapper: Providers });
    await waitFor(() => expect(first.result.current.authority).toBe('cached'));
    first.unmount();

    const second = renderHook(() => useGalleryData(EXPECTATION, ACCOUNT_ID), { wrapper: Providers });
    await waitFor(() => expect(second.result.current.authority).toBe('cached'));

    // A warm store suppresses the cached read entirely, so a second one proves
    // the store is still empty: the projection never entered it and cannot be
    // served to a later remount as though it were authority. The batch itself
    // is correctly joined rather than re-issued.
    expect(galleryCached).toHaveBeenCalledTimes(2);
    expect(galleryList).toHaveBeenCalledOnce();
  });

  it('discards a cached read that lands after a lock', async () => {
    const cached = deferred<unknown>();
    install({
      'gallery.list': () => new Promise(() => undefined),
      'gallery.cached': () => cached.promise,
    });

    const { result } = renderHook(() => useGalleryData(EXPECTATION, ACCOUNT_ID), { wrapper: Providers });
    emitRuntimeMessage({ type: SESSION_STATE_CHANGED_EVENT, locked: true });

    cached.settle({
      ok: true,
      result: { accountId: ACCOUNT_ID, hit: true, items: [cachedItem(INSCRIPTION_ID, true)], cachedAt: 5 },
    });
    // Long enough that the paint would have landed were it not refused; 'fresh'
    // and a null result are both initial values, so waiting on them would prove
    // nothing on its own.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The read was issued for a session that has since ended. Painting it would
    // put the previous wallet's pixels on screen behind a lock.
    expect(result.current.authority).toBe('fresh');
    expect(result.current.result).toBeNull();
  });

  it('discards a cached read that lands after the account moved on', async () => {
    const first = deferred<unknown>();
    const galleryCached = vi.fn((payload: unknown) =>
      (payload as { accountId: string }).accountId === ACCOUNT_ID
        ? first.promise
        : { ok: true, result: { accountId: OTHER_ACCOUNT_ID, hit: false } });
    install({
      'gallery.list': () => new Promise(() => undefined),
      'gallery.cached': galleryCached,
    });

    const { result, rerender } = renderHook(
      ({ account }: { account: string }) => useGalleryData(EXPECTATION, account),
      { wrapper: Providers, initialProps: { account: ACCOUNT_ID } },
    );
    rerender({ account: OTHER_ACCOUNT_ID });

    first.settle({
      ok: true,
      result: { accountId: ACCOUNT_ID, hit: true, items: [cachedItem(INSCRIPTION_ID, true)], cachedAt: 5 },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Account 0's pixels must never appear under account 1's identity.
    expect(result.current.authority).toBe('fresh');
    expect(result.current.result).toBeNull();
  });

  it('leaves the paint-ahead window when a joined request lands', async () => {
    // A remount that joins an in-flight request never runs refresh() itself, so
    // it has its own path out of the cached window. Without it the grid shows
    // verified data with Send, Hide, and the viewer disabled forever.
    const batch = deferred<unknown>();
    install({
      'gallery.list': () => batch.promise,
      'gallery.cached': () => ({
        ok: true,
        result: { accountId: ACCOUNT_ID, hit: true, items: [cachedItem(INSCRIPTION_ID, true)], cachedAt: 5 },
      }),
    });

    const first = renderHook(() => useGalleryData(EXPECTATION, ACCOUNT_ID), { wrapper: Providers });
    await waitFor(() => expect(first.result.current.authority).toBe('cached'));
    first.unmount();

    const second = renderHook(() => useGalleryData(EXPECTATION, ACCOUNT_ID), { wrapper: Providers });
    await waitFor(() => expect(second.result.current.authority).toBe('cached'));

    batch.settle({ ok: true, result: freshResult() });

    await waitFor(() => expect(second.result.current.authority).toBe('fresh'));
    expect(second.result.current.result?.items[0]?.action.status).toBe('available');
  });

  it('retries a raster requested while a joined request was running', async () => {
    // The cached grid renders cards whose rasters were never cached, so
    // LazyCard asks for them during the joined window. refresh() early-returns
    // on the inFlight guard and the id is already marked wanted, so only an
    // explicit drain can recover it.
    const batch = deferred<unknown>();
    const galleryList = vi.fn(() => batch.promise);
    install({
      'gallery.list': galleryList,
      'gallery.cached': () => ({
        ok: true,
        result: {
          accountId: ACCOUNT_ID,
          hit: true,
          items: [cachedItem(INSCRIPTION_ID, true), cachedItem(SECOND_ID, false)],
          cachedAt: 5,
        },
      }),
    });

    const first = renderHook(() => useGalleryData(EXPECTATION, ACCOUNT_ID), { wrapper: Providers });
    await waitFor(() => expect(first.result.current.authority).toBe('cached'));
    first.unmount();

    const second = renderHook(() => useGalleryData(EXPECTATION, ACCOUNT_ID), { wrapper: Providers });
    await waitFor(() => expect(second.result.current.authority).toBe('cached'));
    second.result.current.requestRasters([SECOND_ID]);
    // Let the request debounce fire while the joined batch is still open.
    await new Promise((resolve) => setTimeout(resolve, 300));

    batch.settle({ ok: true, result: freshResult() });

    await waitFor(() => expect(galleryList).toHaveBeenCalledTimes(2));
    expect(galleryList).toHaveBeenLastCalledWith(
      expect.objectContaining({ rasterFor: [SECOND_ID] }),
    );
  });

  it('does not ask for a cached paint when the store is already warm', async () => {
    const galleryCached = vi.fn(() => ({ ok: true, result: { accountId: ACCOUNT_ID, hit: false } }));
    install({
      'gallery.list': () => ({ ok: true, result: freshResult() }),
      'gallery.cached': galleryCached,
    });

    const first = renderHook(() => useGalleryData(EXPECTATION, ACCOUNT_ID), { wrapper: Providers });
    await waitFor(() => expect(first.result.current.result).not.toBeNull());
    expect(galleryCached).toHaveBeenCalledOnce();
    first.unmount();

    // A tab switch already paints from the store; a session read would be pure
    // cost for an answer that is strictly worse than what is on screen.
    renderHook(() => useGalleryData(EXPECTATION, ACCOUNT_ID), { wrapper: Providers });
    expect(galleryCached).toHaveBeenCalledOnce();
  });
});

describe('gallery paint-ahead surface', () => {
  function renderGallery() {
    return render(
      <Providers>
        <Gallery expectation={EXPECTATION} account={0} accountId={ACCOUNT_ID} onReceive={() => undefined} />
      </Providers>,
    );
  }

  it('offers nothing actionable while the grid is unverified', async () => {
    install({
      'gallery.list': () => new Promise(() => undefined),
      'gallery.cached': () => ({
        ok: true,
        result: { accountId: ACCOUNT_ID, hit: true, items: [cachedItem(INSCRIPTION_ID, true)], cachedAt: 5 },
      }),
    });

    renderGallery();

    const article = await findGalleryArticle();
    expect(article).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    // Hide/Unhide is a local preference rather than authority, but its
    // optimistic write would be silently discarded by the arriving batch.
    expect(screen.getByRole('button', { name: 'Hide' })).toBeDisabled();
    // A healthy background verification is routine, so the previous view
    // stays calm instead of presenting a transient status banner.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    // The blocked default must not surface as a finding about the wallet.
    expect(screen.queryByText(/Asset verification is out of date/u)).not.toBeInTheDocument();
    // "Verified details" is a claim the paint cache cannot make: its satpoint
    // and outpoint are last-view bytes, superseded by the arriving batch.
    expect(screen.queryByText('Verified details')).not.toBeInTheDocument();
    expect(screen.queryByText('Recovered addresses included')).not.toBeInTheDocument();
    expect(article.querySelector('[data-details-slot]')).toBeEmptyDOMElement();
  });

  it('gates on the flag alone, without relying on the hydration', async () => {
    // The hook already neuters every cached item's action and mediaAvailable,
    // so these gates are unreachable through it. They are the second half of a
    // deliberate belt-and-braces pair living in a different file: drive the
    // component with a deliberately live-looking cached item and prove it still
    // refuses on the flag by itself.
    const live = {
      ...cachedItem(INSCRIPTION_ID, true),
      ownership: null,
      preview: raster,
      display: { title: null, collections: [] },
      mediaAvailable: true,
      action: { status: 'available' as const, kind: 'send' as const },
    };
    hookOverride = {
      result: {
        accountId: ACCOUNT_ID,
        items: [live],
        attentionItems: [],
        sweepCandidates: [],
        previewsUnavailable: false,
        collectionCatalog: null,
        recoveredAddressCount: 0,
        refreshedAt: 0,
      },
      status: 'ready',
      authority: 'cached',
      refreshing: false,
      refresh: async () => undefined,
      synchronizeWallet: async () => true,
      requestRasters: () => undefined,
      applyItemState: () => undefined,
    };
    install({ 'gallery.list': () => new Promise(() => undefined) });

    renderGallery();

    expect(await findGalleryArticle()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Open media' })).not.toBeInTheDocument();
    // Identifiers are gated on the same flag, so a live-looking cached item
    // cannot present last-view bytes under a "verified" label either.
    expect(screen.queryByText('Verified details')).not.toBeInTheDocument();
    expect(screen.queryByText(INSCRIPTION_ID)).not.toBeInTheDocument();
  });

  it('presents unknown counts and lazy previews as pending, never empty or unavailable', async () => {
    install({ 'gallery.list': () => new Promise(() => undefined) });
    hookOverride = {
      result: null,
      status: 'syncing',
      authority: 'fresh',
      refreshing: true,
      refresh: async () => undefined,
      synchronizeWallet: async () => true,
      requestRasters: () => undefined,
      applyItemState: () => undefined,
    };
    const rendered = renderGallery();

    expect(screen.getByRole('tab', { name: 'All (—)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Hidden (—)' })).toBeInTheDocument();
    expect(screen.getByText('Checking your wallet for Ordinals…')).toBeInTheDocument();

    const requestRasters = vi.fn();
    hookOverride = {
      ...hookOverride,
      result: {
        ...freshResult(),
        items: [{
          ...freshResult().items[0]!,
          preview: { kind: 'placeholder' as const, reason: NOT_REQUESTED },
        }],
      },
      status: 'ready',
      refreshing: false,
      requestRasters,
    };
    rendered.rerender(
      <Providers>
        <Gallery expectation={EXPECTATION} account={0} accountId={ACCOUNT_ID} onReceive={() => undefined} />
      </Providers>,
    );

    expect(screen.getByText('Preview rendering…')).toBeInTheDocument();
    expect(screen.queryByText('Preview unavailable')).not.toBeInTheDocument();
    await waitFor(() => expect(requestRasters).toHaveBeenCalledWith([INSCRIPTION_ID]));
  });

  it('keeps verified shelves stationary while checking in the background', () => {
    hookOverride = {
      result: freshResult(),
      status: 'syncing',
      authority: 'fresh',
      refreshing: true,
      refresh: async () => undefined,
      synchronizeWallet: async () => true,
      requestRasters: () => undefined,
      applyItemState: () => undefined,
    };

    const rendered = renderGallery();

    expect(screen.queryByText('Checking your wallet for Ordinals…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toHaveTextContent('Checking…');
    expect(rendered.container.querySelector('[data-gallery-collection]')).toBeInTheDocument();
  });

  it('keeps a settled preview failure distinct and does not lazy-request it', async () => {
    install({ 'gallery.list': () => new Promise(() => undefined) });
    const requestRasters = vi.fn();
    hookOverride = {
      result: {
        ...freshResult(),
        previewsUnavailable: true,
        items: [{
          ...freshResult().items[0]!,
          preview: { kind: 'placeholder' as const, reason: GALLERY_PREVIEW_UNAVAILABLE },
        }],
      },
      status: 'ready',
      authority: 'fresh',
      refreshing: false,
      refresh: async () => undefined,
      synchronizeWallet: async () => true,
      requestRasters,
      applyItemState: () => undefined,
    };

    renderGallery();

    expect(screen.getByText('Preview unavailable')).toBeInTheDocument();
    expect(screen.queryByText('Preview rendering…')).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestRasters).not.toHaveBeenCalled();
  });

  it('restores every affordance once the batch lands', async () => {
    const batch = deferred<unknown>();
    install({
      'gallery.list': () => batch.promise,
      'gallery.cached': () => ({
        ok: true,
        result: { accountId: ACCOUNT_ID, hit: true, items: [cachedItem(INSCRIPTION_ID, true)], cachedAt: 5 },
      }),
    });

    renderGallery();

    const article = await findGalleryArticle();
    const detailsSlot = article.querySelector('[data-details-slot]');
    expect(detailsSlot).toBeEmptyDOMElement();
    batch.settle({ ok: true, result: freshResult() });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Hide' })).toBeEnabled();
    expect(article.querySelector('[data-details-slot]')).toBe(detailsSlot);
    expect(detailsSlot?.querySelector('details')).not.toBeNull();
  });
});
