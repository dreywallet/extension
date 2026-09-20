import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Runes } from '../../src/entrypoints/popup/Runes';
import { ActivityList } from '../../src/entrypoints/popup/ActivityList';
import { Receive } from '../../src/entrypoints/popup/Receive';
import type { RuneDraft, RuneListResult, RuneReview, RuneTransferView } from '../../src/messaging/rune-ops';
import { installFakeChrome, Providers } from './fake-rpc';

const expectation = { expectedVaultId: 'vault-1', expectedSessionId: '00000000-0000-4000-8000-000000000001' };
const accountId = `acct_signet_${'1'.repeat(64)}`;
const rune = { id: '840000:1', name: 'EXAMPLE•RUNE', amount: '125000', divisibility: 2, symbol: 'R' };
const draft: RuneDraft = { runeId: rune.id, recipient: 'tb1precipient', quantity: '25', sending: true, feeRate: '2.345', feeTier: 'custom' };
const listing = (): RuneListResult => ({ status: 'ready', canSign: true, feeFundingSats: '25000', transfers: [], holdings: [{ ...rune, total: rune.amount, available: rune.amount, reserved: '0', hidden: false, constrained: [] }] });
const review = (extra: Partial<RuneReview> = {}): RuneReview => ({ planId: '00000000-0000-4000-8000-000000000002', planHash: 'a'.repeat(64), rune, recipient: draft.recipient, amount: '2500', retained: '122500', feeSats: '700', postageSats: '546', changeSats: '23000', feeRate: '3.5', expiresAt: Date.now() + 120000, requiresReauth: false, ...extra });
const ok = (result: unknown) => ({ ok: true, result });
function setup(handlers: Parameters<typeof installFakeChrome>[0] = {}, initial: RuneDraft | null = null) {
  let stored = initial;
  const writes = vi.fn((payload: unknown) => { if ('draft' in (payload as object)) stored = (payload as { draft: RuneDraft | null }).draft; return ok({ draft: stored }); });
  installFakeChrome({ 'runes.list': () => ok(listing()), 'runes.draft': writes,
    'fees.quote': () => ok({ prioritySatPerKvB: 5000, standardSatPerKvB: 3500, economySatPerKvB: 1000, floorSatPerKvB: 1000, sampledAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString() }),
    'runes.prepare': () => ok(review()), 'runes.cancel': () => ok({ cancelled: true }), ...handlers });
  return writes;
}
function mount(extra: Partial<Parameters<typeof Runes>[0]> = {}) {
  return render(<Providers><Runes expectation={expectation} accountId={accountId} onClose={vi.fn()} {...extra} /></Providers>);
}
async function openSend() {
  fireEvent.click(await screen.findByRole('button', { name: /EXAMPLE•RUNE/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  fireEvent.change(screen.getByLabelText('Recipient’s Runes address'), { target: { value: draft.recipient } });
  fireEvent.change(screen.getByLabelText('Amount', { exact: true }), { target: { value: '25' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Review transfer' })).toBeEnabled());
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Rune navigation and draft lifecycle', () => {
  it('opens the list after reopening; resumes entered data and discards explicitly', async () => {
    const writes = setup();
    const first = mount(); await openSend();
    await waitFor(() => expect(writes).toHaveBeenLastCalledWith(expect.objectContaining({ draft: expect.objectContaining({ quantity: '25' }) })));
    first.unmount(); mount();
    expect(await screen.findByRole('button', { name: 'Resume transfer' })).toBeEnabled();
    expect(screen.getByRole('heading', { name: 'Runes' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Amount')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume transfer' }));
    expect(screen.getByLabelText('Amount')).toHaveValue('25');
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(writes).toHaveBeenLastCalledWith(expect.objectContaining({ draft: null })));
    expect(screen.queryByRole('button', { name: 'Resume transfer' })).not.toBeInTheDocument();
  });
  it('does not save navigation when merely browsing a token or entering a blank Send form', async () => {
    const writes = setup(); mount();
    fireEvent.click(await screen.findByRole('button', { name: /EXAMPLE•RUNE/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.queryByRole('button', { name: 'Resume transfer' })).not.toBeInTheDocument();
    expect(writes.mock.calls.every(([payload]) => !('draft' in (payload as object)))).toBe(true);
  });
  it('uses explicit continuation for expansion and waits for successful persistence', async () => {
    const expand = vi.fn(); const writes = setup(); mount({ onExpand: expand }); await openSend();
    fireEvent.click(screen.getByRole('button', { name: 'Open in full page' }));
    await waitFor(() => expect(expand).toHaveBeenCalledWith(true));
    expect(writes).toHaveBeenLastCalledWith(expect.objectContaining({ draft: expect.objectContaining({ quantity: '25' }) }));
  });
  it('does not expand when saving fails', async () => {
    const expand = vi.fn(); setup({ 'runes.draft': (payload) => 'draft' in (payload as object) ? { ok: false, code: 'ERR_INTERNAL' } : ok({ draft: null }) });
    mount({ onExpand: expand }); await openSend(); fireEvent.click(screen.getByRole('button', { name: 'Open in full page' }));
    await screen.findByText(/Couldn’t save or load/); expect(expand).not.toHaveBeenCalled();
  });
  it('restores a draft automatically only for explicit full-page continuation', async () => {
    setup({}, draft); mount({ resumeDraft: true });
    expect(await screen.findByLabelText('Amount')).toHaveValue('25');
    expect(screen.getByLabelText('Recipient’s Runes address')).toHaveValue(draft.recipient);
  });
  it('retries a failed draft read without replacing the saved draft with null', async () => {
    let failed = true;
    const request = vi.fn((payload: unknown) => { if ('draft' in (payload as object)) throw new Error('Retry must not write'); return failed ? { ok: false, code: 'ERR_INTERNAL' } : ok({ draft }); });
    setup({ 'runes.draft': request }); mount(); await screen.findByText(/Couldn’t save or load/);
    failed = false; fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Resume transfer' })).toBeEnabled();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('keeps the list usable when a saved token is no longer held', async () => {
    setup({}, { ...draft, runeId: '2:2' }); mount();
    await screen.findByText(/not in your current balances/);
    expect(screen.getByRole('button', { name: 'Resume transfer' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /EXAMPLE•RUNE/ })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByText(/not in your current balances/)).not.toBeInTheDocument();
  });
});

describe('Rune send feedback', () => {
  it('puts focus on the new review heading and displays the exact combined Bitcoin cost', async () => {
    setup(); mount(); await openSend();
    expect(screen.queryByRole('radio', { name: /Standard/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review transfer' }));
    expect(await screen.findByRole('heading', { name: 'Review transfer' })).toHaveFocus();
    expect(screen.getByText('1,246 sats')).toBeInTheDocument();
  });
  it('focuses an invalid recipient without losing the entered amount', async () => {
    setup({ 'runes.prepare': () => ({ ok: false, code: 'ERR_INVALID_ADDRESS' }) }); mount(); await openSend();
    fireEvent.click(screen.getByRole('button', { name: 'Review transfer' })); await screen.findByRole('alert');
    expect(screen.getByLabelText('Recipient’s Runes address')).toHaveFocus();
    expect(screen.getByLabelText('Recipient’s Runes address')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Amount')).toHaveValue('25');
  });
  it('offers Bitcoin funding for insufficient nonzero balances', async () => {
    setup({ 'runes.prepare': () => ({ ok: false, code: 'ERR_INSUFFICIENT_FUNDS' }) }); mount(); await openSend();
    fireEvent.click(screen.getByRole('button', { name: 'Review transfer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Not enough available Bitcoin');
    expect(screen.getByRole('button', { name: 'Receive Bitcoin' })).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveFocus();
  });
  it('renews an expired review only after an explicit click and never sends automatically', async () => {
    const prepare = vi.fn().mockReturnValueOnce(ok(review({ expiresAt: Date.now() - 1 }))).mockImplementation(() => ok(review({ planId: '00000000-0000-4000-8000-000000000003' })));
    const approve = vi.fn(); const cancel = vi.fn(() => ok({ cancelled: true }));
    setup({ 'runes.prepare': prepare, 'runes.approve': approve, 'runes.cancel': cancel }); mount(); await openSend();
    fireEvent.click(screen.getByRole('button', { name: 'Review transfer' }));
    const again = await screen.findByRole('button', { name: 'Review again' });
    expect(prepare).toHaveBeenCalledOnce(); expect(approve).not.toHaveBeenCalled();
    fireEvent.click(again); await screen.findByRole('button', { name: 'Confirm and send' });
    expect(cancel).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledTimes(2); expect(approve).not.toHaveBeenCalled();
  });
  it('handles blank and wrong passwords explicitly and obtains a new review before retrying', async () => {
    const prepare = vi.fn(() => ok(review({ requiresReauth: true })));
    const approve = vi.fn(() => ({ ok: false, code: 'ERR_WRONG_PASSWORD' }));
    setup({ 'runes.prepare': prepare, 'runes.approve': approve }); mount(); await openSend();
    fireEvent.click(screen.getByRole('button', { name: 'Review transfer' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm and send' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Enter your password'); expect(approve).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'synthetic-incorrect' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and send' }));
    await screen.findByText(/Incorrect password/);
    expect(screen.queryByRole('button', { name: 'Confirm and send' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review again' }));
    await screen.findByRole('button', { name: 'Confirm and send' });
    expect(prepare).toHaveBeenCalledTimes(2); expect(approve).toHaveBeenCalledOnce();
    expect(screen.getByLabelText(/password/i)).toHaveValue('');
  });
  it('does not retry or encourage resending after an absent approval response', async () => {
    const prepare = vi.fn(() => ok(review())); const approve = vi.fn(() => undefined);
    setup({ 'runes.prepare': prepare, 'runes.approve': approve }); mount(); await openSend();
    fireEvent.click(screen.getByRole('button', { name: 'Review transfer' })); fireEvent.click(await screen.findByRole('button', { name: 'Confirm and send' }));
    await screen.findByText(/Do not send again/); expect(approve).toHaveBeenCalledOnce(); expect(prepare).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Review transfer' })).toBeDisabled();
  });
  it('explains no search matches and supports undoing Hide token', async () => {
    const data = listing(); data.holdings = Array.from({ length: 5 }, (_, index) => ({ ...data.holdings[0]!, id: `840000:${index + 1}`, name: `TOKEN•${String.fromCharCode(65 + index)}` }));
    setup({ 'runes.list': () => ok(data), 'runes.visibility': (payload) => { data.holdings[0]!.hidden = (payload as { hidden: boolean }).hidden; return ok({ updated: true }); } }); mount();
    fireEvent.change(await screen.findByLabelText('Search name or ID'), { target: { value: 'zzzz' } });
    expect(screen.getByText('No matching Runes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' })); fireEvent.click(screen.getByRole('button', { name: /TOKEN•A/ }));
    fireEvent.click(screen.getByText('Token options')); fireEvent.click(screen.getByRole('button', { name: 'Hide token' }));
    await screen.findByText('Token hidden from your list.'); expect(screen.queryByRole('button', { name: /TOKEN•A/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' })); expect(await screen.findByRole('button', { name: /TOKEN•A/ })).toBeInTheDocument();
  });
});

it('pins Rune receiving to the asset role even if the caller supplies payment', async () => {
  const receive = vi.fn(() => ok({ accountId, address: 'tb1pfixture', path: "m/86'/1'/0'/0/0", kind: 'ordinals', network: 'signet' }));
  setup({ 'address.receive': receive });
  render(<Providers><Receive initialKind="payment" runeContext expectation={expectation} activeAccountId={accountId} onClose={vi.fn()} /></Providers>);
  await screen.findByText('tb1pfixture'); expect(receive).toHaveBeenCalledWith(expect.objectContaining({ kind: 'ordinals' }));
  expect(screen.queryByRole('radio', { hidden: true })).not.toBeInTheDocument();
});

it('combines Rune and Bitcoin history chronologically, deduplicates and retains transfer details', () => {
  setup();
  const transfer: RuneTransferView = { direction: 'sent', txid: 'a'.repeat(64), rune, amount: '2500', recipient: draft.recipient, status: 'pending', createdAt: Date.parse('2026-09-09T12:00:00Z') };
  const activity = [{ txid: transfer.txid, deltaSats: '-1246', feeSats: '700', confirmationState: 'mempool' as const, timestamp: '2026-09-09T12:00:00Z', height: null }, { txid: 'b'.repeat(64), deltaSats: '10000', feeSats: null, confirmationState: 'confirmed' as const, timestamp: '2026-09-09T11:00:00Z', height: 1 }];
  const view = render(<Providers><ActivityList activity={activity} runeTransfers={[transfer]} expectation={expectation} accountId={accountId} network="signet" /></Providers>);
  expect(screen.queryByText(/Your transaction history will appear/)).not.toBeInTheDocument();
  const summary = screen.getByText('Sent · EXAMPLE•RUNE').closest('summary')!;
  expect(summary.compareDocumentPosition(screen.getByText('+10,000 sats')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  fireEvent.click(summary);
  expect(screen.getByText(draft.recipient)).toBeInTheDocument();
  expect(screen.getByText(transfer.txid)).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: /View transaction on mempool.space/i }).filter((link) => link.getAttribute('href')?.endsWith(transfer.txid))).toHaveLength(1);
  view.rerender(<Providers><ActivityList activity={[]} runeTransfers={[transfer]} expectation={expectation} accountId={accountId} network="signet" /></Providers>);
  expect(screen.queryByText(/Your transaction history will appear/)).not.toBeInTheDocument();
});

 it('ignores a delayed saved-draft read after the user has begun a new transfer', async () => {
  let resolve!: (result: unknown) => void;
  setup({ 'runes.draft': (payload) => 'draft' in (payload as object) ? ok({ draft: (payload as { draft: RuneDraft }).draft }) : new Promise((done) => { resolve = done; }) });
  mount(); await openSend();
  await act(async () => resolve(ok({ draft: { ...draft, quantity: '99' } })));
  expect(screen.getByLabelText('Amount')).toHaveValue('25');
  expect(screen.getByRole('heading', { name: 'Send Runes' })).toBeInTheDocument();
});

 it('does not expand an unrelated old draft when the active send is blank', async () => {
  const data = listing(); data.holdings.push({ ...data.holdings[0]!, id: '840000:2', name: 'ANOTHER•RUNE' });
  const expand = vi.fn(); setup({ 'runes.list': () => ok(data) }, draft); mount({ onExpand: expand });
  fireEvent.click(await screen.findByRole('button', { name: /ANOTHER•RUNE/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(screen.getByLabelText('Amount')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: 'Open in full page' }));
  await waitFor(() => expect(expand).toHaveBeenCalledWith(false));
});
