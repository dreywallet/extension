import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Home } from '../../src/entrypoints/popup/Home';
import type { GatewayStatusView } from '@drey/core/domain/gateway/status-view';
import type { WalletHomeResult } from '@drey/core/messaging/ops';
import { UiRoot } from '../../src/ui/UiRoot';
import { UI_PREFS_KEY } from '../../src/adapters/storage/keys';
import { installFakeChrome } from './fake-rpc';

const ACCOUNT_ID = `acct_mainnet_${'1'.repeat(64)}`;

afterEach(cleanup);

const gateway: GatewayStatusView = {
  state: 'connected',
  network: 'signet',
  mode: 'full_sat_safety',
  missingProtections: [],
  tipHeight: 250000,
  verifiedAtMs: 1,
  ageMs: 0,
  lastReason: null,
};

const home: WalletHomeResult = {
  accountId: ACCOUNT_ID,
  balances: {
    availableSats: '205556',
    protectedSats: '10000',
    reservedSats: '0',
    pendingSats: '1234',
    frozenSats: '0',
    unavailableCleanSats: '0',
  },
  protectionBreakdown: {
    assetSats: '10000',
    awaitingClassificationSats: '0',
    userFrozenSats: '0',
    dustQuarantinedSats: '0',
  },
  collectiblesCount: 0,
  wrongLaneCount: 0,
  dataGating: { state: 'fresh', blockedActions: [] },
  activity: [{
    txid: 'a'.repeat(64),
    deltaSats: '123456',
    feeSats: null,
    confirmationState: 'confirmed',
    timestamp: '2026-07-19T12:00:00.000Z',
    height: 249900,
  }],
  wrongLane: [],
  lastSyncedAt: 1_752_969_600_000,
  scan: {
    kind: 'completed',
    scanId: 'scan-1',
    unitsDone: 2,
    unitsTotal: 2,
    currentUnit: null,
    boundaryUnits: [],
    failureReason: null,
  },
};

function UnitExample() {
  return (
    <Home activeAccountId={ACCOUNT_ID}
      gateway={gateway}
      expectation={{
        expectedVaultId: 'vault-1',
        expectedSessionId: '00000000-0000-4000-8000-000000000001',
      }}
      onReceive={() => undefined}
    />
  );
}

describe('display amount units', () => {
  it('switches every home amount to BTC and restores the preference after remount', async () => {
    const storage = installFakeChrome({
      'wallet.home': () => ({ ok: true, result: home }),
    });
    storage.set(UI_PREFS_KEY, { accent: 'white', activityUnit: 'sats', language: 'en' });

    const first = render(
      <UiRoot sender="popup">
        <UnitExample />
      </UiRoot>,
    );
    expect(await screen.findByText('205,556 sats')).toBeInTheDocument();
    expect(screen.getByText('10,000 sats')).toBeInTheDocument();
    expect(screen.getByText('1,234 sats')).toBeInTheDocument();
    expect(await screen.findByText(/\+123,456 sats/u)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'BTC' }));
    expect(screen.getByText('0.00205556 BTC')).toBeInTheDocument();
    expect(screen.getByText('0.0001 BTC')).toBeInTheDocument();
    expect(screen.getByText('0.00001234 BTC')).toBeInTheDocument();
    expect(screen.getByText(/\+0\.00123456 BTC/u)).toBeInTheDocument();
    await waitFor(() => {
      expect(storage.get(UI_PREFS_KEY)).toMatchObject({ activityUnit: 'btc' });
    });

    first.unmount();
    render(
      <UiRoot sender="popup">
        <UnitExample />
      </UiRoot>,
    );
    expect(await screen.findByText('0.00205556 BTC')).toBeInTheDocument();
    expect(await screen.findByText(/\+0\.00123456 BTC/u)).toBeInTheDocument();
  });

  it('hides portfolio amounts without hiding send decisions and persists the device preference', async () => {
    const storage = installFakeChrome({
      'wallet.home': () => ({ ok: true, result: home }),
    });
    const first = render(
      <UiRoot sender="popup">
        <UnitExample />
      </UiRoot>,
    );
    expect(await screen.findByText('205,556 sats')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Hide balances' }));
    expect(screen.queryByText('205,556 sats')).toBeNull();
    expect(screen.queryByText(/123,456/u)).toBeNull();
    expect(screen.getAllByText('••••').length).toBeGreaterThan(2);
    expect(screen.getByRole('button', { name: 'Show balances' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await waitFor(() => {
      expect(storage.get(UI_PREFS_KEY)).toMatchObject({ hidePortfolioAmounts: true });
    });

    first.unmount();
    render(
      <UiRoot sender="popup">
        <UnitExample />
      </UiRoot>,
    );
    expect(await screen.findByRole('button', { name: 'Show balances' })).toBeInTheDocument();
    expect(screen.queryByText('205,556 sats')).toBeNull();
  });
});
