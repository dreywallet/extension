import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreFixturesDir } from '../helpers/core-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GatewayClient } from '@drey/core/gateway-client';
import { getSession } from '../../src/adapters/session/session-store';
import { MemoryWalletCache } from '../../src/adapters/storage/wallet-cache-idb';
import { openRecord, sealRecord } from '../../src/adapters/storage/wallet-cache';
import { storedPlanSchema } from '@drey/core/scan/cache-schemas';
import type { WalletUtxo } from '@drey/core/domain/classification/types';
import {
  statusCapabilitiesSchema,
  feeQuoteResponseSchema,
  type BroadcastRequest,
  type InscriptionApprovalBatchRequest,
  type UtxoClassification,
} from '@drey/core/domain/gateway/contract';
import { deriveAccountNode, deriveAddress } from '@drey/core/domain/keys/derivation';
import { mnemonicToSeed } from '@drey/core/domain/keys/mnemonic';
import { publicAccountFromSeed } from '@drey/core/domain/accounts/public-account';
import { scriptPubKeyHex } from '@drey/core/domain/keys/script-hash';
import { base64ToBytes, bytesToBase64, hexToBytes } from '@drey/core/domain/vault/encoding';
import { SigHash, Transaction } from '@scure/btc-signer';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { signAndValidatePlan, validateSignedTransactionHex } from '@drey/core/domain/transactions/signing';
import { providerPsbtUnsignedTxid } from '@drey/core/domain/transactions/provider-psbt-batch';
import type { TransactionPlanRequest } from '@drey/core/messaging/ops';
import { makeHarness } from './service-helpers';

const fixtures = join(coreFixturesDir, 'gateway');
const status = statusCapabilitiesSchema.parse(JSON.parse(readFileSync(join(fixtures, 'status.signed.json'), 'utf8')));
const fees = feeQuoteResponseSchema.parse(JSON.parse(readFileSync(join(fixtures, 'fees.signed.json'), 'utf8')));
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'correct horse battery staple';
const ACCOUNT_ID = publicAccountFromSeed(mnemonicToSeed(MNEMONIC), 'signet', 0).accountId;

beforeAll(async () => { await installTestCryptoProvider(); });

describe('M7 indeterminate broadcast recovery', () => {
  it('persists exact bytes but never automatically replays them across rebuild()', async () => {
    const cache = new MemoryWalletCache();
    const broadcasts: string[] = [];
    let fail = true;
    let feeRate = fees.tiers[0].effectiveSatPerKvB;
    let currentStatus = status;
    let classificationStatus = status;
    let advanceStatusAfterRequest = false;
    const walletChanges: string[] = [];
    const seed = mnemonicToSeed(MNEMONIC);
    const inputAddress = deriveAddress(deriveAccountNode(seed, 'payment', 'signet', 0), 'payment', 'signet', 0, 0);
    const recipient = deriveAddress(deriveAccountNode(seed, 'payment', 'signet', 1), 'payment', 'signet', 0, 0);
    seed.fill(0);
    const classification: UtxoClassification = {
      txid: 'a'.repeat(64), vout: 0, valueSats: '100000',
      scriptPubKey: scriptPubKeyHex(inputAddress.publicKeyHex, 'payment', 'signet'), confirmations: 10,
      primaryClass: 'cardinal_clean', inscriptions: [], satRanges: null,
      unsupportedAssetDetected: false, confidence: 'authoritative',
      classifiedTip: status.coreTip, classificationRevision: status.activeRevision,
    };
    const now = Date.parse(status.timestamp) + 15_000;
    let statusRequests = 0;
    let feeRequests = 0;
    let classificationRequests = 0;
    const gateway = {
      endpoint: 'http://fixture-gateway',
      fetchStatus: async () => {
        statusRequests += 1;
        const returnedStatus = currentStatus;
        if (advanceStatusAfterRequest) {
          currentStatus = classificationStatus;
          advanceStatusAfterRequest = false;
        }
        return { ok: true as const, status: returnedStatus, verifiedAtMs: now };
      },
      fetchFees: async () => {
        feeRequests += 1;
        return { ok: true as const, value: {
          ...fees,
          sampledAt: new Date(now + 1_000).toISOString(),
          expiresAt: new Date(now + 121_000).toISOString(),
          tiers: [{ ...fees.tiers[0], rawSatPerKvB: feeRate, effectiveSatPerKvB: feeRate }, fees.tiers[1], fees.tiers[2]],
        }, verifiedAtMs: now };
      },
      classifyOutpoints: async () => {
        classificationRequests += 1;
        return { ok: true as const, value: {
          ...classificationStatus,
          classifications: [{ ...classification, classifiedTip: classificationStatus.coreTip }],
          unknownOutpoints: [],
        }, verifiedAtMs: now };
      },
      broadcastTransaction: async (request: { transactionHex: string; txid: string }) => {
        broadcasts.push(request.transactionHex);
        if (fail) return { ok: false as const, reason: 'network_error' as const };
        return { ok: true as const, value: { ...status, submittedTxid: request.txid,
          status: 'accepted' as const, txid: request.txid, errorCode: null, detail: null },
          verifiedAtMs: now };
      },
    } as unknown as GatewayClient;
    const harness = makeHarness(now, {
      network: 'signet', gateway, walletCache: cache,
      notifyWalletDataChanged: (reason) => walletChanges.push(reason),
    });
    const { vaultId } = await harness.service.restore({ name: 'recovery', password: PASSWORD, mnemonic: MNEMONIC });
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
      outpoint: { txid: classification.txid, vout: 0 }, valueSats: 100_000n,
      scriptPubKey: classification.scriptPubKey,
      account: 0, lane: 'payment', chain: 0,
      addressIndex: 0, height: 249_991, walletCreatedChange: false,
      facts: { primaryClass: classification.primaryClass, inscriptions: [], satRanges: null,
        unsupportedAssetDetected: false, confidence: 'authoritative', classifiedTip: status.coreTip,
        classificationRevision: status.activeRevision },
      flags: { userFrozen: false, dustQuarantined: false },
    };
    await cache.put(sealRecord(dek, [walletUtxo], { vaultId, network: 'signet', type: 'utxos', key: 'a0:payment' }, new Uint8Array(24).fill(1), now));
    await cache.put(sealRecord(dek, { lastCompletedScanId: 'scan', lastSyncedAt: now,
      revision: status.activeRevision, hasConflictingSources: false },
    { vaultId, network: 'signet', type: 'accountsMeta', key: 'all' }, new Uint8Array(24).fill(2), now));
    dek.fill(0);

    type NativeRequest = Extract<TransactionPlanRequest, { kind: 'native_send' }>;
    const request = (overrides: Partial<NativeRequest> = {}): NativeRequest => ({
      kind: 'native_send' as const,
      account: 0,
      recipient: recipient.address,
      amountSats: '50000',
      sendMax: false,
      fee: { type: 'automatic' as const, tier: 'recommended' as const },
      ...expectation,
      ...overrides,
    });
    await expect(harness.service.resolvePaymentInstruction({
      input: recipient.address,
      ...expectation,
    })).resolves.toEqual({
      address: recipient.address,
      amountSats: null,
      label: null,
      message: null,
    });
    const paymentUri = `BITCOIN:${recipient.address}?AmOuNt=0.0005&LaBeL=Receiver` +
      '&MeSsAgE=Invoice&pop=https%3A%2F%2Fevil.example%2Fcallback&lightning=ln-ignored';
    await expect(harness.service.resolvePaymentInstruction({
      input: paymentUri,
      ...expectation,
    })).resolves.toEqual({
      address: recipient.address,
      amountSats: '50000',
      label: 'Receiver',
      message: 'Invoice',
    });
    await expect(harness.service.resolvePaymentInstruction({
      input: 'bitcoin:?lightning=ln-unsupported',
      ...expectation,
    })).rejects.toMatchObject({ code: 'ERR_UNSUPPORTED_PAYMENT_METHOD' });
    await expect(harness.service.resolvePaymentInstruction({
      input: `bitcoin:${recipient.address}?req-pop=https%3A%2F%2Fevil.example`,
      ...expectation,
    })).rejects.toMatchObject({ code: 'ERR_INVALID_PAYMENT_INSTRUCTION' });
    await expect(harness.service.resolvePaymentInstruction({
      input: 'bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      ...expectation,
    })).rejects.toMatchObject({ code: 'ERR_INVALID_ADDRESS' });
    expect(statusRequests).toBe(0);
    expect(feeRequests).toBe(0);
    expect(broadcasts).toHaveLength(0);
    await expect(harness.service.createTransactionPlan(request({ recipient: 'not-an-address' })))
      .rejects.toMatchObject({ code: 'ERR_INVALID_ADDRESS' });
    await expect(harness.service.createTransactionPlan(request({
      recipient: 'tb1zqyqszqgpqyqszqgpqyqszqgpqyqszqgpdxnudk',
    }))).rejects.toMatchObject({ code: 'ERR_UNSUPPORTED_ADDRESS' });
    await expect(harness.service.createTransactionPlan(request({ amountSats: '293' })))
      .rejects.toMatchObject({ code: 'ERR_OUTPUT_DUST' });
    await expect(harness.service.createTransactionPlan(request({ amountSats: '1000000' })))
      .rejects.toMatchObject({ code: 'ERR_INSUFFICIENT_FUNDS' });
    await expect(harness.service.createTransactionPlan(request({
      selectedOutpoints: [{ txid: 'b'.repeat(64), vout: 0 }],
    }))).rejects.toMatchObject({ code: 'ERR_INSUFFICIENT_FUNDS' });
    statusRequests = 0;
    feeRequests = 0;
    const planned = await harness.service.createTransactionPlan(request({ recipient: paymentUri }));
    expect(statusRequests).toBe(1);
    expect(feeRequests).toBe(1);
    const plannedSession = await getSession(harness.session);
    if (!plannedSession) throw new Error('missing planned session');
    const plannedDek = base64ToBytes(plannedSession.dekB64);
    const encryptedPlan = await cache.get({
      vaultId, network: 'signet', type: 'plans', key: planned.planId,
    });
    if (!encryptedPlan) throw new Error('missing encrypted native-send plan');
    const storedPlan = openRecord(plannedDek, encryptedPlan, storedPlanSchema);
    plannedDek.fill(0);
    if (storedPlan.version !== 4) throw new Error('native-send plan version changed');
    expect(storedPlan.policy.intent).toMatchObject({
      kind: 'native_send',
      recipient: recipient.address,
    });
    expect(storedPlan.outputs.find(({ role }) => role === 'payment_change')?.derivation)
      .toMatchObject({ account: 0, lane: 'payment', chain: 1, index: 3 });
    feeRate += 1000;
    const statusBeforeFeeReview = statusRequests;
    const classificationsBeforeFeeReview = classificationRequests;
    const changed = await harness.service.approveTransaction({ planId: planned.planId,
      planHash: planned.planHash, ...expectation });
    expect(changed.status).toBe('review_required');
    if (changed.status !== 'review_required') throw new Error('expected replacement review');
    expect(changed.replacement.review.feeRateSatPerKvB).toBe(String(feeRate));
    expect(statusRequests).toBe(statusBeforeFeeReview + 1);
    expect(classificationRequests).toBe(classificationsBeforeFeeReview + 1);
    expect(broadcasts).toHaveLength(0);
    const feeReplacement = changed.replacement;
    feeRate -= 1000;
    const advancedTip = { height: status.coreTip.height + 1, hash: 'b'.repeat(64) };
    classificationStatus = {
      ...status,
      timestamp: new Date(now + 2_000).toISOString(),
      serverTime: new Date(now + 2_000).toISOString(),
      mempoolObservedAt: new Date(now + 1_000).toISOString(),
      coreTip: advancedTip,
      indexTip: advancedTip,
      historyTip: advancedTip,
      ordTip: advancedTip,
    };
    // Model the production ordering that previously caused a repeat loop: the
    // classification response has advanced, while the concurrently requested
    // status response returns the prior tip once before catching up.
    advanceStatusAfterRequest = true;
    const statusBeforeSourceReview = statusRequests;
    const classificationsBeforeSourceReview = classificationRequests;
    const sourceChanged = await harness.service.approveTransaction({
      planId: feeReplacement.planId,
      planHash: feeReplacement.planHash,
      ...expectation,
    });
    expect(sourceChanged.status).toBe('review_required');
    if (sourceChanged.status !== 'review_required') throw new Error('expected source replacement review');
    expect(statusRequests).toBe(statusBeforeSourceReview + 2);
    expect(classificationRequests).toBe(classificationsBeforeSourceReview + 1);
    const replacement = sourceChanged.replacement;
    const approval = harness.service.approveTransaction({ planId: replacement.planId,
      planHash: replacement.planHash, ...expectation });
    await expect(harness.service.approveTransaction({
      planId: replacement.planId,
      planHash: replacement.planHash,
      ...expectation,
    })).rejects.toMatchObject({ code: 'ERR_PLAN_CHANGED' });
    const approved = await approval;
    expect(approved.status).toBe('pending');
    expect(broadcasts).toHaveLength(1);

    fail = false;
    harness.clock.now += 5_000;
    const restarted = harness.rebuild();
    await restarted.init();
    await restarted.retryBroadcasts();
    expect(broadcasts).toHaveLength(1);
    const final = await restarted.transactionStatus(expectation);
    expect(final.transactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ planId: replacement.planId, status: 'pending', recovering: true }),
    ]));
    await expect(cache.listKeys(vaultId, 'signet', 'broadcastRecovery')).resolves.toEqual([replacement.planId]);
    await expect(cache.listKeys(vaultId, 'signet', 'transactions')).resolves.toEqual([]);

    walletChanges.length = 0;
    const explicitlyRetried = await restarted.approveTransaction({
      planId: replacement.planId,
      planHash: replacement.planHash,
      ...expectation,
    });
    expect(explicitlyRetried.status).toBe('accepted');
    expect(broadcasts).toHaveLength(2);
    expect(walletChanges).toEqual(['transaction']);
    const acceptedStatus = await restarted.transactionStatus(expectation);
    const acceptedTransaction = acceptedStatus.transactions.find((entry) => entry.txid === explicitlyRetried.txid);
    expect(acceptedTransaction).toBeDefined();
    if (!acceptedTransaction) throw new Error('missing accepted transaction');
    const home = await restarted.homeView(expectation);
    expect(home.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        txid: explicitlyRetried.txid,
        deltaSats: (-(BigInt(acceptedTransaction.amountSats) + BigInt(acceptedTransaction.feeSats))).toString(),
        feeSats: acceptedTransaction.feeSats,
        confirmationState: 'mempool',
      }),
    ]));

    const confirmedSession = await getSession(harness.session);
    if (!confirmedSession) throw new Error('missing confirmed session');
    const confirmedDek = base64ToBytes(confirmedSession.dekB64);
    await cache.put(sealRecord(confirmedDek, [{
      txid: explicitlyRetried.txid,
      height: 959_199,
      timestamp: '2026-07-22T23:12:53.000Z',
      fundedScriptHashes: [],
      spentScriptHashes: [],
      deltaSats: (-(BigInt(acceptedTransaction.amountSats) + BigInt(acceptedTransaction.feeSats))).toString(),
      replacesTxid: null,
      replacedByTxid: null,
      confirmationState: 'confirmed',
      feeSats: acceptedTransaction.feeSats,
      vsize: 141,
      replaceable: true,
      packageFeeSats: null,
      packageVsize: null,
      cpfpEligible: false,
    }], { vaultId, network: 'signet', type: 'history', key: 'a0:payment' },
    new Uint8Array(24).fill(12), harness.clock.now));
    confirmedDek.fill(0);

    const reconciled = await restarted.transactionStatus(expectation);
    expect(reconciled.network).toBe('signet');
    expect(reconciled.transactions).toEqual(expect.arrayContaining([
      expect.objectContaining({ txid: explicitlyRetried.txid, status: 'confirmed', recovering: false }),
    ]));
  });

  it('plans and broadcasts an explicit custom fee without requesting estimates', async () => {
    const cache = new MemoryWalletCache();
    const now = Date.parse(status.timestamp) + 15_000;
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
      txid: 'b'.repeat(64),
      vout: 0,
      valueSats: '100000',
      scriptPubKey: scriptPubKeyHex(inputAddress.publicKeyHex, 'payment', 'signet'),
      confirmations: 10,
      primaryClass: 'cardinal_clean',
      inscriptions: [],
      satRanges: null,
      unsupportedAssetDetected: false,
      confidence: 'authoritative',
      classifiedTip: status.coreTip,
      classificationRevision: status.activeRevision,
    };
    let feeRequests = 0;
    let broadcastRequest: BroadcastRequest | null = null;
    const gateway = {
      endpoint: 'http://fixture-gateway',
      fetchStatus: async () => ({ ok: true as const, status, verifiedAtMs: now }),
      fetchFees: async () => {
        feeRequests += 1;
        return { ok: false as const, reason: 'server_error' as const };
      },
      classifyOutpoints: async () => ({ ok: true as const, value: {
        ...status,
        classifications: [classification],
        unknownOutpoints: [],
      }, verifiedAtMs: now }),
      broadcastTransaction: async (request: BroadcastRequest) => {
        broadcastRequest = request;
        return { ok: true as const, value: {
          ...status,
          submittedTxid: request.txid,
          submittedWtxid: request.wtxid,
          status: 'accepted' as const,
          txid: request.txid,
          errorCode: null,
          detail: null,
        }, verifiedAtMs: now };
      },
    } as unknown as GatewayClient;
    const harness = makeHarness(now, { network: 'signet', gateway, walletCache: cache });
    const { vaultId } = await harness.service.restore({
      name: 'custom fee fallback',
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
      valueSats: 100_000n,
      scriptPubKey: classification.scriptPubKey,
      account: 0,
      lane: 'payment',
      chain: 0,
      addressIndex: 0,
      height: 249_991,
      walletCreatedChange: false,
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
      new Uint8Array(24).fill(13),
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
      new Uint8Array(24).fill(14),
      now,
    ));
    dek.fill(0);

    const planned = await harness.service.createTransactionPlan({
      kind: 'native_send',
      account: 0,
      recipient: recipient.address,
      amountSats: '50000',
      sendMax: false,
      fee: { type: 'custom', rateSatPerVb: '2' },
      ...expectation,
    });
    expect(planned.review.feeRateSatPerKvB).toBe('2000');
    expect(feeRequests).toBe(0);

    const approved = await harness.service.approveTransaction({
      planId: planned.planId,
      planHash: planned.planHash,
      ...expectation,
    });
    expect(approved.status).toBe('accepted');
    expect(feeRequests).toBe(0);
    expect(broadcastRequest).toMatchObject({
      network: 'signet',
      customFeeRateSatPerKvB: 2_000,
      status,
    });
    expect(broadcastRequest).not.toHaveProperty('feeQuote');
    expect(broadcastRequest).not.toHaveProperty('feeTarget');
  });
});

describe('M8 provider indeterminate broadcast recovery', () => {
  it('persists exact approved provider bytes without automatic replay across rebuild()', async () => {
    const cache = new MemoryWalletCache();
    const broadcasts: string[] = [];
    let fail = true;
    const now = Date.parse(status.timestamp) + 15_000;
    const derivedSeed = mnemonicToSeed(MNEMONIC);
    const inputAddress = deriveAddress(deriveAccountNode(derivedSeed, 'payment', 'signet', 0), 'payment', 'signet', 0, 0);
    const recipient = deriveAddress(deriveAccountNode(derivedSeed, 'payment', 'signet', 1), 'payment', 'signet', 0, 0);
    const recipientTwo = deriveAddress(deriveAccountNode(derivedSeed, 'payment', 'signet', 2), 'payment', 'signet', 0, 0);
    derivedSeed.fill(0);
    const classification: UtxoClassification = {
      txid: 'c'.repeat(64), vout: 0, valueSats: '100000',
      scriptPubKey: scriptPubKeyHex(inputAddress.publicKeyHex, 'payment', 'signet'), confirmations: 10,
      primaryClass: 'cardinal_clean', inscriptions: [], satRanges: null,
      unsupportedAssetDetected: false, confidence: 'authoritative',
      classifiedTip: status.coreTip, classificationRevision: status.activeRevision,
    };
    const gateway = {
      endpoint: 'http://fixture-gateway',
      fetchStatus: async () => ({ ok: true as const, status, verifiedAtMs: now }),
      fetchFees: async () => ({ ok: true as const, value: fees, verifiedAtMs: now }),
      classifyOutpoints: async () => ({ ok: true as const, value: {
        ...status, classifications: [classification], unknownOutpoints: [],
      }, verifiedAtMs: now }),
      broadcastTransaction: async (request: { transactionHex: string; txid: string }) => {
        broadcasts.push(request.transactionHex);
        if (fail) return { ok: false as const, reason: 'network_error' as const };
        return { ok: true as const, value: { ...status, submittedTxid: request.txid,
          status: 'accepted' as const, txid: request.txid, errorCode: null, detail: null },
          verifiedAtMs: now };
      },
    } as unknown as GatewayClient;
    const harness = makeHarness(now, { network: 'signet', gateway, walletCache: cache });
    const { vaultId } = await harness.service.restore({ name: 'provider recovery', password: PASSWORD, mnemonic: MNEMONIC });
    await harness.service.unlock({ vaultId, password: PASSWORD });
    const session = await getSession(harness.session);
    if (!session) throw new Error('missing session');
    const dek = base64ToBytes(session.dekB64);
    const walletUtxo: WalletUtxo = {
      accountId: ACCOUNT_ID,
      outpoint: { txid: classification.txid, vout: 0 }, valueSats: 100_000n,
      scriptPubKey: classification.scriptPubKey, account: 0, lane: 'payment', chain: 0,
      addressIndex: 0, height: 249_991, walletCreatedChange: false,
      facts: { primaryClass: 'cardinal_clean', inscriptions: [], satRanges: null,
        unsupportedAssetDetected: false, confidence: 'authoritative', classifiedTip: status.coreTip,
        classificationRevision: status.activeRevision },
      flags: { userFrozen: false, dustQuarantined: false },
    };
    await cache.put(sealRecord(dek, [walletUtxo], {
      vaultId, network: 'signet', type: 'utxos', key: 'a0:payment',
    }, new Uint8Array(24).fill(9), now));
    dek.fill(0);
    const plan = await harness.service.providerPrepareTransfer({
      recipients: [
        { address: recipient.address, amount: 40_000 },
        { address: recipientTwo.address, amount: 30_000 },
      ],
      binding: { origin: 'https://app.example', tabId: 1, frameId: 0,
        documentId: '123e4567-e89b-42d3-a456-426614174000',
        requestNonce: '123e4567-e89b-42d3-a456-426614174001', providerMethod: 'sendTransfer' },
    });
    expect(plan.kind).toBe('provider_transfer');
    expect(plan.outputs.filter((output) => output.role === 'recipient')).toHaveLength(2);

    const currentSession = await getSession(harness.session);
    if (!currentSession) throw new Error('missing current session');
    const currentDek = base64ToBytes(currentSession.dekB64);
    walletUtxo.flags.userFrozen = true;
    await cache.put(sealRecord(currentDek, [walletUtxo], {
      vaultId, network: 'signet', type: 'utxos', key: 'a0:payment',
    }, new Uint8Array(24).fill(10), now));
    await expect(harness.service.providerSignPreparedPsbt(plan)).rejects.toMatchObject({ code: 'ERR_UNSAFE_TRANSACTION' });
    walletUtxo.flags.userFrozen = false;
    await cache.put(sealRecord(currentDek, [walletUtxo], {
      vaultId, network: 'signet', type: 'utxos', key: 'a0:payment',
    }, new Uint8Array(24).fill(11), now));
    currentDek.fill(0);

    classification.confidence = 'degraded';
    await expect(harness.service.providerSignPreparedPsbt(plan)).rejects.toMatchObject({ code: 'ERR_DATA_STALE' });
    expect(broadcasts).toHaveLength(0);
    classification.confidence = 'authoritative';

    let staleGuardChecks = 0;
    await expect(harness.service.providerBroadcastPreparedPsbt(plan, undefined, () => {
      staleGuardChecks += 1;
      if (staleGuardChecks === 3) throw new Error('authority became stale');
    })).rejects.toThrow(/authority became stale/u);
    expect(broadcasts).toHaveLength(0);
    await expect(cache.listKeys(vaultId, 'signet', 'providerBroadcastRecovery')).resolves.toEqual([]);

    let guardChecks = 0;
    await expect(harness.service.providerBroadcastPreparedPsbt(
      plan,
      undefined,
      () => { guardChecks += 1; },
    )).rejects.toMatchObject({
      code: 'ERR_BROADCAST_OUTCOME_UNKNOWN',
      message: expect.stringContaining('manual reconciliation'),
    });
    expect(guardChecks).toBe(3);
    expect(broadcasts).toHaveLength(1);
    await expect(cache.listKeys(vaultId, 'signet', 'providerBroadcastRecovery')).resolves.toEqual([plan.planId]);

    fail = false;
    await harness.service.lock();
    const unlockedAgain = await harness.service.unlock({ vaultId, password: PASSWORD });
    expect(unlockedAgain.sessionId).not.toBe(plan.sessionId);
    const restarted = harness.rebuild();
    await restarted.init();
    await restarted.retryProviderBroadcasts();
    expect(broadcasts).toHaveLength(1);
    await expect(cache.listKeys(vaultId, 'signet', 'providerBroadcastRecovery')).resolves.toEqual([plan.planId]);
  });
});

describe('independent provider PSBT batch execution', () => {
  it('prepares every item, signs once atomically, and matches independent single-item results', async () => {
    const cache = new MemoryWalletCache();
    const now = Date.parse(status.timestamp) + 15_000;
    const derivedSeed = mnemonicToSeed(MNEMONIC);
    const input = deriveAddress(
      deriveAccountNode(derivedSeed, 'payment', 'signet', 0), 'payment', 'signet', 0, 0,
    );
    const recipient = deriveAddress(
      deriveAccountNode(derivedSeed, 'payment', 'signet', 1), 'payment', 'signet', 0, 0,
    );
    derivedSeed.fill(0);
    const inputScript = scriptPubKeyHex(input.publicKeyHex, 'payment', 'signet');
    const recipientScript = scriptPubKeyHex(recipient.publicKeyHex, 'payment', 'signet');
    const classifications: UtxoClassification[] = [0, 1].map((index) => ({
      txid: String(index + 1).repeat(64), vout: 0, valueSats: String(100_000 + index * 10_000),
      scriptPubKey: inputScript, confirmations: 10, primaryClass: 'cardinal_clean',
      inscriptions: [], satRanges: null, unsupportedAssetDetected: false,
      confidence: 'authoritative', classifiedTip: status.coreTip,
      classificationRevision: status.activeRevision,
    }));
    const gateway = {
      endpoint: 'http://fixture-gateway',
      fetchStatus: async () => ({ ok: true as const, status, verifiedAtMs: now }),
      classifyOutpoints: async (request: { outpoints: Array<{ txid: string; vout: number }> }) => ({
        ok: true as const,
        value: {
          ...status,
          classifications: request.outpoints.map((outpoint) => classifications.find((item) =>
            item.txid === outpoint.txid && item.vout === outpoint.vout)!),
          unknownOutpoints: [],
        },
        verifiedAtMs: now,
      }),
    } as unknown as GatewayClient;
    const harness = makeHarness(now, { network: 'signet', gateway, walletCache: cache });
    const { vaultId } = await harness.service.restore({
      name: 'batch signing', password: PASSWORD, mnemonic: MNEMONIC,
    });
    await harness.service.unlock({ vaultId, password: PASSWORD });
    const session = await getSession(harness.session);
    if (!session) throw new Error('missing session');
    const dek = base64ToBytes(session.dekB64);
    const walletUtxos: WalletUtxo[] = classifications.map((classification) => ({
      accountId: ACCOUNT_ID,
      outpoint: { txid: classification.txid, vout: classification.vout },
      valueSats: BigInt(classification.valueSats), scriptPubKey: classification.scriptPubKey,
      account: 0, lane: 'payment', chain: 0, addressIndex: 0,
      height: 249_991, walletCreatedChange: false,
      facts: {
        primaryClass: 'cardinal_clean', inscriptions: [], satRanges: null,
        unsupportedAssetDetected: false, confidence: 'authoritative',
        classifiedTip: status.coreTip, classificationRevision: status.activeRevision,
      },
      flags: { userFrozen: false, dustQuarantined: false },
    }));
    await cache.put(sealRecord(dek, walletUtxos, {
      vaultId, network: 'signet', type: 'utxos', key: 'a0:payment',
    }, new Uint8Array(24).fill(12), now));
    dek.fill(0);
    const psbts = classifications.map((classification, index) => {
      const tx = new Transaction({ lowR: true });
      tx.addInput({
        txid: classification.txid, index: 0, sighashType: SigHash.ALL,
        witnessUtxo: { script: hexToBytes(inputScript), amount: BigInt(classification.valueSats) },
      });
      tx.addOutput({
        script: hexToBytes(recipientScript),
        amount: BigInt(classification.valueSats) - BigInt(2_000 + index * 100),
      });
      return bytesToBase64(tx.toPSBT());
    });
    const batchRequest = {
      items: psbts.map((psbtBase64) => ({
        psbtBase64,
        inputsToSign: [{ address: input.address, signingIndexes: [0], sigHash: 1 as const }],
      })),
      binding: {
        origin: 'https://app.example', tabId: 1, frameId: 0,
        documentId: '123e4567-e89b-42d3-a456-426614174000',
        requestNonce: '123e4567-e89b-42d3-a456-426614174009',
        providerMethod: 'signMultipleTransactions' as const,
      },
      approvalGeneration: 9,
    };
    const batch = await harness.service.providerPreparePsbtBatch(batchRequest);
    expect(batch.items).toHaveLength(2);
    expect(batch.aggregate).toMatchObject({ inputs: 2, outputs: 2 });

    let staleChecks = 0;
    await expect(harness.service.providerSignPreparedPsbtBatch(batch, () => {
      staleChecks += 1;
      if (staleChecks === 3) throw new Error('batch approval became stale');
    })).rejects.toThrow(/batch approval became stale/u);
    expect(staleChecks).toBe(3);

    const signed = await harness.service.providerSignPreparedPsbtBatch(batch);
    expect(signed).toHaveLength(2);
    expect(signed.every((item) =>
      Transaction.fromPSBT(base64ToBytes(item.psbtBase64)).getInput(0).partialSig?.length === 1)).toBe(true);
    const independent = [];
    for (const item of batch.items) {
      independent.push(await harness.service.providerSignPreparedPsbt(item.plan, item.requestedInputIndexes));
    }
    expect(signed.map((item) => item.psbtBase64)).toEqual(independent.map((item) => item.psbtBase64));

    const group = await harness.service.providerPreparePsbtGroup({
      items: psbts.map((psbtBase64, index) => ({
        nodeId: `transaction-${index + 1}`,
        psbtBase64,
        inputsToSign: [{ address: input.address, signingIndexes: [0], sigHash: 1 as const }],
        expectedUnsignedTxid: providerPsbtUnsignedTxid(batch.items[index]!.plan),
      })),
      binding: batchRequest.binding,
      approvalGeneration: 10,
    });
    expect(group.signatureRelease).toBe('all_or_nothing');
    expect(group.topology.independent).toBe(true);
    expect(group.items.map((item) => item.expectedUnsignedTxid)).toEqual(
      batch.items.map((item) => providerPsbtUnsignedTxid(item.plan)),
    );
    await expect(harness.service.providerRevalidatePreparedPsbtGroup(group)).resolves.toBeUndefined();

    let groupGuardChecks = 0;
    await expect(harness.service.providerSignPreparedPsbtGroup(group, () => {
      groupGuardChecks += 1;
      if (groupGuardChecks === 3) throw new Error('group approval became stale');
    })).rejects.toThrow(/group approval became stale/u);
    expect(groupGuardChecks).toBe(3);

    const groupSigned = await harness.service.providerSignPreparedPsbtGroup(group);
    expect(groupSigned).toHaveLength(2);
    expect(groupSigned.map((item) => item.psbtBase64)).toEqual(signed.map((item) => item.psbtBase64));
  });
});

describe('M8 provider co-located ordinal partitioning', () => {
  it('routes the target externally, other inscriptions to owned ordinal change, and fees from payment only', async () => {
    const cache = new MemoryWalletCache();
    const now = Date.parse(status.timestamp) + 15_000;
    const derivedSeed = mnemonicToSeed(MNEMONIC);
    const ordinalNode = deriveAccountNode(derivedSeed, 'ordinals', 'signet', 0);
    const paymentNode = deriveAccountNode(derivedSeed, 'payment', 'signet', 0);
    const recipientNode = deriveAccountNode(derivedSeed, 'ordinals', 'signet', 1);
    const wrongNetworkNode = deriveAccountNode(derivedSeed, 'ordinals', 'mainnet', 0);
    const ordinalAddress = deriveAddress(ordinalNode, 'ordinals', 'signet', 0, 0);
    const paymentAddress = deriveAddress(paymentNode, 'payment', 'signet', 0, 0);
    const recipient = deriveAddress(recipientNode, 'ordinals', 'signet', 0, 0);
    const wrongNetworkRecipient = deriveAddress(wrongNetworkNode, 'ordinals', 'mainnet', 0, 0);
    ordinalNode.wipePrivateData();
    paymentNode.wipePrivateData();
    recipientNode.wipePrivateData();
    wrongNetworkNode.wipePrivateData();
    derivedSeed.fill(0);

    const protectedTxid = 'd'.repeat(64);
    const paymentTxid = 'e'.repeat(64);
    const firstCoLocatedId = `${protectedTxid}i0`;
    const secondCoLocatedId = `${protectedTxid}i1`;
    const targetId = `${protectedTxid}i2`;
    const protectedClassification: UtxoClassification = {
      txid: protectedTxid,
      vout: 0,
      valueSats: '50000',
      scriptPubKey: scriptPubKeyHex(ordinalAddress.publicKeyHex, 'ordinals', 'signet'),
      confirmations: 10,
      primaryClass: 'mixed',
      inscriptions: [
        { inscriptionId: firstCoLocatedId, satpoint: `${protectedTxid}:0:0` },
        { inscriptionId: secondCoLocatedId, satpoint: `${protectedTxid}:0:0` },
        { inscriptionId: targetId, satpoint: `${protectedTxid}:0:20000` },
      ],
      satRanges: null,
      unsupportedAssetDetected: false,
      confidence: 'authoritative',
      classifiedTip: status.coreTip,
      classificationRevision: status.activeRevision,
    };
    const paymentClassification: UtxoClassification = {
      txid: paymentTxid,
      vout: 1,
      valueSats: '20000',
      scriptPubKey: scriptPubKeyHex(paymentAddress.publicKeyHex, 'payment', 'signet'),
      confirmations: 10,
      primaryClass: 'cardinal_clean',
      inscriptions: [],
      satRanges: null,
      unsupportedAssetDetected: false,
      confidence: 'authoritative',
      classifiedTip: status.coreTip,
      classificationRevision: status.activeRevision,
    };
    const classifications = new Map([
      [`${protectedTxid}:0`, protectedClassification],
      [`${paymentTxid}:1`, paymentClassification],
    ]);
    let activityMetadataRequests = 0;
    let activityPreviewRequests = 0;
    let activityBatchRequests = 0;
    let feeRate = fees.tiers[0].effectiveSatPerKvB;
    const gateway = {
      endpoint: 'http://fixture-gateway',
      fetchStatus: async () => ({ ok: true as const, status, verifiedAtMs: now }),
      fetchFees: async () => ({
        ok: true as const,
        value: {
          ...fees,
          tiers: [
            {
              ...fees.tiers[0],
              rawSatPerKvB: feeRate,
              effectiveSatPerKvB: feeRate,
            },
            fees.tiers[1],
            fees.tiers[2],
          ],
        },
        verifiedAtMs: now,
      }),
      classifyOutpoints: async (request: { outpoints: Array<{ txid: string; vout: number }> }) => ({
        ok: true as const,
        value: {
          ...status,
          classifications: request.outpoints.map((outpoint) => classifications.get(`${outpoint.txid}:${outpoint.vout}`)!),
          unknownOutpoints: [],
        },
        verifiedAtMs: now,
      }),
      fetchInscriptionApprovalBatch: async (request: InscriptionApprovalBatchRequest) => ({
        ok: true as const,
        value: {
          ...status,
          analysisHash: request.analysisHash,
          psbtHash: request.psbtHash,
          transactionCommitmentHash: request.transactionCommitmentHash,
          effectSetHash: request.effectSetHash,
          items: request.inscriptions.map((identity) => ({
            metadata: {
              ...identity, number: null, contentType: null, contentLength: null,
              confirmations: 10, parent: null, delegate: null, reinscription: false, cursed: false,
            },
            preview: {
              disposition: 'placeholder' as const, reason: 'unavailable' as const,
              requestedInscriptionId: identity.inscriptionId,
              sourceInscriptionId: identity.inscriptionId,
              resolvedInscriptionId: identity.inscriptionId,
              delegateInscriptionId: null, sourceContentSha256: null,
              declaredMime: null, declaredContentLength: null, detectedMime: null,
              detectedFormat: null, sourceContentLength: null,
              policyRevision: 'm9p-preview-v2' as const, rendererRevision: 'test-v1',
              pngSha256: null, pngWidth: null, pngHeight: null, pngByteLength: null,
              bytesBase64: null,
            },
          })),
        },
        verifiedAtMs: now,
      }),
      fetchInscriptionMetadata: async (inscriptionId: string) => {
        activityMetadataRequests += 1;
        return {
          ok: true as const,
          value: {
            metadata: {
              inscriptionId,
              satpoint: `${protectedTxid}:0:20000`,
              outpoint: { txid: protectedTxid, vout: 0 },
              classificationRevision: status.activeRevision,
            },
          },
          verifiedAtMs: now,
        };
      },
      fetchInscriptionPreview: async () => {
        activityPreviewRequests += 1;
        return {
          ok: true as const,
          value: {
            preview: {
              disposition: 'raster' as const,
              bytesBase64: 'aQ==',
              pngSha256: 'f'.repeat(64),
              pngWidth: 1,
              pngHeight: 1,
            },
          },
          verifiedAtMs: now,
        };
      },
      fetchInscriptionActivityBatch: async (request: {
        inscriptionIds: string[];
      }) => {
        activityBatchRequests += 1;
        return {
          ok: true as const,
          value: {
            items: request.inscriptionIds.map((inscriptionId) => ({
              metadata: { inscriptionId },
              preview: {
                disposition: 'raster' as const,
                bytesBase64: 'aQ==',
                pngSha256: 'f'.repeat(64),
                pngWidth: 1,
                pngHeight: 1,
              },
            })),
          },
          verifiedAtMs: now,
        };
      },
    } as unknown as GatewayClient;
    const harness = makeHarness(now, { network: 'signet', gateway, walletCache: cache });
    const { vaultId } = await harness.service.restore({
      name: 'ordinal partition', password: PASSWORD, mnemonic: MNEMONIC,
    });
    await harness.service.unlock({ vaultId, password: PASSWORD });
    const session = await getSession(harness.session);
    if (!session) throw new Error('missing session');
    const dek = base64ToBytes(session.dekB64);
    const protectedUtxo: WalletUtxo = {
      accountId: ACCOUNT_ID,
      outpoint: { txid: protectedTxid, vout: 0 },
      valueSats: 50_000n,
      scriptPubKey: protectedClassification.scriptPubKey,
      account: 0,
      lane: 'ordinals',
      chain: 0,
      addressIndex: 0,
      height: 249_990,
      walletCreatedChange: false,
      facts: {
        primaryClass: protectedClassification.primaryClass,
        inscriptions: protectedClassification.inscriptions,
        satRanges: null,
        unsupportedAssetDetected: false,
        confidence: 'authoritative',
        classifiedTip: status.coreTip,
        classificationRevision: status.activeRevision,
      },
      flags: { userFrozen: false, dustQuarantined: false },
    };
    const paymentUtxo: WalletUtxo = {
      accountId: ACCOUNT_ID,
      outpoint: { txid: paymentTxid, vout: 1 },
      valueSats: 20_000n,
      scriptPubKey: paymentClassification.scriptPubKey,
      account: 0,
      lane: 'payment',
      chain: 0,
      addressIndex: 0,
      height: 249_990,
      walletCreatedChange: false,
      facts: {
        primaryClass: 'cardinal_clean', inscriptions: [], satRanges: null,
        unsupportedAssetDetected: false, confidence: 'authoritative',
        classifiedTip: status.coreTip, classificationRevision: status.activeRevision,
      },
      flags: { userFrozen: false, dustQuarantined: false },
    };
    await cache.put(sealRecord(dek, [protectedUtxo], {
      vaultId, network: 'signet', type: 'utxos', key: 'a0:ordinals',
    }, new Uint8Array(24).fill(12), now));
    await cache.put(sealRecord(dek, [paymentUtxo], {
      vaultId, network: 'signet', type: 'utxos', key: 'a0:payment',
    }, new Uint8Array(24).fill(13), now));
    dek.fill(0);

    const expectation = {
      expectedVaultId: vaultId,
      expectedSessionId: session.sessionId,
      accountId: ACCOUNT_ID,
    };
    const native = await harness.service.createTransactionPlan({
      kind: 'ordinal_transfer',
      account: 0,
      inscriptionId: targetId,
      outpoint: { txid: protectedTxid, vout: 0 },
      recipient: recipient.address,
      fee: { type: 'automatic', tier: 'recommended' },
      ...expectation,
    });
    expect(native.review.kind).toBe('ordinal_transfer');
    expect(native.review.rbf).toBe(false);
    expect(native.review.ordinalAction).toMatchObject({
      action: 'transfer',
      inscriptionId: targetId,
      destination: { address: recipient.address, ownership: 'external' },
      protectedSource: { txid: protectedTxid, vout: 0 },
      retainedInscriptionIds: [firstCoLocatedId, secondCoLocatedId],
      requiresNonTaprootAcknowledgement: false,
    });
    expect(native.review.ordinalAction?.fundingInputs).toEqual([
      expect.objectContaining({ txid: paymentTxid, vout: 1 }),
    ]);
    const nativeSession = await getSession(harness.session);
    if (!nativeSession) throw new Error('missing native plan session');
    const nativeDek = base64ToBytes(nativeSession.dekB64);
    const encryptedNativePlan = await cache.get({
      vaultId,
      network: 'signet',
      type: 'plans',
      key: native.planId,
    });
    if (!encryptedNativePlan) throw new Error('missing encrypted native ordinal plan');
    const nativePlan = openRecord(nativeDek, encryptedNativePlan, storedPlanSchema);
    nativeDek.fill(0);
    if (nativePlan.version !== 4) throw new Error('native ordinal plan version changed');
    const signingSeed = mnemonicToSeed(MNEMONIC);
    const signedNative = signAndValidatePlan(
      nativePlan,
      signingSeed,
      (length) => new Uint8Array(length),
    );
    signingSeed.fill(0);
    expect(() => validateSignedTransactionHex(nativePlan, signedNative.transactionHex)).not.toThrow();
    const activityTxid = 'f'.repeat(64);
    const activitySession = await getSession(harness.session);
    if (!activitySession) throw new Error('missing activity session');
    const activityDek = base64ToBytes(activitySession.dekB64);
    await cache.put(sealRecord(activityDek, {
      planId: nativePlan.planId,
      kind: nativePlan.kind,
      txid: activityTxid,
      createdAt: nativePlan.createdAt,
      amountSats: nativePlan.outputs
        .filter((output) => output.role === 'postage')
        .reduce((sum, output) => sum + output.valueSats, 0n),
      feeSats: nativePlan.feeSats,
      status: 'accepted',
      detail: null,
      parentTxid: nativePlan.parentTxid,
      replacesTxid: nativePlan.replacesTxid,
      plan: nativePlan,
    }, {
      vaultId,
      network: 'signet',
      type: 'transactions',
      key: activityTxid,
    }, new Uint8Array(24).fill(20), now));
    await cache.put(sealRecord(activityDek, [{
      txid: protectedTxid,
      height: 249_990,
      timestamp: '2026-07-20T12:00:00.000Z',
      fundedScriptHashes: [],
      spentScriptHashes: [],
      deltaSats: '50000',
      replacesTxid: null,
      replacedByTxid: null,
      confirmationState: 'confirmed',
      feeSats: null,
      vsize: null,
      replaceable: null,
      packageFeeSats: null,
      packageVsize: null,
      cpfpEligible: false,
    }], {
      vaultId,
      network: 'signet',
      type: 'history',
      key: 'a0:ordinals',
    }, new Uint8Array(24).fill(21), now));
    activityDek.fill(0);
    const activityHome = await harness.service.homeView(expectation);
    expect(activityHome.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        txid: protectedTxid,
        actionKind: 'ordinal_receive',
        inscriptionId: firstCoLocatedId,
        receivedInscriptionCount: 3,
        ordinalValueSats: '50000',
      }),
    ]));
    await expect(harness.service.activityInscriptionPreview({
      txid: activityTxid,
      inscriptionId: targetId,
      ...expectation,
    })).resolves.toEqual({
      inscriptionId: targetId,
      preview: {
        kind: 'raster',
        rasterBase64: 'aQ==',
        pngSha256: 'f'.repeat(64),
        pngWidth: 1,
        pngHeight: 1,
      },
    });
    await expect(harness.service.activityInscriptionPreviewBatch({
      items: [
        { txid: activityTxid, inscriptionId: targetId },
        { txid: protectedTxid, inscriptionId: firstCoLocatedId },
      ],
      ...expectation,
    })).resolves.toMatchObject({
      items: [
        { inscriptionId: targetId, preview: { kind: 'raster' } },
        { inscriptionId: firstCoLocatedId, preview: { kind: 'raster' } },
      ],
    });
    await expect(harness.service.activityInscriptionPreview({
      txid: protectedTxid,
      inscriptionId: targetId,
      ...expectation,
    })).resolves.toEqual({
      inscriptionId: targetId,
      preview: {
        kind: 'raster',
        rasterBase64: 'aQ==',
        pngSha256: 'f'.repeat(64),
        pngWidth: 1,
        pngHeight: 1,
      },
    });
    await expect(harness.service.activityInscriptionPreview({
      txid: activityTxid,
      inscriptionId: firstCoLocatedId,
      ...expectation,
    })).rejects.toMatchObject({ code: 'ERR_INVALID_PAYLOAD' });
    expect(activityMetadataRequests).toBe(2);
    expect(activityPreviewRequests).toBe(2);
    expect(activityBatchRequests).toBe(1);
    await harness.service.cancelTransactionPlan({ planId: native.planId, ...expectation });
    const batch = await harness.service.createTransactionPlan({
      kind: 'ordinal_batch_transfer',
      account: 0,
      recipient: recipient.address,
      selections: protectedClassification.inscriptions.map((inscription) => ({
        inscriptionId: inscription.inscriptionId,
        outpoint: { txid: protectedTxid, vout: 0 },
        satpoint: inscription.satpoint,
        classificationRevision: status.activeRevision,
      })),
      fee: { type: 'automatic', tier: 'recommended' },
      ...expectation,
    });
    expect(batch.review).toMatchObject({
      kind: 'ordinal_batch_transfer',
      rbf: false,
      ordinalAction: {
        action: 'batch_transfer',
        inscriptionCount: 3,
        inscriptionIds: [firstCoLocatedId, secondCoLocatedId, targetId],
        destination: { address: recipient.address, ownership: 'external' },
        requiresNonTaprootAcknowledgement: false,
      },
    });
    if (batch.review.ordinalAction?.action !== 'batch_transfer') {
      throw new Error('missing batch review');
    }
    expect(batch.review.ordinalAction.groups).toHaveLength(2);
    expect(batch.review.ordinalAction.groups[0]).toMatchObject({
      inscriptionIds: [firstCoLocatedId, secondCoLocatedId],
      source: { txid: protectedTxid, vout: 0 },
      travelsTogether: true,
    });
    expect(batch.review.ordinalAction.groups[1]).toMatchObject({
      inscriptionIds: [targetId],
      travelsTogether: false,
    });
    const batchSession = await getSession(harness.session);
    if (!batchSession) throw new Error('missing batch plan session');
    const batchDek = base64ToBytes(batchSession.dekB64);
    const encryptedBatchPlan = await cache.get({
      vaultId, network: 'signet', type: 'plans', key: batch.planId,
    });
    if (!encryptedBatchPlan) throw new Error('missing encrypted ordinal batch plan');
    const batchPlan = openRecord(batchDek, encryptedBatchPlan, storedPlanSchema);
    batchDek.fill(0);
    if (batchPlan.version !== 4) throw new Error('batch plan version changed');
    expect(batchPlan.inputs[0]).toMatchObject({ txid: protectedTxid, sequence: 0xffffffff });
    expect(batchPlan.inputs.slice(1)).toEqual([
      expect.objectContaining({ txid: paymentTxid, sequence: 0xffffffff }),
    ]);
    const batchSigningSeed = mnemonicToSeed(MNEMONIC);
    const signedBatch = signAndValidatePlan(
      batchPlan,
      batchSigningSeed,
      (length) => new Uint8Array(length),
    );
    batchSigningSeed.fill(0);
    expect(() => validateSignedTransactionHex(batchPlan, signedBatch.transactionHex)).not.toThrow();
    feeRate += 1_000;
    const refreshedBatch = await harness.service.approveTransaction({
      planId: batch.planId,
      planHash: batch.planHash,
      ...expectation,
    });
    expect(refreshedBatch.status).toBe('review_required');
    if (refreshedBatch.status !== 'review_required') {
      throw new Error('expected batch replacement review');
    }
    expect(refreshedBatch.replacement.planId).not.toBe(batch.planId);
    expect(refreshedBatch.replacement.planHash).not.toBe(batch.planHash);
    expect(refreshedBatch.replacement.review.ordinalAction).toMatchObject({
      action: 'batch_transfer',
      inscriptionCount: 3,
      inscriptionIds: [firstCoLocatedId, secondCoLocatedId, targetId],
    });
    await expect(harness.service.reviewTransactionPlan({
      planId: batch.planId,
      ...expectation,
    })).rejects.toMatchObject({ code: 'ERR_PLAN_EXPIRED' });
    await expect(harness.service.approveTransaction({
      planId: refreshedBatch.replacement.planId,
      planHash: batch.planHash,
      ...expectation,
    })).rejects.toMatchObject({ code: 'ERR_PLAN_CHANGED' });
    feeRate -= 1_000;
    await harness.service.cancelTransactionPlan({
      planId: refreshedBatch.replacement.planId,
      ...expectation,
    });
    await expect(harness.service.createTransactionPlan({
      kind: 'ordinal_batch_transfer',
      account: 0,
      recipient: recipient.address,
      selections: [{
        inscriptionId: targetId,
        outpoint: { txid: protectedTxid, vout: 0 },
        satpoint: `${protectedTxid}:0:20000`,
        classificationRevision: status.activeRevision,
      }],
      fee: { type: 'automatic', tier: 'recommended' },
      ...expectation,
    })).rejects.toMatchObject({ code: 'ERR_UNSAFE_TRANSACTION' });
    const nonTaprootBatch = await harness.service.createTransactionPlan({
      kind: 'ordinal_batch_transfer',
      account: 0,
      recipient: paymentAddress.address,
      selections: protectedClassification.inscriptions.map((inscription) => ({
        inscriptionId: inscription.inscriptionId,
        outpoint: { txid: protectedTxid, vout: 0 },
        satpoint: inscription.satpoint,
        classificationRevision: status.activeRevision,
      })),
      fee: { type: 'automatic', tier: 'recommended' },
      ...expectation,
    });
    expect(nonTaprootBatch.review.ordinalAction?.action === 'batch_transfer' &&
      nonTaprootBatch.review.ordinalAction.requiresNonTaprootAcknowledgement).toBe(true);
    await expect(harness.service.approveTransaction({
      planId: nonTaprootBatch.planId,
      planHash: nonTaprootBatch.planHash,
      previewUnavailableAcknowledged: true,
      ...expectation,
    })).rejects.toThrow(/non-Taproot/u);
    await harness.service.cancelTransactionPlan({ planId: nonTaprootBatch.planId, ...expectation });
    await expect(harness.service.createTransactionPlan({
      kind: 'ordinal_batch_transfer',
      account: 0,
      recipient: recipient.address,
      selections: protectedClassification.inscriptions.map((inscription) => ({
        inscriptionId: inscription.inscriptionId,
        outpoint: { txid: protectedTxid, vout: 0 },
        satpoint: inscription.satpoint,
        classificationRevision: 'stale-revision',
      })),
      fee: { type: 'automatic', tier: 'recommended' },
      ...expectation,
    })).rejects.toMatchObject({ code: 'ERR_UNSAFE_TRANSACTION' });
    await expect(harness.service.createTransactionPlan({
      kind: 'ordinal_transfer',
      account: 0,
      inscriptionId: firstCoLocatedId,
      outpoint: { txid: protectedTxid, vout: 0 },
      recipient: recipient.address,
      fee: { type: 'automatic', tier: 'recommended' },
      ...expectation,
    })).rejects.toMatchObject({ code: 'ERR_INSCRIPTION_INSEPARABLE' });
    await expect(harness.service.createTransactionPlan({
      kind: 'ordinal_transfer',
      account: 0,
      inscriptionId: targetId,
      outpoint: { txid: protectedTxid, vout: 0 },
      recipient: wrongNetworkRecipient.address,
      fee: { type: 'automatic', tier: 'recommended' },
      ...expectation,
    })).rejects.toMatchObject({ code: 'ERR_INVALID_ADDRESS' });
    await expect(harness.service.createTransactionPlan({
      kind: 'ordinal_transfer',
      account: 1,
      inscriptionId: targetId,
      outpoint: { txid: protectedTxid, vout: 0 },
      recipient: recipient.address,
      fee: { type: 'automatic', tier: 'recommended' },
      ...expectation,
    })).rejects.toMatchObject({ code: 'ERR_INVALID_PAYLOAD' });
    const feeMissingSession = await getSession(harness.session);
    if (!feeMissingSession) throw new Error('missing fee-input session');
    const feeMissingDek = base64ToBytes(feeMissingSession.dekB64);
    await cache.put(sealRecord(
      feeMissingDek,
      [],
      { vaultId, network: 'signet', type: 'utxos', key: 'a0:payment' },
      new Uint8Array(24).fill(14),
      now,
    ));
    feeMissingDek.fill(0);
    await expect(harness.service.createTransactionPlan({
      kind: 'ordinal_transfer',
      account: 0,
      inscriptionId: targetId,
      outpoint: { txid: protectedTxid, vout: 0 },
      recipient: recipient.address,
      fee: { type: 'automatic', tier: 'recommended' },
      ...expectation,
    })).rejects.toMatchObject({ code: 'ERR_CLEAN_FEE_INPUTS_UNAVAILABLE' });
    await expect(harness.service.createTransactionPlan({
      kind: 'ordinal_batch_transfer',
      account: 0,
      recipient: recipient.address,
      selections: protectedClassification.inscriptions.map((inscription) => ({
        inscriptionId: inscription.inscriptionId,
        outpoint: { txid: protectedTxid, vout: 0 },
        satpoint: inscription.satpoint,
        classificationRevision: status.activeRevision,
      })),
      fee: { type: 'automatic', tier: 'recommended' },
      ...expectation,
    })).rejects.toMatchObject({ code: 'ERR_CLEAN_FEE_INPUTS_UNAVAILABLE' });
    const restoreSession = await getSession(harness.session);
    if (!restoreSession) throw new Error('missing fee-input restore session');
    const restoreDek = base64ToBytes(restoreSession.dekB64);
    await cache.put(sealRecord(
      restoreDek,
      [paymentUtxo],
      { vaultId, network: 'signet', type: 'utxos', key: 'a0:payment' },
      new Uint8Array(24).fill(15),
      now,
    ));
    await cache.put(sealRecord(
      restoreDek,
      [{
        ...protectedUtxo,
        facts: { ...protectedUtxo.facts!, unsupportedAssetDetected: true },
      }],
      { vaultId, network: 'signet', type: 'utxos', key: 'a0:ordinals' },
      new Uint8Array(24).fill(16),
      now,
    ));
    restoreDek.fill(0);
    await expect(harness.service.createTransactionPlan({
      kind: 'ordinal_transfer',
      account: 0,
      inscriptionId: targetId,
      outpoint: { txid: protectedTxid, vout: 0 },
      recipient: recipient.address,
      fee: { type: 'automatic', tier: 'recommended' },
      ...expectation,
    })).rejects.toMatchObject({ code: 'ERR_UNSAFE_TRANSACTION' });
    const safeRestoreSession = await getSession(harness.session);
    if (!safeRestoreSession) throw new Error('missing protected restore session');
    const safeRestoreDek = base64ToBytes(safeRestoreSession.dekB64);
    await cache.put(sealRecord(
      safeRestoreDek,
      [protectedUtxo],
      { vaultId, network: 'signet', type: 'utxos', key: 'a0:ordinals' },
      new Uint8Array(24).fill(17),
      now,
    ));
    safeRestoreDek.fill(0);
    const nonTaproot = await harness.service.createTransactionPlan({
      kind: 'ordinal_transfer',
      account: 0,
      inscriptionId: targetId,
      outpoint: { txid: protectedTxid, vout: 0 },
      recipient: paymentAddress.address,
      fee: { type: 'automatic', tier: 'recommended' },
      ...expectation,
    });
    expect(nonTaproot.review.ordinalAction?.action === 'transfer' &&
      nonTaproot.review.ordinalAction.requiresNonTaprootAcknowledgement).toBe(true);
    await expect(harness.service.approveTransaction({
      planId: nonTaproot.planId,
      planHash: nonTaproot.planHash,
      previewUnavailableAcknowledged: true,
      ...expectation,
    })).rejects.toThrow(/non-Taproot/u);
    await harness.service.cancelTransactionPlan({
      planId: nonTaproot.planId,
      ...expectation,
    });

    const smallPostageClassification: UtxoClassification = {
      ...protectedClassification,
      valueSats: '546',
      primaryClass: 'inscribed',
      inscriptions: [{ inscriptionId: targetId, satpoint: `${protectedTxid}:0:0` }],
    };
    const smallPostageUtxo: WalletUtxo = {
      ...protectedUtxo,
      valueSats: 546n,
      facts: {
        ...protectedUtxo.facts!,
        primaryClass: 'inscribed',
        inscriptions: smallPostageClassification.inscriptions,
      },
    };
    classifications.set(`${protectedTxid}:0`, smallPostageClassification);
    const smallPostageSession = await getSession(harness.session);
    if (!smallPostageSession) throw new Error('missing small-postage session');
    const smallPostageDek = base64ToBytes(smallPostageSession.dekB64);
    await cache.put(sealRecord(
      smallPostageDek,
      [smallPostageUtxo],
      { vaultId, network: 'signet', type: 'utxos', key: 'a0:ordinals' },
      new Uint8Array(24).fill(18),
      now,
    ));
    smallPostageDek.fill(0);
    const smallPostage = await harness.service.createTransactionPlan({
      kind: 'ordinal_transfer',
      account: 0,
      inscriptionId: targetId,
      outpoint: { txid: protectedTxid, vout: 0 },
      recipient: recipient.address,
      fee: { type: 'automatic', tier: 'recommended' },
      ...expectation,
    });
    expect(smallPostage.review.ordinalAction).toMatchObject({
      postageSats: '546',
      protectedSource: { txid: protectedTxid, vout: 0, valueSats: '546' },
      fundingInputs: [expect.objectContaining({ txid: paymentTxid, vout: 1 })],
    });
    const postagePlanSession = await getSession(harness.session);
    if (!postagePlanSession) throw new Error('missing postage plan session');
    const postagePlanDek = base64ToBytes(postagePlanSession.dekB64);
    const encryptedPostagePlan = await cache.get({
      vaultId,
      network: 'signet',
      type: 'plans',
      key: smallPostage.planId,
    });
    if (!encryptedPostagePlan) throw new Error('missing encrypted postage plan');
    const storedPostagePlan = openRecord(postagePlanDek, encryptedPostagePlan, storedPlanSchema);
    postagePlanDek.fill(0);
    if (storedPostagePlan.version !== 4) throw new Error('postage plan version changed');
    const postageSigningSeed = mnemonicToSeed(MNEMONIC);
    const signedPostagePlan = signAndValidatePlan(
      storedPostagePlan,
      postageSigningSeed,
      (length) => new Uint8Array(length),
    );
    postageSigningSeed.fill(0);
    expect(() => validateSignedTransactionHex(
      storedPostagePlan,
      signedPostagePlan.transactionHex,
    )).not.toThrow();
    await harness.service.cancelTransactionPlan({
      planId: smallPostage.planId,
      ...expectation,
    });

    classifications.set(`${protectedTxid}:0`, protectedClassification);
    const providerRestoreSession = await getSession(harness.session);
    if (!providerRestoreSession) throw new Error('missing provider restore session');
    const providerRestoreDek = base64ToBytes(providerRestoreSession.dekB64);
    await cache.put(sealRecord(
      providerRestoreDek,
      [protectedUtxo],
      { vaultId, network: 'signet', type: 'utxos', key: 'a0:ordinals' },
      new Uint8Array(24).fill(19),
      now,
    ));
    providerRestoreDek.fill(0);

    const plan = await harness.service.providerPrepareOrdinalTransfer({
      inscriptionId: targetId,
      address: recipient.address,
      binding: {
        origin: 'https://app.example', tabId: 1, frameId: 0,
        documentId: '123e4567-e89b-42d3-a456-426614174010',
        requestNonce: '123e4567-e89b-42d3-a456-426614174011',
        providerMethod: 'ord_sendInscriptions',
      },
    });
    expect(plan.inputs[0]).toMatchObject({ txid: protectedTxid, sequence: 0xffffffff });
    expect(plan.inputs.slice(1)).toHaveLength(1);
    expect(plan.inputs[1]).toMatchObject({ txid: paymentTxid, sequence: 0xffffffff });
    expect(plan.inputs[1]?.derivation?.lane).toBe('payment');
    expect(plan.protectedSatFlow).toHaveLength(3);
    const targetFlow = plan.protectedSatFlow.find((flow) => flow.inscriptionId === targetId)!;
    const firstFlow = plan.protectedSatFlow.find((flow) => flow.inscriptionId === firstCoLocatedId)!;
    const secondFlow = plan.protectedSatFlow.find((flow) => flow.inscriptionId === secondCoLocatedId)!;
    expect(firstFlow.outputIndex).toBe(secondFlow.outputIndex);
    expect(firstFlow.outputOffset).toBe(secondFlow.outputOffset);
    expect(targetFlow.outputIndex).not.toBe(firstFlow.outputIndex);
    expect(plan.outputs[targetFlow.outputIndex]).toMatchObject({ role: 'postage', address: recipient.address });
    expect(plan.outputs[firstFlow.outputIndex]).toMatchObject({ role: 'ordinal_change' });
    expect(plan.outputs[firstFlow.outputIndex]?.derivation?.lane).toBe('ordinals');
    expect(plan.rbf).toBe(false);
    expect(plan.analysis.hardViolations).toEqual([]);

    await expect(harness.service.providerPrepareOrdinalTransfer({
      inscriptionId: firstCoLocatedId,
      address: recipient.address,
      binding: {
        origin: 'https://app.example', tabId: 1, frameId: 0,
        documentId: '123e4567-e89b-42d3-a456-426614174010',
        requestNonce: '123e4567-e89b-42d3-a456-426614174012',
        providerMethod: 'ord_sendInscriptions',
      },
    })).rejects.toThrow(/co-located/u);
  });
});
