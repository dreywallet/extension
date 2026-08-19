import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountListResult } from '@drey/core/messaging/ops';
import { publicAccountFromSeed, derivePublicAccountAddress } from '@drey/core/domain/accounts/public-account';
import { bitcoinCoreDescriptorJson } from '@drey/core/domain/accounts/public-account-interchange';
import { ManageAccounts } from '../../src/entrypoints/fullpage/ManageAccounts';
import { UiRoot } from '../../src/ui/UiRoot';
import { emitRuntimeMessage, installFakeChrome } from './fake-rpc';

const EXPECTATION = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};
const ACCOUNT_IDS = [1, 2, 3, 4].map((digit) => `acct_signet_${String(digit).repeat(64)}`);

function accountRow(account: number, fields: Omit<AccountListResult['accounts'][number], 'account' | 'accountId' | 'name' | 'signingSource'>): AccountListResult['accounts'][number] {
  return {
    account,
    accountId: ACCOUNT_IDS[account]!,
    name: `Account ${account + 1}`,
    signingSource: 'software',
    ...fields,
  };
}

afterEach(cleanup);

describe('ManageAccounts', () => {
  it('confirms the empty-account recovery tradeoff before adding', async () => {
    const additions: unknown[] = [];
    installFakeChrome({
      'account.list': () => ({ ok: true, result: {
        accountAddState: {
          kind: 'available', nextAccount: 2, trailingEmptyAccounts: 1,
          limit: 5, requiresAcknowledgement: true,
        },
        accounts: [
          accountRow(0, { active: true, hidden: false, hasHistory: true, canHide: false, hideBlocker: 'active' }),
          accountRow(1, { active: false, hidden: false, hasHistory: false, canHide: true, hideBlocker: null }),
        ],
      } }),
      'account.add': (payload) => {
        additions.push(payload);
        return { ok: true, result: { accountId: ACCOUNT_IDS[2], account: 2 } };
      },
    });
    render(<UiRoot sender="fullpage"><ManageAccounts expectation={EXPECTATION} onBack={vi.fn()} /></UiRoot>);
    await userEvent.click(await screen.findByRole('button', { name: 'Add account' }));
    expect(screen.getByText(/Some other wallets may stop at the first empty account/iu)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(additions).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(additions).toEqual([{
      ...EXPECTATION,
      acknowledgeEmptyAccountRisk: true,
    }]));
  });

  it('keeps switching compact, explains blockers, and hides or shows reversibly', async () => {
    const visibilityPayloads: unknown[] = [];
    let state: AccountListResult = {
      accountAddState: null,
      accounts: [
        accountRow(0, { active: true, hidden: false, hasHistory: true, canHide: false, hideBlocker: 'active' }),
        accountRow(1, { active: false, hidden: false, hasHistory: false, canHide: false, hideBlocker: 'stale' }),
        accountRow(2, { active: false, hidden: false, hasHistory: true, canHide: true, hideBlocker: null }),
        accountRow(3, { active: false, hidden: true, hasHistory: true, canHide: false, hideBlocker: null }),
      ],
    };
    installFakeChrome({
      'account.list': () => ({ ok: true, result: state }),
      'account.visibility.set': (payload) => {
        visibilityPayloads.push(payload);
        const request = payload as { accountId: string; hidden: boolean };
        state = {
          accountAddState: state.accountAddState,
          accounts: state.accounts.map((account) => account.accountId === request.accountId
            ? { ...account, hidden: request.hidden, canHide: !request.hidden, hideBlocker: null }
            : account),
        };
        return {
          ok: true,
          result: {
            accountId: request.accountId,
            account: state.accounts.find((account) => account.accountId === request.accountId)?.account ?? 0,
            hidden: request.hidden,
          },
        };
      },
    });
    render(
      <UiRoot sender="fullpage">
        <ManageAccounts expectation={EXPECTATION} onBack={vi.fn()} />
      </UiRoot>,
    );

    expect(await screen.findByRole('heading', { name: 'Manage accounts' })).toBeInTheDocument();
    expect(screen.getByText(/Hiding never deletes an account/iu)).toBeInTheDocument();
    const stale = await screen.findByRole('article', { name: 'Account 2' });
    expect(within(stale).getByRole('button', { name: 'Hide account' })).toBeDisabled();
    expect(within(stale).getByText(/Refresh both account lanes/iu)).toBeInTheDocument();

    const hideable = screen.getByRole('article', { name: 'Account 3' });
    const hide = within(hideable).getByRole('button', { name: 'Hide account' });
    hide.focus();
    await userEvent.keyboard('{Enter}');
    expect(within(hideable).getByRole('note')).toHaveTextContent(/keys, history, labels/iu);
    await userEvent.click(within(hideable).getByRole('button', { name: 'Hide account' }));
    await waitFor(() => expect(visibilityPayloads[0]).toEqual({
      accountId: ACCOUNT_IDS[2],
      hidden: true,
      ...EXPECTATION,
    }));

    await userEvent.click(await screen.findByText('Hidden accounts (2)'));
    const archived = screen.getByRole('article', { name: 'Account 4' });
    await userEvent.click(within(archived).getByRole('button', { name: 'Show account' }));
    await waitFor(() => expect(visibilityPayloads[1]).toEqual({
      accountId: ACCOUNT_IDS[3],
      hidden: false,
      ...EXPECTATION,
    }));
  });

  it('announces when scanning restores a hidden account automatically', async () => {
    let hidden = true;
    installFakeChrome({
      'account.list': () => ({
        ok: true,
        result: {
          accountAddState: null,
          accounts: [
            accountRow(0, { active: true, hidden: false, hasHistory: true, canHide: false, hideBlocker: 'active' }),
            accountRow(1, { active: false, hidden, hasHistory: hidden, canHide: !hidden, hideBlocker: null }),
          ],
        },
      }),
    });
    render(
      <UiRoot sender="fullpage">
        <ManageAccounts expectation={EXPECTATION} onBack={vi.fn()} />
      </UiRoot>,
    );
    await screen.findByText('Hidden accounts (1)');
    hidden = false;
    act(() => emitRuntimeMessage({
      type: 'squirrel:wallet-data-changed',
      reason: 'account',
    }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Account 2 was shown again because new activity was found.',
    );
  });

  it('auto-detects one pasted account, reviews both first addresses, and gates import', async () => {
    const definition = publicAccountFromSeed(Uint8Array.from({ length: 32 }, (_, index) => index + 1), 'signet', 6);
    const imports: unknown[] = [];
    const scans: unknown[] = [];
    installFakeChrome({
      'account.list': () => ({ ok: true, result: { accountAddState: null, accounts: [
        accountRow(0, { active: true, hidden: false, hasHistory: true, canHide: false, hideBlocker: 'active' }),
      ] } }),
      'account.watch.import': (payload) => {
        imports.push(payload);
        return { ok: true, result: { accountId: definition.accountId, account: 6 } };
      },
      'scan.start': (payload) => {
        scans.push(payload);
        return { ok: true, result: { scanId: 'scan-1' } };
      },
    });
    render(<UiRoot sender="fullpage"><ManageAccounts expectation={EXPECTATION} onBack={vi.fn()} /></UiRoot>);
    await userEvent.click(await screen.findByRole('button', { name: 'Import watch-only account' }));
    await userEvent.click(screen.getByRole('button', { name: 'Paste' }));
    const input = screen.getByLabelText('Public account data');
    fireEvent.change(input, { target: { value: bitcoinCoreDescriptorJson(definition) } });
    await userEvent.click(screen.getByRole('button', { name: 'Review detected account' }));

    expect(screen.getByText(derivePublicAccountAddress(definition, 'payment', 0, 0).address)).toBeInTheDocument();
    expect(screen.getByText(derivePublicAccountAddress(definition, 'ordinals', 0, 0).address)).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'Import and scan' });
    expect(submit).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: /compared both addresses/iu }));
    await userEvent.click(submit);
    await waitFor(() => expect(imports).toHaveLength(1));
    expect(imports[0]).toMatchObject({
      network: 'signet',
      paymentReceiveDescriptor: definition.lanes.payment.receiveDescriptor,
      ordinalsReceiveDescriptor: definition.lanes.ordinals.receiveDescriptor,
      ...EXPECTATION,
    });
    expect(scans).toEqual([{ mode: 'rescan', ...EXPECTATION }]);
  });

  it('reauthenticates before exporting a software account and exposes current round-trip formats', async () => {
    const definition = publicAccountFromSeed(Uint8Array.from({ length: 32 }, (_, index) => 64 - index), 'signet', 0);
    const exports: unknown[] = [];
    installFakeChrome({
      'account.list': () => ({ ok: true, result: { accountAddState: null, accounts: [
        { ...accountRow(0, { active: true, hidden: false, hasHistory: true, canHide: false, hideBlocker: 'active' }), accountId: definition.accountId },
      ] } }),
      'account.public.export': (payload) => {
        exports.push(payload);
        return { ok: true, result: { definition } };
      },
    });
    render(<UiRoot sender="fullpage"><ManageAccounts expectation={EXPECTATION} onBack={vi.fn()} /></UiRoot>);
    await userEvent.click(await screen.findByRole('button', { name: 'Export public account' }));
    expect(screen.queryByRole('button', { name: 'Export public account' })).not.toBeInTheDocument();
    expect(screen.getByText(/reveals every derived address/iu)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('App password'), 'correct horse battery staple');
    await userEvent.click(screen.getByRole('button', { name: 'Continue to export' }));
    await waitFor(() => expect(exports).toEqual([{
      accountId: definition.accountId,
      password: 'correct horse battery staple',
      ...EXPECTATION,
    }]));
    expect(await screen.findByRole('img', { name: 'Public account QR code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download JSON' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy public keys' })).toBeInTheDocument();
  });
});
