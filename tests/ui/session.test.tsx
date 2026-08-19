import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { ACTIVE_VAULT_KEY } from '../../src/adapters/storage/keys';
import { useSession } from '../../src/ui/hooks/use-session';
import { emitRuntimeMessage, installFakeChrome, Providers } from './fake-rpc';

afterEach(cleanup);

const READY = {
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
  backupVerified: true,
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

function Probe(): ReactNode {
  const session = useSession();
  return (
    <div>
      <span data-testid="state">{session.state}</span>
      <span data-testid="active">{session.activeVaultId ?? 'none'}</span>
      <span data-testid="preferred">{session.preferredUnlockVaultId ?? 'none'}</span>
      <span data-testid="account">{session.activeAccount}</span>
      <span data-testid="recovered">{session.activeRecoveredAddressCount}</span>
    </div>
  );
}

describe('useSession', () => {
  it('uses one coherent snapshot for routing', async () => {
    let calls = 0;
    installFakeChrome({
      'session.snapshot': () => {
        calls += 1;
        return { ok: true, result: READY };
      },
    });
    render(
      <Providers>
        <Probe />
      </Providers>,
    );
    expect(await screen.findByText('ready')).toBeInTheDocument();
    expect(screen.getByTestId('active')).toHaveTextContent('vault-1');
    expect(screen.getByTestId('recovered')).toHaveTextContent('0');
    expect(calls).toBe(1);
  });

  it('routes an unverified descriptor-only account to its read-only wallet', async () => {
    installFakeChrome({
      'session.snapshot': () => ({
        ok: true,
        result: {
          ...READY,
          backupVerified: false,
          activeAccountId: `acct_mainnet_${'2'.repeat(64)}`,
          accountSummaries: [{
            accountId: `acct_mainnet_${'2'.repeat(64)}`,
            account: 7,
            name: 'Cold observer',
            signingSource: 'none',
          }],
          capabilities: {
            ...READY.capabilities,
            signMethod: 'none',
            canSignTransactions: false,
            canSignMessages: false,
            canBroadcast: false,
            canExposeToProviders: false,
            canUseMarketplaces: false,
            canSignPsbt: false,
            canSignBip322: false,
            canRevealSeed: false,
            canExportPublicAccount: true,
          },
        },
      }),
    });
    render(<Providers><Probe /></Providers>);
    expect(await screen.findByTestId('state')).toHaveTextContent('ready');
  });

  it('shows an error rather than treating an RPC failure as an empty profile', async () => {
    installFakeChrome({ 'session.snapshot': () => ({ ok: false, code: 'ERR_INTERNAL' }) });
    render(
      <Providers>
        <Probe />
      </Providers>,
    );
    expect(await screen.findByText('error')).toBeInTheDocument();
  });

  it('exposes a valid stored wallet only as the locked UI preference', async () => {
    const storage = installFakeChrome({
      'session.snapshot': () => ({
        ok: true,
        result: {
          ...READY,
          vaults: [
            ...READY.vaults,
            { vaultId: 'vault-2', name: 'Cold', createdAt: 2 },
          ],
          locked: true,
          activeVaultId: null,
          sessionId: null,
          deadline: null,
        },
      }),
    });
    storage.set(ACTIVE_VAULT_KEY, 'vault-2');
    render(<Providers><Probe /></Providers>);

    expect(await screen.findByTestId('state')).toHaveTextContent('locked');
    expect(screen.getByTestId('active')).toHaveTextContent('none');
    expect(screen.getByTestId('preferred')).toHaveTextContent('vault-2');
  });

  it('ignores dangling preferences and tolerates preference read failures', async () => {
    const storage = installFakeChrome({
      'session.snapshot': () => ({
        ok: true,
        result: { ...READY, locked: true, activeVaultId: null, sessionId: null, deadline: null },
      }),
    });
    storage.set(ACTIVE_VAULT_KEY, 'removed-vault');
    render(<Providers><Probe /></Providers>);
    expect(await screen.findByTestId('state')).toHaveTextContent('locked');
    expect(screen.getByTestId('preferred')).toHaveTextContent('none');

    cleanup();
    installFakeChrome({
      'session.snapshot': () => ({
        ok: true,
        result: { ...READY, locked: true, activeVaultId: null, sessionId: null, deadline: null },
      }),
    });
    chrome.storage.local.get = () => Promise.reject(new Error('storage unavailable'));
    render(<Providers><Probe /></Providers>);
    expect(await screen.findByTestId('state')).toHaveTextContent('locked');
    expect(screen.getByTestId('preferred')).toHaveTextContent('none');
  });

  it('redacts immediately when the worker announces a lock', async () => {
    let locked = false;
    installFakeChrome({
      'session.snapshot': () => ({
        ok: true,
        result: locked
          ? {
              ...READY,
              locked: true,
              activeVaultId: null,
              sessionId: null,
              deadline: null,
              backupVerified: false,
              capabilities: {
                signMethod: 'none',
                canBuildUnsignedPsbt: false,
                canSignPsbt: false,
                canSignBip322: false,
                canRevealSeed: false,
                canExportPublicAccount: false,
                canVerifyAddress: false,
              },
            }
          : READY,
      }),
    });
    render(
      <Providers>
        <Probe />
      </Providers>,
    );
    expect(await screen.findByText('ready')).toBeInTheDocument();

    locked = true;
    act(() => emitRuntimeMessage({ type: 'squirrel:session-state-changed', locked: true }));
    expect(screen.getByTestId('state')).toHaveTextContent('locked');
    expect(screen.getByTestId('active')).toHaveTextContent('none');
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('locked'));
  });

  it('refreshes the selected account after a worker mutation event', async () => {
    let activeAccount = 0;
    let activeRecoveredAddressCount = 0;
    let calls = 0;
    installFakeChrome({
      'session.snapshot': () => {
        calls += 1;
        return {
          ok: true,
          result: { ...READY, activeAccount, activeRecoveredAddressCount },
        };
      },
    });
    render(
      <Providers>
        <Probe />
      </Providers>,
    );
    expect(await screen.findByTestId('account')).toHaveTextContent('0');

    activeAccount = 3;
    activeRecoveredAddressCount = 2;
    act(() => emitRuntimeMessage({ type: 'squirrel:wallet-data-changed', reason: 'account' }));
    await waitFor(() => expect(screen.getByTestId('account')).toHaveTextContent('3'));
    expect(screen.getByTestId('recovered')).toHaveTextContent('2');
    expect(calls).toBe(2);

    act(() => emitRuntimeMessage({ type: 'squirrel:wallet-data-changed', reason: 'transaction' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
  });

  it('preserves the expectation object when a refresh stays in the same session', async () => {
    let calls = 0;
    let expectationChanges = 0;
    installFakeChrome({
      'session.snapshot': () => {
        calls += 1;
        return { ok: true, result: { ...READY, activeAccount: calls - 1 } };
      },
    });
    function ExpectationProbe(): ReactNode {
      const session = useSession();
      const expectation = session.expectation;
      useEffect(() => {
        if (expectation !== null) expectationChanges += 1;
      }, [expectation]);
      return <span>{session.activeAccount}</span>;
    }
    render(<Providers><ExpectationProbe /></Providers>);
    expect(await screen.findByText('0')).toBeInTheDocument();
    await waitFor(() => expect(expectationChanges).toBe(1));

    act(() => emitRuntimeMessage({ type: 'squirrel:wallet-data-changed', reason: 'account' }));
    expect(await screen.findByText('1')).toBeInTheDocument();
    expect(calls).toBe(2);
    expect(expectationChanges).toBe(1);
  });
});
