import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Gallery } from '../../src/entrypoints/popup/Gallery';
import { clearGalleryDataStore } from '../../src/ui/hooks/use-gallery-data';
import type { OrdinalActionDraft } from '../../src/ui/ordinal-action';
import { installFakeChrome, Providers } from './fake-rpc';

const EXPECTATION = {
  expectedVaultId: 'vault-batch',
  expectedSessionId: '00000000-0000-4000-8000-000000000016',
};
const ACCOUNT_ID = `acct_signet_${'1'.repeat(64)}`;

function galleryItem(character: string, number: number, options: {
  txid?: string;
  vout?: number;
  offset?: number;
  coLocated?: boolean;
  idHex?: string;
} = {}) {
  const txid = options.txid ?? character.repeat(64);
  const vout = options.vout ?? 0;
  const offset = options.offset ?? 0;
  return {
    inscriptionId: `${options.idHex ?? character.repeat(64)}i0`,
    state: 'visible' as const,
    number,
    contentType: 'image/png',
    contentLength: 1,
    satpoint: `${txid}:${vout}:${offset}`,
    outpoint: { txid, vout },
    confirmations: 6,
    parent: null,
    delegate: null,
    reinscription: false,
    cursed: false,
    classificationRevision: 'batch-rev-1',
    rareSats: [],
    ownership: { address: `tb1p${character.repeat(38)}`, lane: 'ordinals' as const, role: 'primary' as const },
    display: { title: null, collections: [] },
    preview: { kind: 'placeholder' as const, reason: 'unavailable' },
    mediaAvailable: false,
    action: options.coLocated
      ? { status: 'blocked' as const, kind: 'send' as const, reason: 'co_located' as const }
      : { status: 'available' as const, kind: 'send' as const },
  };
}

function renderGallery(
  items: ReturnType<typeof galleryItem>[],
  onOrdinalAction = vi.fn<(draft: OrdinalActionDraft) => void>(),
) {
  installFakeChrome({
    'gallery.cached': () => ({ ok: true, result: { hit: false } }),
    'gallery.list': () => ({
      ok: true,
      result: {
        accountId: ACCOUNT_ID,
        items,
        attentionItems: [],
        sweepCandidates: [],
        previewsUnavailable: false,
        collectionCatalog: null,
        recoveredAddressCount: 0,
        refreshedAt: 1,
      },
    }),
  });
  render(
    <Providers>
      <Gallery
        expectation={EXPECTATION}
        account={0}
        accountId={ACCOUNT_ID}
        onOrdinalAction={onOrdinalAction}
        onReceive={() => undefined}
        continuous={false}
      />
    </Providers>,
  );
  return onOrdinalAction;
}

async function openSelectionMode(): Promise<void> {
  await userEvent.click(await screen.findByRole('button', { name: 'Select' }));
  const shelf = await waitFor(() => {
    const node = document.querySelector<HTMLElement>('[data-gallery-collection]');
    expect(node).not.toBeNull();
    return node!;
  });
  fireEvent.click(shelf);
}

afterEach(() => {
  cleanup();
  clearGalleryDataStore();
  vi.restoreAllMocks();
});

describe('native ordinal batch gallery selection', () => {
  it('selects every co-located inscription only after explicit confirmation', async () => {
    const sharedTxid = 'a'.repeat(64);
    const first = galleryItem('a', 1, { txid: sharedTxid, offset: 7, coLocated: true });
    const second = galleryItem('b', 2, { txid: sharedTxid, offset: 7, coLocated: true });
    const onOrdinalAction = renderGallery([first, second]);
    await openSelectionMode();

    const opener = screen.getByRole('button', { name: 'Select #1' });
    await userEvent.click(opener);
    const prompt = screen.getByRole('dialog', { name: 'These inscriptions travel together' });
    expect(prompt.tagName).toBe('DIALOG');
    expect(prompt).toHaveAttribute('open');
    expect(within(prompt).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(prompt).toHaveTextContent(
      '2 inscriptions share this sat and must travel together. Include all of them?',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Include all 2' }));
    expect(screen.queryByText('2 selected')).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
    await userEvent.click(screen.getByRole('button', { name: 'Continue with 2' }));

    expect(onOrdinalAction).toHaveBeenCalledOnce();
    expect(onOrdinalAction.mock.calls[0]?.[0]).toMatchObject({
      kind: 'ordinal_batch_transfer',
      account: 0,
      selections: [
        { inscriptionId: first.inscriptionId, satpoint: first.satpoint, classificationRevision: 'batch-rev-1' },
        { inscriptionId: second.inscriptionId, satpoint: second.satpoint, classificationRevision: 'batch-rev-1' },
      ],
    });
  });

  it('retains an incomplete source selection and offers explicit repair', async () => {
    const sharedTxid = 'c'.repeat(64);
    renderGallery([
      galleryItem('c', 3, { txid: sharedTxid, offset: 1 }),
      galleryItem('d', 4, { txid: sharedTxid, offset: 20 }),
    ]);
    await openSelectionMode();

    await userEvent.click(screen.getByRole('button', { name: 'Select #3' }));
    expect(screen.getByRole('button', { name: 'Continue with 1' })).toBeDisabled();
    expect(screen.getByText(/1 more inscription\(s\).*must also be selected/u)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Select all from this output' }));
    expect(screen.queryByText('2 selected')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with 2' })).toBeEnabled();
  });

  it('enforces the 16-ID cap without dropping the current selection', async () => {
    renderGallery(Array.from({ length: 17 }, (_, index) => {
      const idHex = index.toString(16).padStart(64, '0');
      return galleryItem((index % 16).toString(16), index + 1, { idHex, txid: idHex });
    }));
    await openSelectionMode();
    for (let index = 1; index <= 16; index += 1) {
      await userEvent.click(screen.getByRole('button', { name: `Select #${index}` }));
    }
    await userEvent.click(screen.getByRole('button', { name: 'Select #17' }));
    expect(screen.getByText('You can send up to 16 inscriptions at once.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with 16' })).toBeEnabled();
  });

  it('clears selection when the wallet session changes', async () => {
    const item = galleryItem('e', 5);
    const rendered = renderGallery([item]);
    await openSelectionMode();
    await userEvent.click(screen.getByRole('button', { name: 'Select #5' }));
    expect(screen.getByRole('button', { name: 'Continue with 1' })).toBeEnabled();

    cleanup();
    clearGalleryDataStore();
    installFakeChrome({
      'gallery.cached': () => ({ ok: true, result: { hit: false } }),
      'gallery.list': () => ({ ok: true, result: {
        accountId: ACCOUNT_ID, items: [item], attentionItems: [], sweepCandidates: [],
        previewsUnavailable: false, collectionCatalog: null, recoveredAddressCount: 0, refreshedAt: 2,
      } }),
    });
    render(<Providers><Gallery
      expectation={{ ...EXPECTATION, expectedSessionId: '00000000-0000-4000-8000-000000000017' }}
      account={0} accountId={ACCOUNT_ID} onOrdinalAction={rendered}
      onReceive={() => undefined} continuous={false}
    /></Providers>);
    expect(await screen.findByRole('button', { name: 'Select' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue with 1' })).not.toBeInTheDocument();
  });
});
