import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreFixturesDir } from '../helpers/core-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GatewayClient } from '@drey/core/gateway-client';
import { getSession } from '../../src/adapters/session/session-store';
import { MemoryWalletCache } from '../../src/adapters/storage/wallet-cache-idb';
import { sealRecord } from '../../src/adapters/storage/wallet-cache';
import type { WalletUtxo } from '@drey/core/domain/classification/types';
import {
  feeQuoteResponseSchema,
  statusCapabilitiesSchema,
  type FeeQuoteResponse,
  type UtxoClassification,
} from '@drey/core/domain/gateway/contract';
import { deriveAccountNode, deriveAddress } from '@drey/core/domain/keys/derivation';
import { mnemonicToSeed } from '@drey/core/domain/keys/mnemonic';
import { publicAccountFromSeed } from '@drey/core/domain/accounts/public-account';
import { scriptPubKeyHex } from '@drey/core/domain/keys/script-hash';
import { feeForVsize } from '@drey/core/domain/transactions/fees';
import { base64ToBytes } from '@drey/core/domain/vault/encoding';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { makeHarness } from './service-helpers';
import { reconcileTrackedTransactionStatus } from '../../src/background/wallet-service';

const fixtures = join(coreFixturesDir, 'gateway');
const status = statusCapabilitiesSchema.parse(
  JSON.parse(readFileSync(join(fixtures, 'status.signed.json'), 'utf8')),
);
const fees = feeQuoteResponseSchema.parse(
  JSON.parse(readFileSync(join(fixtures, 'fees.signed.json'), 'utf8')),
);
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'correct horse battery staple';
const ACCOUNT_ID = publicAccountFromSeed(mnemonicToSeed(MNEMONIC), 'signet', 0).accountId;

beforeAll(async () => { await installTestCryptoProvider(); });

function quoteAt(rate: number, incrementalRelaySatPerKvB: number): FeeQuoteResponse {
  return {
    ...fees,
    incrementalRelaySatPerKvB,
    tiers: fees.tiers.map((tier) => ({
      ...tier,
      rawSatPerKvB: rate,
      effectiveSatPerKvB: rate,
    })) as FeeQuoteResponse['tiers'],
  };
}

async function setupWallet(options: {
  quote: FeeQuoteResponse;
  valueSats?: bigint;
  walletCreatedChange?: boolean;
}) {
  const now = Date.parse(status.timestamp) + 15_000;
  const cache = new MemoryWalletCache();
  const seed = mnemonicToSeed(MNEMONIC);
  const inputAddress = deriveAddress(
    deriveAccountNode(seed, 'payment', 'signet', 0),
    'payment',
    'signet',
    0,
    0,
  );
  const recipient = deriveAddress(
    deriveAccountNode(seed, 'payment', 'signet', 1),
    'payment',
    'signet',
    0,
    0,
  );
  seed.fill(0);
  const classification: UtxoClassification = {
    txid: 'a'.repeat(64),
    vout: 0,
    valueSats: String(options.valueSats ?? 100_000n),
    scriptPubKey: scriptPubKeyHex(inputAddress.publicKeyHex, 'payment', 'signet'),
    confirmations: options.walletCreatedChange ? 0 : 10,
    primaryClass: 'cardinal_clean',
    inscriptions: [],
    satRanges: null,
    unsupportedAssetDetected: false,
    confidence: 'authoritative',
    classifiedTip: status.coreTip,
    classificationRevision: status.activeRevision,
  };
  const pendingTransactionIds = new Set<string>();
  const gateway = {
    endpoint: 'http://fixture-gateway',
    fetchStatus: async () => ({ ok: true as const, status, verifiedAtMs: now }),
    fetchFees: async () => ({ ok: true as const, value: options.quote, verifiedAtMs: now }),
    classifyOutpoints: async () => ({
      ok: true as const,
      value: { ...status, classifications: [classification], unknownOutpoints: [] },
      verifiedAtMs: now,
    }),
    fetchSnapshot: async (request: { scriptHashes: string[] }) => ({
      ok: true as const,
      value: {
        ...status,
        requestedScriptHashes: request.scriptHashes,
        activeScriptHashes: request.scriptHashes,
        historyCoverage: { status: 'complete' as const, limitedScriptHashes: [] },
        utxos: [],
        history: [...pendingTransactionIds].map((txid) => ({
          txid,
          height: null,
          timestamp: null,
          fundedScriptHashes: [],
          spentScriptHashes: request.scriptHashes,
          deltaSats: '-1',
          replacesTxid: null,
          replacedByTxid: null,
          confirmationState: 'mempool' as const,
          feeSats: '1',
          vsize: 1,
          replaceable: true,
          packageFeeSats: '1',
          packageVsize: 1,
          cpfpEligible: false,
        })),
      },
      verifiedAtMs: now,
    }),
    broadcastTransaction: async (request: { txid: string }) => ({
      ok: true as const,
      value: (() => {
        pendingTransactionIds.add(request.txid);
        return {
          ...status,
          submittedTxid: request.txid,
          status: 'accepted' as const,
          txid: request.txid,
          errorCode: null,
          detail: null,
        };
      })(),
      verifiedAtMs: now,
    }),
  } as unknown as GatewayClient;
  const harness = makeHarness(now, {
    network: 'signet',
    gateway,
    walletCache: cache,
  });
  const { vaultId } = await harness.service.restore({
    name: 'fee recovery',
    password: PASSWORD,
    mnemonic: MNEMONIC,
  });
  const unlocked = await harness.service.unlock({ vaultId, password: PASSWORD });
  const expectation = {
    expectedVaultId: vaultId,
    expectedSessionId: unlocked.sessionId,
    accountId: ACCOUNT_ID,
  };
  const session = await getSession(harness.session);
  if (!session) throw new Error('missing session');
  const dek = base64ToBytes(session.dekB64);
  const walletUtxo: WalletUtxo = {
    accountId: ACCOUNT_ID,
    outpoint: { txid: classification.txid, vout: 0 },
    valueSats: BigInt(classification.valueSats),
    scriptPubKey: classification.scriptPubKey,
    account: 0,
    lane: 'payment',
    chain: 0,
    addressIndex: 0,
    height: options.walletCreatedChange ? null : 249_991,
    walletCreatedChange: options.walletCreatedChange ?? false,
    facts: {
      primaryClass: classification.primaryClass,
      inscriptions: [],
      satRanges: null,
      unsupportedAssetDetected: false,
      confidence: 'authoritative',
      classifiedTip: status.coreTip,
      classificationRevision: status.activeRevision,
    },
    flags: { userFrozen: false, dustQuarantined: false },
  };
  await cache.put(sealRecord(
    dek,
    [walletUtxo],
    { vaultId, network: 'signet', type: 'utxos', key: 'a0:payment' },
    new Uint8Array(24).fill(1),
    now,
  ));
  await cache.put(sealRecord(
    dek,
    {
      lastCompletedScanId: 'scan',
      lastSyncedAt: now,
      revision: status.activeRevision,
      hasConflictingSources: false,
    },
    { vaultId, network: 'signet', type: 'accountsMeta', key: 'all' },
    new Uint8Array(24).fill(2),
    now,
  ));
  dek.fill(0);
  return {
    harness, cache, vaultId, expectation, recipient, walletUtxo, now,
    pendingTransactionIds,
  };
}

async function replaceCachedUtxos(
  setup: Awaited<ReturnType<typeof setupWallet>>,
  utxos: WalletUtxo[],
) {
  const session = await getSession(setup.harness.session);
  if (!session) throw new Error('missing session');
  const dek = base64ToBytes(session.dekB64);
  await setup.cache.put(sealRecord(
    dek,
    utxos,
    { vaultId: setup.vaultId, network: 'signet', type: 'utxos', key: 'a0:payment' },
    new Uint8Array(24).fill(4),
    setup.now,
  ));
  dek.fill(0);
}

async function seedCpfpHistory(
  setup: Awaited<ReturnType<typeof setupWallet>>,
  packageFeeSats: bigint,
) {
  const session = await getSession(setup.harness.session);
  if (!session) throw new Error('missing session');
  const dek = base64ToBytes(session.dekB64);
  await setup.cache.put(sealRecord(
    dek,
    [{
      txid: setup.walletUtxo.outpoint.txid,
      height: null,
      timestamp: null,
      fundedScriptHashes: [],
      spentScriptHashes: [],
      deltaSats: '100000',
      replacesTxid: null,
      replacedByTxid: null,
      confirmationState: 'mempool',
      feeSats: packageFeeSats.toString(),
      vsize: 200,
      replaceable: true,
      packageFeeSats: packageFeeSats.toString(),
      packageVsize: 200,
      cpfpEligible: true,
    }],
    { vaultId: setup.vaultId, network: 'signet', type: 'history', key: 'a0:payment' },
    new Uint8Array(24).fill(3),
    setup.now,
  ));
  dek.fill(0);
}

describe('transaction fee recovery arithmetic', () => {
  it('prices CPFP against the total package vsize in sat/kvB without a 1000x unit error', async () => {
    const setup = await setupWallet({
      quote: fees,
      walletCreatedChange: true,
      valueSats: 100_000n,
    });
    await seedCpfpHistory(setup, 200n);

    const planned = await setup.harness.service.createTransactionPlan({
      kind: 'cpfp',
      account: 0,
      txid: setup.walletUtxo.outpoint.txid,
      fee: { type: 'automatic', tier: 'recommended' },
      ...setup.expectation,
    });
    const vsize = BigInt(planned.review.vsize);
    const feeRate = BigInt(planned.review.feeRateSatPerKvB);
    const packageTarget = feeForVsize(200n + vsize, feeRate) - 200n;
    expect(planned.review.feeSats).toBe(
      String(packageTarget > feeForVsize(vsize, feeRate)
        ? packageTarget
        : feeForVsize(vsize, feeRate)),
    );
  });

  it('uses the standalone child fee when the parent package already exceeds the target', async () => {
    const setup = await setupWallet({
      quote: fees,
      walletCreatedChange: true,
      valueSats: 100_000n,
    });
    await seedCpfpHistory(setup, 10_000n);

    const planned = await setup.harness.service.createTransactionPlan({
      kind: 'cpfp',
      account: 0,
      txid: setup.walletUtxo.outpoint.txid,
      fee: { type: 'automatic', tier: 'recommended' },
      ...setup.expectation,
    });
    expect(planned.review.feeSats).toBe(String(feeForVsize(
      BigInt(planned.review.vsize),
      BigInt(planned.review.feeRateSatPerKvB),
    )));
  });

  it('uses the signed incremental relay rate for automatic RBF replacements', async () => {
    const setup = await setupWallet({ quote: quoteAt(1_000, 2_500) });
    const original = await setup.harness.service.createTransactionPlan({
      kind: 'native_send',
      account: 0,
      recipient: setup.recipient.address,
      amountSats: '50000',
      sendMax: false,
      fee: { type: 'custom', rateSatPerVb: '1' },
      ...setup.expectation,
    });
    const accepted = await setup.harness.service.approveTransaction({
      planId: original.planId,
      planHash: original.planHash,
      ...setup.expectation,
    });
    expect(accepted.status).toBe('accepted');
    if (!accepted.txid) throw new Error('missing accepted transaction id');

    const replacement = await setup.harness.service.createTransactionPlan({
      kind: 'rbf',
      account: 0,
      txid: accepted.txid,
      fee: { type: 'automatic', tier: 'recommended' },
      ...setup.expectation,
    });
    const replacementVsize = BigInt(replacement.review.vsize);
    expect(replacement.review.feeSats).toBe(String(
      BigInt(original.review.feeSats) + feeForVsize(replacementVsize, 2_500n),
    ));
  });

  it('retains a conservative 1 sat/vB incremental floor for custom RBF replacements', async () => {
    const setup = await setupWallet({ quote: quoteAt(1_000, 2_500) });
    const original = await setup.harness.service.createTransactionPlan({
      kind: 'native_send',
      account: 0,
      recipient: setup.recipient.address,
      amountSats: '50000',
      sendMax: false,
      fee: { type: 'custom', rateSatPerVb: '1' },
      ...setup.expectation,
    });
    const accepted = await setup.harness.service.approveTransaction({
      planId: original.planId,
      planHash: original.planHash,
      ...setup.expectation,
    });
    expect(accepted.status).toBe('accepted');
    if (!accepted.txid) throw new Error('missing accepted transaction id');

    const replacement = await setup.harness.service.createTransactionPlan({
      kind: 'rbf',
      account: 0,
      txid: accepted.txid,
      fee: { type: 'custom', rateSatPerVb: '1' },
      ...setup.expectation,
    });
    const replacementVsize = BigInt(replacement.review.vsize);
    expect(replacement.review.feeSats).toBe(String(
      BigInt(original.review.feeSats) + feeForVsize(replacementVsize, 1_000n),
    ));
  });

  it('replaces a pending wallet transaction after its spent inputs leave the UTXO snapshot', async () => {
    const setup = await setupWallet({ quote: quoteAt(2_000, 1_000) });
    const original = await setup.harness.service.createTransactionPlan({
      kind: 'native_send',
      account: 0,
      recipient: setup.recipient.address,
      amountSats: '50000',
      sendMax: false,
      fee: { type: 'custom', rateSatPerVb: '1' },
      ...setup.expectation,
    });
    const accepted = await setup.harness.service.approveTransaction({
      planId: original.planId,
      planHash: original.planHash,
      ...setup.expectation,
    });
    if (!accepted.txid) throw new Error('missing accepted transaction id');

    await replaceCachedUtxos(setup, []);

    const replacement = await setup.harness.service.createTransactionPlan({
      kind: 'rbf',
      account: 0,
      txid: accepted.txid,
      fee: { type: 'custom', rateSatPerVb: '2' },
      ...setup.expectation,
    });
    expect(replacement.review.recipients).toEqual(original.review.recipients);
    expect(replacement.review.inputs).toEqual(original.review.inputs);
    expect(BigInt(replacement.review.feeSats)).toBeGreaterThan(BigInt(original.review.feeSats));

    const replaced = await setup.harness.service.approveTransaction({
      planId: replacement.planId,
      planHash: replacement.planHash,
      ...setup.expectation,
    });
    expect(replaced.status).toBe('accepted');
    expect(reconcileTrackedTransactionStatus('accepted', 'mempool', true)).toBe('replaced');
    expect(reconcileTrackedTransactionStatus('accepted', 'confirmed', true)).toBe('confirmed');
    expect(reconcileTrackedTransactionStatus('accepted', 'mempool', false)).toBe('accepted');
  });

  it('fails closed when fresh signed history no longer reports the parent as pending', async () => {
    const setup = await setupWallet({ quote: quoteAt(2_000, 1_000) });
    const original = await setup.harness.service.createTransactionPlan({
      kind: 'native_send',
      account: 0,
      recipient: setup.recipient.address,
      amountSats: '50000',
      sendMax: false,
      fee: { type: 'custom', rateSatPerVb: '1' },
      ...setup.expectation,
    });
    const accepted = await setup.harness.service.approveTransaction({
      planId: original.planId,
      planHash: original.planHash,
      ...setup.expectation,
    });
    if (!accepted.txid) throw new Error('missing accepted transaction id');
    setup.pendingTransactionIds.clear();
    await replaceCachedUtxos(setup, []);

    await expect(setup.harness.service.createTransactionPlan({
      kind: 'rbf',
      account: 0,
      txid: accepted.txid,
      fee: { type: 'custom', rateSatPerVb: '2' },
      ...setup.expectation,
    })).rejects.toMatchObject({ code: 'ERR_NOT_ACCELERATABLE' });
  });

  it('uses exact sub-sat sat/kvB input when calculating UTXO effective value', async () => {
    const setup = await setupWallet({ quote: fees });
    const listed = await setup.harness.service.listUtxos({
      feeRateSatPerKvB: 100,
      ...setup.expectation,
    });
    expect(listed.utxos[0]?.effectiveValueSats).toBe('99993');
  });
});
