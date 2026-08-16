import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Transactions } from '../../src/entrypoints/fullpage/Transactions';
import type { WalletHomeResult } from '@drey/core/messaging/ops';
import { emitRuntimeMessage, installFakeChrome, Providers } from './fake-rpc';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

const SESSION_1 = '00000000-0000-4000-8000-000000000001';
const SESSION_2 = '00000000-0000-4000-8000-000000000002';
const ACCOUNT_ID = `acct_mainnet_${'1'.repeat(64)}`;
const CAPABILITIES = {
  canView: true,
  canDeriveAddresses: true,
  canPlanTransactions: true,
  canSignTransactions: true,
  canSignMessages: true,
  canBroadcast: true,
  canExposeToProviders: true,
  canUseMarketplaces: true,
  signMethod: 'software' as const,
  canBuildUnsignedPsbt: true,
  canSignPsbt: true,
  canSignBip322: false,
  canRevealSeed: true,
  canExportPublicAccount: false,
  canVerifyAddress: false,
};
const QUOTE = {
  prioritySatPerKvB: 5000,
  standardSatPerKvB: 3500,
  economySatPerKvB: 2000,
  floorSatPerKvB: 1000,
  sampledAt: '2026-07-21T12:00:00.000Z',
  expiresAt: '2026-07-21T12:02:00.000Z',
};

function homeWithActivity(activity: WalletHomeResult['activity']): WalletHomeResult {
  return {
    accountId: ACCOUNT_ID,
    balances: {
      availableSats: '0',
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
    activity,
    historyComplete: true,
    wrongLane: [],
    lastSyncedAt: 1_752_969_600_000,
    scan: {
      kind: 'completed',
      scanId: 'scan-1',
      unitsDone: 2,
      unitsTotal: 2,
      currentUnit: null,
      boundaryUnits: [],
      failureReason: null,
      historyPartial: false,
    },
  };
}

/**
 * A `utxo.list` row. Defaults to an ineligible protected coin because that is
 * the case the manager has to present carefully; pass `eligible: true` with
 * `reasons: []` for a spendable one.
 */
function utxoRow(overrides: Record<string, unknown> = {}) {
  return {
    txid: 'a'.repeat(64),
    vout: 0,
    valueSats: '546',
    effectiveValueSats: '480',
    account: 0,
    accountId: ACCOUNT_ID,
    lane: 'payment',
    path: "m/86'/0'/0'/0/0",
    classification: 'inscribed',
    eligible: false,
    reasons: ['not_cardinal_clean', 'classification_stale'],
    frozen: false,
    dustQuarantined: false,
    wrongLane: 'normal',
    inscriptions: [],
    label: null,
    ...overrides,
  };
}

function view(initialSection: 'send' | 'utxos' | 'activity', session = SESSION_1) {
  return (
    <Providers>
      <Transactions
        accountId={ACCOUNT_ID}
        expectedVaultId="vault-1"
        expectedSessionId={session}
        capabilities={CAPABILITIES}
        initialSection={initialSection}
        onNavigate={() => undefined}
      />
    </Providers>
  );
}

describe('transaction screen orchestration', () => {
  it('binds the send form to the account selected by the shell', async () => {
    installFakeChrome({});
    render(
      <Providers>
        <Transactions
          accountId={ACCOUNT_ID}
          expectedVaultId="vault-1"
          expectedSessionId={SESSION_1}
          capabilities={CAPABILITIES}
          initialSection="send"
          initialAccount={25}
          selectableAccounts={[0, 25]}
          onNavigate={() => undefined}
        />
      </Providers>,
    );

    expect(screen.queryByLabelText('Account')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Send Bitcoin' })).toBeInTheDocument();
  });

  it('searches saved, recent, and active-wallet accounts without duplicate addresses', async () => {
    const savedAddress = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
    const recentAddress = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
    const ownedAddress = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'addressBook.list': () => ({ ok: true, result: {
        version: 1,
        network: 'mainnet',
        saved: [{
          id: '1'.repeat(32), label: 'Alice', address: savedAddress,
          createdAtMs: 1, updatedAtMs: 1,
        }],
        recent: [
          { address: savedAddress, lastUsedAtMs: 3, useCount: 2, lastKind: 'bitcoin' },
          { address: recentAddress, lastUsedAtMs: 2, useCount: 1, lastKind: 'bitcoin' },
        ],
      } }),
      'address.receive': () => ({ ok: true, result: {
        accountId: ACCOUNT_ID, address: ownedAddress, path: "m/84'/0'/0'/0/0",
        kind: 'payment', network: 'mainnet',
      } }),
    });
    render(
      <Providers>
        <Transactions accountId={ACCOUNT_ID} expectedVaultId="vault-1"
          expectedSessionId={SESSION_1} capabilities={CAPABILITIES} initialSection="send"
          accountSummaries={[{ accountId: ACCOUNT_ID, name: 'Everyday' }]}
          onNavigate={() => undefined} />
      </Providers>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Address book' }));
    const dialog = await screen.findByRole('dialog', { name: 'Choose recipient' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getAllByText(new RegExp(savedAddress, 'u'))).toHaveLength(1);
    expect(screen.getByText(new RegExp(recentAddress, 'u'))).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search recipients'), { target: { value: 'Everyday' } });
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Everyday.*${ownedAddress}`, 'u') }));
    expect(screen.getByLabelText('Recipient address or BIP-321 URI')).toHaveValue(ownedAddress);
    expect(screen.getByRole('note')).toHaveTextContent(/within this wallet/iu);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('explains empty and unmatched recipient searches and links to management', async () => {
    const openAddressBook = vi.fn();
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'addressBook.list': () => ({ ok: true, result: {
        version: 1, network: 'mainnet', saved: [], recent: [],
      } }),
    });
    render(
      <Providers>
        <Transactions accountId={ACCOUNT_ID} expectedVaultId="vault-1"
          expectedSessionId={SESSION_1} capabilities={CAPABILITIES} initialSection="send"
          onNavigate={() => undefined} onOpenAddressBook={openAddressBook} />
      </Providers>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Address book' }));
    expect(await screen.findByText('No recipients are available yet.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search recipients'), { target: { value: 'Alice' } });
    expect(screen.getByText('No recipients match your search.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Manage address book' }));
    expect(openAddressBook).toHaveBeenCalledOnce();
  });

  it('prefills a saved recipient handed off by address-book management once', async () => {
    const consumed = vi.fn();
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'addressBook.list': () => ({ ok: true, result: {
        version: 1, network: 'mainnet', saved: [], recent: [],
      } }),
    });
    render(
      <Providers>
        <Transactions accountId={ACCOUNT_ID} expectedVaultId="vault-1"
          expectedSessionId={SESSION_1} capabilities={CAPABILITIES} initialSection="send"
          initialRecipient="bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"
          onInitialRecipientConsumed={consumed} onNavigate={() => undefined} />
      </Providers>,
    );

    expect(await screen.findByLabelText('Recipient address or BIP-321 URI'))
      .toHaveValue('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh');
    expect(consumed).toHaveBeenCalledOnce();
  });

  it('keeps fee choices compact while preserving exact fractional rates', async () => {
    installFakeChrome({
      'fees.quote': () => ({
        ok: true,
        result: {
          ...QUOTE,
          prioritySatPerKvB: 123_456,
          standardSatPerKvB: 99_995,
          economySatPerKvB: 471,
        },
      }),
    });

    render(view('send'));
    expect(await screen.findByText('123.456 sat/vB')).toBeInTheDocument();
    expect(screen.getByText('99.995 sat/vB')).toBeInTheDocument();
    expect(screen.getByText('0.471 sat/vB')).toBeInTheDocument();
    expect(screen.getByText('~1 block')).toBeInTheDocument();
    expect(screen.getByText('~1–2 blocks')).toBeInTheDocument();
    expect(screen.queryByText(/best effort/iu)).not.toBeInTheDocument();
    expect(screen.queryByText(/about/iu)).not.toBeInTheDocument();
  });

  it('shows fee refresh progress in a reserved legend slot without inserting flow content', async () => {
    let quotes = 0;
    let finishRefresh: (() => void) | undefined;
    installFakeChrome({
      'fees.quote': () => {
        quotes += 1;
        if (quotes === 1) return { ok: true, result: QUOTE };
        return new Promise((resolve) => {
          finishRefresh = () => resolve({ ok: true, result: QUOTE });
        });
      },
    });

    render(view('send'));
    expect(await screen.findByText('3.5 sat/vB')).toBeInTheDocument();
    const refreshStatus = screen.getByRole('status');
    expect(refreshStatus.closest('legend')).not.toBeNull();
    expect(refreshStatus).toHaveAttribute('data-loading', 'false');
    expect(screen.queryByText('Loading current fee rates…')).not.toBeInTheDocument();

    fireEvent.focus(window);
    await waitFor(() => expect(quotes).toBe(2));
    expect(refreshStatus).toHaveAttribute('data-loading', 'true');
    expect(refreshStatus).toHaveAccessibleName('Loading current fee rates…');
    expect(screen.queryByText('Loading current fee rates…')).not.toBeInTheDocument();

    act(() => finishRefresh?.());
    await waitFor(() => expect(refreshStatus).toHaveAttribute('data-loading', 'false'));
    expect(refreshStatus.closest('legend')).not.toBeNull();
  });

  it('defaults send entry to BTC and converts the value to exact integer sats', async () => {
    const plans: unknown[] = [];
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'transaction.plan': (payload) => {
        plans.push(payload);
        return { ok: false, code: 'ERR_INTERNAL' };
      },
    });

    render(view('send'));
    expect(await screen.findByRole('radio', { name: 'BTC' })).toBeChecked();
    fireEvent.change(screen.getByLabelText('Recipient address or BIP-321 URI'), {
      target: { value: 'tb1qrecipient' },
    });
    fireEvent.change(screen.getByLabelText('Amount (BTC)'), {
      target: { value: '0.00001' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review transaction' }));

    await waitFor(() => expect(plans).toHaveLength(1));
    expect(plans[0]).toMatchObject({
      kind: 'native_send',
      amountSats: '1000',
      sendMax: false,
      fee: { type: 'automatic', tier: 'standard' },
    });
  });

  it('resolves BIP-321 metadata as read-only request context', async () => {
    const resolvedInputs: unknown[] = [];
    const open = vi.spyOn(window, 'open');
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'paymentInstruction.resolve': (payload) => {
        resolvedInputs.push(payload);
        const input = (payload as { input: string }).input;
        return { ok: true, result: {
          address: 'bc1qcanonical',
          amountSats: input.startsWith('bitcoin:') ? '1000' : null,
          label: input.startsWith('bitcoin:') ? 'Receiver' : null,
          message: input.startsWith('bitcoin:') ? 'Invoice 7' : null,
        } };
      },
    });

    render(view('send'));
    const recipientInput = await screen.findByLabelText('Recipient address or BIP-321 URI');
    fireEvent.paste(recipientInput, {
      clipboardData: { getData: () => 'bc1qpasted' },
    });
    await waitFor(() => expect(recipientInput).toHaveValue('bc1qcanonical'));
    expect(screen.getByLabelText('Amount (BTC)')).toHaveValue('');

    fireEvent.paste(recipientInput, {
      clipboardData: { getData: () =>
        'bitcoin:bc1qpasted?amount=0.00001&label=Receiver&message=Invoice%207' },
    });
    await waitFor(() => expect(screen.getByLabelText('Amount (BTC)')).toHaveValue('0.00001'));
    expect(screen.queryByRole('textbox', { name: 'Recipient name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Payment purpose' })).not.toBeInTheDocument();
    expect(screen.getByText('Payment request details')).toBeInTheDocument();
    expect(screen.getByText('Receiver')).toBeInTheDocument();
    expect(screen.getByText('Invoice 7')).toBeInTheDocument();
    expect(screen.getByText(/not sent on-chain/iu)).toBeInTheDocument();
    expect(resolvedInputs).toHaveLength(2);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('preserves the entered amount and Send Max until the user accepts a requested amount', async () => {
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'paymentInstruction.resolve': () => ({ ok: true, result: {
        address: 'bc1qcanonical',
        amountSats: '1000',
        label: 'Requested receiver',
        message: 'Requested invoice',
      } }),
    });

    render(view('send'));
    const recipientInput = await screen.findByLabelText('Recipient address or BIP-321 URI');
    fireEvent.change(recipientInput, { target: { value: 'bc1qexisting' } });
    fireEvent.change(screen.getByLabelText('Amount (BTC)'), { target: { value: '0.00002' } });
    fireEvent.click(screen.getByLabelText('Send maximum available'));

    fireEvent.paste(recipientInput, {
      clipboardData: { getData: () => 'bitcoin:bc1qrequested?amount=0.00001' },
    });
    await waitFor(() => expect(recipientInput).toHaveValue('bc1qcanonical'));
    expect(screen.getByLabelText('Send maximum available')).toBeChecked();
    expect(screen.getByLabelText('Amount (BTC)')).toHaveValue('0.00002');
    expect(screen.getByText(/asks for 0.00001 BTC/iu)).toBeInTheDocument();
    expect(screen.getByText('Requested receiver')).toBeInTheDocument();
    expect(screen.getByText('Requested invoice')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Use request value' })[0]!);
    expect(screen.getByLabelText('Send maximum available')).not.toBeChecked();
    expect(screen.getByLabelText('Amount (BTC)')).toHaveValue('0.00001');

    fireEvent.change(recipientInput, { target: { value: 'bc1qmanual' } });
    expect(screen.queryByText('Requested receiver')).not.toBeInTheDocument();
    expect(screen.queryByText('Requested invoice')).not.toBeInTheDocument();
  });

  it('leaves the current composition untouched when a pasted request has no supported method', async () => {
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'paymentInstruction.resolve': (payload) =>
        (payload as { input: string }).input === 'bitcoin:bc1qsupported'
          ? { ok: true, result: {
              address: 'bc1qexisting', amountSats: null,
              label: 'Existing recipient', message: 'Existing purpose',
            } }
          : { ok: false, code: 'ERR_UNSUPPORTED_PAYMENT_METHOD' },
    });
    render(view('send'));
    const recipientInput = await screen.findByLabelText('Recipient address or BIP-321 URI');
    fireEvent.change(screen.getByLabelText('Amount (BTC)'), { target: { value: '0.00002' } });
    fireEvent.paste(recipientInput, {
      clipboardData: { getData: () => 'bitcoin:bc1qsupported' },
    });
    await waitFor(() => expect(screen.getByText('Existing recipient')).toBeInTheDocument());
    fireEvent.paste(recipientInput, {
      clipboardData: { getData: () => 'bitcoin:?lightning=ln-unsupported' },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'no ordinary on-chain address that Drey supports',
    );
    expect(recipientInput).toHaveValue('bc1qexisting');
    expect(screen.getByLabelText('Amount (BTC)')).toHaveValue('0.00002');
    expect(screen.getByText('Existing recipient')).toBeInTheDocument();
    expect(screen.getByText('Existing purpose')).toBeInTheDocument();
  });

  it('creates an immutable gallery transfer plan only after the explicit Review action', async () => {
    const plans: unknown[] = [];
    const inscriptionId = `${'a'.repeat(64)}i0`;
    const outpoint = { txid: 'b'.repeat(64), vout: 2 };
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'transaction.plan': (payload) => {
        plans.push(payload);
        return { ok: false, code: 'ERR_INTERNAL' };
      },
    });
    render(
      <Providers>
        <Transactions
          accountId={ACCOUNT_ID}
          expectedVaultId="vault-1"
          expectedSessionId={SESSION_1}
          capabilities={CAPABILITIES}
          initialSection="send"
          initialAccount={0}
          initialOrdinalAction={{
            kind: 'ordinal_transfer',
            account: 0,
            inscriptionId,
            outpoint,
            presentation: {
              number: 67_368_437,
              preview: {
                kind: 'raster',
                rasterBase64: 'AA==',
                pngSha256: 'c'.repeat(64),
                pngWidth: 1,
                pngHeight: 1,
              },
            },
          }}
          onNavigate={() => undefined}
        />
      </Providers>,
    );
    expect(await screen.findByRole('heading', { name: 'Send inscription' })).toBeInTheDocument();
    expect(screen.getByText("You're sending")).toBeInTheDocument();
    expect(screen.getByText('#67368437')).toBeInTheDocument();
    expect(screen.getByTitle(`Inert preview for inscription ${inscriptionId}`))
      .toBeInTheDocument();
    expect(screen.getByText('Technical details').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText(inscriptionId)).toBeInTheDocument();
    expect(plans).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Recipient address'), {
      target: { value: 'tb1pdestination' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review transaction' }));
    await waitFor(() => expect(plans).toHaveLength(1));
    expect(plans[0]).toMatchObject({
      kind: 'ordinal_transfer',
      account: 0,
      inscriptionId,
      outpoint,
      recipient: 'tb1pdestination',
      fee: { type: 'automatic', tier: 'standard' },
    });
    expect(plans[0]).not.toHaveProperty('presentation');
  });

  it('composes one bound batch request without sending preview bytes to the worker', async () => {
    const plans: unknown[] = [];
    const firstTxid = 'c'.repeat(64);
    const secondTxid = 'd'.repeat(64);
    const selections = [
      { inscriptionId: `${firstTxid}i0`, outpoint: { txid: firstTxid, vout: 0 },
        satpoint: `${firstTxid}:0:3`, classificationRevision: 'rev-batch' },
      { inscriptionId: `${secondTxid}i0`, outpoint: { txid: secondTxid, vout: 1 },
        satpoint: `${secondTxid}:1:9`, classificationRevision: 'rev-batch' },
    ];
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'transaction.plan': (payload) => {
        plans.push(payload);
        return { ok: false, code: 'ERR_INTERNAL' };
      },
    });
    render(
      <Providers>
        <Transactions
          accountId={ACCOUNT_ID}
          expectedVaultId="vault-1"
          expectedSessionId={SESSION_1}
          capabilities={CAPABILITIES}
          initialSection="send"
          initialAccount={0}
          initialOrdinalAction={{
            kind: 'ordinal_batch_transfer',
            account: 0,
            selections: selections.map((selection, index) => ({
              ...selection,
              presentation: { number: index + 1, preview: { kind: 'placeholder' } },
            })),
          }}
          onNavigate={() => undefined}
        />
      </Providers>,
    );
    expect(await screen.findByRole('heading', { name: 'Send 2 inscriptions' }))
      .toBeInTheDocument();
    expect(screen.getByText('2 inscriptions to one address')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Recipient address'), {
      target: { value: 'tb1pbatchdestination' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review transaction' }));
    await waitFor(() => expect(plans).toHaveLength(1));
    expect(plans[0]).toMatchObject({
      kind: 'ordinal_batch_transfer',
      account: 0,
      recipient: 'tb1pbatchdestination',
      selections,
    });
    expect(JSON.stringify(plans[0])).not.toContain('presentation');
    expect(JSON.stringify(plans[0])).not.toContain('rasterBase64');
  });

  it('binds rescue and sweep plans to both stable and derivation account identity', async () => {
    const plans: unknown[] = [];
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'transaction.plan': (payload) => {
        plans.push(payload);
        return { ok: false, code: 'ERR_INTERNAL' };
      },
    });
    render(
      <Providers>
        <Transactions
          accountId={ACCOUNT_ID}
          expectedVaultId="vault-1"
          expectedSessionId={SESSION_1}
          capabilities={CAPABILITIES}
          initialSection="send"
          initialAccount={25}
          initialOrdinalAction={{
            kind: 'ordinal_sweep',
            outpoint: { txid: 'd'.repeat(64), vout: 3 },
          }}
          onNavigate={() => undefined}
        />
      </Providers>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Review transaction' }));
    await waitFor(() => expect(plans).toHaveLength(1));
    expect(plans[0]).toMatchObject({
      kind: 'ordinal_sweep',
      accountId: ACCOUNT_ID,
      account: 25,
      outpoint: { txid: 'd'.repeat(64), vout: 3 },
    });
  });

  it('loads each visible data section once and does not refetch from fee-form renders', async () => {
    let quotes = 0;
    const utxoRates: number[] = [];
    let plans = 0;
    let approvals = 0;
    installFakeChrome({
      'fees.quote': () => {
        quotes += 1;
        return { ok: true, result: QUOTE };
      },
      'utxo.list': (payload) => {
        utxoRates.push((payload as { feeRateSatPerKvB: number }).feeRateSatPerKvB);
        return { ok: true, result: { utxos: [], privacyNotes: [] } };
      },
      'transaction.plan': () => {
        plans += 1;
        return { ok: false, code: 'ERR_INTERNAL' };
      },
      'transaction.approve': () => {
        approvals += 1;
        return { ok: false, code: 'ERR_INTERNAL' };
      },
    });

    render(view('utxos'));
    await waitFor(() => expect(utxoRates).toEqual([3500]));
    await waitFor(() => expect(quotes).toBe(1));
    expect(plans).toBe(0);
    expect(approvals).toBe(0);

    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('Fee rate (sat/vB)'), { target: { value: '17' } });
    await Promise.resolve();
    expect(utxoRates).toEqual([3500]);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(utxoRates).toEqual([3500, 17_000]));
    expect(quotes).toBe(1);
    expect(plans).toBe(0);
    expect(approvals).toBe(0);
  });

  it('passes the selected automatic quote to UTXO economics without rounding sub-sat rates', async () => {
    const utxoRates: number[] = [];
    installFakeChrome({
      'fees.quote': () => ({
        ok: true,
        result: { ...QUOTE, standardSatPerKvB: 471 },
      }),
      'utxo.list': (payload) => {
        utxoRates.push((payload as { feeRateSatPerKvB: number }).feeRateSatPerKvB);
        return { ok: true, result: { utxos: [], privacyNotes: [] } };
      },
    });

    render(view('utxos'));
    await waitFor(() => expect(screen.getByText('0.471 sat/vB')).toBeInTheDocument());
    await waitFor(() => expect(utxoRates).toEqual([471]));
  });

  it('explains dust quarantine in plain language without offering a misleading freeze action', async () => {
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'utxo.list': () => ({
        ok: true,
        result: {
          utxos: [{
            txid: 'a'.repeat(64),
            vout: 0,
            valueSats: '293',
            effectiveValueSats: '225',
            accountId: ACCOUNT_ID,
            account: 0,
            lane: 'payment',
            path: "m/84'/0'/0'/0/0",
            classification: 'cardinal_clean',
            eligible: false,
            reasons: ['dust_quarantined'],
            frozen: false,
            dustQuarantined: true,
            wrongLane: 'normal',
            inscriptions: [],
            label: null,
          }],
          privacyNotes: [],
        },
      }),
    });

    render(view('utxos'));
    expect(await screen.findByText(/below Bitcoin's script dust limit/iu))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Freeze' })).not.toBeInTheDocument();
    expect(screen.queryByText('dust_quarantined')).not.toBeInTheDocument();
  });

  it('states the verification refresh once for the wallet, not once per coin', async () => {
    // The live screen repeated this on every protected row, which read as a
    // wallet stuck loading. It is a wallet-wide condition, so it is said once.
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'utxo.list': () => ({
        ok: true,
        result: {
          utxos: [
            utxoRow({ txid: 'a'.repeat(64), classification: 'inscribed' }),
            utxoRow({ txid: 'b'.repeat(64), classification: 'inscribed' }),
            utxoRow({ txid: 'c'.repeat(64), classification: 'runic_or_unsupported' }),
          ],
          privacyNotes: [],
        },
      }),
    });

    render(view('utxos'));
    await screen.findByText('Protected');
    expect(screen.getAllByText(/Checking some coins against the asset index/iu))
      .toHaveLength(1);
    // The per-row wording is gone: three protected coins used to print it three
    // times, on top of a reason that already implied the same thing.
    expect(screen.queryByText(/Asset verification is refreshing automatically/iu))
      .not.toBeInTheDocument();
  });

  it('never tells the holder that a permanently protected coin is still pending', async () => {
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'utxo.list': () => ({
        ok: true,
        result: {
          utxos: [utxoRow({ classification: 'inscribed', reasons: ['not_cardinal_clean'] })],
          privacyNotes: [],
        },
      }),
    });

    render(view('utxos'));
    await screen.findByText('Protected');
    expect(screen.queryByText(/not yet verified/iu)).not.toBeInTheDocument();
    // The per-class explanation carries the meaning, in more useful words than
    // the generic protected-asset line — which is therefore suppressed rather
    // than printed alongside it.
    expect(screen.getByText(/carries an inscription/iu)).toBeInTheDocument();
    expect(screen.queryByText('Holds a collectible, so it is never spent'))
      .not.toBeInTheDocument();
  });

  it('still reports a second reason alongside the class explanation', async () => {
    // A protected coin that is also frozen has something to say that the class
    // help does not cover, so suppression must not swallow it.
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'utxo.list': () => ({
        ok: true,
        result: {
          utxos: [utxoRow({
            classification: 'rare_sat',
            reasons: ['not_cardinal_clean', 'user_frozen'],
            frozen: true,
          })],
          privacyNotes: [],
        },
      }),
    });

    render(view('utxos'));
    await screen.findByText('Protected');
    expect(screen.getByText(/place in Bitcoin history/iu)).toBeInTheDocument();
    expect(screen.getByText(/Frozen by you/iu)).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /Inscription preview/iu })).not.toBeInTheDocument();
  });

  it('keeps protected coins collapsed and never prints a raw classification token', async () => {
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'utxo.list': () => ({
        ok: true,
        result: {
          utxos: [
            utxoRow({ txid: 'a'.repeat(64), eligible: true, reasons: [] }),
            utxoRow({ txid: 'b'.repeat(64), classification: 'runic_or_unsupported' }),
          ],
          privacyNotes: [],
        },
      }),
    });

    render(view('utxos'));
    const protectedGroup = (await screen.findByText('Protected')).closest('details');
    expect(protectedGroup).not.toBeNull();
    expect(protectedGroup?.open).toBe(false);
    expect((await screen.findByText('Available')).closest('details')?.open).toBe(true);

    // §10.3 keeps enum tokens out of the UI; §12.4 forbids naming the protocol.
    expect(screen.queryByText(/runic_or_unsupported/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/cardinal_clean/u)).not.toBeInTheDocument();
    expect(screen.getByText('Protected asset')).toBeInTheDocument();
  });

  it('loads a wrong-lane inscription thumbnail only after Protected opens', async () => {
    const highId = `${'f'.repeat(64)}i0`;
    const lowId = `${'b'.repeat(64)}i0`;
    const previews = vi.fn((payload: unknown) => {
      const request = payload as { items: Array<{ inscriptionId: string }> };
      return { ok: true as const, result: { items: request.items.map(({ inscriptionId }) => ({
        inscriptionId,
        preview: {
          kind: 'raster' as const,
          rasterBase64: 'AA==',
          pngSha256: 'e'.repeat(64),
          pngWidth: 1,
          pngHeight: 1,
        },
      })) } };
    });
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'utxo.list': () => ({
        ok: true,
        result: {
          utxos: [utxoRow({
            classification: 'mixed',
            wrongLane: 'protected_wrong_address',
            inscriptions: [
              { inscriptionId: highId, satpoint: `${'a'.repeat(64)}:0:9` },
              { inscriptionId: lowId, satpoint: `${'a'.repeat(64)}:0:2` },
            ],
          })],
          privacyNotes: [],
        },
      }),
      'activity.inscriptionPreviewBatch': previews,
    });

    render(view('utxos'));
    const protectedSummary = await screen.findByText('Protected');
    expect(previews).not.toHaveBeenCalled();
    fireEvent.click(protectedSummary);

    await waitFor(() => expect(previews).toHaveBeenCalledOnce());
    expect(previews.mock.calls[0]?.[0]).toMatchObject({
      items: [{ txid: 'a'.repeat(64), inscriptionId: lowId }],
    });
    const tileFrame = await screen.findByTitle('2 inscriptions on this coin') as HTMLIFrameElement;
    fireEvent(window, new MessageEvent('message', { source: tileFrame.contentWindow, data: {
      type: 'drey:inert-inscription-preview-ready', protocolVersion: 1, inscriptionId: lowId,
    } }));
    const preview = await screen.findByRole('button', {
      name: 'Enlarge 2 inscriptions on this coin',
    });
    expect(preview)
      .toHaveTextContent('+1');
    fireEvent.click(preview);
    const dialog = screen.getByRole('dialog', { name: '2 inscriptions on this coin' });
    expect(dialog).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '2 inscriptions on this coin' }))
      .not.toBeInTheDocument();
    expect(screen.getByText('Mixed contents')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rescue inscription' })).toBeInTheDocument();
    fireEvent.click(protectedSummary);
    fireEvent.click(protectedSummary);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(previews).toHaveBeenCalledOnce();
  });

  it('keeps a 31-coin Protected section idle and batches only its visible window', async () => {
    const callbacks: IntersectionObserverCallback[] = [];
    const observed: Element[] = [];
    class FakeIntersectionObserver {
      readonly root = null;
      readonly rootMargin = '160px 0px';
      readonly thresholds = [0];
      constructor(callback: IntersectionObserverCallback) { callbacks.push(callback); }
      observe(element: Element): void { observed.push(element); }
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): IntersectionObserverEntry[] { return []; }
    }
    const original = globalThis.IntersectionObserver;
    globalThis.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;
    const batches: Array<Array<{ txid: string; inscriptionId: string }>> = [];
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'utxo.list': () => ({
        ok: true,
        result: {
          utxos: Array.from({ length: 31 }, (_, index) => {
            const hex = index.toString(16).padStart(64, '0');
            return utxoRow({
              txid: hex,
              vout: index,
              reasons: ['not_cardinal_clean'],
              inscriptions: [{ inscriptionId: `${hex}i0`, satpoint: `${hex}:${index}:0` }],
            });
          }),
          privacyNotes: [],
        },
      }),
      'activity.inscriptionPreviewBatch': (payload) => {
        const items = (payload as { items: Array<{ txid: string; inscriptionId: string }> }).items;
        batches.push(items);
        return {
          ok: true as const,
          result: { items: items.map(({ inscriptionId }) => ({
            inscriptionId,
            preview: {
              kind: 'text' as const,
              textMime: 'text/plain' as const,
              excerpt: 'signed text',
              truncated: false,
            },
          })) },
        };
      },
    });

    try {
      render(view('utxos'));
      fireEvent.click(await screen.findByText('Protected'));
      await waitFor(() => expect(observed).toHaveLength(31));
      expect(batches).toHaveLength(0);

      for (let index = 0; index < 10; index += 1) {
        callbacks[index]?.([{
          isIntersecting: true,
          target: observed[index]!,
        } as IntersectionObserverEntry], {} as IntersectionObserver);
      }
      await waitFor(() => expect(batches.flat()).toHaveLength(10));
      expect(batches.map((batch) => batch.length)).toEqual([8, 2]);
      expect(batches.flat().map(({ inscriptionId }) => inscriptionId))
        .toEqual(Array.from({ length: 10 }, (_, index) =>
          `${index.toString(16).padStart(64, '0')}i0`));
      expect(await screen.findAllByText('Aa')).toHaveLength(10);
      expect(screen.queryByText('signed text')).not.toBeInTheDocument();
    } finally {
      globalThis.IntersectionObserver = original;
    }
  });

  it('keeps an unavailable inscription as a stable accessible fallback', async () => {
    const inscriptionId = `${'d'.repeat(64)}i0`;
    let attempts = 0;
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'utxo.list': () => ({
        ok: true,
        result: {
          utxos: [utxoRow({
            wrongLane: 'protected_wrong_address',
            inscriptions: [{
              inscriptionId,
              satpoint: `${'a'.repeat(64)}:0:0`,
            }],
          })],
          privacyNotes: [],
        },
      }),
      'activity.inscriptionPreviewBatch': () => {
        attempts += 1;
        return {
          ok: true as const,
          result: { items: [{
            inscriptionId,
            preview: attempts === 1
              ? { kind: 'placeholder' as const, reason: 'decode_failed' as const }
              : {
                  kind: 'raster' as const,
                  rasterBase64: 'AA==',
                  pngSha256: 'e'.repeat(64),
                  pngWidth: 1,
                  pngHeight: 1,
                },
          }] },
        };
      },
    });

    render(view('utxos'));
    fireEvent.click(await screen.findByText('Protected'));
    expect(await screen.findByRole('button', { name: 'Inscription preview unavailable' }))
      .toBeDisabled();
    expect(screen.queryByText(/^Inscription$/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    const frame = await screen.findByTitle('Inscription preview') as HTMLIFrameElement;
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, data: {
      type: 'drey:inert-inscription-preview-ready', protocolVersion: 1, inscriptionId,
    } }));
    expect(await screen.findByRole('button', { name: 'Enlarge Inscription preview' })).toBeEnabled();
    expect(attempts).toBe(2);
  });

  it('reserves a calm loading tile until the signed preview settles', async () => {
    const inscriptionId = `${'c'.repeat(64)}i0`;
    let settle: ((value: unknown) => void) | undefined;
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'utxo.list': () => ({
        ok: true,
        result: {
          utxos: [utxoRow({
            inscriptions: [{ inscriptionId, satpoint: `${'a'.repeat(64)}:0:0` }],
          })],
          privacyNotes: [],
        },
      }),
      'activity.inscriptionPreviewBatch': () => new Promise((resolve) => { settle = resolve; }),
    });

    render(view('utxos'));
    fireEvent.click(await screen.findByText('Protected'));
    const loading = await screen.findByRole('button', { name: 'Loading inscription preview' });
    expect(loading).toBeDisabled();
    expect(loading).not.toHaveTextContent('INS');

    settle?.({
      ok: true,
      result: { items: [{
        inscriptionId,
        preview: {
          kind: 'text', textMime: 'text/plain', excerpt: 'signed text', truncated: false,
        },
      }] },
    });
    expect(await screen.findByRole('button', { name: 'Enlarge Inscription preview' }))
      .toHaveTextContent('Aa');
  });

  it('distinguishes coins that share an amount and a derivation path', async () => {
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'utxo.list': () => ({
        ok: true,
        result: {
          utxos: [
            utxoRow({ txid: `1111${'0'.repeat(56)}aaaa`, eligible: true, reasons: [] }),
            utxoRow({ txid: `2222${'0'.repeat(56)}bbbb`, eligible: true, reasons: [] }),
          ],
          privacyNotes: [],
        },
      }),
    });

    render(view('utxos'));
    expect(await screen.findByText('1111…aaaa:0')).toBeInTheDocument();
    expect(screen.getByText('2222…bbbb:0')).toBeInTheDocument();
  });

  it('reports the selected total and only allows consolidation from two inputs', async () => {
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'utxo.list': () => ({
        ok: true,
        result: {
          utxos: [
            utxoRow({ txid: 'a'.repeat(64), valueSats: '609646', eligible: true, reasons: [] }),
            utxoRow({ txid: 'b'.repeat(64), valueSats: '86257', eligible: true, reasons: [] }),
          ],
          privacyNotes: [],
        },
      }),
    });

    render(view('utxos'));
    // A bare disabled button explains nothing, so the requirement is stated.
    expect(await screen.findByText('Select two or more coins to combine them.'))
      .toBeInTheDocument();
    const consolidate = screen.getByRole('button', { name: 'Consolidate selected' });
    expect(consolidate).toBeDisabled();

    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0]!);
    expect(screen.getByText('1 selected · 609,646 sats')).toBeInTheDocument();
    expect(consolidate).toBeDisabled();

    fireEvent.click(boxes[1]!);
    expect(screen.getByText('2 selected · 695,903 sats')).toBeInTheDocument();
    expect(consolidate).toBeEnabled();
  });

  it('selects only spendable coins from the Available header and clears them again', async () => {
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'utxo.list': () => ({
        ok: true,
        result: {
          utxos: [
            utxoRow({ txid: 'a'.repeat(64), valueSats: '500', eligible: true, reasons: [] }),
            utxoRow({ txid: 'b'.repeat(64), valueSats: '250', eligible: true, reasons: [] }),
            utxoRow({ txid: 'c'.repeat(64), valueSats: '546', classification: 'inscribed' }),
          ],
          privacyNotes: [],
        },
      }),
    });

    render(view('utxos'));
    fireEvent.click(await screen.findByRole('button', { name: 'Select all' }));
    // The inscription is excluded: 500 + 250, not 1,296.
    expect(screen.getByText('2 selected · 750 sats')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText('Select two or more coins to combine them.')).toBeInTheDocument();
  });

  // utxo.list is wallet-wide, but selectCoins builds one plan under one
  // account and rejects the whole thing when the selection reaches past it.
  // Select All used to take every eligible coin in the wallet, which made an
  // unsatisfiable plan the default first click for a multi-account holder.
  it('keeps Select All inside the account the plan is built under', async () => {
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'utxo.list': () => ({
        ok: true,
        result: {
          utxos: [
            utxoRow({ txid: 'a'.repeat(64), valueSats: '500', eligible: true, reasons: [] }),
            utxoRow({ txid: 'b'.repeat(64), valueSats: '250', eligible: true, reasons: [] }),
            utxoRow({
              txid: 'c'.repeat(64), valueSats: '9000', account: 1, eligible: true, reasons: [],
            }),
          ],
          privacyNotes: [],
        },
      }),
    });

    render(view('utxos'));
    fireEvent.click(await screen.findByRole('button', { name: 'Select all' }));
    // 500 + 250. The 9,000 in account 1 is spendable, just not from here.
    expect(screen.getByText('2 selected · 750 sats')).toBeInTheDocument();

    // It is still listed — freeze, label, rescue, and sweep all address a
    // single outpoint and work across accounts — but it cannot be ticked, and
    // the row says why rather than leaving a dead checkbox.
    const foreign = screen.getByLabelText(/9,000 sats/u);
    expect(foreign).toBeDisabled();
    expect(screen.getByText('In another account, so it cannot join this selection.'))
      .toBeInTheDocument();
  });

  it('drops a selection when the send form switches account', async () => {
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'utxo.list': () => ({
        ok: true,
        result: {
          utxos: [
            utxoRow({ txid: 'a'.repeat(64), valueSats: '500', eligible: true, reasons: [] }),
            utxoRow({ txid: 'b'.repeat(64), valueSats: '250', eligible: true, reasons: [] }),
          ],
          privacyNotes: [],
        },
      }),
    });

    const ui = (
      section: 'send' | 'utxos',
      accountId = ACCOUNT_ID,
      initialAccount = 0,
    ): React.ReactElement => (
      <Providers>
        <Transactions
          accountId={accountId}
          expectedVaultId="vault-1"
          expectedSessionId={SESSION_1}
          capabilities={CAPABILITIES}
          initialSection={section}
          initialAccount={initialAccount}
          selectableAccounts={[0, 1]}
          onNavigate={() => undefined}
        />
      </Providers>
    );

    // Navigation is a hash change, not a remount, so the selection carries into
    // Send on purpose. Switching account there has to invalidate it: every one
    // of those coins now belongs to a different account than the plan.
    const { rerender } = render(ui('utxos'));
    fireEvent.click(await screen.findByRole('button', { name: 'Select all' }));
    expect(screen.getByText('2 selected · 750 sats')).toBeInTheDocument();

    rerender(ui('send'));
    expect(await screen.findByText('2 manually selected inputs')).toBeInTheDocument();
    rerender(ui('send', `acct_mainnet_${'2'.repeat(64)}`, 1));
    await waitFor(() =>
      expect(screen.queryByText(/manually selected inputs/u)).not.toBeInTheDocument());
  });

  it('drops a selection that stops being eligible when the list reloads', async () => {
    // A higher fee tier can turn a selected input uneconomic. selectCoins
    // rejects the entire plan on a stale selection rather than skipping it.
    let loads = 0;
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'utxo.list': () => {
        loads += 1;
        return {
          ok: true,
          result: {
            utxos: [
              utxoRow({ txid: 'a'.repeat(64), valueSats: '900', eligible: true, reasons: [] }),
              utxoRow({
                txid: 'b'.repeat(64),
                valueSats: '600',
                eligible: loads === 1,
                reasons: loads === 1 ? [] : ['uneconomic'],
              }),
            ],
            privacyNotes: [],
          },
        };
      },
    });

    render(view('utxos'));
    fireEvent.click(await screen.findByRole('button', { name: 'Select all' }));
    expect(screen.getByText('2 selected · 1,500 sats')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() =>
      expect(screen.getByText('1 selected · 900 sats')).toBeInTheDocument());
  });

  it('separates the empty wallet from a load still in flight', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'utxo.list': async () => {
        await gate;
        return { ok: true, result: { utxos: [], privacyNotes: [] } };
      },
    });

    render(view('utxos'));
    expect(await screen.findByText('Loading your coins…')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Network fee' })).not.toBeInTheDocument();
    expect(screen.queryByText(/No coins yet/iu)).not.toBeInTheDocument();

    await act(async () => { release?.(); await Promise.resolve(); });
    await waitFor(() => expect(screen.getByText(/No coins yet/iu)).toBeInTheDocument());
    expect(screen.queryByText('Loading your coins…')).not.toBeInTheDocument();
  });

  it('explains an ordinals-lane coin instead of disabling it with a blank line', async () => {
    // listUtxos suppresses the ordinals lane after §11.2 already passed, which
    // used to leave the row ineligible with an empty reasons array.
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'utxo.list': () => ({
        ok: true,
        result: {
          utxos: [utxoRow({
            lane: 'ordinals',
            classification: 'cardinal_clean',
            reasons: ['reserved_ordinals_lane'],
            wrongLane: 'reserved_ordinal_lane_btc',
          })],
          privacyNotes: [],
        },
      }),
    });

    render(view('utxos'));
    expect(await screen.findByText('Reserved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sweep excess bitcoin' })).toBeInTheDocument();
  });

  it('coalesces focus and visibility resume into one visible-section refresh', async () => {
    let quotes = 0;
    let utxoLoads = 0;
    installFakeChrome({
      'fees.quote': () => {
        quotes += 1;
        return { ok: true, result: QUOTE };
      },
      'utxo.list': () => {
        utxoLoads += 1;
        return { ok: true, result: { utxos: [], privacyNotes: [] } };
      },
      'scan.status': () => ({
        ok: true,
        result: {
          kind: 'running', scanId: 'scan-1', unitsDone: 1, unitsTotal: 2,
          currentUnit: null, boundaryUnits: [], failureReason: null,
          historyPartial: false,
        },
      }),
    });

    render(view('utxos'));
    await waitFor(() => {
      expect(quotes).toBe(1);
      expect(utxoLoads).toBe(1);
    });
    act(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => {
      expect(quotes).toBe(2);
      expect(utxoLoads).toBe(2);
    });
  });

  it('refreshes a fee quote before expiry without continuous polling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'));
    let quotes = 0;
    const expiringQuote = { ...QUOTE, expiresAt: '2026-07-22T12:00:10.000Z' };
    installFakeChrome({
      'fees.quote': () => {
        quotes += 1;
        return { ok: true, result: expiringQuote };
      },
    });

    render(view('send'));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(quotes).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(4_999));
    expect(quotes).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(quotes).toBe(2);
  });

  it('uses one visible-only chain refresh per minute as the external-payment fallback', async () => {
    vi.useFakeTimers();
    let scanChecks = 0;
    let scanStarts = 0;
    installFakeChrome({
      'transaction.status': () => ({
        ok: true,
        result: { network: 'mainnet', accountId: ACCOUNT_ID, transactions: [] },
      }),
      'scan.status': () => {
        scanChecks += 1;
        return {
          ok: true,
          result: {
            kind: 'completed', scanId: 'scan-1', unitsDone: 2, unitsTotal: 2,
            currentUnit: null, boundaryUnits: [], failureReason: null,
            historyPartial: false,
          },
        };
      },
      'scan.start': () => {
        scanStarts += 1;
        return { ok: true, result: { scanId: `scan-${scanStarts + 1}` } };
      },
    });

    render(view('activity'));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(scanChecks).toBe(1);
    expect(scanStarts).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(59_999));
    expect(scanChecks).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(scanChecks).toBe(2);
    expect(scanStarts).toBe(2);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(scanChecks).toBe(2);
    expect(scanStarts).toBe(2);
  });

  it('shows scanned wallet history while retaining controls for tracked outgoing transactions', async () => {
    const incomingTxid = '8'.repeat(64);
    const outgoingTxid = '9'.repeat(64);
    installFakeChrome({
      'wallet.home': () => ({
        ok: true,
        result: homeWithActivity([
          {
            txid: outgoingTxid,
            deltaSats: '-2734',
            feeSats: '234',
            confirmationState: 'mempool',
            timestamp: null,
            height: null,
          },
          {
            txid: incomingTxid,
            deltaSats: '123456',
            feeSats: null,
            confirmationState: 'confirmed',
            addressContext: 'ordinals_received',
            timestamp: '2026-07-23T12:00:00.000Z',
            height: 250000,
          },
        ]),
      }),
      'transaction.status': () => ({
        ok: true,
        result: {
          network: 'mainnet',
          accountId: ACCOUNT_ID,
          transactions: [{
            planId: 'tracked-send',
            kind: 'native_send',
            txid: outgoingTxid,
            createdAt: 1,
            amountSats: '2500',
            feeSats: '234',
            status: 'accepted',
            detail: null,
            parentTxid: null,
            replacesTxid: null,
            recovering: false,
            recommendedAcceleration: 'rbf',
            accelerationUnavailableReason: null,
          }],
        },
      }),
      'scan.status': () => ({
        ok: true,
        result: {
          kind: 'running',
          scanId: 'scan-2',
          unitsDone: 1,
          unitsTotal: 2,
          currentUnit: null,
          boundaryUnits: [],
          failureReason: null,
          historyPartial: false,
        },
      }),
    });

    render(view('activity'));

    const received = await screen.findByText('Received at Ordinals address');
    const receivedSummary = received.closest('summary');
    const receivedDisclosure = received.closest('details');
    expect(receivedSummary).toHaveTextContent('+123,456 sats');
    expect(receivedDisclosure).not.toHaveAttribute('open');
    fireEvent.click(receivedSummary!);
    expect(receivedDisclosure).toHaveAttribute('open');
    expect(receivedDisclosure?.querySelector('code')).toHaveTextContent(incomingTxid);
    expect(receivedSummary).not.toHaveTextContent(/No verified inscription or Rune/u);
    expect(screen.getByText(
      'No verified inscription or Rune was linked to this transaction.',
    )).toBeInTheDocument();
    const sentSummary = screen.getByText('Sent').closest('summary');
    expect(sentSummary).toHaveTextContent('−2,500 sats');
    expect(sentSummary).toHaveTextContent('234 sats network fee');
    fireEvent.click(sentSummary!);
    expect(screen.getByRole('button', { name: 'Speed up with RBF' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Speed up with CPFP' })).not.toBeInTheDocument();
    expect(screen.queryByText('Your transaction history will appear here.'))
      .not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'View transaction on mempool.space' }))
      .toHaveLength(2);
  });

  it('keeps an unmatched indeterminate broadcast visible for manual reconciliation', async () => {
    const txid = '7'.repeat(64);
    installFakeChrome({
      'wallet.home': () => ({ ok: true, result: homeWithActivity([]) }),
      'transaction.status': () => ({
        ok: true,
        result: {
          network: 'signet',
          accountId: ACCOUNT_ID,
          transactions: [{
            planId: 'recovery-plan',
            kind: 'native_send',
            txid,
            createdAt: 1,
            amountSats: '2500',
            feeSats: '234',
            status: 'pending',
            detail: 'broadcast outcome indeterminate',
            parentTxid: null,
            replacesTxid: null,
            recovering: true,
          }],
        },
      }),
      'scan.status': () => ({
        ok: true,
        result: {
          kind: 'running',
          scanId: 'scan-2',
          unitsDone: 1,
          unitsTotal: 2,
          currentUnit: null,
          boundaryUnits: [],
          failureReason: null,
          historyPartial: false,
        },
      }),
    });

    render(view('activity'));

    expect(await screen.findByText(/manual reconciliation/iu)).toBeInTheDocument();
    expect(screen.getByText('2,500 sats')).toBeInTheDocument();
    expect(screen.getByText('234 sats network fee')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View transaction on mempool.space' }))
      .toHaveAttribute('href', `https://mempool.space/signet/tx/${txid}`);
  });

  it('keeps chain refresh single-flight during a burst of transaction events', async () => {
    let releaseScan: ((value: unknown) => void) | undefined;
    const pendingScan = new Promise((resolve) => { releaseScan = resolve; });
    let scanChecks = 0;
    installFakeChrome({
      'transaction.status': () => ({
        ok: true,
        result: { network: 'mainnet', accountId: ACCOUNT_ID, transactions: [] },
      }),
      'scan.status': () => {
        scanChecks += 1;
        return pendingScan;
      },
    });

    render(view('activity'));
    await waitFor(() => expect(scanChecks).toBe(1));
    act(() => {
      emitRuntimeMessage({ type: 'squirrel:wallet-data-changed', reason: 'transaction' });
      emitRuntimeMessage({ type: 'squirrel:wallet-data-changed', reason: 'transaction' });
    });
    await Promise.resolve();
    expect(scanChecks).toBe(1);

    releaseScan?.({
      ok: true,
      result: {
        kind: 'running', scanId: 'scan-1', unitsDone: 1, unitsTotal: 2,
        currentUnit: null, boundaryUnits: [], failureReason: null,
        historyPartial: false,
      },
    });
    await act(async () => Promise.resolve());
  });

  it('ignores a stale activity response after the session identity changes', async () => {
    let releaseOld: ((value: unknown) => void) | undefined;
    const oldResponse = new Promise((resolve) => { releaseOld = resolve; });
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'transaction.status': (payload) => {
        const session = (payload as { expectedSessionId: string }).expectedSessionId;
        if (session === SESSION_1) return oldResponse;
        return { ok: true, result: { network: 'signet', accountId: ACCOUNT_ID, transactions: [] } };
      },
    });
    const rendered = render(view('activity', SESSION_1));
    rendered.rerender(view('activity', SESSION_2));
    expect(await screen.findByText('Your transaction history will appear here.')).toBeInTheDocument();

    releaseOld?.({
      ok: true,
      result: {
        network: 'signet',
        accountId: ACCOUNT_ID,
        transactions: [{
          planId: 'old', kind: 'native_send', txid: 'a'.repeat(64), createdAt: 1,
          amountSats: '1000', feeSats: '100', status: 'accepted', detail: null,
          parentTxid: null, replacesTxid: null, recovering: false,
        }],
      },
    });
    await Promise.resolve();
    expect(screen.queryByText('1,000 sats')).not.toBeInTheDocument();
  });

  it('shows a real initial loading state and retry when neither activity source is available', async () => {
    let finishHome: ((value: unknown) => void) | undefined;
    let finishStatus: ((value: unknown) => void) | undefined;
    const home = new Promise((resolve) => { finishHome = resolve; });
    const status = new Promise((resolve) => { finishStatus = resolve; });
    installFakeChrome({
      'wallet.home': () => home,
      'transaction.status': () => status,
      'scan.status': () => ({ ok: false, code: 'ERR_INTERNAL' }),
    });

    render(view('activity'));
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText('Your transaction history will appear here.')).not.toBeInTheDocument();

    await act(async () => {
      finishHome?.({ ok: false, code: 'ERR_INTERNAL' });
      finishStatus?.({ ok: false, code: 'ERR_INTERNAL' });
      await Promise.all([home, status]);
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Transaction activity could not be loaded.',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('Your transaction history will appear here.')).not.toBeInTheDocument();
  });

  it('refreshes an accepted transaction to confirmed and removes acceleration actions', async () => {
    let confirmed = false;
    const txid = '9'.repeat(64);
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'scan.status': () => ({
        ok: true,
        result: {
          kind: 'completed', scanId: 'scan-1', unitsDone: 2, unitsTotal: 2,
          currentUnit: null, boundaryUnits: [], failureReason: null,
          historyPartial: false,
        },
      }),
      'scan.start': () => {
        confirmed = true;
        queueMicrotask(() => emitRuntimeMessage({ type: 'squirrel:scan-progress' }));
        return { ok: true, result: { scanId: 'scan-2' } };
      },
      'transaction.status': () => ({
        ok: true,
        result: {
          network: 'mainnet',
          accountId: ACCOUNT_ID,
          transactions: [{
            planId: 'confirmed-plan', kind: 'native_send', txid, createdAt: 1,
            amountSats: '2500', feeSats: '234', status: confirmed ? 'confirmed' : 'accepted',
            detail: null, parentTxid: null, replacesTxid: null, recovering: false,
          }],
        },
      }),
      'activity.list': () => ({
        ok: true,
        result: {
          accountId: ACCOUNT_ID,
          items: [{
            txid,
            deltaSats: '-2734',
            feeSats: '234',
            confirmationState: confirmed ? 'confirmed' : 'mempool',
            timestamp: '2026-08-01T12:00:00.000Z',
            height: confirmed ? 900_000 : null,
          }],
          nextCursor: null,
          reset: false,
          historyComplete: true,
        },
      }),
    });

    render(view('activity'));
    expect((await screen.findAllByText('Confirmed')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('234 sats network fee').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('link', { name: /View transaction on mempool\.space/u })).toHaveAttribute(
      'href',
      `https://mempool.space/tx/${txid}`,
    );

    expect(screen.queryByRole('button', { name: 'Speed up with RBF' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Speed up with CPFP' })).not.toBeInTheDocument();
  });

  it('renders a retained inscription in native review and forwards the unavailable-preview acknowledgement', async () => {
    const approvals: unknown[] = [];
    const inscriptionId = `${'a'.repeat(64)}i0`;
    const txid = 'b'.repeat(64);
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'transaction.plan': () => ({
        ok: true,
        result: {
          planId: 'm9p-plan', planHash: 'c'.repeat(64), expiresAt: Date.now() + 60_000,
          review: {
            kind: 'native_send', network: 'signet', accountId: ACCOUNT_ID,
            recipients: [{ address: 'tb1qrecipient', valueSats: '1000', role: 'recipient' }],
            inputs: [{ txid, vout: 0, valueSats: '2000', classification: 'inscribed', path: "m/86'/1'/0'/1/0" }],
            change: [], amountSats: '1000', feeSats: '100', totalSats: '1100',
            vsize: '100', feeRateSatPerKvB: '1000', feeRateSatPerVb: '1',
            urgency: 'recommended', rbf: true, psbtHash: 'd'.repeat(64),
            standardModeMissingProtections: [], requiresReauth: false, reauthReasons: [],
            effectCount: 1, requiresPreviewAcknowledgement: true,
            inscriptions: [{
              inscriptionId, satpoint: `${txid}:0:0`, outpoint: { txid, vout: 0 },
              inputIndex: 0, inputOffset: '0', outputIndex: 0, outputOffset: '0',
              movement: 'retained', coLocationGroup: `${txid}:0:0`,
              qualifiedPartialAuthorization: false,
              number: 1, contentType: 'image/png',
              preview: { kind: 'placeholder', reason: 'oversized_content' },
            }],
          },
        },
      }),
      'transaction.approve': (payload) => {
        approvals.push(payload);
        return { ok: true, result: { planId: 'm9p-plan', txid: 'e'.repeat(64), status: 'accepted', detail: null } };
      },
    });

    render(view('send'));
    expect(screen.getByRole('button', { name: 'Settings' })).toBeEnabled();
    fireEvent.change(await screen.findByLabelText('Recipient address or BIP-321 URI'), { target: { value: 'tb1qrecipient' } });
    fireEvent.click(screen.getByRole('radio', { name: 'sats' }));
    fireEvent.change(screen.getByLabelText('Amount (sats)'), { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review transaction' }));
    expect(await screen.findByText(inscriptionId)).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('1,100 sats')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeDisabled();
    expect(screen.getByText('Retained')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('exceeded the safe preview limits');
    const approve = screen.getByRole('button', { name: 'Sign and broadcast' });
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/checked the full inscription identifier/iu));
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    await waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0]).toMatchObject({ previewUnavailableAcknowledged: true });
    const explorer = await screen.findByRole('link', { name: /View transaction on mempool\.space/u });
    expect(screen.getByRole('heading', { name: 'Transaction sent' })).toBeInTheDocument();
    expect(screen.getByText('1,000 sats')).toBeInTheDocument();
    expect(screen.getByText('100 sats')).toBeInTheDocument();
    expect(screen.getByText('tb1qrecipient')).toHaveAttribute('title', 'tb1qrecipient');
    expect(screen.getByRole('button', { name: 'Settings' })).toBeEnabled();
    expect(explorer).toHaveAttribute(
      'href',
      `https://mempool.space/signet/tx/${'e'.repeat(64)}`,
    );
    expect(explorer).toHaveAttribute('target', '_blank');
    expect(explorer).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('shows every ordinal transfer safety field and enforces both acknowledgements', async () => {
    const approvals: unknown[] = [];
    const inscriptionId = `${'1'.repeat(64)}i0`;
    const retainedId = `${'2'.repeat(64)}i0`;
    const sourceTxid = '3'.repeat(64);
    const feeTxid = '4'.repeat(64);
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'transaction.plan': () => ({
        ok: true,
        result: {
          planId: 'ordinal-plan',
          planHash: '5'.repeat(64),
          expiresAt: Date.now() + 60_000,
          review: {
            kind: 'ordinal_transfer',
            network: 'signet',
            accountId: ACCOUNT_ID,
            recipients: [{ address: 'tb1qdestination', valueSats: '10000', role: 'postage' }],
            inputs: [
              { txid: sourceTxid, vout: 0, valueSats: '50000',
                classification: 'mixed', path: "m/86'/1'/0'/0/0" },
              { txid: feeTxid, vout: 1, valueSats: '20000',
                classification: 'cardinal_clean', path: "m/84'/1'/0'/0/0" },
            ],
            change: [
              { address: 'tb1pordinalchange', valueSats: '30000', role: 'ordinal_change' },
              { address: 'tb1qpaymentchange', valueSats: '19000', role: 'payment_change' },
            ],
            amountSats: '10000',
            feeSats: '1000',
            totalSats: '11000',
            vsize: '200',
            feeRateSatPerKvB: '5000',
            feeRateSatPerVb: '5',
            urgency: 'recommended',
            rbf: false,
            psbtHash: '6'.repeat(64),
            standardModeMissingProtections: [],
            requiresReauth: false,
            reauthReasons: [],
            effectCount: 2,
            requiresPreviewAcknowledgement: true,
            ordinalAction: {
              action: 'transfer',
              inscriptionId,
              destination: {
                address: 'tb1qdestination',
                valueSats: '10000',
                ownership: 'external',
              },
              postageSats: '10000',
              feeSats: '1000',
              protectedSource: { txid: sourceTxid, vout: 0, valueSats: '50000' },
              fundingInputs: [{ txid: feeTxid, vout: 1, valueSats: '20000' }],
              retainedInscriptionIds: [retainedId],
              returnedBtcSats: '19000',
              requiresNonTaprootAcknowledgement: true,
            },
            inscriptions: [inscriptionId, retainedId].map((id, index) => ({
              inscriptionId: id,
              satpoint: `${sourceTxid}:0:${index * 20000}`,
              outpoint: { txid: sourceTxid, vout: 0 },
              inputIndex: 0,
              inputOffset: String(index * 20000),
              outputIndex: index,
              outputOffset: '0',
              movement: index === 0 ? 'sent' : 'retained',
              coLocationGroup: `${sourceTxid}:0:${index * 20000}`,
              qualifiedPartialAuthorization: false,
              number: null,
              contentType: null,
              preview: { kind: 'placeholder', reason: 'unavailable' },
            })),
          },
        },
      }),
      'transaction.approve': (payload) => {
        approvals.push(payload);
        return {
          ok: true,
          result: {
            planId: 'ordinal-plan',
            txid: '7'.repeat(64),
            status: 'accepted',
            detail: null,
          },
        };
      },
    });
    render(
      <Providers>
        <Transactions
          accountId={ACCOUNT_ID}
          expectedVaultId="vault-1"
          expectedSessionId={SESSION_1}
          capabilities={CAPABILITIES}
          initialSection="send"
          initialOrdinalAction={{
            kind: 'ordinal_transfer',
            account: 0,
            inscriptionId,
            outpoint: { txid: sourceTxid, vout: 0 },
          }}
          onNavigate={() => undefined}
        />
      </Providers>,
    );
    expect(screen.queryByText(
      'Choose the destination. Postage is set automatically and protected inscriptions stay separated.',
    )).not.toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText('Recipient address'), {
      target: { value: 'tb1qdestination' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review transaction' }));
    expect(await screen.findByRole('heading', {
      name: 'Send this inscription?',
    })).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('11,000 sats')).toBeInTheDocument();
    expect(screen.getByText('Technical details').closest('details')).not.toHaveAttribute('open');
    expect(screen.getAllByText(`${sourceTxid}:0`).length).toBeGreaterThan(0);
    expect(screen.getByText(/19,000 sats/u)).toBeInTheDocument();
    expect(screen.getAllByText(retainedId).length).toBeGreaterThan(0);
    const approve = screen.getByRole('button', { name: 'Send inscription' });
    expect(approve).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/checked the full inscription identifier/iu));
    fireEvent.click(screen.getByLabelText(/confirmed the recipient supports inscriptions/iu));
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    await waitFor(() => expect(approvals).toHaveLength(1));
    expect(approvals[0]).toMatchObject({
      previewUnavailableAcknowledged: true,
      nonTaprootDestinationAcknowledged: true,
    });
    expect(await screen.findByRole('heading', { name: 'Inscription sent' })).toBeInTheDocument();
    expect(screen.getByText('10,000 sats')).toBeInTheDocument();
    expect(screen.getByText('1,000 sats')).toBeInTheDocument();
    expect(screen.getByText('tb1qdestination')).toHaveAttribute('title', 'tb1qdestination');
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('shows current collectible bitcoin and removes the fee-only keep-current choice', async () => {
    const plans: unknown[] = [];
    const sourceTxid = '8'.repeat(64);
    const inscriptionId = `${'9'.repeat(64)}i0`;
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'utxo.list': () => ({
        ok: true,
        result: {
          utxos: [utxoRow({
            txid: sourceTxid,
            vout: 2,
            valueSats: '81252',
            effectiveValueSats: '81186',
            lane: 'ordinals',
            path: "m/86'/0'/0'/0/2",
            reasons: ['reserved_ordinals_lane'],
            inscriptions: [{ inscriptionId, satpoint: `${sourceTxid}:2:0` }],
          })],
          privacyNotes: [],
        },
      }),
      'transaction.plan': (payload) => {
        plans.push(payload);
        return { ok: false, code: 'ERR_INTERNAL' };
      },
    });

    render(
      <Providers>
        <Transactions
          accountId={ACCOUNT_ID}
          expectedVaultId="vault-1"
          expectedSessionId={SESSION_1}
          capabilities={CAPABILITIES}
          initialSection="send"
          initialOrdinalAction={{
            kind: 'ordinal_postage_manage',
            account: 0,
            selection: {
              inscriptionId,
              outpoint: { txid: sourceTxid, vout: 2 },
              satpoint: `${sourceTxid}:2:0`,
              classificationRevision: 'rev-postage',
            },
          }}
          onNavigate={() => undefined}
        />
      </Providers>,
    );

    expect(await screen.findByText(
      'Currently with this collectible: 81,252 sats',
    )).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Minimum — 330 sats' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Keep current amount' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Minimum — 330 sats' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review transaction' }));
    await waitFor(() => expect(plans).toHaveLength(1));
    expect(plans[0]).toMatchObject({
      kind: 'ordinal_postage_manage',
      target: { type: 'minimum_standard' },
    });
  });

  it('explains when recovering collectible bitcoin would cost at least as much as it returns', async () => {
    const sourceTxid = '7'.repeat(64);
    const inscriptionId = `${'6'.repeat(64)}i0`;
    installFakeChrome({
      'fees.quote': () => ({ ok: true, result: QUOTE }),
      'utxo.list': () => ({
        ok: true,
        result: {
          utxos: [utxoRow({
            txid: sourceTxid,
            vout: 0,
            valueSats: '700',
            effectiveValueSats: '634',
            lane: 'ordinals',
            path: "m/86'/0'/0'/0/3",
            reasons: ['reserved_ordinals_lane'],
            inscriptions: [{ inscriptionId, satpoint: `${sourceTxid}:0:0` }],
          })],
          privacyNotes: [],
        },
      }),
      'transaction.plan': () => ({ ok: false, code: 'ERR_NO_SWEEPABLE_EXCESS' }),
    });

    render(
      <Providers>
        <Transactions
          accountId={ACCOUNT_ID}
          expectedVaultId="vault-1"
          expectedSessionId={SESSION_1}
          capabilities={CAPABILITIES}
          initialSection="send"
          initialOrdinalAction={{
            kind: 'ordinal_postage_manage',
            account: 0,
            selection: {
              inscriptionId,
              outpoint: { txid: sourceTxid, vout: 0 },
              satpoint: `${sourceTxid}:0:0`,
              classificationRevision: 'rev-postage',
            },
          }}
          onNavigate={() => undefined}
        />
      </Providers>,
    );

    await screen.findByText('Currently with this collectible: 700 sats');
    fireEvent.click(screen.getByRole('button', { name: 'Review transaction' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /network fee is at least the bitcoin that would be recovered/iu,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/choose a lower amount to keep/iu);
    expect(screen.queryByText(/something went wrong/iu)).toBeNull();
  });

  it('keeps custom fees available when estimates fail and recovers presets with one retry', async () => {
    let quotes = 0;
    const plans: unknown[] = [];
    installFakeChrome({
      'fees.quote': () => {
        quotes += 1;
        return quotes === 1
          ? { ok: false, code: 'ERR_FEE_QUOTE_INVALID' }
          : { ok: true, result: QUOTE };
      },
      'transaction.plan': (payload) => {
        plans.push(payload);
        return { ok: false, code: 'ERR_INTERNAL' };
      },
    });

    render(view('send'));
    expect(await screen.findByRole('note')).toHaveTextContent(
      'Enter a custom rate to try anyway',
    );
    expect(screen.getByRole('radio', { name: /^Priority/u })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /^Standard/u })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /^Economy/u })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Custom' })).toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Custom fees do not use a current automatic estimate',
    );
    expect(screen.getByLabelText('Fee rate (sat/vB)')).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Recipient address or BIP-321 URI'), { target: { value: 'tb1qrecipient' } });
    fireEvent.click(screen.getByRole('radio', { name: 'sats' }));
    fireEvent.change(screen.getByLabelText('Amount (sats)'), { target: { value: '1000' } });
    const review = screen.getByRole('button', { name: 'Review transaction' });
    expect(review).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Fee rate (sat/vB)'), { target: { value: '10001' } });
    expect(review).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Fee rate (sat/vB)'), { target: { value: '2' } });
    expect(review).toBeEnabled();
    fireEvent.click(review);
    await waitFor(() => expect(plans).toHaveLength(1));
    expect(plans[0]).toMatchObject({ fee: { type: 'custom', rateSatPerVb: '2' } });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(quotes).toBe(2));
    await waitFor(() => expect(screen.getByRole('radio', { name: /^Standard/u })).toBeEnabled());
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Custom' })).toBeChecked();
  });
});
