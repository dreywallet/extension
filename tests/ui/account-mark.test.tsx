import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { accountMark } from '../../src/ui/account-mark';
import { AccountMark } from '../../src/ui/components/AccountMark';
import { AccountSelector } from '../../src/ui/components/AccountSelector';
import type { SessionView } from '../../src/ui/hooks/use-session';
import { App } from '../../src/entrypoints/popup/App';
import { installFakeChrome, Providers } from './fake-rpc';

afterEach(cleanup);

// Shaped like the real `acct_<network>_<sha256>` ids built by
// core's `accountIdFor`, so the geometry is exercised on realistic seeds.
const ACCOUNT_A = `acct_mainnet_${'a3f1'.repeat(16)}`;
const ACCOUNT_B = `acct_mainnet_${'7c20'.repeat(16)}`;

describe('account mark geometry', () => {
  it('is deterministic for a seed', () => {
    expect(accountMark(ACCOUNT_A)).toEqual(accountMark(ACCOUNT_A));
  });

  it('distinguishes accounts, including ones sharing a long prefix', () => {
    expect(accountMark(ACCOUNT_A).path).not.toEqual(accountMark(ACCOUNT_B).path);
    // The network segment alone must change the mark: the same seed phrase on
    // signet and mainnet are different accounts and must not look identical.
    expect(accountMark(`acct_signet_${'a3f1'.repeat(16)}`).path)
      .not.toEqual(accountMark(ACCOUNT_A).path);
  });

  it('mirrors horizontally so the shape reads as an object', () => {
    const mark = accountMark(ACCOUNT_A);
    for (let y = 0; y < mark.size; y += 1) {
      for (let x = 0; x < mark.size; x += 1) {
        expect(mark.cells[y * mark.size + x])
          .toBe(mark.cells[y * mark.size + (mark.size - 1 - x)]);
      }
    }
  });

  it('never renders a blank or solid square', () => {
    // Sweep enough seeds to cover the uniform-grid guard.
    for (let index = 0; index < 500; index += 1) {
      const filled = accountMark(`acct_mainnet_${index}`).cells.filter(Boolean).length;
      expect(filled).toBeGreaterThan(0);
      expect(filled).toBeLessThan(25);
    }
  });

  it('survives an empty seed rather than throwing', () => {
    expect(accountMark('').path).not.toBe('');
  });
});

describe('account mark rendering', () => {
  it('emits no image source, so it renders under the approval page CSP', () => {
    const { container } = render(<AccountMark seed={ACCOUNT_A} />);

    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(container.querySelector('image')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain('url(');
    expect(container.innerHTML).not.toContain('data:');
  });

  it('is decorative unless it is given an accessible name', () => {
    const { container } = render(<AccountMark seed={ACCOUNT_A} />);

    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('svg')).not.toHaveAttribute('role', 'img');
  });

  it('names itself only when asked to', () => {
    render(<AccountMark seed={ACCOUNT_A} label="Account 1" />);

    expect(screen.getByRole('img', { name: 'Account 1' })).toBeInTheDocument();
  });

  it('takes its fill from the surrounding text colour, never a semantic colour', () => {
    const { container } = render(<AccountMark seed={ACCOUNT_A} />);
    const path = container.querySelector('path');

    // Identity, not state: the mark must not carry danger/warning/success.
    expect(path).not.toHaveAttribute('fill');
    expect(path?.getAttribute('class')).toMatch(/cells/u);
  });
});

describe('placement: marks disambiguate, never decorate', () => {
  const selectorSession = (
    accountSummaries: SessionView['accountSummaries'],
  ): SessionView => ({
    state: 'ready',
    activeVaultId: 'vault-1',
    preferredUnlockVaultId: 'vault-1',
    vaults: [{ vaultId: 'vault-1', name: 'Main' }],
    expectation: { expectedVaultId: 'vault-1', expectedSessionId: 'session-1' },
    deadline: Date.now() + 60_000,
    quarantinedVaultCount: 0,
    activeAccountId: ACCOUNT_A,
    activeAccount: 0,
    selectableAccounts: accountSummaries.map((account) => account.account),
    accountSummaries,
    accountAddState: null,
    activeRecoveredAddressCount: 0,
    capabilities: {
      signMethod: 'software', canView: true, canDeriveAddresses: true,
      canPlanTransactions: true, canSignTransactions: true, canSignMessages: true,
      canBroadcast: true, canExposeToProviders: true, canUseMarketplaces: true,
      canBuildUnsignedPsbt: true, canSignPsbt: true, canSignBip322: true,
      canRevealSeed: true, canExportPublicAccount: false, canVerifyAddress: false,
    },
    refresh: () => undefined,
  });

  it('shows a mark per menu row when there is something to tell apart', () => {
    installFakeChrome({});
    const { container } = render(
      <Providers>
        <AccountSelector session={selectorSession([
          { accountId: ACCOUNT_A, account: 0, name: 'Main', signingSource: 'software' },
          { accountId: ACCOUNT_B, account: 1, name: 'Second', signingSource: 'software' },
        ])} />
      </Providers>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Active account' }));
    expect(container.querySelectorAll('[role="menuitemradio"] path[class*="cells"]'))
      .toHaveLength(2);
    // Never on the always-visible trigger: a constant glyph habituates into
    // furniture, and the header is the popup's most contested space.
    expect(screen.getByRole('button', { name: 'Active account' }).querySelector('svg'))
      .toBeNull();
  });

  it('shows no mark anywhere while only one account exists', () => {
    installFakeChrome({});
    const { container } = render(
      <Providers>
        <AccountSelector session={selectorSession([
          { accountId: ACCOUNT_A, account: 0, name: 'Main', signingSource: 'software' },
        ])} />
      </Providers>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Active account' }));
    expect(screen.getByRole('menuitemradio', { name: 'Main' })).toBeInTheDocument();
    expect(container.querySelector('path[class*="cells"]')).toBeNull();
  });
});

describe('locked privacy (§7.5)', () => {
  it('shows no account mark on the locked popup', async () => {
    // The snapshot deliberately still carries account data while locked, which
    // is what the worker really returns — `use-session` copies it straight
    // through. Nothing may paint it: a stable per-account glyph identifies the
    // account as surely as the address §7.5 already withholds.
    installFakeChrome({
      'session.snapshot': () => ({
        ok: true,
        result: {
          locked: true,
          activeVaultId: null,
          sessionId: null,
          deadline: null,
          highSecurityMode: false,
          backupVerified: true,
          vaults: [{ vaultId: 'vault-1', name: 'Main', createdAt: 0 }],
          quarantinedVaultCount: 0,
          activeAccountId: ACCOUNT_A,
          activeAccount: 0,
          selectableAccounts: [0],
          accountSummaries: [
            { accountId: ACCOUNT_A, account: 0, name: 'Main', signingSource: 'software' },
            { accountId: ACCOUNT_B, account: 1, name: 'Second', signingSource: 'software' },
          ],
          accountAddState: null,
          activeRecoveredAddressCount: 0,
          capabilities: {
            canView: false, canDeriveAddresses: false, canPlanTransactions: false,
            canSignTransactions: false, canSignMessages: false, canBroadcast: false,
            canExposeToProviders: false, canUseMarketplaces: false,
            signMethod: 'none', canBuildUnsignedPsbt: false, canSignPsbt: false,
            canSignBip322: false, canRevealSeed: false, canExportPublicAccount: false,
            canVerifyAddress: false,
          },
        },
      }),
    });

    const { container } = render(<Providers><App /></Providers>);

    // Assert the locked screen specifically, not merely "some branch rendered":
    // the brand mark appears on the loading and error branches too, so waiting
    // on it alone would let a schema-invalid fake pass this test silently.
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Unlock Drey' })).toBeInTheDocument());
    // Matched on the emitted CSS-module class and viewBox rather than a
    // component name: the bundler rewrites `styles['cells']` to `_cells_<hash>`,
    // so a filename selector would pass whether or not the mark rendered.
    expect(container.querySelector('path[class*="cells"]')).not.toBeInTheDocument();
    expect(container.querySelector('svg[viewBox="0 0 5 5"]')).not.toBeInTheDocument();
  });
});
