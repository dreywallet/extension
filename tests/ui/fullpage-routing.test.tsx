import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/entrypoints/fullpage/App';
import {
  FULLPAGE_HASH,
  fullpageViewFromHash,
} from '../../src/entrypoints/fullpage/routes';
import { UiRoot } from '../../src/ui/UiRoot';
import { emitRuntimeMessage, installFakeChrome } from './fake-rpc';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});
const ACCOUNT_ID = `acct_signet_${'1'.repeat(64)}`;

const READY_SESSION = {
  vaults: [{ vaultId: 'vault-1', name: 'Main', createdAt: 1 }],
  quarantinedVaultCount: 0,
  locked: false,
  activeVaultId: 'vault-1',
  sessionId: '00000000-0000-4000-8000-000000000001',
  deadline: Date.now() + 60_000,
  highSecurityMode: false,
  backupVerified: true,
  activeAccountId: ACCOUNT_ID,
  activeAccount: 0,
  selectableAccounts: [0],
  accountSummaries: [{
    accountId: ACCOUNT_ID,
    account: 0,
    name: 'Main',
    signingSource: 'software',
  }],
  accountAddState: null,
  activeRecoveredAddressCount: 0,
  capabilities: {
    signMethod: 'software',
    canView: true,
    canDeriveAddresses: true,
    canPlanTransactions: true,
    canSignTransactions: true,
    canSignMessages: true,
    canBroadcast: true,
    canExposeToProviders: true,
    canUseMarketplaces: true,
    canBuildUnsignedPsbt: true,
    canSignPsbt: true,
    canSignBip322: true,
    canRevealSeed: true,
    canExportPublicAccount: false,
    canVerifyAddress: false,
  },
};

describe('full-page routing', () => {
  it('gives an empty full page one clear path into onboarding', async () => {
    installFakeChrome({
      'session.snapshot': () => ({
        ok: true,
        result: {
          ...READY_SESSION,
          vaults: [],
          activeVaultId: null,
          sessionId: null,
          activeAccountId: null,
          accountSummaries: [],
        },
      }),
    });

    render(
      <UiRoot sender="fullpage">
        <App />
      </UiRoot>,
    );

    expect(await screen.findByRole('heading', { name: 'Welcome to Drey' })).toBeInTheDocument();
    expect(screen.getByText('Bitcoin and Ordinals, kept safe.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Set up your wallet' })).toBeVisible();
  });

  it('maps every supported hash to its view and defaults unknown hashes to settings', () => {
    expect(Object.entries(FULLPAGE_HASH).map(([view, hash]) => [
      view,
      fullpageViewFromHash(hash),
    ])).toEqual([
      ['settings', 'settings'],
      ['walletAccounts', 'walletAccounts'],
      ['accounts', 'accounts'],
      ['recovery', 'recovery'],
      ['reveal', 'reveal'],
      ['passkeys', 'passkeys'],
      ['vault', 'vault'],
      ['communityVault', 'communityVault'],
      ['messageSigning', 'messageSigning'],
      ['addressBook', 'addressBook'],
      ['siteBlocked', 'siteBlocked'],
      ['send', 'send'],
      ['utxos', 'utxos'],
      ['activity', 'activity'],
    ]);
    expect(fullpageViewFromHash('#/utxos')).toBe('settings');
    expect(fullpageViewFromHash('#/unknown')).toBe('settings');
  });

  it('renders Manage coins when opened through the protected-sats destination', async () => {
    window.location.hash = FULLPAGE_HASH.utxos;
    installFakeChrome({
      'session.snapshot': () => ({ ok: true, result: READY_SESSION }),
      'fees.quote': () => ({ ok: false, code: 'ERR_GATEWAY_UNAVAILABLE' }),
      'utxo.list': () => ({ ok: true, result: { utxos: [] } }),
      'scan.status': () => ({ ok: false, code: 'ERR_GATEWAY_UNAVAILABLE' }),
    });

    render(
      <UiRoot sender="fullpage">
        <App />
      </UiRoot>,
    );

    expect(await screen.findByRole('heading', { name: 'Manage coins' }))
      .toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Wallet navigation' }))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage coins' }))
      .toHaveAttribute('aria-current', 'page');
  });

  it('opens Community Vault as a separate, keyless shared-ownership surface', async () => {
    window.location.hash = FULLPAGE_HASH.communityVault;
    installFakeChrome({
      'session.snapshot': () => ({ ok: true, result: READY_SESSION }),
      'communityVault.status': () => ({
        ok: true,
        result: { owners: [], unusableCampaignIds: [] },
      }),
    });

    render(
      <UiRoot sender="fullpage">
        <App />
      </UiRoot>,
    );

    expect(await screen.findByRole('heading', { name: 'Community Vault' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Join a campaign' })).toBeVisible();
    expect(screen.getByText(/Drey and the gallery cannot spend or recover the vault/u)).toBeVisible();
  });

  it('connects Settings to every ordinary full-page destination without changing routes', async () => {
    window.location.hash = FULLPAGE_HASH.settings;
    installFakeChrome({
      'session.snapshot': () => ({ ok: true, result: READY_SESSION }),
      'config.get': () => ({
        ok: true,
        result: { idleTimeoutMs: 3_600_000, advancedPsbtSigning: false },
      }),
      'provider.sites.list': () => ({ ok: true, result: { sites: [] } }),
      'fees.quote': () => ({ ok: false, code: 'ERR_GATEWAY_UNAVAILABLE' }),
    });

    render(
      <UiRoot sender="fullpage">
        <App />
      </UiRoot>,
    );

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' }))
      .toHaveAttribute('aria-current', 'page');

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('heading', { name: 'Send Bitcoin' })).toBeInTheDocument();
    expect(window.location.hash).toBe(FULLPAGE_HASH.send);
    expect(screen.getByRole('button', { name: 'Send' }))
      .toHaveAttribute('aria-current', 'page');

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(window.location.hash).toBe(FULLPAGE_HASH.settings);
  });

  it('keeps the recovery-phrase ceremony outside ordinary navigation', async () => {
    window.location.hash = FULLPAGE_HASH.reveal;
    installFakeChrome({
      'session.snapshot': () => ({ ok: true, result: READY_SESSION }),
    });

    render(
      <UiRoot sender="fullpage">
        <App />
      </UiRoot>,
    );

    expect(await screen.findByRole('heading', { name: 'Reveal recovery phrase' }))
      .toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Wallet navigation' }))
      .not.toBeInTheDocument();
  });

  it('opens the focused wallet page and then the detailed account manager', async () => {
    window.location.hash = FULLPAGE_HASH.settings;
    installFakeChrome({
      'session.snapshot': () => ({ ok: true, result: READY_SESSION }),
      'config.get': () => ({
        ok: true,
        result: { idleTimeoutMs: 3_600_000, highSecurityMode: false, advancedPsbtSigning: false },
      }),
      'provider.sites.list': () => ({ ok: true, result: { sites: [] } }),
      'account.list': () => ({
        ok: true,
        result: { accountAddState: null, accounts: [{
          accountId: ACCOUNT_ID,
          account: 0,
          name: 'Main',
          signingSource: 'software',
          active: true,
          hidden: false,
          hasHistory: false,
          canHide: false,
          hideBlocker: 'active',
        }] },
      }),
    });
    render(
      <UiRoot sender="fullpage">
        <App />
      </UiRoot>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Open wallets & accounts' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Wallets & accounts' }))
      .toBeInTheDocument();
    expect(window.location.hash).toBe(FULLPAGE_HASH.walletAccounts);
    expect(screen.getByText('How accounts work')).toBeInTheDocument();
    expect(screen.getByText(/All standard accounts in this wallet share one recovery phrase/iu))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Manage accounts' }));
    expect(await screen.findByRole('heading', { name: 'Manage accounts' })).toBeInTheDocument();
    expect(window.location.hash).toBe(FULLPAGE_HASH.accounts);
    expect(screen.queryByRole('navigation', { name: 'Wallet navigation' }))
      .not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Wallets & accounts' }))
      .toBeInTheDocument();
    expect(window.location.hash).toBe(FULLPAGE_HASH.walletAccounts);
  });

  it('does not reload accounts when a protected read extends the same session', async () => {
    window.location.hash = FULLPAGE_HASH.accounts;
    let snapshotCalls = 0;
    let accountListCalls = 0;
    installFakeChrome({
      'session.snapshot': () => {
        snapshotCalls += 1;
        return { ok: true, result: READY_SESSION };
      },
      'account.list': () => {
        accountListCalls += 1;
        if (accountListCalls === 1) {
          emitRuntimeMessage({ type: 'squirrel:session-state-changed', locked: false });
        }
        return {
          ok: true,
          result: { accountAddState: null, accounts: [{
            accountId: ACCOUNT_ID,
            account: 0,
            name: 'Main',
            signingSource: 'software',
            active: true,
            hidden: false,
            hasHistory: false,
            canHide: false,
            hideBlocker: 'active',
          }] },
        };
      },
    });

    render(
      <UiRoot sender="fullpage">
        <App />
      </UiRoot>,
    );

    expect(await screen.findByRole('article', { name: 'Account 1' })).toBeInTheDocument();
    await waitFor(() => expect(snapshotCalls).toBe(2));
    expect(accountListCalls).toBe(1);
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
  });

  it('connects Settings, Recovery, and the protected reveal ceremony', async () => {
    window.location.hash = FULLPAGE_HASH.settings;
    installFakeChrome({
      'session.snapshot': () => ({ ok: true, result: READY_SESSION }),
      'config.get': () => ({
        ok: true,
        result: { idleTimeoutMs: 3_600_000, highSecurityMode: false, advancedPsbtSigning: false },
      }),
      'provider.sites.list': () => ({ ok: true, result: { sites: [] } }),
      'backup.status': () => ({
        ok: true,
        result: {
          backupVerified: true,
          metadata: {
            version: 1, origin: 'generated', usageGatePassed: true, wordCount: 12,
            usesPassphrase: false, lastSpotCheckAt: null, lastFullRecoveryCheckAt: null,
          },
        },
      }),
      'vaultCoordinator.recoveryCReadiness': () => ({
        ok: true,
        result: {
          state: 'not_started', localRole: 'absent', policyState: 'absent',
          phoneSignerPaired: false, standaloneRecoveryPackageAvailable: true,
          policyId: null, setupComplete: false, kitExported: false,
          backupCheckComplete: false, ready: false,
        },
      }),
    });

    render(
      <UiRoot sender="fullpage">
        <App />
      </UiRoot>,
    );

    await screen.findByRole('heading', { name: 'Settings' });
    fireEvent.click(screen.getByRole('button', { name: 'Open recovery center' }));
    expect(await screen.findByRole('heading', { name: 'Recovery center' })).toBeInTheDocument();
    expect(window.location.hash).toBe(FULLPAGE_HASH.recovery);
    expect(screen.queryByRole('navigation', { name: 'Wallet navigation' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reveal recovery phrase' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Reveal recovery phrase' }))
      .toBeInTheDocument();
    expect(window.location.hash).toBe(FULLPAGE_HASH.reveal);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: 'Recovery center' })).toBeInTheDocument();
    expect(window.location.hash).toBe(FULLPAGE_HASH.recovery);

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(window.location.hash).toBe(FULLPAGE_HASH.settings);
  });
});
