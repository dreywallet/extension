import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Gallery } from '../../src/entrypoints/popup/Gallery';
import { installFakeChrome, Providers } from './fake-rpc';

const EXPECTATION = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};
const ACCOUNT_ID = `acct_signet_${'1'.repeat(64)}`;

afterEach(cleanup);

function item(character: string, number: number) {
  const inscriptionId = `${character.repeat(64)}i0`;
  return {
    inscriptionId,
    state: 'visible' as const,
    number,
    contentType: 'image/png',
    contentLength: 1,
    satpoint: `${character.repeat(64)}:0:0`,
    outpoint: { txid: character.repeat(64), vout: 0 },
    confirmations: 2,
    parent: null,
    delegate: null,
    reinscription: false,
    cursed: false,
    classificationRevision: 'rev-1',
    rareSats: [],
    ownership: {
      address: `bc1q${character.repeat(38)}`,
      lane: 'ordinals' as const,
      role: 'primary' as const,
    },
    display: { title: null, collections: [] },
    preview: {
      kind: 'raster' as const,
      rasterBase64: 'AA==',
      pngSha256: character.repeat(64),
      pngWidth: 1,
      pngHeight: 1,
    },
    mediaAvailable: true,
    action: { status: 'available' as const, kind: 'send' as const },
  };
}

function mediaResponse(inscriptionId: string, leaseCharacter: string) {
  return {
    ok: true as const,
    result: {
      disposition: 'media' as const,
      leaseId: leaseCharacter.repeat(32),
      expiresAt: Date.now() + 30_000,
      inscriptionId,
      contentType: 'image/png',
      contentSha256: leaseCharacter.repeat(64),
      contentByteLength: 1,
      bytesBase64: 'AA==',
    },
  };
}

function renderDeferredGallery() {
  const first = item('a', 1);
  const second = item('b', 2);
  const requests: Array<{
    inscriptionId: string;
    resolve(response: ReturnType<typeof mediaResponse>): void;
  }> = [];
  installFakeChrome({
    'gallery.cached': () => ({ ok: true, result: { hit: false } }),
    'gallery.list': () => ({
      ok: true,
      result: {
        accountId: ACCOUNT_ID,
        items: [first, second],
        attentionItems: [],
        sweepCandidates: [],
        previewsUnavailable: false,
        collectionCatalog: null,
        recoveredAddressCount: 0,
        refreshedAt: 1,
      },
    }),
    'gallery.media.open': (payload) => new Promise((resolve) => {
      requests.push({
        inscriptionId: (payload as { inscriptionId: string }).inscriptionId,
        resolve: resolve as (response: ReturnType<typeof mediaResponse>) => void,
      });
    }),
  });
  render(
    <Providers>
      <Gallery
        expectation={EXPECTATION}
        account={0}
        accountId={ACCOUNT_ID}
        onReceive={() => undefined}
        continuous={false}
      />
    </Providers>,
  );
  return { first, second, requests };
}

const completedScan = {
  kind: 'completed' as const,
  scanId: 'scan-1',
  unitsDone: 4,
  unitsTotal: 4,
  currentUnit: null,
  boundaryUnits: [],
  failureReason: null,
  historyPartial: false,
};

function renderGalleryWithMediaHandlers(handlers: Record<string, (payload: unknown) => unknown>) {
  const galleryItem = item('a', 1);
  installFakeChrome({
    'gallery.cached': () => ({ ok: true, result: { hit: false } }),
    'gallery.list': () => ({
      ok: true,
      result: {
        accountId: ACCOUNT_ID,
        items: [galleryItem],
        attentionItems: [],
        sweepCandidates: [],
        previewsUnavailable: false,
        collectionCatalog: null,
        recoveredAddressCount: 0,
        refreshedAt: 1,
      },
    }),
    ...handlers,
  });
  render(
    <Providers>
      <Gallery
        expectation={EXPECTATION}
        account={0}
        accountId={ACCOUNT_ID}
        onReceive={() => undefined}
        continuous={false}
      />
    </Providers>,
  );
  return galleryItem;
}

async function openOnlyGalleryItem(): Promise<void> {
  const collection = await waitFor(() => {
    const node = document.querySelector<HTMLElement>('[data-gallery-collection]');
    expect(node).not.toBeNull();
    return node!;
  });
  fireEvent.click(collection);
  await userEvent.click(await screen.findByRole('button', { name: 'Open media' }));
}

describe('gallery media request identity', () => {
  it('uses a compact card label and offers postage management from the media viewer', async () => {
    const onOrdinalAction = vi.fn();
    const galleryItem = item('a', 1);
    installFakeChrome({
      'gallery.cached': () => ({ ok: true, result: { hit: false } }),
      'gallery.list': () => ({
        ok: true,
        result: {
          accountId: ACCOUNT_ID,
          items: [galleryItem],
          attentionItems: [],
          sweepCandidates: [],
          previewsUnavailable: false,
          collectionCatalog: null,
          recoveredAddressCount: 0,
          refreshedAt: 1,
        },
      }),
      'gallery.media.open': (payload) => mediaResponse(
        (payload as { inscriptionId: string }).inscriptionId,
        'c',
      ),
    });
    render(
      <Providers>
        <Gallery
          expectation={EXPECTATION}
          account={0}
          accountId={ACCOUNT_ID}
          onReceive={() => undefined}
          onOrdinalAction={onOrdinalAction}
          continuous={false}
        />
      </Providers>,
    );

    const collection = await waitFor(() => {
      const node = document.querySelector<HTMLElement>('[data-gallery-collection]');
      expect(node).not.toBeNull();
      return node!;
    });
    fireEvent.click(collection);
    const compactAction = await screen.findByRole('button', {
      name: 'Manage bitcoin kept with this collectible',
    });
    expect(compactAction).toHaveTextContent('Manage postage');

    await userEvent.click(screen.getByRole('button', { name: 'Open media' }));
    const viewer = await screen.findByRole('dialog', { name: 'Sandboxed inscription media' });
    await userEvent.click(within(viewer).getByRole('button', {
      name: 'Manage bitcoin kept with this collectible',
    }));

    expect(onOrdinalAction).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'ordinal_postage_manage',
      account: 0,
      selection: expect.objectContaining({ inscriptionId: galleryItem.inscriptionId }),
    }));
    await waitFor(() => expect(screen.queryByRole('dialog', {
      name: 'Sandboxed inscription media',
    })).not.toBeInTheDocument());
  });

  it('keeps the newest inscription when deferred responses arrive in reverse order', async () => {
    const { first, second, requests } = renderDeferredGallery();
    await waitFor(() => expect(document.querySelector('[data-gallery-collection]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-gallery-collection]')!);
    const buttons = await screen.findAllByRole('button', { name: 'Open media' });
    await userEvent.click(buttons[0]!);
    await userEvent.click(buttons[1]!);
    expect(requests.map(({ inscriptionId }) => inscriptionId)).toEqual([
      first.inscriptionId,
      second.inscriptionId,
    ]);

    await act(async () => requests[1]!.resolve(mediaResponse(second.inscriptionId, 'd')));
    const viewer = await screen.findByRole('dialog', { name: 'Sandboxed inscription media' });
    expect(within(viewer).getByText(second.inscriptionId)).toBeInTheDocument();

    await act(async () => requests[0]!.resolve(mediaResponse(first.inscriptionId, 'c')));
    expect(within(viewer).getByText(second.inscriptionId)).toBeInTheDocument();
    expect(within(viewer).queryByText(first.inscriptionId)).not.toBeInTheDocument();
  });

  it('does not reopen after the viewer closes while an older request is outstanding', async () => {
    const { first, second, requests } = renderDeferredGallery();
    await waitFor(() => expect(document.querySelector('[data-gallery-collection]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-gallery-collection]')!);
    const buttons = await screen.findAllByRole('button', { name: 'Open media' });
    await userEvent.click(buttons[0]!);
    await userEvent.click(buttons[1]!);
    await act(async () => requests[1]!.resolve(mediaResponse(second.inscriptionId, 'd')));
    const viewer = await screen.findByRole('dialog', { name: 'Sandboxed inscription media' });
    await userEvent.click(within(viewer).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', {
      name: 'Sandboxed inscription media',
    })).not.toBeInTheDocument());

    await act(async () => requests[0]!.resolve(mediaResponse(first.inscriptionId, 'c')));
    expect(screen.queryByRole('dialog', { name: 'Sandboxed inscription media' }))
      .not.toBeInTheDocument();
  });

  it('refreshes a stale classification and retries the complete media open exactly once', async () => {
    const scanStartResolvers: Array<(value: unknown) => void> = [];
    const scanStart = vi.fn(() => new Promise((resolve) => scanStartResolvers.push(resolve)));
    const open = vi.fn()
      .mockReturnValueOnce({ ok: false, code: 'ERR_DATA_STALE' })
      .mockImplementationOnce((payload: unknown) => mediaResponse(
        (payload as { inscriptionId: string }).inscriptionId,
        'c',
      ));
    const galleryItem = renderGalleryWithMediaHandlers({
      'gallery.media.open': open,
      'scan.status': () => ({ ok: true, result: completedScan }),
      'scan.start': scanStart,
    });

    const opening = openOnlyGalleryItem();
    expect(await screen.findByText(
      'A new block changed wallet verification. Refreshing it before opening this media…',
    )).toBeInTheDocument();
    expect(open).toHaveBeenCalledOnce();
    expect(scanStart).toHaveBeenCalledWith({ mode: 'refresh', ...EXPECTATION });

    await act(async () => scanStartResolvers[0]?.({ ok: true, result: { scanId: 'scan-2' } }));
    await opening;
    const viewer = await screen.findByRole('dialog', { name: 'Sandboxed inscription media' });
    expect(within(viewer).getByText(galleryItem.inscriptionId)).toBeInTheDocument();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('does not loop when the single stale-revision retry fails', async () => {
    const open = vi.fn()
      .mockReturnValueOnce({ ok: false, code: 'ERR_DATA_STALE' })
      .mockReturnValueOnce({ ok: false, code: 'ERR_GATEWAY_UNAVAILABLE' });
    const scanStart = vi.fn(() => ({ ok: true, result: { scanId: 'scan-2' } }));
    renderGalleryWithMediaHandlers({
      'gallery.media.open': open,
      'scan.status': () => ({ ok: true, result: completedScan }),
      'scan.start': scanStart,
    });

    await openOnlyGalleryItem();
    expect(await screen.findByText(
      'The media service is temporarily unavailable. Please try again.',
    )).toBeInTheDocument();
    expect(scanStart).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('reports genuinely unsafe media without synchronizing or retrying', async () => {
    const open = vi.fn(() => ({
      ok: true,
      result: {
        disposition: 'unavailable' as const,
        reason: 'active_content',
        inscriptionId: `${'a'.repeat(64)}i0`,
      },
    }));
    const scanStart = vi.fn();
    renderGalleryWithMediaHandlers({
      'gallery.media.open': open,
      'scan.status': () => ({ ok: true, result: completedScan }),
      'scan.start': scanStart,
    });

    await openOnlyGalleryItem();
    expect(await screen.findByText(
      'This media is unsupported or could not be verified safely. The inscription is still protected.',
    )).toBeInTheDocument();
    expect(open).toHaveBeenCalledOnce();
    expect(scanStart).not.toHaveBeenCalled();
  });
});
