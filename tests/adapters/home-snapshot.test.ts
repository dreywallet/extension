import { describe, expect, it } from 'vitest';
import type { WalletHomeResult } from '@drey/core/messaging/ops';
import {
  HOME_SNAPSHOT_KEY,
  clearBoundHomeSnapshot,
  loadHomeSnapshot,
  saveHomeSnapshot,
  type HomeSnapshotBinding,
} from '../../src/adapters/session/home-snapshot';
import { makeFakeArea } from './fake-area';

const binding: HomeSnapshotBinding = {
  vaultId: 'vault-a',
  sessionId: '11111111-1111-4111-8111-111111111111',
  accountId: `acct_mainnet_${'1'.repeat(64)}`,
};

function home(accountId = binding.accountId): WalletHomeResult {
  return {
    accountId,
    balances: {
      availableSats: '1000', protectedSats: '2000', reservedSats: '0',
      pendingSats: '0', pendingOrdinalSats: '0', frozenSats: '0', unavailableCleanSats: '0',
    },
    protectionBreakdown: {
      assetSats: '2000', awaitingClassificationSats: '0',
      userFrozenSats: '0', dustQuarantinedSats: '0',
    },
    collectiblesCount: 1,
    pendingOrdinalCount: 0,
    wrongLaneCount: 0,
    dataGating: { state: 'fresh', blockedActions: [] },
    activity: [],
    wrongLane: [],
    lastSyncedAt: 1,
    scan: {
      kind: 'completed', scanId: 'scan-1', unitsDone: 1, unitsTotal: 1,
      currentUnit: null, boundaryUnits: [], failureReason: null,
    },
  };
}

describe('Home session snapshot', () => {
  it('round-trips only for the exact vault/session/account binding', async () => {
    const area = makeFakeArea();
    await saveHomeSnapshot(area, binding, home());
    await expect(loadHomeSnapshot(area, binding)).resolves.toEqual(home());

    await expect(loadHomeSnapshot(area, {
      ...binding,
      accountId: `acct_mainnet_${'2'.repeat(64)}`,
    })).resolves.toBeNull();
    expect(area.store.has(HOME_SNAPSHOT_KEY)).toBe(false);
  });

  it('self-repairs malformed or internally mismatched records', async () => {
    const area = makeFakeArea();
    await area.set({ [HOME_SNAPSHOT_KEY]: { vaultId: binding.vaultId, home: 'not-home' } });
    await expect(loadHomeSnapshot(area, binding)).resolves.toBeNull();
    expect(area.store.has(HOME_SNAPSHOT_KEY)).toBe(false);

    await expect(saveHomeSnapshot(area, binding, home(
      `acct_mainnet_${'2'.repeat(64)}`,
    ))).rejects.toThrow();
  });

  it('does not let a late failed request clear a newer identity snapshot', async () => {
    const area = makeFakeArea();
    const next = {
      vaultId: 'vault-b',
      sessionId: '22222222-2222-4222-8222-222222222222',
      accountId: `acct_mainnet_${'2'.repeat(64)}`,
    };
    await saveHomeSnapshot(area, next, home(next.accountId));
    await clearBoundHomeSnapshot(area, binding);
    await expect(loadHomeSnapshot(area, next)).resolves.toEqual(home(next.accountId));

    await clearBoundHomeSnapshot(area, next);
    expect(area.store.has(HOME_SNAPSHOT_KEY)).toBe(false);
  });
});
