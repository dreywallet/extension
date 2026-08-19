import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '../../src/entrypoints/fullpage/Settings';
import { BlockedSiteSupport } from '../../src/entrypoints/fullpage/BlockedSiteSupport';
import { UiRoot } from '../../src/ui/UiRoot';
import { I18nProvider } from '../../src/ui/i18n';
import { AccountSelector } from '../../src/ui/components/AccountSelector';
import type { SessionView } from '../../src/ui/hooks/use-session';
import { emitRuntimeMessage, installFakeChrome } from './fake-rpc';
import { UI_PREFS_KEY } from '../../src/adapters/storage/keys';

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset['accent'];
});

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
const THIRD_ACCOUNT_ID = `acct_signet_${'3'.repeat(64)}`;

function session(refresh: () => void, overrides: Partial<SessionView> = {}): SessionView {
  return {
    state: 'ready', activeVaultId: 'vault-1', preferredUnlockVaultId: 'vault-1',
    vaults: [{ vaultId: 'vault-1', name: 'Main' }],
    expectation: EXPECTATION, deadline: Date.now() + 60_000, quarantinedVaultCount: 0,
    activeAccountId: ACCOUNT_ID, activeAccount: 0, selectableAccounts: [0],
    accountSummaries: [{ accountId: ACCOUNT_ID, account: 0, name: 'Main', signingSource: 'software' }],
    accountAddState: null,
    activeRecoveredAddressCount: 0,
    capabilities: {
      canView: true, canDeriveAddresses: true, canPlanTransactions: true,
      canSignTransactions: true, canSignMessages: true, canBroadcast: true,
      canExposeToProviders: true, canUseMarketplaces: true,
      signMethod: 'software', canBuildUnsignedPsbt: true, canSignPsbt: true,
      canSignBip322: true, canRevealSeed: true, canExportPublicAccount: false,
      canVerifyAddress: false,
    },
    ...overrides,
    refresh,
  };
}

describe('provider settings', () => {
  it('promotes wallet identity, separates recipients, and keeps advanced tools collapsed', async () => {
    installFakeChrome({
      'config.get': () => ({
        ok: true,
        result: {
          idleTimeoutMs: 3_600_000,
          highSecurityMode: false,
          advancedPsbtSigning: false,
        },
      }),
    });
    render(
      <UiRoot sender="fullpage">
        <Settings session={session(() => undefined)} />
      </UiRoot>,
    );

    const walletAccounts = await screen.findByRole('heading', { name: 'Wallets & accounts' });
    const recovery = screen.getByRole('heading', { name: 'Backup & recovery' });
    const recipients = screen.getByRole('heading', { name: 'Saved recipients' });
    const security = screen.getByRole('heading', { name: 'Security' });
    expect(walletAccounts.compareDocumentPosition(recovery) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(recovery.compareDocumentPosition(recipients) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(recipients.compareDocumentPosition(security) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Accounts' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Wallets' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open wallets & accounts' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open recovery center' })).toBeVisible();
    expect(screen.getByText('No approved sites.').closest('[role="status"]')).not.toBeNull();

    const advancedControl = screen.getByLabelText('Advanced PSBT signing');
    expect(advancedControl).not.toBeVisible();
    const summary = screen.getByText('Advanced').closest('summary');
    expect(summary).not.toBeNull();
    await userEvent.click(summary!);
    expect(advancedControl).toBeVisible();

    expect(screen.getByText('Update the password used to unlock Drey.')).toBeVisible();
    expect(screen.getByLabelText('Current app password')).not.toBeVisible();
    expect(screen.getByText(
      'Learn what address and network information the wallet service receives.',
    )).toBeVisible();
    expect(screen.getByText(/one-way hashes of individual addresses/iu)).not.toBeVisible();
  });

  it('selects and persists the one-week inactivity timeout', async () => {
    const payloads: unknown[] = [];
    installFakeChrome({
      'config.get': () => ({
        ok: true,
        result: {
          idleTimeoutMs: 3_600_000,
          highSecurityMode: false,
          advancedPsbtSigning: false,
        },
      }),
      'config.set': (payload) => {
        payloads.push(payload);
        return {
          ok: true,
          result: {
            idleTimeoutMs: 604_800_000,
            highSecurityMode: false,
            advancedPsbtSigning: false,
          },
        };
      },
    });

    render(
      <UiRoot sender="fullpage">
        <Settings session={session(() => undefined)} />
      </UiRoot>,
    );

    const picker = await screen.findByRole('radiogroup', { name: 'Lock after inactivity' });
    const oneHour = within(picker).getByRole('radio', { name: '1 hour' });
    const oneWeek = within(picker).getByRole('radio', { name: '1 week' });
    await waitFor(() => expect(oneHour).toHaveAttribute('aria-checked', 'true'));
    expect(oneWeek).toHaveAttribute('aria-checked', 'false');

    await userEvent.click(oneWeek);
    await waitFor(() => expect(oneWeek).toHaveAttribute('aria-checked', 'true'));
    expect(oneHour).toHaveAttribute('aria-checked', 'false');
    expect(payloads).toEqual([{ idleTimeoutMs: 604_800_000, ...EXPECTATION }]);
  });

  it('selects and persists the profile accent with accessible keyboard behavior', async () => {
    const storage = installFakeChrome({});
    render(
      <UiRoot sender="fullpage">
        <Settings session={session(() => undefined)} />
      </UiRoot>,
    );

    const picker = await screen.findByRole('radiogroup', { name: 'Accent color' });
    const white = within(picker).getByRole('radio', { name: 'White' });
    const orange = within(picker).getByRole('radio', { name: 'Orange' });
    const green = within(picker).getByRole('radio', { name: 'Green' });
    expect(white).toHaveAttribute('aria-checked', 'true');
    expect(within(white).getByText('✓')).toBeVisible();
    expect(document.documentElement.dataset['accent']).toBe('white');

    await userEvent.click(orange);
    orange.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(green).toHaveFocus();
    expect(green).toHaveAttribute('aria-checked', 'true');
    expect(within(green).getByText('✓')).toBeVisible();
    expect(within(white).queryByText('✓')).not.toBeInTheDocument();
    expect(document.documentElement.dataset['accent']).toBe('green');
    await waitFor(() => expect(storage.get(UI_PREFS_KEY)).toEqual({
      accent: 'green',
      activityUnit: 'sats',
      hidePortfolioAmounts: false,
      language: 'en',
    }));
  });

  it('keeps the one-wallet picker compact and explains the gap rule only on request', async () => {
    installFakeChrome({});
    const createTab = vi.fn(async () => ({}));
    (chrome.tabs as unknown as { create: typeof createTab }).create = createTab;
    render(
      <UiRoot sender="popup">
        <AccountSelector session={session(() => undefined, {
          accountAddState: {
            kind: 'empty_limit', firstEmptyAccount: 1, lastEmptyAccount: 5, limit: 5,
          },
        })} compact />
      </UiRoot>,
    );
    const selector = await screen.findByRole('button', { name: 'Active account' });
    expect(selector).not.toHaveTextContent('W1');
    expect(selector).toHaveTextContent('Main');
    expect(selector).toHaveAttribute('title', 'Main / Main');
    expect(screen.queryByText('Active account')).not.toBeInTheDocument();

    await userEvent.click(selector);
    const menu = screen.getByRole('menu', { name: 'Active account' });
    expect(within(menu).getAllByRole('menuitemradio')).toHaveLength(1);
    expect(within(menu).getByRole('menuitemradio', { name: 'Main' }))
      .toHaveAttribute('aria-checked', 'true');
    const addAccount = within(menu).getByRole('menuitem', { name: 'Add account' });
    expect(addAccount).toBeEnabled();
    expect(within(menu).queryByRole('menuitem', { name: 'Add wallet' })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Wallets' })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Wallets & accounts' })).toBeEnabled();
    expect(within(menu).queryByText("Accounts use this wallet's recovery phrase."))
      .not.toBeInTheDocument();
    expect(within(menu).queryByText(/five unused accounts/u)).not.toBeInTheDocument();
    await userEvent.click(addAccount);
    expect(within(menu).getByText(/You already have five unused accounts/iu)).toBeInTheDocument();
    expect(within(menu).queryByText('Account 20')).not.toBeInTheDocument();
    expect(within(menu).queryByText(/recovered address/u)).not.toBeInTheDocument();
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'Wallets & accounts' }));
    expect(createTab).toHaveBeenCalledWith({
      url: 'chrome-extension://test/fullpage.html#/settings/wallets-accounts',
    });
  });

  it('shows the compact wallet cue only when wallet identity needs disambiguation', async () => {
    installFakeChrome({});
    const createTab = vi.fn(async () => ({}));
    (chrome.tabs as unknown as { create: typeof createTab }).create = createTab;
    render(
      <UiRoot sender="popup">
        <AccountSelector session={session(() => undefined, {
          vaults: [
            { vaultId: 'vault-1', name: 'Main' },
            { vaultId: 'vault-2', name: 'Savings' },
          ],
        })} compact />
      </UiRoot>,
    );
    const selector = await screen.findByRole('button', { name: 'Active account' });
    expect(selector).toHaveTextContent('W1');
    expect(selector).toHaveTextContent('Main');
    await userEvent.click(selector);
    const menu = screen.getByRole('menu', { name: 'Active account' });
    const walletEntry = within(menu).getByRole('menuitem', { name: 'Main' });
    expect(walletEntry).toBeEnabled();
    expect(within(menu).queryByText('Savings')).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Add wallet' })).not.toBeInTheDocument();
    await userEvent.click(walletEntry);
    expect(createTab).toHaveBeenCalledWith({
      url: 'chrome-extension://test/fullpage.html#/settings/wallets-accounts',
    });
  });

  it('keeps recovered-address detail out of the quick picker', async () => {
    installFakeChrome({});
    render(
      <UiRoot sender="popup">
        <AccountSelector
          session={session(() => undefined, {
            activeAccount: 2,
            selectableAccounts: [0, 2],
            activeRecoveredAddressCount: 2,
          })}
          compact
        />
      </UiRoot>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Active account' }));
    const menu = screen.getByRole('menu', { name: 'Active account' });
    expect(within(menu).queryByText(/recovered address/u)).not.toBeInTheDocument();
  });

  it('adds and selects the next account through the worker', async () => {
    const payloads: unknown[] = [];
    const refresh = vi.fn();
    installFakeChrome({
      'account.add': (payload) => {
        payloads.push(payload);
        return { ok: true, result: { accountId: ACCOUNT_ID, account: 1 } };
      },
    });
    render(
      <UiRoot sender="popup">
        <AccountSelector
          session={session(refresh, { accountAddState: {
            kind: 'available', nextAccount: 1, trailingEmptyAccounts: 0,
            limit: 5, requiresAcknowledgement: false,
          } })}
          compact
        />
      </UiRoot>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Active account' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Add account' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(payloads).toEqual([{ ...EXPECTATION, acknowledgeEmptyAccountRisk: false }]);
    expect(screen.queryByRole('menu', { name: 'Active account' })).not.toBeInTheDocument();
  });

  it('shows the recovery warning before crossing an unused account and supports cancellation', async () => {
    const payloads: unknown[] = [];
    const refresh = vi.fn();
    installFakeChrome({
      'account.add': (payload) => {
        payloads.push(payload);
        return { ok: true, result: { accountId: ACCOUNT_ID, account: 2 } };
      },
    });
    render(
      <UiRoot sender="popup">
        <AccountSelector session={session(refresh, { accountAddState: {
          kind: 'available', nextAccount: 2, trailingEmptyAccounts: 1,
          limit: 5, requiresAcknowledgement: true,
        } })} compact />
      </UiRoot>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Active account' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Add account' }));
    expect(screen.getByText(/Drey can recover activity through up to five empty accounts/iu))
      .toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(payloads).toHaveLength(0);
    expect(screen.queryByText(/Drey can recover activity through up to five empty accounts/iu))
      .not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('menuitem', { name: 'Add account' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(payloads).toEqual([{
      ...EXPECTATION,
      acknowledgeEmptyAccountRisk: true,
    }]);
  });

  it('revokes a scoped connected-site grant', async () => {
    const revokePayloads: unknown[] = [];
    installFakeChrome({
      'config.get': () => ({
        ok: true,
        result: { idleTimeoutMs: 3_600_000, highSecurityMode: false, advancedPsbtSigning: false },
      }),
      'provider.sites.list': () => ({
        ok: true,
        result: { sites: [{
          resourceId: '11'.repeat(16), origin: 'https://app.example', network: 'signet',
          accountId: ACCOUNT_ID, account: 0, categories: ['addresses', 'balance'],
        }] },
      }),
      'provider.sites.revoke': (payload) => {
        revokePayloads.push(payload);
        return { ok: true, result: { revoked: true } };
      },
    });

    render(
      <UiRoot sender="fullpage">
        <Settings session={session(() => undefined, {
          selectableAccounts: [0, 2],
          accountSummaries: [
            { accountId: ACCOUNT_ID, account: 0, name: 'Main', signingSource: 'software' },
            {
              accountId: THIRD_ACCOUNT_ID,
              account: 2,
              name: 'Account 3',
              signingSource: 'software',
            },
          ],
        })} />
      </UiRoot>,
    );

    expect(await screen.findByText('https://app.example')).toBeInTheDocument();
    expect(screen.getByText('Signet · Account 1 · Wallet addresses, Balance')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(screen.queryByText('https://app.example')).not.toBeInTheDocument());
    expect(revokePayloads).toEqual([{ resourceId: '11'.repeat(16), ...EXPECTATION }]);
    expect(screen.getByText('No approved sites.')).toBeInTheDocument();
  });

  it('exposes password confirmation for every transaction as an opt-in setting', async () => {
    const payloads: unknown[] = [];
    installFakeChrome({
      'config.get': () => ({
        ok: true,
        result: {
          idleTimeoutMs: 3_600_000,
          highSecurityMode: false,
          advancedPsbtSigning: false,
        },
      }),
      'config.set': (payload) => {
        payloads.push(payload);
        return {
          ok: true,
          result: {
            idleTimeoutMs: 3_600_000,
            highSecurityMode: true,
            advancedPsbtSigning: false,
          },
        };
      },
    });

    render(
      <UiRoot sender="fullpage">
        <Settings session={session(() => undefined)} />
      </UiRoot>,
    );

    const toggle = await screen.findByRole('checkbox', {
      name: 'Confirm every transaction with password',
    });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(payloads).toEqual([{ highSecurityMode: true, ...EXPECTATION }]);
  });

  it('updates connected sites immediately when permissions change elsewhere', async () => {
    let origin = 'https://first.example';
    installFakeChrome({
      'config.get': () => ({
        ok: true,
        result: { idleTimeoutMs: 3_600_000, highSecurityMode: false, advancedPsbtSigning: false },
      }),
      'provider.sites.list': () => ({
        ok: true,
        result: { sites: [{
          resourceId: '22'.repeat(16), origin, network: 'mainnet', account: 0,
          accountId: ACCOUNT_ID, categories: ['addresses'],
        }] },
      }),
    });
    render(
      <UiRoot sender="fullpage">
        <Settings session={session(() => undefined)} />
      </UiRoot>,
    );
    expect(await screen.findByText('https://first.example')).toBeInTheDocument();

    origin = 'https://second.example';
    act(() => emitRuntimeMessage({
      type: 'squirrel:wallet-data-changed',
      reason: 'permissions',
    }));
    expect(await screen.findByText('https://second.example')).toBeInTheDocument();
    expect(screen.queryByText('https://first.example')).not.toBeInTheDocument();
  });

  it('provides a local, non-secret blocked-origin appeal screen', async () => {
    window.location.hash = '#/settings/site-blocked';
    render(<I18nProvider initial="en"><BlockedSiteSupport /></I18nProvider>);
    expect(screen.getByRole('heading', { name: 'Blocked site support' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('No account data or permission was shared');
    expect(screen.getByText(/ERR_PHISHING_BLOCKED/u)).toBeInTheDocument();
    expect(document.querySelector('a[href^="http"]')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Back to settings' }));
    expect(window.location.hash).toBe('#/settings');
  });
});
