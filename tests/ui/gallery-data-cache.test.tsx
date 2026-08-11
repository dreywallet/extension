/**
 * The popup unmounts the inactive tab, so the gallery must survive a tab
 * switch without re-issuing its signed batch — while still refetching whenever
 * ownership could have moved. These cover both halves.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Gallery } from '../../src/entrypoints/popup/Gallery';
import {
  PENDING_GALLERY_SCAN_INTERVAL_MS,
  useGalleryData,
} from '../../src/ui/hooks/use-gallery-data';
import {
  SCAN_PROGRESS_EVENT,
  SESSION_STATE_CHANGED_EVENT,
  WALLET_DATA_CHANGED_EVENT,
} from '@drey/core/messaging/events';
import { emitRuntimeMessage, installFakeChrome, Providers } from './fake-rpc';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

function galleryResult(recovered = false) {
  return {
    accountId: ACCOUNT_ID,
    items: [
      {
        inscriptionId: INSCRIPTION_ID,
        state: 'visible' as const,
        number: 1,
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
        ownership: {
          address: recovered
            ? 'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh'
            : 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
          lane: 'ordinals' as const,
          role: recovered ? 'recovered' as const : 'primary' as const,
        },
        preview: {
          kind: 'raster' as const,
          rasterBase64: 'AA==',
          pngSha256: 'e'.repeat(64),
          pngWidth: 1,
          pngHeight: 1,
        },
        mediaAvailable: false,
        action: { status: 'available' as const, kind: 'send' as const },
      },
    ],
    sweepCandidates: [],
    recoveredAddressCount: recovered ? 1 : 0,
    refreshedAt: 1_752_969_600_000,
  };
}

function pendingGallery(number: number | null = 1234) {
  const base = galleryResult();
  return {
    ...base,
    items: [{
      ...base.items[0]!,
      number,
      confirmations: 0,
      preview: { kind: 'placeholder' as const, reason: 'stale_classification' },
      mediaAvailable: false,
      action: {
        status: 'blocked' as const,
        kind: 'send' as const,
        reason: 'unconfirmed' as const,
      },
    }],
  };
}

function renderGallery(account = 0) {
  return render(
    <Providers>
      <Gallery
        expectation={EXPECTATION}
        account={account}
        accountId={account === 0 ? ACCOUNT_ID : OTHER_ACCOUNT_ID}
        onReceive={() => undefined}
      />
    </Providers>,
  );
}

async function openFirstShelf(): Promise<void> {
  await waitFor(() => expect(document.querySelector('[data-gallery-collection]')).not.toBeNull());
  fireEvent.click(document.querySelector('[data-gallery-collection]')!);
}

async function findGalleryArticle(): Promise<HTMLElement> {
  const current = screen.queryByRole('article');
  if (current !== null) return current;
  await openFirstShelf();
  return screen.findByRole('article');
}

function install(galleryList: ReturnType<typeof vi.fn>) {
  installFakeChrome({
    'gallery.list': galleryList,
    'scan.status': () => ({ ok: true, result: completedScan }),
    'scan.start': () => ({ ok: true, result: { scanId: 'scan-2' } }),
    'gallery.update': () => ({ ok: true, result: { updated: true } }),
  });
}

describe('gallery data cache', () => {
  it('leaves ordinary accounts visually unchanged', async () => {
    install(vi.fn(() => ({ ok: true, result: galleryResult() })));
    renderGallery();
    expect(await findGalleryArticle()).toBeInTheDocument();
    expect(screen.queryByText('Recovered addresses included')).not.toBeInTheDocument();
  });

  it('presents curated collections as shelves that drill into the existing cards', async () => {
    const base = galleryResult().items[0]!;
    const nodeRoot =
      '2ebbd9b93006b69714dd517fbe0d4bf7f8462ffe213105e03048d49ed46eba04i0';
    const boldRoot =
      'bc5f7ea515822472d6da34d6986e1d1fecd0df865098de79e33d913ab743eb7di0';
    const item = (
      suffix: string,
      number: number,
      title: string | null,
      collections: Array<{
        slug: string;
        name: string;
        kind: 'parent' | 'gallery';
        rootInscriptionIds: string[];
      }>,
    ) => ({
      ...base,
      inscriptionId: `${suffix.repeat(64)}i0`,
      number,
      display: {
        title: title === null ? null : { text: title, source: 'ord_properties' as const },
        collections,
      },
    });
    const result = {
      ...galleryResult(),
      collectionCatalog: {
        source: 'TheWizardsOfOrd/ordinals-collections' as const,
        revision: '1'.repeat(40),
        sha256: '2'.repeat(64),
        galleryIndexStatus: 'ready' as const,
      },
      items: [
        item('b', 2, null, [{
          slug: 'boldinals', name: 'boldinals', kind: 'parent', rootInscriptionIds: [boldRoot],
        }]),
        item('a', 1, 'NodeMonke #1', [{
          slug: 'nodemonkes', name: 'NodeMonkes', kind: 'gallery', rootInscriptionIds: [nodeRoot],
        }]),
        item('c', 3, null, [
          { slug: 'nodemonkes', name: 'NodeMonkes', kind: 'gallery', rootInscriptionIds: [nodeRoot] },
          { slug: 'wizards', name: 'The Wizards of Ord', kind: 'gallery',
            rootInscriptionIds: [`${'d'.repeat(64)}i0`] },
        ]),
        item('e', 4, null, []),
      ],
    };
    install(vi.fn(() => ({ ok: true, result })));
    renderGallery();

    const shelves = await screen.findAllByRole('button', {
      name: /^(boldinals|NodeMonkes|Multiple collections|Other inscriptions) \(1\)$/u,
    });
    expect(shelves).toHaveLength(4);
    expect(screen.queryByRole('article')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'NodeMonkes (1)' }));
    expect(screen.getByRole('heading', { name: 'NodeMonkes' })).toBeInTheDocument();
    expect(screen.getAllByText('NodeMonke #1')).toHaveLength(2);
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('Curated gallery')).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(1);

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'NodeMonkes (1)' })).toHaveFocus();
  });

  it('uses the same shelf drill-in for hidden inscriptions', async () => {
    const base = galleryResult();
    install(vi.fn(() => ({
      ok: true,
      result: { ...base, items: [{ ...base.items[0]!, state: 'hidden' as const }] },
    })));
    renderGallery();

    await userEvent.click(await screen.findByRole('tab', { name: 'Hidden (1)' }));
    const shelf = screen.getByRole('button', { name: 'Other inscriptions (1)' });
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    await userEvent.click(shelf);
    expect(await screen.findByRole('article')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unhide' })).toBeInTheDocument();
  });

  it('opens the target collection before focusing a deep-linked inscription', async () => {
    const handled = vi.fn();
    install(vi.fn(() => ({ ok: true, result: galleryResult() })));
    render(
      <Providers>
        <Gallery
          expectation={EXPECTATION}
          account={0}
          accountId={ACCOUNT_ID}
          initialInscriptionId={INSCRIPTION_ID}
          onInitialInscriptionHandled={handled}
          onReceive={() => undefined}
        />
      </Providers>,
    );

    const article = await screen.findByRole('article');
    await waitFor(() => expect(article.querySelector('details')).toHaveAttribute('open'));
    expect(screen.getByRole('heading', { name: 'Other inscriptions' })).toBeInTheDocument();
    expect(handled).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'co-located inscription',
      'co_located' as const,
      'This inscription is co-located with another inscription and cannot be sent alone.',
    ],
    [
      'unverifiable location',
      'unverifiable_location' as const,
      'This inscription’s on-chain location could not be verified, so it cannot be sent safely.',
    ],
  ])('keeps a blocked-action explanation discoverable for %s', async (_label, blockedReason, copy) => {
    const base = galleryResult();
    const result = {
      ...base,
      items: [{
        ...base.items[0]!,
        action: {
          status: 'blocked' as const,
          kind: 'send' as const,
          reason: blockedReason,
        },
      }],
    };
    install(vi.fn(() => ({ ok: true, result })));
    renderGallery();

    await openFirstShelf();
    const summary = await screen.findByText('Why unavailable?');
    const reason = screen.getByText(copy);
    expect(reason).not.toBeVisible();
    await userEvent.click(summary);
    expect(reason).toBeVisible();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('presents a known pending inscription as a lifecycle state instead of stale data', async () => {
    install(vi.fn(() => ({ ok: true, result: pendingGallery() })));
    renderGallery();

    const card = await findGalleryArticle();
    expect(card).toHaveTextContent('#1234');
    expect(card).toHaveTextContent('Pending confirmation');
    expect(card).toHaveTextContent('Preview pending confirmation');
    expect(card).not.toHaveTextContent('Unnumbered inscription');
    expect(screen.queryByText(/Asset verification is out of date/u)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    await userEvent.click(screen.getByText('Why unavailable?'));
    expect(screen.getByText(
      'This inscription is in an unconfirmed Bitcoin transaction. Drey will finish verification after the first confirmation. No action is needed.',
    )).toBeVisible();
  });

  it('calls a pending item without a corroborated number a pending inscription', async () => {
    install(vi.fn(() => ({ ok: true, result: pendingGallery(null) })));
    renderGallery();

    await openFirstShelf();
    expect(await screen.findByText('Pending inscription')).toBeInTheDocument();
    expect(screen.queryByText('Unnumbered inscription')).not.toBeInTheDocument();
  });

  it('reserves the stale Refresh instruction for a confirmed stale item', async () => {
    const base = galleryResult();
    const result = {
      ...base,
      items: [{
        ...base.items[0]!,
        preview: { kind: 'placeholder' as const, reason: 'stale_classification' },
        mediaAvailable: false,
        action: {
          status: 'blocked' as const,
          kind: 'send' as const,
          reason: 'stale_classification' as const,
        },
      }],
    };
    install(vi.fn(() => ({ ok: true, result })));
    renderGallery();

    await openFirstShelf();
    await userEvent.click(await screen.findByText('Why unavailable?'));
    expect(screen.getByText('Asset verification is out of date. Refresh before spending.'))
      .toBeVisible();
    expect(screen.queryByText('Pending confirmation')).not.toBeInTheDocument();
  });

  it('explains verified recovered collectibles once per vault', async () => {
    const galleryList = vi.fn(() => ({ ok: true, result: galleryResult(true) }));
    install(galleryList);

    const first = renderGallery();
    expect(await screen.findByText('Recovered addresses included')).toBeInTheDocument();
    expect(screen.getByText(/Wallets such as Xverse may show those addresses/u))
      .toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByText('Recovered addresses included')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('tab', { name: 'All (1)' })).toHaveFocus());

    first.unmount();
    renderGallery();
    await waitFor(() => {
      expect(screen.queryByText('Recovered addresses included')).not.toBeInTheDocument();
    });
    expect(galleryList).toHaveBeenCalledOnce();
  });

  it('keeps a delayed dismissal read alive while the notice enters loading state', async () => {
    install(vi.fn(() => ({ ok: true, result: galleryResult(true) })));
    let resolveStorage!: (value: Record<string, unknown>) => void;
    const storageRead = new Promise<Record<string, unknown>>((resolve) => {
      resolveStorage = resolve;
    });
    const originalGet = chrome.storage.local.get;
    chrome.storage.local.get = () => storageRead;
    try {
      renderGallery();
      expect(await findGalleryArticle()).toBeInTheDocument();
      expect(screen.queryByText('Recovered addresses included')).not.toBeInTheDocument();
      resolveStorage({});
      expect(await screen.findByText('Recovered addresses included')).toBeInTheDocument();
    } finally {
      chrome.storage.local.get = originalGet;
    }
  });

  it('keeps a dismissed notice hidden for the current popup when storage fails', async () => {
    install(vi.fn(() => ({ ok: true, result: galleryResult(true) })));
    const originalSet = chrome.storage.local.set;
    chrome.storage.local.set = vi.fn(() => Promise.reject(new Error('quota')));
    try {
      renderGallery();
      await userEvent.click(await screen.findByRole('button', { name: 'Got it' }));
      expect(screen.queryByText('Recovered addresses included')).not.toBeInTheDocument();
      expect(await findGalleryArticle()).toBeInTheDocument();
    } finally {
      chrome.storage.local.set = originalSet;
    }
  });

  it('serves a tab switch from the store without re-issuing the batch', async () => {
    const galleryList = vi.fn(() => ({ ok: true, result: galleryResult() }));
    install(galleryList);

    const first = renderGallery();
    expect(await findGalleryArticle()).toBeInTheDocument();
    expect(galleryList).toHaveBeenCalledOnce();

    // Leaving the Ordinals tab unmounts the surface.
    first.unmount();
    renderGallery();

    // Coming back paints immediately from the store and issues no new batch.
    expect(await findGalleryArticle()).toBeInTheDocument();
    expect(galleryList).toHaveBeenCalledOnce();
  });

  it('still refetches for a different account', async () => {
    const galleryList = vi.fn(() => ({ ok: true, result: galleryResult() }));
    install(galleryList);

    const first = renderGallery(0);
    expect(await findGalleryArticle()).toBeInTheDocument();
    first.unmount();

    renderGallery(1);
    await waitFor(() => expect(galleryList).toHaveBeenCalledTimes(2));
    expect(galleryList).toHaveBeenLastCalledWith({
      accountId: OTHER_ACCOUNT_ID, rasterFor: [], ...EXPECTATION,
    });
  });

  it('refetches when the Refresh button is used', async () => {
    const galleryList = vi.fn(() => ({ ok: true, result: galleryResult() }));
    install(galleryList);

    renderGallery();
    const refresh = await screen.findByRole('button', { name: 'Refresh' });
    await waitFor(() => expect(refresh).toBeEnabled());
    await userEvent.click(refresh);

    await waitFor(() => expect(galleryList).toHaveBeenCalledTimes(2));
  });

  it.each([
    ['a wallet-data change', { type: WALLET_DATA_CHANGED_EVENT, reason: 'utxo' }],
    ['scan progress', { type: SCAN_PROGRESS_EVENT }],
  ])('invalidates on %s so confirmations cannot go stale', async (_label, event) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const galleryList = vi.fn(() => ({ ok: true, result: galleryResult() }));
    install(galleryList);

    renderGallery();
    expect(await findGalleryArticle()).toBeInTheDocument();
    expect(galleryList).toHaveBeenCalledOnce();

    emitRuntimeMessage(event);
    // Invalidation refetches are debounced so a running scan cannot storm.
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await waitFor(() => expect(galleryList).toHaveBeenCalledTimes(2), { timeout: 4_000 });
  });

  it('disables Refresh while a batch is in flight behind a painted grid', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const galleryList = vi.fn(async () => {
      calls += 1;
      if (calls > 1) await gate;
      return { ok: true, result: galleryResult() };
    });
    install(galleryList);

    renderGallery();
    const refresh = await screen.findByRole('button', { name: 'Refresh' });
    await waitFor(() => expect(refresh).toBeEnabled());

    // A revalidation behind an already-painted grid keeps status 'ready', so
    // without the refreshing flag this button would look clickable and do
    // nothing.
    emitRuntimeMessage({ type: WALLET_DATA_CHANGED_EVENT, reason: 'utxo' });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await waitFor(() => expect(refresh).toBeDisabled(), { timeout: 4_000 });

    release();
    await waitFor(() => expect(refresh).toBeEnabled());
  });

  it('does not lose an invalidation that lands mid-batch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const galleryList = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await gate;
      return { ok: true, result: galleryResult() };
    });
    install(galleryList);

    renderGallery();
    await waitFor(() => expect(galleryList).toHaveBeenCalledOnce());

    // The event arrives while the first batch is still in flight, so its
    // response already predates the change and must not be the final word.
    emitRuntimeMessage({ type: WALLET_DATA_CHANGED_EVENT, reason: 'utxo' });
    release();

    await waitFor(() => expect(galleryList).toHaveBeenCalledTimes(2), { timeout: 4_000 });
    expect(await findGalleryArticle()).toBeInTheDocument();
  });

  it('stops auto-refetching after a failure so scan progress cannot storm', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const galleryList = vi.fn(() => ({ ok: false, code: 'ERR_DATA_STALE' }));
    install(galleryList);

    renderGallery();
    // Stale recovery runs a scan, and that scan's progress events invalidate
    // the gallery again. Without parking, each event refetches forever.
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    const afterFailure = galleryList.mock.calls.length;

    for (let i = 0; i < 5; i += 1) {
      emitRuntimeMessage({ type: SCAN_PROGRESS_EVENT });
    }
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(galleryList).toHaveBeenCalledTimes(afterFailure);

    // The user asking again must still work.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(galleryList.mock.calls.length).toBeGreaterThan(afterFailure));
  });

  it('drops the store on lock so a relock cannot repaint the grid', async () => {
    const galleryList = vi.fn(() => ({ ok: true, result: galleryResult() }));
    install(galleryList);

    const first = renderGallery();
    expect(await findGalleryArticle()).toBeInTheDocument();

    emitRuntimeMessage({ type: SESSION_STATE_CHANGED_EVENT, locked: true });
    first.unmount();
    renderGallery();

    // Nothing is painted from memory; the surface refetches from scratch.
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    await waitFor(() => expect(galleryList).toHaveBeenCalledTimes(2));
  });

  it('clears a cached grid when revalidation fails, leaving nothing tappable', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const galleryList = vi.fn()
      .mockReturnValueOnce({ ok: true, result: galleryResult() })
      .mockReturnValue({ ok: false, code: 'ERR_INTERNAL' });
    install(galleryList);

    renderGallery();
    expect(await findGalleryArticle()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();

    emitRuntimeMessage({ type: WALLET_DATA_CHANGED_EVENT, reason: 'utxo' });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(
      'Verified inscription details are unavailable.'), { timeout: 4_000 });
    // The stale card and its Send action are gone, not merely annotated.
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });
});

describe('gallery lazy rasters', () => {
  const OTHER_ID = `${'b'.repeat(64)}i0`;

  function bothRastered() {
    const base = galleryResult();
    const first = base.items[0]!;
    return {
      ...base,
      items: [first, { ...first, inscriptionId: OTHER_ID, satpoint: `${'d'.repeat(64)}:0:0` }],
    };
  }

  function secondUnrequested(
    overrides: { movedSatpoint?: boolean; newRevision?: boolean } = {},
  ) {
    const base = bothRastered();
    const second = base.items[1]!;
    return {
      ...base,
      items: [
        base.items[0]!,
        {
          ...second,
          ...(overrides.movedSatpoint === true ? { satpoint: `${'f'.repeat(64)}:9:9` } : {}),
          ...(overrides.newRevision === true ? { classificationRevision: 'rev-2' } : {}),
          preview: { kind: 'placeholder' as const, reason: 'not_requested' },
        },
      ],
    };
  }

  async function renderThenRevalidate(second: ReturnType<typeof secondUnrequested>) {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const galleryList = vi.fn()
      .mockReturnValueOnce({ ok: true, result: bothRastered() })
      .mockReturnValue({ ok: true, result: second });
    install(galleryList);

    renderGallery();
    await waitFor(() =>
      expect(screen.getAllByTitle(/Inert preview for inscription/)).toHaveLength(2));

    emitRuntimeMessage({ type: WALLET_DATA_CHANGED_EVENT, reason: 'utxo' });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await waitFor(() => expect(galleryList).toHaveBeenCalledTimes(2), { timeout: 4_000 });
  }

  it('reuses a retained raster when the inscription has not moved', async () => {
    await renderThenRevalidate(secondUnrequested());

    // The second item came back as not_requested but its identity is unchanged,
    // so its already-verified raster is carried forward rather than dropped.
    expect(screen.getAllByTitle(/Inert preview for inscription/)).toHaveLength(2);
  });

  it('reuses a retained media badge instead of flashing a placeholder', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const badge = {
      kind: 'mediaBadge' as const,
      mediaKind: 'video' as const,
      contentLength: 3_969_199,
    };
    const initial = bothRastered();
    initial.items[1] = { ...initial.items[1]!, preview: badge as never };
    const revalidated = secondUnrequested();
    const galleryList = vi.fn()
      .mockReturnValueOnce({ ok: true, result: initial })
      .mockReturnValue({ ok: true, result: revalidated });
    install(galleryList);

    renderGallery();
    await waitFor(() => expect(screen.getByText('Video inscription')).toBeInTheDocument());

    emitRuntimeMessage({ type: WALLET_DATA_CHANGED_EVENT, reason: 'utxo' });
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    await waitFor(() => expect(galleryList).toHaveBeenCalledTimes(2), { timeout: 4_000 });

    // The badge is a settled, signed preview bound to the same identity; a
    // re-list that skipped it must not demote it to "Preview unavailable".
    expect(screen.getByText('Video inscription')).toBeInTheDocument();
    expect(screen.queryByText('Preview unavailable')).not.toBeInTheDocument();
  });

  it.each([
    ['the satpoint moved', { movedSatpoint: true }],
    ['the classification revision changed', { newRevision: true }],
  ])('drops a retained raster when %s', async (_label, overrides) => {
    await renderThenRevalidate(secondUnrequested(overrides));

    // A raster is bound to an exact identity; once that identity changes the
    // old image must never be shown against the new one.
    await waitFor(() =>
      expect(screen.getAllByTitle(/Inert preview for inscription/)).toHaveLength(1));
  });
});

describe('gallery raster requests', () => {
  const OTHER = `${'b'.repeat(64)}i0`;

  function unrequestedPair() {
    const base = galleryResult();
    const first = base.items[0]!;
    const placeholder = { kind: 'placeholder' as const, reason: 'not_requested' };
    return {
      ...base,
      items: [
        { ...first, preview: placeholder },
        { ...first, inscriptionId: OTHER, satpoint: `${'d'.repeat(64)}:0:0`, preview: placeholder },
      ],
    };
  }

  it('asks for rasters of cards on screen instead of the whole wallet', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const galleryList = vi.fn(() => ({ ok: true, result: unrequestedPair() }));
    install(galleryList);

    renderGallery();

    // Every load is lazy now: the first request asks for nothing, and the
    // worker still returns anything lacking cached metadata.
    await waitFor(() => expect(galleryList).toHaveBeenCalled());
    const firstCall = galleryList.mock.calls.at(0) as unknown[] | undefined;
    expect(firstCall?.[0]).toMatchObject({ rasterFor: [] });

    // jsdom has no IntersectionObserver, so LazyCard fails open and requests
    // both visible cards — the follow-up names exactly them.
    await act(async () => vi.advanceTimersByTimeAsync(150));
    await waitFor(() => expect(galleryList.mock.calls.length).toBeGreaterThan(1));
    const followUp = (galleryList.mock.calls.at(-1) as unknown[])[0] as { rasterFor: string[] };
    expect([...followUp.rasterFor].sort()).toEqual([INSCRIPTION_ID, OTHER].sort());
  });

  it('requests only three shelf previews before the collection is opened', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const base = galleryResult();
    const first = base.items[0]!;
    const ids = ['a', 'b', 'c', 'd'].map((character) => `${character.repeat(64)}i0`);
    const result = {
      ...base,
      items: ids.map((inscriptionId, index) => ({
        ...first,
        inscriptionId,
        satpoint: `${(index + 1).toString(16).repeat(64)}:0:0`,
        preview: { kind: 'placeholder' as const, reason: 'not_requested' },
      })),
    };
    const galleryList = vi.fn(() => ({ ok: true, result }));
    install(galleryList);
    renderGallery();

    await act(async () => vi.advanceTimersByTimeAsync(150));
    await waitFor(() => expect(galleryList.mock.calls.length).toBeGreaterThan(1));
    expect((galleryList.mock.calls.at(-1) as unknown[])[0]).toMatchObject({
      rasterFor: ids.slice(0, 3),
    });

    await openFirstShelf();
    await act(async () => vi.advanceTimersByTimeAsync(150));
    await waitFor(() => expect(galleryList).toHaveBeenCalledTimes(3));
    expect((galleryList.mock.calls.at(-1) as unknown[])[0]).toMatchObject({
      rasterFor: [ids[3]],
    });
  });

  it('does not lose a raster request made while a batch is in flight', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const galleryList = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await gate;
      return { ok: true, result: unrequestedPair() };
    });
    install(galleryList);

    // Driven through the hook so the request lands at an exact point in the
    // batch's lifetime rather than at the mercy of card mount timing.
    const { result } = renderHook(() => useGalleryData(EXPECTATION, ACCOUNT_ID), { wrapper: Providers });
    await waitFor(() => expect(galleryList).toHaveBeenCalledOnce());

    result.current.requestRasters([OTHER]);
    // Let the debounce fire while the first batch is still open: refresh()
    // early-returns, and the id is already marked wanted so requestRasters
    // will not re-fire it. Only a trailing queue can recover this.
    await act(async () => vi.advanceTimersByTimeAsync(400));
    expect(galleryList).toHaveBeenCalledOnce();

    release();
    await waitFor(() => expect(galleryList).toHaveBeenCalledTimes(2), { timeout: 4_000 });
    const secondCall = galleryList.mock.calls.at(1) as unknown[] | undefined;
    expect(secondCall?.[0]).toMatchObject({ rasterFor: [OTHER] });
  });

  it('sends each newly visible raster once across successive scroll bursts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const galleryList = vi.fn(() => ({ ok: true, result: galleryResult() }));
    install(galleryList);
    const ids = Array.from(
      { length: 14 },
      (_, index) => `${index.toString(16).padStart(64, '0')}i0`,
    );
    const bursts = [ids.slice(0, 4), ...Array.from(
      { length: 5 },
      (_, index) => ids.slice(4 + index * 2, 6 + index * 2),
    )];

    const { result } = renderHook(() => useGalleryData(EXPECTATION, ACCOUNT_ID), { wrapper: Providers });
    await waitFor(() => expect(galleryList).toHaveBeenCalledOnce());
    expect((galleryList.mock.calls[0] as unknown[])[0]).toMatchObject({ rasterFor: [] });

    for (const burst of bursts) {
      const callsBefore = galleryList.mock.calls.length;
      result.current.requestRasters(burst);
      await act(async () => vi.advanceTimersByTimeAsync(150));
      await waitFor(() => expect(galleryList).toHaveBeenCalledTimes(callsBefore + 1));
    }

    const requested = galleryList.mock.calls.slice(1).flatMap((call) =>
      ((call as unknown[])[0] as { rasterFor: string[] }).rasterFor);
    expect(requested).toEqual(ids);
    expect(new Set(requested).size).toBe(ids.length);
    // The former cumulative behavior sent 54 identities for these bursts.
    expect(requested).toHaveLength(14);
  });
});

describe('gallery refresh is never a no-op', () => {
  it('refetches every raster on an explicit Refresh, not just what is on screen', async () => {
    const galleryList = vi.fn(() => ({ ok: true, result: galleryResult() }));
    install(galleryList);

    renderGallery();
    const refresh = await screen.findByRole('button', { name: 'Refresh' });
    await waitFor(() => expect(refresh).toBeEnabled());
    await userEvent.click(refresh);

    await waitFor(() => expect(galleryList).toHaveBeenCalledTimes(2));
    // Automatic loads filter; an explicit Refresh must omit the filter entirely,
    // or a wallet whose metadata is already cached would re-verify nothing.
    const explicit = (galleryList.mock.calls.at(-1) as unknown[])[0] as Record<string, unknown>;
    expect(explicit).not.toHaveProperty('rasterFor');
  });
});

describe('pending gallery confirmation checks', () => {
  it('coalesces focus events and never restarts an already running scan', async () => {
    const galleryList = vi.fn(() => ({ ok: true, result: pendingGallery() }));
    const scanStatus = vi.fn(() => ({
      ok: true,
      result: { ...completedScan, kind: 'running' as const, unitsDone: 1 },
    }));
    const scanStart = vi.fn();
    installFakeChrome({
      'gallery.list': galleryList,
      'scan.status': scanStatus,
      'scan.start': scanStart,
    });

    const { result } = renderHook(
      () => useGalleryData(EXPECTATION, ACCOUNT_ID),
      { wrapper: Providers },
    );
    await waitFor(() => expect(result.current.result?.items[0]?.confirmations).toBe(0));

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(scanStatus).toHaveBeenCalledOnce());
    expect(scanStart).not.toHaveBeenCalled();
  });

  it('checks after one bounded interval and stops after the wallet locks', async () => {
    vi.useFakeTimers();
    const galleryList = vi.fn(() => ({ ok: true, result: pendingGallery() }));
    const scanStatus = vi.fn(() => ({ ok: true, result: completedScan }));
    const scanStart = vi.fn(() => ({ ok: true, result: { scanId: 'scan-2' } }));
    installFakeChrome({
      'gallery.list': galleryList,
      'scan.status': scanStatus,
      'scan.start': scanStart,
    });

    const { result, unmount } = renderHook(
      () => useGalleryData(EXPECTATION, ACCOUNT_ID),
      { wrapper: Providers },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.result?.items[0]?.confirmations).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_GALLERY_SCAN_INTERVAL_MS - 1);
    });
    expect(scanStatus).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(scanStatus).toHaveBeenCalledOnce();
    expect(scanStart).toHaveBeenCalledOnce();
    expect(scanStart).toHaveBeenCalledWith({ mode: 'refresh', ...EXPECTATION });

    emitRuntimeMessage({ type: SESSION_STATE_CHANGED_EVENT, locked: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_GALLERY_SCAN_INTERVAL_MS);
    });
    expect(scanStatus).toHaveBeenCalledOnce();
    unmount();
  });

  it('does not run pending-confirmation scans on a persistent panel', async () => {
    vi.useFakeTimers();
    const galleryList = vi.fn(() => ({ ok: true, result: pendingGallery() }));
    const scanStatus = vi.fn(() => ({ ok: true, result: completedScan }));
    const scanStart = vi.fn(() => ({ ok: true, result: { scanId: 'scan-2' } }));
    installFakeChrome({
      'gallery.list': galleryList,
      'scan.status': scanStatus,
      'scan.start': scanStart,
    });

    const { result } = renderHook(
      () => useGalleryData(EXPECTATION, ACCOUNT_ID, { continuous: false }),
      { wrapper: Providers },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.result?.items[0]?.confirmations).toBe(0);

    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_GALLERY_SCAN_INTERVAL_MS * 2);
    });
    expect(scanStatus).not.toHaveBeenCalled();
    expect(scanStart).not.toHaveBeenCalled();
  });

  it('stops checking after a pending item becomes confirmed', async () => {
    vi.useFakeTimers();
    const galleryList = vi.fn()
      .mockReturnValueOnce({ ok: true, result: pendingGallery() })
      .mockReturnValue({ ok: true, result: galleryResult() });
    const scanStatus = vi.fn(() => ({ ok: true, result: completedScan }));
    installFakeChrome({
      'gallery.list': galleryList,
      'scan.status': scanStatus,
      'scan.start': () => ({ ok: true, result: { scanId: 'scan-2' } }),
    });

    const { result } = renderHook(
      () => useGalleryData(EXPECTATION, ACCOUNT_ID),
      { wrapper: Providers },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.result?.items[0]?.confirmations).toBe(0);

    emitRuntimeMessage({ type: WALLET_DATA_CHANGED_EVENT, reason: 'utxo' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(result.current.result?.items[0]?.confirmations).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PENDING_GALLERY_SCAN_INTERVAL_MS);
    });
    expect(scanStatus).not.toHaveBeenCalled();
  });
});

describe('gallery rapid tab switching', () => {
  it('does not refetch on any remount inside the freshness window', async () => {
    const galleryList = vi.fn(() => ({ ok: true, result: galleryResult() }));
    install(galleryList);

    let surface = renderGallery();
    expect(await findGalleryArticle()).toBeInTheDocument();
    expect(galleryList).toHaveBeenCalledOnce();

    // Hammer the tab switch. Repeated remounts must not accumulate requests.
    for (let i = 0; i < 8; i += 1) {
      surface.unmount();
      surface = renderGallery();
    }

    expect(await findGalleryArticle()).toBeInTheDocument();
    expect(galleryList).toHaveBeenCalledOnce();
  });

  it('still loads a cold surface even while parked from an earlier failure', async () => {
    const galleryList = vi.fn()
      .mockReturnValueOnce({ ok: false, code: 'ERR_INTERNAL' })
      .mockReturnValue({ ok: true, result: galleryResult() });
    install(galleryList);

    const first = renderGallery();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    const afterFailure = galleryList.mock.calls.length;
    first.unmount();

    // Parked, and there is nothing cached to paint. Refusing to fetch here
    // would strand the surface on "Loading…" with no request in flight, so the
    // user must still be able to recover with Refresh.
    renderGallery();
    const refresh = await screen.findByRole('button', { name: 'Refresh' });
    await waitFor(() => expect(refresh).toBeEnabled());
    await userEvent.click(refresh);

    expect(await findGalleryArticle()).toBeInTheDocument();
    expect(galleryList.mock.calls.length).toBeGreaterThan(afterFailure);
  });
});

describe('gallery request sharing and failure closure', () => {
  it('joins an in-flight request instead of starting one per remount', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const galleryList = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await gate;
      return { ok: true, result: galleryResult() };
    });
    install(galleryList);

    let surface = renderGallery();
    await waitFor(() => expect(galleryList).toHaveBeenCalledOnce());

    // Impatient switching before the first load lands. Each remount is a fresh
    // component, so a component-local guard would start another full gallery
    // operation every time.
    for (let i = 0; i < 6; i += 1) {
      surface.unmount();
      surface = renderGallery();
    }
    expect(galleryList).toHaveBeenCalledOnce();

    release();
    // The surface that joined still gets the result.
    expect(await findGalleryArticle()).toBeInTheDocument();
    expect(galleryList).toHaveBeenCalledOnce();
  });

  it('clears the grid and parks when the wallet scan fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const galleryList = vi.fn(() => ({ ok: true, result: galleryResult() }));
    installFakeChrome({
      'gallery.list': galleryList,
      // A scan that cannot be resumed makes synchronizeWallet fail.
      'scan.status': () => ({ ok: true, result: { ...completedScan, kind: 'failed' } }),
      'scan.start': () => ({ ok: false, code: 'ERR_INTERNAL' }),
      'gallery.update': () => ({ ok: true, result: { updated: true } }),
    });

    renderGallery();
    expect(await findGalleryArticle()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();

    // Refresh runs a scan first; when that fails the grid must not stay
    // tappable behind the error banner.
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();

    // And it must be parked: scan progress cannot restart the failed recovery.
    const afterFailure = galleryList.mock.calls.length;
    for (let i = 0; i < 3; i += 1) emitRuntimeMessage({ type: SCAN_PROGRESS_EVENT });
    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(galleryList).toHaveBeenCalledTimes(afterFailure);
  });

  it('does not repopulate the store after a lock', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const galleryList = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await gate;
      return { ok: true, result: galleryResult() };
    });
    install(galleryList);

    const surface = renderGallery();
    await waitFor(() => expect(galleryList).toHaveBeenCalledOnce());

    // Lock while the batch is open, then let it land.
    emitRuntimeMessage({ type: SESSION_STATE_CHANGED_EVENT, locked: true });
    surface.unmount();
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Remounting must not find the locked wallet's previews waiting in memory.
    renderGallery();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });
});
