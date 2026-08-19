import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CommunityVault } from '../../src/entrypoints/fullpage/CommunityVault';
import { installFakeChrome, Providers } from './fake-rpc';
import type { CommunityVaultSummary } from '../../src/messaging/community-vault-ops';

const EXPECTATION = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};

const CAMPAIGN_ROOT = {
  version: 1 as const,
  masterFingerprintHex: '01020304',
  originPath: 'm' as const,
  campaignXpub: `xpub${'1'.repeat(107)}`,
};

const RECOVERY_WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function owner(overrides: Partial<CommunityVaultSummary> = {}): CommunityVaultSummary {
  return {
    campaignId: 'cp_123',
    ownerId: 'owner_456',
    label: 'OMB #123',
    createdAt: 1,
    campaignRoot: CAMPAIGN_ROOT,
    recoveryConfirmed: false,
    policyId: null,
    capTableHash: null,
    units: [],
    mode: null,
    readiness: 'needs-recovery',
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

describe('Community Vault setup handoff', () => {
  it('prefills public campaign details supplied by a connected site', async () => {
    window.history.replaceState(
      {},
      '',
      '/fullpage.html?communityCampaignId=cp_123&communityOwnerId=owner_456&communityLabel=OMB+%23123#/settings/community-vault',
    );
    installFakeChrome({
      'communityVault.status': () => ({
        ok: true,
        result: { owners: [], unusableCampaignIds: [] },
      }),
    });

    render(
      <Providers>
        <CommunityVault expectation={EXPECTATION} onBack={() => undefined} />
      </Providers>,
    );

    expect(await screen.findByRole('heading', { name: 'Join a campaign' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Campaign ID' })).toHaveValue('cp_123');
    expect(screen.getByRole('textbox', { name: 'Owner ID' })).toHaveValue('owner_456');
    expect(screen.getByRole('textbox', { name: 'Name (optional)' })).toHaveValue('OMB #123');
    expect(screen.getByRole('button', { name: 'Enter password to continue' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Drey password'), { target: { value: 'password' } });
    expect(screen.getByRole('button', { name: 'Create owner key' })).toBeEnabled();
  });

  it('shows only the recovery step while setup is unfinished', async () => {
    installFakeChrome({
      'communityVault.status': () => ({
        ok: true,
        result: { owners: [owner()], unusableCampaignIds: [] },
      }),
    });

    render(
      <Providers>
        <CommunityVault expectation={EXPECTATION} onBack={() => undefined} />
      </Providers>,
    );

    expect(await screen.findByRole('heading', { name: '1. Secure your owner key' })).toBeVisible();
    expect(screen.getByText('Step 1 of 2')).toBeVisible();
    expect(screen.queryByText('Your units')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy public enrollment details' })).not.toBeInTheDocument();
    expect(screen.queryByText('Final cap table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join another campaign' })).not.toBeInTheDocument();
  });

  it('reveals recovery words before asking for the confirmation and a fresh password', async () => {
    installFakeChrome({
      'communityVault.status': () => ({
        ok: true,
        result: { owners: [owner()], unusableCampaignIds: [] },
      }),
      'communityVault.revealRecovery': () => ({
        ok: true,
        result: { mnemonic: RECOVERY_WORDS },
      }),
    });

    render(
      <Providers>
        <CommunityVault expectation={EXPECTATION} onBack={() => undefined} />
      </Providers>,
    );

    await screen.findByRole('heading', { name: '1. Secure your owner key' });
    fireEvent.change(screen.getByLabelText('Drey password'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show recovery words' }));

    expect(await screen.findByText(RECOVERY_WORDS)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Show recovery words' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify recovery' })).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox', { name: 'Re-enter all recovery words' }), {
      target: { value: RECOVERY_WORDS },
    });
    expect(screen.getByRole('button', { name: 'Verify recovery' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Drey password'), { target: { value: 'password' } });
    expect(screen.getByRole('button', { name: 'Verify recovery' })).toBeEnabled();
  });

  it('makes the Gallery handoff primary after recovery and keeps the later cap table collapsed', async () => {
    installFakeChrome({
      'communityVault.status': () => ({
        ok: true,
        result: {
          owners: [owner({ recoveryConfirmed: true, readiness: 'needs-policy' })],
          unusableCampaignIds: [],
        },
      }),
    });

    render(
      <Providers>
        <CommunityVault expectation={EXPECTATION} onBack={() => undefined} />
      </Providers>,
    );

    expect(await screen.findByRole('heading', { name: 'Owner key secured' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Copy setup for Gallery' })).toBeVisible();
    expect(screen.getByText(/private key and recovery words stay in Drey/u)).toBeVisible();
    expect(screen.queryByText('Your units')).not.toBeInTheDocument();

    const later = screen.getByText('Final cap table');
    expect(later).toBeVisible();
    expect(screen.getByRole('heading', { name: '2. Accept the final cap table' })).not.toBeVisible();
    fireEvent.click(later);
    expect(screen.getByRole('heading', { name: '2. Accept the final cap table' })).toBeVisible();
  });
});
