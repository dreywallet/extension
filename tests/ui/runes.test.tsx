import '@testing-library/jest-dom/vitest';
import { p2tr, TEST_NETWORK } from '@scure/btc-signer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { clearRunesStore } from '../../src/ui/hooks/use-runes';
import { Runes, RunesEntry } from '../../src/entrypoints/popup/Runes';
import { emitRuntimeMessage, installFakeChrome as installRpc, Providers } from './fake-rpc';
import type { RuneListResult } from '../../src/messaging/rune-ops';
const quote = { prioritySatPerKvB: 5000, standardSatPerKvB: 3500, economySatPerKvB: 832,
  floorSatPerKvB: 1000, sampledAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString() };
function installFakeChrome(handlers: Parameters<typeof installRpc>[0]) {
  let draft: unknown = null;
  return installRpc({ 'runes.draft': (payload) => { if ('draft' in (payload as object)) draft = (payload as { draft: unknown }).draft; return { ok: true, result: { draft } }; }, 'fees.quote': () => ({ ok: true, result: quote }), ...handlers });
}
const expectation = { expectedVaultId: 'vault-1', expectedSessionId: '00000000-0000-4000-8000-000000000001' };
const accountId = `acct_signet_${'1'.repeat(64)}`;
const rune = { id: '1:1', name: 'EXACT•RUNE', amount: '9007199254740993', divisibility: 8, symbol: null };
function listing(): RuneListResult {
  return { status: 'ready', canSign: true, feeFundingSats: '10000', transfers: [], holdings: [{ ...rune,
    total: rune.amount, available: rune.amount, reserved: '0', constrained: [], hidden: false }] };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe('compact Rune flow', () => {
  it('keeps receive discoverable for a verified empty wallet and distinguishes unavailable from zero', async () => {
    const data = listing(); data.holdings = [];
    installFakeChrome({ 'runes.list': () => ({ ok: true, result: data }) });
    render(<Providers><RunesEntry expectation={expectation} accountId={accountId} onOpen={vi.fn()} /></Providers>);
    expect(await screen.findByText('No Runes yet')).toBeInTheDocument(); cleanup(); clearRunesStore();
    data.status = 'unavailable';
    render(<Providers><Runes expectation={expectation} accountId={accountId} onClose={vi.fn()} /></Providers>);
    expect(await screen.findByText(/Rune balances are unavailable/)).toBeInTheDocument();
    expect(screen.queryByText('No Runes yet')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Receive Runes' })).toBeEnabled();
  });
  it('enters exact quantities and shows fee separately from postage', async () => {
    const prepare = vi.fn((payload: unknown) => ({ ok: true, result: { planId: '00000000-0000-4000-8000-000000000002', planHash: 'a'.repeat(64), rune,
      recipient: (payload as { recipient: string }).recipient, amount: '1', retained: '9007199254740992', feeSats: '200', postageSats: '546', changeSats: '9000', feeRate: '1', expiresAt: Date.now() + 120000, requiresReauth: false } }));
    installFakeChrome({ 'runes.list': () => ({ ok: true, result: listing() }), 'runes.prepare': prepare });
    render(<Providers><Runes expectation={expectation} accountId={accountId} onClose={vi.fn()} /></Providers>);
    fireEvent.click(await screen.findByRole('button', { name: /EXACT•RUNE/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.change(screen.getByLabelText('Recipient’s Runes address'), { target: { value: 'tb1precipient' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '0.00000001' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review transfer' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Review transfer' }));
    await screen.findByRole('button', { name: 'Confirm and send' });
    expect(prepare.mock.calls[0]?.[0]).toMatchObject({ amount: '1', recipient: 'tb1precipient' });
    expect(screen.getByText('200 sats')).toBeInTheDocument(); expect(screen.getByText('546 sats')).toBeInTheDocument();
    expect(screen.getByText('Bitcoin network fee')).toBeInTheDocument();
    expect(screen.getByText('Bitcoin sent with tokens')).toBeInTheDocument();
  });
  it('makes hidden tokens reversible and preserves watch-only receiving', async () => {
    const data = listing(); data.holdings[0]!.hidden = true; data.canSign = false;
    installFakeChrome({ 'runes.list': () => ({ ok: true, result: data }) });
    render(<Providers><Runes expectation={expectation} accountId={accountId} onClose={vi.fn()} /></Providers>);
    fireEvent.click(await screen.findByLabelText('Include hidden'));
    fireEvent.click(screen.getByRole('button', { name: /EXACT•RUNE/ }));
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Receive Runes' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Show token' })).toBeInTheDocument();
  });
  it('rejects excessive token precision before preparing anything', async () => {
    const prepare = vi.fn();
    installFakeChrome({ 'runes.list': () => ({ ok: true, result: listing() }), 'runes.prepare': prepare });
    render(<Providers><Runes expectation={expectation} accountId={accountId} onClose={vi.fn()} /></Providers>);
    fireEvent.click(await screen.findByRole('button', { name: /EXACT•RUNE/ })); fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.change(screen.getByLabelText('Recipient’s Runes address'), { target: { value: 'tb1precipient' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '0.000000001' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review transfer' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Review transfer' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('8 decimal places'));
    expect(prepare).not.toHaveBeenCalled();
  });
  it('explains a wrong-network address without clearing the send form', async () => {
    installFakeChrome({ 'runes.list': () => ({ ok: true, result: listing() }),
      'runes.prepare': () => ({ ok: false, code: 'ERR_INVALID_ADDRESS' }) });
    render(<Providers><Runes expectation={expectation} accountId={accountId} onClose={vi.fn()} /></Providers>);
    fireEvent.click(await screen.findByRole('button', { name: /EXACT•RUNE/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.change(screen.getByLabelText('Recipient’s Runes address'), { target: { value: 'bc1pwrongnetwork' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review transfer' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Review transfer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('valid for this network');
    expect(screen.getByLabelText('Recipient’s Runes address')).toHaveValue('bc1pwrongnetwork');
    expect(screen.getByLabelText('Amount')).toHaveValue('1');
    expect(screen.queryByRole('button', { name: 'Confirm and send' })).not.toBeInTheDocument();
  });
});


describe('Rune refresh and draft safety', () => {
  it('keeps balances visible across focus, an ongoing scan, and a failed refresh', async () => {
    let response: RuneListResult = listing();
    const list = vi.fn(() => ({ ok: true, result: response }));
    const start = vi.fn();
    installFakeChrome({ 'runes.list': list, 'scan.start': start });
    const entry = render(<Providers><RunesEntry expectation={expectation} accountId={accountId} onOpen={vi.fn()} /></Providers>);
    await screen.findByText('1 asset');
    entry.unmount();
    render(<Providers><Runes expectation={expectation} accountId={accountId} onClose={vi.fn()} onExpand={vi.fn()} /></Providers>);
    const token = screen.getByRole('button', { name: /EXACT•RUNE/ });
    const before = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(before + 11_000);
    response = { ...listing(), status: 'checking', holdings: [] };
    act(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(token).toBeInTheDocument();
    expect(screen.getByText('90,071,992.54740993 ¤')).toBeInTheDocument();
    expect(screen.queryByText('Checking…')).not.toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Open in full page' }).querySelector('svg')).not.toBeNull();
    expect(screen.queryByText('Open send in full page')).not.toBeInTheDocument();
    response = { ...response, status: 'unavailable' };
    act(() => emitRuntimeMessage({ type: 'squirrel:wallet-data-changed', reason: 'utxo' }));
    await screen.findByText('Couldn’t refresh. Showing your last loaded balances.');
    expect(token).toBeInTheDocument();
    expect(screen.queryByText('No Runes yet')).not.toBeInTheDocument();
  });

  it('still starts discovery when opened without a loaded wallet view', async () => {
    const start = vi.fn(() => ({ ok: true, result: { scanId: 'scan-2' } }));
    installFakeChrome({ 'runes.list': () => ({ ok: true, result: listing() }), 'scan.start': start,
      'scan.status': () => ({ ok: true, result: { kind: 'completed', scanId: 'scan-1', unitsDone: 0, unitsTotal: 0, currentUnit: null, boundaryUnits: [], failureReason: null, historyPartial: false } }) });
    render(<Providers><Runes expectation={expectation} accountId={accountId} onClose={vi.fn()} /></Providers>);
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
  });

  it('shares a pending list request across navigation and never shows it in another account', async () => {
    let resolve!: (value: unknown) => void;
    const list = vi.fn(() => new Promise((done) => { resolve = done; }));
    installFakeChrome({ 'runes.list': list });
    const entry = render(<Providers><RunesEntry expectation={expectation} accountId={accountId} onOpen={vi.fn()} /></Providers>);
    entry.unmount();
    const page = render(<Providers><Runes expectation={expectation} accountId={accountId} onClose={vi.fn()} /></Providers>);
    expect(list).toHaveBeenCalledOnce();
    await act(async () => { resolve({ ok: true, result: listing() }); });
    expect(screen.getByRole('button', { name: /EXACT•RUNE/ })).toBeInTheDocument();
    page.rerender(<Providers><Runes expectation={expectation} accountId={`acct_signet_${'2'.repeat(64)}`} onClose={vi.fn()} /></Providers>);
    expect(screen.queryByRole('button', { name: /EXACT•RUNE/ })).not.toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
    await act(async () => { clearRunesStore(); resolve({ ok: true, result: listing() }); });
    expect(screen.queryByRole('button', { name: /EXACT•RUNE/ })).not.toBeInTheDocument();
  });

  it('opens the loaded list immediately without repeating discovery, then refreshes after Receive closes', async () => {
    const start = vi.fn(() => ({ ok: true, result: { scanId: 'scan-2' } }));
    const list = vi.fn(() => ({ ok: true, result: listing() }));
    installFakeChrome({
      'runes.list': list,
      'scan.status': () => ({ ok: true, result: { kind: 'completed', scanId: 'scan-1', unitsDone: 0, unitsTotal: 0, currentUnit: null, boundaryUnits: [], failureReason: null, historyPartial: false } }),
      'scan.start': start,
    });
    const view = render(<Providers><RunesEntry expectation={expectation} accountId={accountId} onOpen={vi.fn()} /></Providers>);
    await waitFor(() => expect(list).toHaveBeenCalledOnce());
    expect(start).not.toHaveBeenCalled();
    view.unmount();
    render(<Providers><Runes expectation={expectation} accountId={accountId} onClose={vi.fn()} /></Providers>);
    expect(screen.getByRole('button', { name: /EXACT•RUNE/ })).toBeInTheDocument();
    expect(screen.queryByText('Checking…')).not.toBeInTheDocument();
    expect(list).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Receive Runes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(start.mock.calls[0]).toEqual([{ mode: 'refresh', ...expectation }]);
    const calls = list.mock.calls.length;
    act(() => emitRuntimeMessage({ type: 'squirrel:scan-progress' }));
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(calls));
  });

  it('keeps Max as an explicit intent and clears it on manual quantity edits', async () => {
    const prepare = vi.fn(() => ({ ok: false, code: 'ERR_PLAN_CHANGED' }));
    installFakeChrome({ 'runes.list': () => ({ ok: true, result: listing() }), 'runes.prepare': prepare });
    render(<Providers><Runes expectation={expectation} accountId={accountId} onClose={vi.fn()} /></Providers>);
    fireEvent.click(await screen.findByRole('button', { name: /EXACT•RUNE/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.change(screen.getByLabelText('Recipient’s Runes address'), { target: { value: 'tb1precipient' } });
    fireEvent.click(screen.getByRole('button', { name: 'Max' }));
    expect(screen.getByLabelText('Amount')).toHaveValue('90071992.54740993');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review transfer' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Review transfer' }));
    await waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(prepare.mock.calls[0]).toEqual([expect.objectContaining({ amount: 'max' })]);
    await screen.findByRole('alert');
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '0.00000001' } });
    expect(screen.getByRole('button', { name: 'Max' })).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review transfer' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Review transfer' }));
    await waitFor(() => expect(prepare).toHaveBeenCalledTimes(2));
    expect(prepare.mock.calls[1]).toEqual([expect.objectContaining({ amount: '1' })]);
  });

  it('disables stale spending after a failed balance refresh', async () => {
    let failed = false;
    installFakeChrome({ 'runes.list': () => failed ? { ok: false, code: 'ERR_NETWORK' } : { ok: true, result: listing() } });
    render(<Providers><Runes expectation={expectation} accountId={accountId} onClose={vi.fn()} /></Providers>);
    fireEvent.click(await screen.findByRole('button', { name: /EXACT•RUNE/ }));
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    failed = true;
    act(() => emitRuntimeMessage({ type: 'squirrel:wallet-data-changed', reason: 'utxo' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Receive Runes' })).toBeEnabled();
  });

  it('retains the send draft while receiving fee funding and prevents fee-free review', async () => {
    const data = listing(); data.feeFundingSats = '0';
    installFakeChrome({ 'runes.list': () => ({ ok: true, result: data }) });
    render(<Providers><Runes expectation={expectation} accountId={accountId} onClose={vi.fn()} /></Providers>);
    fireEvent.click(await screen.findByRole('button', { name: /EXACT•RUNE/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.change(screen.getByLabelText('Recipient’s Runes address'), { target: { value: 'tb1precipient' } });
    fireEvent.click(screen.getByRole('button', { name: 'Max' }));
    expect(screen.getByRole('button', { name: 'Review transfer' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Receive Bitcoin' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByLabelText('Recipient’s Runes address')).toHaveValue('tb1precipient');
    expect(screen.getByRole('button', { name: 'Max' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Rune cold popup display', () => {
  it('hydrates a reopened popup while the live network request remains pending', async () => {
    installFakeChrome({ 'runes.snapshot': () => ({ ok: true, result: { data: listing() } }),
      'runes.list': () => new Promise(() => undefined) });
    render(<Providers><Runes expectation={expectation} accountId={accountId} onClose={vi.fn()} /></Providers>);
    expect(await screen.findByText('90,071,992.54740993 ¤')).toBeInTheDocument();
  });
  it('shows the supplied Rune symbol with a grouped exact amount', async () => {
    const data = listing(); data.holdings[0]!.symbol = '🛢';
    data.holdings[0]!.total = '105000000'; data.holdings[0]!.divisibility = 0;
    installFakeChrome({ 'runes.list': () => ({ ok: true, result: data }) });
    render(<Providers><Runes expectation={expectation} accountId={accountId} onClose={vi.fn()} /></Providers>);
    expect(await screen.findByText('105,000,000 🛢')).toBeInTheDocument();
  });
});

it('refreshes promptly when scan completion arrives during a pending checking response', async () => {
  let resolve!: (value: unknown) => void;
  const list = vi.fn().mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
    .mockImplementation(() => ({ ok: true, result: listing() }));
  installFakeChrome({ 'runes.list': list });
  render(<Providers><RunesEntry expectation={expectation} accountId={accountId} onOpen={vi.fn()} /></Providers>);
  act(() => emitRuntimeMessage({ type: 'squirrel:wallet-data-changed', reason: 'utxo' }));
  await act(async () => resolve({ ok: true, result: { ...listing(), status: 'checking', holdings: [] } }));
  expect(await screen.findByText('1 asset')).toBeInTheDocument();
  expect(list).toHaveBeenCalledTimes(2);
});

it('still hydrates known balances when a checking result wins the startup race', async () => {
  let resolve!: (value: unknown) => void;
  installFakeChrome({ 'runes.snapshot': () => new Promise((done) => { resolve = done; }),
    'runes.list': () => ({ ok: true, result: { ...listing(), status: 'checking', holdings: [] } }) });
  render(<Providers><RunesEntry expectation={expectation} accountId={accountId} onOpen={vi.fn()} /></Providers>);
  await act(async () => undefined);
  await act(async () => resolve({ ok: true, result: { data: listing() } }));
  expect(await screen.findByText('1 asset')).toBeInTheDocument();
});

it('uses quoted fee tiers, supports exact custom rates, and hides unnecessary funding actions', async () => {
  const prepare = vi.fn(() => ({ ok: false, code: 'ERR_PLAN_CHANGED' }));
  installFakeChrome({ 'runes.list': () => ({ ok: true, result: listing() }), 'runes.prepare': prepare });
  render(<Providers><Runes expectation={expectation} accountId={accountId} onClose={vi.fn()} /></Providers>);
  fireEvent.click(await screen.findByRole('button', { name: /EXACT•RUNE/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  fireEvent.change(screen.getByLabelText('Recipient’s Runes address'), { target: { value: 'tb1precipient' } });
  fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Change fee' }));
  await waitFor(() => expect(screen.getByRole('radio', { name: /Standard/ })).toBeEnabled());
  expect(screen.getByRole('radio', { name: /Standard/ })).toBeChecked();
  expect(screen.queryByRole('button', { name: 'Receive Bitcoin' })).not.toBeInTheDocument();
  expect(screen.getByText('Bitcoin available for fees: 10,000 sats')).toBeInTheDocument();
  for (const [name, rate] of [['Standard', '3.5'], ['Economy', '1'], ['Priority', '5']] as const) {
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(name) }));
    fireEvent.click(screen.getByRole('button', { name: 'Review transfer' }));
    await waitFor(() => expect(prepare).toHaveBeenLastCalledWith(expect.objectContaining({ feeRate: rate })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review transfer' })).toBeEnabled());
  }
  fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
  fireEvent.change(screen.getByLabelText('Fee rate (sat/vB)'), { target: { value: '1.832' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review transfer' }));
  await waitFor(() => expect(prepare).toHaveBeenLastCalledWith(expect.objectContaining({ feeRate: '1.832' })));
  fireEvent.change(screen.getByLabelText('Fee rate (sat/vB)'), { target: { value: 'oops' } });
  expect(screen.getByRole('button', { name: 'Review transfer' })).toBeDisabled();
});

it('does not overwrite a custom rate when a delayed quote arrives', async () => {
  let resolve!: (value: unknown) => void;
  installFakeChrome({ 'runes.list': () => ({ ok: true, result: listing() }),
    'fees.quote': () => new Promise((done) => { resolve = done; }) });
  render(<Providers><Runes expectation={expectation} accountId={accountId} onClose={vi.fn()} /></Providers>);
  fireEvent.click(await screen.findByRole('button', { name: /EXACT•RUNE/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(screen.getByRole('button', { name: 'Review transfer' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Change fee' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
  fireEvent.change(screen.getByLabelText('Fee rate (sat/vB)'), { target: { value: '2.345' } });
  await act(async () => resolve({ ok: true, result: quote }));
  expect(screen.getByRole('radio', { name: 'Custom' })).toBeChecked();
  expect(screen.getByLabelText('Fee rate (sat/vB)')).toHaveValue('2.345');
});

it('opens the list and restores a draft only after Resume transfer', async () => {
  installFakeChrome({ 'runes.list': () => ({ ok: true, result: listing() }),
    'runes.draft': () => ({ ok: true, result: { draft: { runeId: rune.id, recipient: 'tb1precipient', quantity: '1.23', sending: true, feeRate: '2.345', feeTier: 'custom' } } }) });
  render(<Providers><Runes expectation={expectation} accountId={accountId} onClose={vi.fn()} /></Providers>);
  fireEvent.click(await screen.findByRole('button', { name: 'Resume transfer' }));
  fireEvent.click(screen.getByRole('button', { name: 'Change fee' }));
  expect(await screen.findByLabelText('Fee rate (sat/vB)')).toHaveValue('2.345');
  expect(screen.getByLabelText('Amount')).toHaveValue('1.23');
  expect(screen.getByRole('radio', { name: 'Custom' })).toBeChecked();
});

it('searches compatible saved and recent addresses, deduplicates, and restores focus after selection', async () => {
  const key = Uint8Array.from(Buffer.from('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'hex'));
  const address = p2tr(key, undefined, TEST_NETWORK).address!;
  const wrongNetwork = p2tr(key).address!;
  installFakeChrome({ 'runes.list': () => ({ ok: true, result: listing() }),
    'addressBook.list': () => ({ ok: true, result: { version: 1, network: 'signet', saved: [
      { id: '1'.repeat(32), label: 'Alice', address, createdAtMs: 1, updatedAtMs: 1 },
      { id: '2'.repeat(32), label: 'Wrong network', address: wrongNetwork, createdAtMs: 1, updatedAtMs: 1 },
      { id: '3'.repeat(32), label: 'Invalid', address: 'tb1pnotvalid', createdAtMs: 1, updatedAtMs: 1 },
    ], recent: [{ address, lastUsedAtMs: 1, useCount: 1, lastKind: 'ordinal' }] } }) });
  render(<Providers><Runes expectation={expectation} accountId={accountId} onClose={vi.fn()} /></Providers>);
  fireEvent.click(await screen.findByRole('button', { name: /EXACT•RUNE/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  const trigger = screen.getByRole('button', { name: 'Address book' });
  fireEvent.click(trigger);
  await screen.findByRole('button', { name: /Alice/ });
  fireEvent.change(screen.getByLabelText('Search recipients'), { target: { value: 'missing' } });
  expect(screen.queryByRole('button', { name: /Alice/ })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Search recipients'), { target: { value: 'alice' } });
  const alice = screen.getByRole('button', { name: /Alice/ });
  expect(screen.queryByRole('button', { name: /Wrong network|Invalid|Recent address/ })).not.toBeInTheDocument();
  fireEvent.click(alice);
  expect(screen.getByLabelText('Recipient’s Runes address')).toHaveValue(address);
  expect(trigger).toHaveFocus();
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
});
