import { describe, expect, it } from 'vitest';
import { approvalSnapshotSchema } from '../../src/provider/approval';

const BITCOIN_MAX_SATS = '2100000000000000';
const OVER_BITCOIN_MAX_SATS = '2100000000000001';
const U64_MAX = '18446744073709551615';
const OVER_U64_MAX = '18446744073709551616';

function transactionFields(overrides: Record<string, unknown> = {}) {
  return {
    authorization: 'complete',
    feeSats: '500',
    walletInputSats: '10500',
    walletOutputSats: '0',
    externalOutputSats: '10000',
    netWalletDebitSats: '10500',
    economicClaims: [],
    outputs: [{
      index: 0,
      address: 'tb1qrecipient',
      valueSats: '10000',
      ownership: 'external',
      role: 'recipient',
      committed: true,
    }],
    ...overrides,
  };
}

function transactionReview(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'transaction',
    walletName: 'Primary wallet',
    account: 0,
    network: 'signet',
    ...transactionFields(),
    ...overrides,
  };
}

function batchReview(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'batch',
    walletName: 'Primary wallet',
    account: 0,
    network: 'signet',
    transactionCount: 1,
    walletInputSats: '10500',
    walletOutputSats: '0',
    netWalletDebitSats: '10500',
    feeExposureSats: '500',
    transactions: [{ index: 0, ...transactionFields() }],
    ...overrides,
  };
}

function snapshot(method: string, review: unknown) {
  return {
    type: 'drey:approval:snapshot',
    protocolVersion: 1,
    request: {
      requestNonce: '123e4567-e89b-42d3-a456-426614174000',
      method,
      origin: 'https://app.example',
      unicodeOrigin: 'https://app.example',
      warnings: [],
      createdAt: 1,
      expiresAt: 300_001,
      approveAfter: 1,
      review,
      details: {},
      requiresPassword: false,
      confirmationPhrase: null,
      approvalError: null,
    },
  };
}

function branch(nodeId: string, overrides: Record<string, unknown> = {}) {
  return {
    nodeId,
    guaranteedWalletReturnSats: '9500',
    maximumWalletDebitSats: '500',
    ...overrides,
  };
}

function linkedReview(overrides: Record<string, unknown> = {}) {
  return batchReview({
    transactionCount: 3,
    linked: true,
    maximumWalletDebitSats: '500',
    maximumFeeExposureSats: '500',
    branchEconomicsExact: true,
    sharedFundingConflictCount: 1,
    alternativeOutcomeGroups: [{
      settlements: [branch('settlement')],
      recovery: branch('recovery'),
    }],
    transactions: Array.from({ length: 3 }, (_, index) => ({
      index,
      ...transactionFields(),
    })),
    ...overrides,
  });
}

describe('provider approval schema', () => {
  it('requires transaction methods and reviews to use matching shapes', () => {
    for (const method of ['signPsbt', 'bitcoin_signPsbtV2', 'signTransaction',
      'sendTransfer', 'ord_sendInscriptions']) {
      expect(approvalSnapshotSchema.safeParse(snapshot(method, transactionReview())).success).toBe(true);
      expect(approvalSnapshotSchema.safeParse(snapshot(method, batchReview())).success).toBe(false);
    }
    expect(approvalSnapshotSchema.safeParse(
      snapshot('signMultipleTransactions', batchReview()),
    ).success).toBe(true);
    expect(approvalSnapshotSchema.safeParse(
      snapshot('signMultipleTransactions', transactionReview()),
    ).success).toBe(false);
    expect(approvalSnapshotSchema.safeParse(
      snapshot('signPsbt', { kind: 'message', walletName: 'Wallet', account: 0,
        network: 'signet', address: 'tb1qaddress', message: 'hello' }),
    ).success).toBe(false);
  });

  it('bounds per-transaction amounts to Bitcoin supply and aggregates to signed or unsigned u64', () => {
    expect(approvalSnapshotSchema.safeParse(snapshot('signPsbt', transactionReview({
      feeSats: BITCOIN_MAX_SATS,
      walletInputSats: BITCOIN_MAX_SATS,
      netWalletDebitSats: `-${BITCOIN_MAX_SATS}`,
      economicClaims: [{ kind: 'miner_fee', valueSats: BITCOIN_MAX_SATS }],
      outputs: [{
        index: 0, address: null, valueSats: BITCOIN_MAX_SATS,
        ownership: 'unproven', role: 'unknown', committed: true,
      }],
    }))).success).toBe(true);
    for (const review of [
      transactionReview({ feeSats: OVER_BITCOIN_MAX_SATS }),
      transactionReview({ netWalletDebitSats: `-${OVER_BITCOIN_MAX_SATS}` }),
      transactionReview({ economicClaims: [{ kind: 'miner_fee', valueSats: OVER_BITCOIN_MAX_SATS }] }),
      transactionReview({ outputs: [{
        index: 0, address: null, valueSats: OVER_BITCOIN_MAX_SATS,
        ownership: 'unproven', role: 'unknown', committed: true,
      }] }),
    ]) {
      expect(approvalSnapshotSchema.safeParse(snapshot('signPsbt', review)).success).toBe(false);
    }
    expect(approvalSnapshotSchema.safeParse(snapshot('signMultipleTransactions', batchReview({
      walletInputSats: U64_MAX,
      walletOutputSats: U64_MAX,
      netWalletDebitSats: `-${U64_MAX}`,
      feeExposureSats: U64_MAX,
    }))).success).toBe(true);
    for (const review of [
      batchReview({ walletInputSats: OVER_U64_MAX }),
      batchReview({ netWalletDebitSats: `-${OVER_U64_MAX}` }),
      batchReview({ netWalletDebitSats: '-0' }),
      batchReview({ feeExposureSats: '01' }),
    ]) {
      expect(approvalSnapshotSchema.safeParse(
        snapshot('signMultipleTransactions', review),
      ).success).toBe(false);
    }
  });

  it('requires complete, unique, and bounded linked outcome groups', () => {
    expect(approvalSnapshotSchema.safeParse(
      snapshot('signMultipleTransactions', linkedReview()),
    ).success).toBe(true);
    expect(approvalSnapshotSchema.safeParse(snapshot('signMultipleTransactions', batchReview({
      linked: false,
      maximumWalletDebitSats: '10500',
      maximumFeeExposureSats: '500',
      branchEconomicsExact: true,
      sharedFundingConflictCount: 0,
      alternativeOutcomeGroups: [],
    }))).success).toBe(true);
    for (const review of [
      linkedReview({ alternativeOutcomeGroups: undefined }),
      linkedReview({ alternativeOutcomeGroups: [{ settlements: [], recovery: branch('recovery') }] }),
      linkedReview({ alternativeOutcomeGroups: [{
        settlements: [branch('same')], recovery: branch('same'),
      }] }),
      linkedReview({ alternativeOutcomeGroups: [
        { settlements: [branch('settlement')], recovery: branch('recovery') },
        { settlements: [branch('settlement')], recovery: branch('recovery') },
      ] }),
      linkedReview({ alternativeOutcomeGroups: [{
        settlements: [branch('one'), branch('two'), branch('three')],
        recovery: branch('four'),
      }] }),
      linkedReview({ alternativeOutcomeGroups: [{
        settlements: [branch('settlement', { guaranteedWalletReturnSats: OVER_BITCOIN_MAX_SATS })],
        recovery: branch('recovery'),
      }] }),
      linkedReview({
        alternativeOutcomeGroups: Array.from({ length: 501 }, (_, index) => ({
          settlements: [branch(`settlement-${index}`)],
          recovery: branch(`recovery-${index}`),
        })),
      }),
      batchReview({ alternativeOutcomeGroups: [{
        settlements: [branch('hidden-settlement')],
        recovery: branch('hidden-recovery'),
      }] }),
    ]) {
      expect(approvalSnapshotSchema.safeParse(
        snapshot('signMultipleTransactions', review),
      ).success).toBe(false);
    }
  });
});
