/**
 * A deferred-backup reminder opens onboarding with #backup. It must resume the
 * phrase backup directly, never the Create/Restore welcome where the obvious
 * next click makes a second wallet.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { App } from '../../src/entrypoints/onboarding/App';
import { BACKUP_INTENT_HASH } from '../../src/ui/backup-reminder';
import { installFakeChrome, Providers } from './fake-rpc';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

const DEFERRED = {
  vaults: [{ vaultId: 'vault-1', name: 'Main', createdAt: 1 }],
  quarantinedVaultCount: 0,
  locked: false,
  activeVaultId: 'vault-1',
  sessionId: '00000000-0000-4000-8000-000000000001',
  deadline: Date.now() + 60_000,
  highSecurityMode: false,
  activeAccountId: `acct_mainnet_${'1'.repeat(64)}`,
  activeAccount: 0,
  selectableAccounts: [0],
  accountSummaries: [{
    accountId: `acct_mainnet_${'1'.repeat(64)}`,
    account: 0,
    name: 'Account 1',
    signingSource: 'software',
  }],
  accountAddState: null,
  activeRecoveredAddressCount: 0,
  backupVerified: false,
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
    canSignBip322: false,
    canRevealSeed: true,
    canExportPublicAccount: false,
    canVerifyAddress: false,
  },
};

function renderOnboarding(hash: string): void {
  window.history.replaceState(null, '', `/onboarding.html${hash}`);
  installFakeChrome({
    'session.snapshot': () => ({ ok: true, result: DEFERRED }),
    'backup.deferralStatus': () => ({ ok: true, result: { deferred: true } }),
  });
  render(<Providers><App /></Providers>);
}

describe('onboarding backup intent', () => {
  it('opens the phrase review for a deferred backup reached from the reminder', async () => {
    renderOnboarding(BACKUP_INTENT_HASH);
    expect(await screen.findByRole('heading', { name: 'Reveal recovery phrase' })).toBeInTheDocument();
    expect(screen.getByLabelText('App password')).toBeInTheDocument();
    expect(screen.queryByText(/Create a new wallet/iu)).not.toBeInTheDocument();
  });

  it('keeps the ordinary welcome for Add wallet on a deferred profile', async () => {
    renderOnboarding('');
    expect(await screen.findByRole('heading', { name: 'Welcome to Drey' })).toBeInTheDocument();
  });
});
