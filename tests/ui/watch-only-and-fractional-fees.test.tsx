import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountSelector } from '../../src/ui/components/AccountSelector';
import { Transactions, parseCustomFeeInput } from '../../src/entrypoints/fullpage/Transactions';
import type { SessionView } from '../../src/ui/hooks/use-session';
import { installFakeChrome, Providers } from './fake-rpc';

const SOFTWARE_ID = `acct_mainnet_${'1'.repeat(64)}`;
const WATCH_ID = `acct_mainnet_${'2'.repeat(64)}`;
const SESSION_ID = '00000000-0000-4000-8000-000000000001';

afterEach(cleanup);

describe('watch-only and fractional-fee UI boundaries', () => {
  it('preserves exact fractional sat/vB authority', () => {
    expect(parseCustomFeeInput('1.001')).toEqual({
      normalizedSatPerVb: '1.001', satPerKvB: 1_001n,
    });
    expect(parseCustomFeeInput('9999.999')?.satPerKvB).toBe(9_999_999n);
    expect(parseCustomFeeInput('1.000')).toEqual({
      normalizedSatPerVb: '1', satPerKvB: 1_000n,
    });
    expect(parseCustomFeeInput('0.999')).toBeNull();
    expect(parseCustomFeeInput('1.0001')).toBeNull();
  });

  it('sends the unchanged decimal fee text across the plan boundary', async () => {
    const plans: unknown[] = [];
    installFakeChrome({
      'fees.quote': () => ({
        ok: true,
        result: {
          prioritySatPerKvB: 5_000,
          standardSatPerKvB: 3_000,
          economySatPerKvB: 2_000,
          floorSatPerKvB: 1_000,
          sampledAt: '2026-08-04T12:00:00.000Z',
          expiresAt: '2026-08-04T12:02:00.000Z',
        },
      }),
      'transaction.plan': (payload) => {
        plans.push(payload);
        return { ok: false, code: 'ERR_INTERNAL' };
      },
    });
    render(
      <Providers>
        <Transactions
          expectedVaultId="vault-1"
          expectedSessionId={SESSION_ID}
          accountId={SOFTWARE_ID}
          capabilities={{
            signMethod: 'software', canView: true, canDeriveAddresses: true,
            canPlanTransactions: true, canSignTransactions: true, canSignMessages: true,
            canBroadcast: true, canExposeToProviders: true, canUseMarketplaces: true,
            canBuildUnsignedPsbt: true, canSignPsbt: true, canSignBip322: true,
            canRevealSeed: true, canExportPublicAccount: false, canVerifyAddress: false,
          }}
          initialSection="send"
          initialAccount={0}
          onNavigate={() => undefined}
        />
      </Providers>,
    );
    await screen.findByText('3 sat/vB');
    fireEvent.click(screen.getByRole('radio', { name: /Custom/ }));
    fireEvent.change(screen.getByLabelText('Fee rate (sat/vB)'), {
      target: { value: '1.001' },
    });
    fireEvent.change(screen.getByLabelText('Recipient address or BIP-321 URI'), {
      target: { value: 'bc1qrecipient' },
    });
    fireEvent.change(screen.getByLabelText('Amount (BTC)'), { target: { value: '0.00001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review transaction' }));
    await waitFor(() => expect(plans).toHaveLength(1));
    expect(plans[0]).toMatchObject({
      accountId: SOFTWARE_ID,
      fee: { type: 'custom', rateSatPerVb: '1.001' },
    });
  });

  it('labels watch-only accounts and switches by stable account ID', async () => {
    const requests: unknown[] = [];
    installFakeChrome({
      'account.active.set': (payload) => {
        requests.push(payload);
        return { accountId: WATCH_ID, account: 7 };
      },
    });
    const session: SessionView = {
      state: 'ready',
      activeVaultId: 'vault-1',
      preferredUnlockVaultId: 'vault-1',
      vaults: [{ vaultId: 'vault-1', name: 'Main' }],
      expectation: { expectedVaultId: 'vault-1', expectedSessionId: SESSION_ID },
      deadline: Date.now() + 60_000,
      quarantinedVaultCount: 0,
      activeAccountId: SOFTWARE_ID,
      activeAccount: 0,
      selectableAccounts: [0],
      accountSummaries: [
        { accountId: SOFTWARE_ID, account: 0, name: 'Everyday', signingSource: 'software' },
        { accountId: WATCH_ID, account: 7, name: 'Cold observer', signingSource: 'none' },
      ],
      accountAddState: null,
      activeRecoveredAddressCount: 0,
      backupDeferred: false,
      capabilities: {
        signMethod: 'software', canView: true, canDeriveAddresses: true,
        canPlanTransactions: true, canSignTransactions: true, canSignMessages: true,
        canBroadcast: true, canExposeToProviders: true, canUseMarketplaces: true,
        canBuildUnsignedPsbt: true, canSignPsbt: true, canSignBip322: true,
        canRevealSeed: true, canExportPublicAccount: false, canVerifyAddress: false,
      },
      refresh: () => undefined,
    };
    render(<Providers><AccountSelector session={session} /></Providers>);
    fireEvent.click(screen.getByRole('button', { name: 'Active account' }));
    expect(screen.getByText('Watch-only')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Cold observer/ }));
    await waitFor(() => expect(requests).toContainEqual({
      accountId: WATCH_ID,
      expectedVaultId: 'vault-1',
      expectedSessionId: SESSION_ID,
    }));
  });
});
