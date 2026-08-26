import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WalletAccountSettings } from '../../src/entrypoints/fullpage/WalletAccountSettings';
import { UiRoot } from '../../src/ui/UiRoot';
import type { SessionView } from '../../src/ui/hooks/use-session';
import { installFakeChrome } from './fake-rpc';

afterEach(cleanup);

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false, media: '', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }),
  });
});

const EXPECTATION = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};
const ACCOUNT_ID = `acct_signet_${'1'.repeat(64)}`;

function session(refresh: () => void): SessionView {
  return {
    state: 'ready',
    activeVaultId: 'vault-1',
    preferredUnlockVaultId: 'vault-1',
    vaults: [
      { vaultId: 'vault-1', name: 'Orange' },
      { vaultId: 'vault-2', name: 'Savings' },
    ],
    expectation: EXPECTATION,
    deadline: Date.now() + 60_000,
    quarantinedVaultCount: 0,
    activeAccountId: ACCOUNT_ID,
    activeAccount: 0,
    selectableAccounts: [0],
    accountSummaries: [{
      accountId: ACCOUNT_ID,
      account: 0,
      name: 'Account 1',
      signingSource: 'software',
    }],
    accountAddState: {
      kind: 'available', nextAccount: 1, trailingEmptyAccounts: 1,
      limit: 5, requiresAcknowledgement: true,
    },
    activeRecoveredAddressCount: 0,
    backupDeferred: false,
    capabilities: {
      canView: true,
      canDeriveAddresses: true,
      canPlanTransactions: true,
      canSignTransactions: true,
      canSignMessages: true,
      canBroadcast: true,
      canExposeToProviders: true,
      canUseMarketplaces: true,
      signMethod: 'software',
      canBuildUnsignedPsbt: true,
      canSignPsbt: true,
      canSignBip322: true,
      canRevealSeed: true,
      canExportPublicAccount: false,
      canVerifyAddress: false,
    },
    refresh,
  };
}

describe('WalletAccountSettings', () => {
  it('keeps the active wallet and its account together without a self-link', async () => {
    installFakeChrome({});
    const onManageAccounts = vi.fn();
    render(
      <UiRoot sender="fullpage">
        <WalletAccountSettings
          session={session(() => undefined)}
          onBack={vi.fn()}
          onManageAccounts={onManageAccounts}
        />
      </UiRoot>,
    );

    expect(await screen.findByRole('heading', { name: 'Wallets & accounts' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Orange' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Accounts in Orange' })).toBeVisible();
    expect(screen.getByText("Accounts use this wallet's recovery phrase.")).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: 'Active account' }));
    const menu = screen.getByRole('menu', { name: 'Active account' });
    expect(within(menu).queryByRole('menuitem', { name: 'Wallets & accounts' }))
      .not.toBeInTheDocument();
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByRole('button', { name: 'Manage accounts' }));
    expect(onManageAccounts).toHaveBeenCalledOnce();
  });

  it('preserves add, switch, and guarded remove-wallet behavior', async () => {
    const switchPayloads: unknown[] = [];
    const removePayloads: unknown[] = [];
    const refresh = vi.fn();
    const onBack = vi.fn();
    installFakeChrome({
      'vault.switch': (payload) => {
        switchPayloads.push(payload);
        return {
          ok: true,
          result: {
            vaultId: 'vault-2',
            sessionId: '00000000-0000-4000-8000-000000000002',
            deadline: Date.now() + 60_000,
          },
        };
      },
      'vault.remove': (payload) => {
        removePayloads.push(payload);
        return { ok: true, result: { removed: true } };
      },
    });
    const createTab = vi.fn(async () => ({}));
    (chrome.tabs as unknown as { create: typeof createTab }).create = createTab;
    render(
      <UiRoot sender="fullpage">
        <WalletAccountSettings
          session={session(refresh)}
          onBack={onBack}
          onManageAccounts={vi.fn()}
        />
      </UiRoot>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Add wallet' }));
    expect(createTab).toHaveBeenCalledWith({ url: 'chrome-extension://test/onboarding.html' });

    const wallets = screen.getByRole('heading', { name: 'Wallets' }).closest('section');
    expect(wallets).not.toBeNull();
    const savingsRow = within(wallets!).getByText('Savings').closest('div');
    expect(savingsRow).not.toBeNull();
    await userEvent.click(within(savingsRow!).getByRole('button', { name: 'Switch' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(onBack).toHaveBeenCalledOnce();
    expect(switchPayloads).toEqual([{ vaultId: 'vault-2' }]);

    await userEvent.click(within(savingsRow!).getByRole('button', { name: 'Remove' }));
    const removeButton = screen.getByRole('button', { name: 'Remove Savings' });
    expect(removeButton).toBeDisabled();
    await userEvent.type(screen.getByLabelText('App password'), 'remove-secret');
    expect(removeButton).toBeDisabled();
    await userEvent.click(screen.getByLabelText(
      "I have backed up this wallet’s recovery phrase.",
    ));
    expect(removeButton).toBeEnabled();
    await userEvent.click(removeButton);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    expect(removePayloads).toEqual([{
      targetVaultId: 'vault-2',
      password: 'remove-secret',
      ...EXPECTATION,
    }]);
  });
});
