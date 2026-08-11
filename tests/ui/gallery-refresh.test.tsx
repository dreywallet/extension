import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Gallery } from '../../src/entrypoints/popup/Gallery';
import { installFakeChrome, Providers } from './fake-rpc';

afterEach(cleanup);

const EXPECTATION = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};
const ACCOUNT_ID = `acct_mainnet_${'1'.repeat(64)}`;

const completedScan = {
  kind: 'completed' as const,
  scanId: 'scan-1',
  unitsDone: 4,
  unitsTotal: 4,
  currentUnit: null,
  boundaryUnits: [],
  failureReason: null,
};

const emptyGallery = {
  accountId: ACCOUNT_ID,
  items: [],
  refreshedAt: 1_752_969_600_000,
};

function renderGallery(): void {
  render(
    <Providers>
      <Gallery expectation={EXPECTATION} account={0} accountId={ACCOUNT_ID} onReceive={() => undefined} />
    </Providers>,
  );
}

describe('Ordinals gallery refresh', () => {
  it('recovers a stale ownership cache before presenting the gallery', async () => {
    const galleryList = vi.fn()
      .mockReturnValueOnce({ ok: false, code: 'ERR_DATA_STALE' })
      .mockReturnValue({ ok: true, result: emptyGallery });
    const scanStart = vi.fn(() => ({ ok: true, result: { scanId: 'scan-2' } }));
    installFakeChrome({
      'gallery.list': galleryList,
      'scan.status': () => ({ ok: true, result: completedScan }),
      'scan.start': scanStart,
    });

    renderGallery();

    expect(await screen.findByText('No Ordinals in this wallet.')).toBeInTheDocument();
    expect(galleryList).toHaveBeenCalledTimes(2);
    expect(scanStart).toHaveBeenCalledOnce();
    expect(scanStart).toHaveBeenCalledWith({ mode: 'refresh', ...EXPECTATION });
  });

  it('runs a bounded wallet refresh before an explicit gallery reload', async () => {
    const galleryList = vi.fn(() => ({ ok: true, result: emptyGallery }));
    const scanStart = vi.fn(() => ({ ok: true, result: { scanId: 'scan-2' } }));
    installFakeChrome({
      'gallery.list': galleryList,
      'scan.status': () => ({ ok: true, result: completedScan }),
      'scan.start': scanStart,
    });

    renderGallery();
    const refresh = await screen.findByRole('button', { name: 'Refresh' });
    await waitFor(() => expect(refresh).toBeEnabled());
    await userEvent.click(refresh);

    await waitFor(() => expect(galleryList).toHaveBeenCalledTimes(2));
    expect(scanStart).toHaveBeenCalledOnce();
    expect(scanStart).toHaveBeenCalledWith({ mode: 'refresh', ...EXPECTATION });
    expect(screen.getByText('No Ordinals in this wallet.')).toBeInTheDocument();
  });

  it('does not restart an already running scan', async () => {
    const galleryList = vi.fn(() => ({ ok: true, result: emptyGallery }));
    const scanStart = vi.fn();
    let statusCalls = 0;
    installFakeChrome({
      'gallery.list': galleryList,
      'scan.status': () => {
        statusCalls += 1;
        return {
          ok: true,
          result: statusCalls <= 2
            ? { ...completedScan, kind: 'running' as const, unitsDone: 1 }
            : completedScan,
        };
      },
      'scan.start': scanStart,
    });

    renderGallery();
    const refresh = await screen.findByRole('button', { name: 'Refresh' });
    await waitFor(() => expect(refresh).toBeEnabled());
    await userEvent.click(refresh);

    expect(await screen.findByText('Checking your wallet for Ordinals…')).toBeInTheDocument();
    await waitFor(() => expect(galleryList).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(scanStart).not.toHaveBeenCalled();
  });

  it('still reports a verification failure', async () => {
    installFakeChrome({
      'gallery.cached': () => ({ ok: true, result: { hit: false } }),
      'gallery.list': () => ({ ok: false, code: 'ERR_GATEWAY_UNAVAILABLE' }),
      'scan.status': () => ({ ok: true, result: completedScan }),
      'scan.start': () => ({ ok: true, result: { scanId: 'scan-2' } }),
    });

    renderGallery();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Verified inscription details are unavailable. Your inscriptions remain protected.',
    );
  });
});

describe('Ordinals lane bitcoin presentation', () => {
  function sweepCandidate(overrides: Record<string, unknown> = {}) {
    return {
      accountId: ACCOUNT_ID,
      account: 0,
      outpoint: { txid: 'a'.repeat(64), vout: 0 },
      valueSats: '546',
      status: 'blocked' as const,
      reason: 'no_economic_excess' as const,
      ...overrides,
    };
  }

  function galleryWith(sweepCandidates: unknown[]) {
    return { ...emptyGallery, sweepCandidates, attentionItems: [] };
  }

  async function renderWith(sweepCandidates: unknown[]): Promise<void> {
    installFakeChrome({
      'gallery.list': () => ({ ok: true, result: galleryWith(sweepCandidates) }),
      'scan.status': () => ({ ok: true, result: completedScan }),
      'scan.start': () => ({ ok: true, result: { scanId: 'scan-2' } }),
    });
    renderGallery();
    await screen.findByRole('button', { name: 'Refresh' });
  }

  it('does not call unsweepable postage a thing that needs attention', async () => {
    // A UTXO's value never changes and the worker already tests at the floor
    // fee rate, so no_economic_excess is permanent. Listing it behind a
    // disabled button is a nag that can never clear.
    await renderWith([sweepCandidate()]);

    await waitFor(() =>
      expect(screen.getByText(/546 sats of plain bitcoin/u)).toBeInTheDocument());
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sweep' })).not.toBeInTheDocument();
  });

  it('aggregates several resting outputs into one calm line', async () => {
    await renderWith([
      sweepCandidate({ outpoint: { txid: 'a'.repeat(64), vout: 0 }, valueSats: '546' }),
      sweepCandidate({ outpoint: { txid: 'b'.repeat(64), vout: 1 }, valueSats: '600' }),
      sweepCandidate({ outpoint: { txid: 'c'.repeat(64), vout: 2 }, valueSats: '330' }),
    ]);

    // 546 + 600 + 330, as one sentence rather than three problem rows.
    await waitFor(() =>
      expect(screen.getByText(/1,476 sats of plain bitcoin/u)).toBeInTheDocument());
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
  });

  it('still surfaces a genuinely sweepable output', async () => {
    await renderWith([
      sweepCandidate({ valueSats: '50000', status: 'available', reason: null }),
    ]);

    await waitFor(() => expect(screen.getByText('Needs attention')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Sweep' })).toBeEnabled();
    expect(screen.queryByText(/plain bitcoin sit at your Ordinals address/u))
      .not.toBeInTheDocument();
  });

  it('keeps a transient block actionable while resting postage stays quiet', async () => {
    // Mixed wallet: one sweepable-but-waiting output and one permanently
    // uneconomic one. Only the first belongs under Needs attention.
    await renderWith([
      sweepCandidate({
        outpoint: { txid: 'd'.repeat(64), vout: 0 },
        valueSats: '90000',
        reason: 'unconfirmed',
      }),
      sweepCandidate({ outpoint: { txid: 'e'.repeat(64), vout: 1 }, valueSats: '546' }),
    ]);

    await waitFor(() => expect(screen.getByText('Needs attention')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Sweep' })).toBeDisabled();
    expect(screen.getByText('Wait for one network confirmation before spending.'))
      .toBeInTheDocument();
    // The resting one is reported, but not as a task.
    expect(screen.getByText(/546 sats of plain bitcoin/u)).toBeInTheDocument();
  });

  it('says nothing at all when the Ordinals lane holds no plain bitcoin', async () => {
    await renderWith([]);
    await waitFor(() =>
      expect(screen.getByText('No Ordinals in this wallet.')).toBeInTheDocument());
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
    expect(screen.queryByText(/plain bitcoin sit at your Ordinals address/u))
      .not.toBeInTheDocument();
  });
});
