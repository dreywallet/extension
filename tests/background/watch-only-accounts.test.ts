import { beforeAll, describe, expect, it } from 'vitest';
import { publicAccountFromSeed, derivePublicAccountAddress } from '@drey/core/domain/accounts/public-account';
import { restoreMnemonic } from '@drey/core/domain/keys/mnemonic';
import { finalizePlan, transactionCommitmentHash, type TransactionPlan } from '@drey/core/domain/transactions/plan';
import { feeQuoteResponseSchema } from '@drey/core/domain/gateway/contract';
import { base64ToBytes } from '@drey/core/domain/vault/encoding';
import { PASSWORD } from '@drey/core/testing/vault-helpers';
import { MemoryWalletCache } from '../../src/adapters/storage/wallet-cache-idb';
import { openRecord, sealRecord } from '../../src/adapters/storage/wallet-cache';
import { getSession } from '../../src/adapters/session/session-store';
import { activityEvidenceRecordSchema } from '@drey/core/scan/cache-schemas';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreFixturesDir } from '../helpers/core-fixtures';
import { makeHarness } from './service-helpers';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const FEES = feeQuoteResponseSchema.parse(JSON.parse(readFileSync(
  join(coreFixturesDir, 'gateway', 'fees.signed.json'), 'utf8',
)));

function pendingPlan(accountId: string, account: number, now: number): TransactionPlan {
  const draft: Omit<TransactionPlan, 'planHash' | 'transactionCommitmentHash'> = {
    version: 4,
    planId: 'watch-pending',
    createdAt: now,
    expiresAt: now + 60_000,
    network: 'mainnet',
    accountId,
    account,
    kind: 'native_send',
    policy: {
      intent: {
        kind: 'native_send', account, recipient: 'bc1qrecipient', amountSats: '1000', sendMax: false,
      },
      fee: { type: 'automatic', tier: 'recommended' },
    },
    source: {
      backend: 'fixture', instanceId: 'fixture', classificationRevision: 'rev-1',
      coreTip: { height: 1, hash: '1'.repeat(64) },
      indexTip: { height: 1, hash: '1'.repeat(64) },
      feeQuoteTimestamp: null, mempoolState: null,
    },
    inputs: [{
      txid: '2'.repeat(64), vout: 0, valueSats: 1_100n,
      scriptPubKey: `0014${'3'.repeat(40)}`, sequence: 0xffff_fffd, sighash: 1,
      ownership: 'wallet',
      derivation: {
        accountId,
        account,
        lane: 'payment',
        chain: 0,
        index: 0,
        path: `m/84'/0'/${account}'/0/0`,
        publicKeyHex: `02${'3'.repeat(64)}`,
      },
      classification: {
        primaryClass: 'cardinal_clean', inscriptions: [], satRanges: null,
        unsupportedAssetDetected: false, confidence: 'authoritative',
        classifiedTip: { height: 1, hash: '1'.repeat(64) }, classificationRevision: 'rev-1',
      },
    }],
    outputs: [{
      valueSats: 1_000n, scriptPubKey: `0014${'4'.repeat(40)}`,
      address: 'bc1qrecipient', role: 'recipient',
    }],
    protectedSatFlow: [], feeSats: 100n, vsize: 100n, feeRateSatPerKvB: 1_000n,
    urgency: 'recommended', rbf: true, parentTxid: null, replacesTxid: null,
    broadcast: true, psbtHex: '00', psbtHash: '5'.repeat(64), analysisHash: '6'.repeat(64),
    inscriptionPreviews: {
      transactionCommitmentHash: '0'.repeat(64), analysisHash: '6'.repeat(64),
      psbtHash: '5'.repeat(64), effectSetHash: '7'.repeat(64),
      classificationRevision: 'rev-1', verifiedAtMs: now, items: [],
    },
  };
  const commitment = transactionCommitmentHash(draft);
  return finalizePlan({
    ...draft,
    inscriptionPreviews: { ...draft.inscriptionPreviews, transactionCommitmentHash: commitment },
  });
}

beforeAll(async () => {
  await installTestCryptoProvider();
});

async function setupWatch(cache: MemoryWalletCache) {
  const harness = makeHarness(undefined, { walletCache: cache });
  const { vaultId } = await harness.service.restore({
    name: 'Main', password: PASSWORD, mnemonic: MNEMONIC,
  });
  const { sessionId } = await harness.service.unlock({ vaultId, password: PASSWORD });
  const expectation = { expectedVaultId: vaultId, expectedSessionId: sessionId };
  const { seed } = restoreMnemonic(MNEMONIC);
  const definition = publicAccountFromSeed(seed, 'mainnet', 7);
  seed.fill(0);
  await harness.service.importWatchAccount({
    name: 'Cold observer',
    network: 'mainnet',
    paymentReceiveDescriptor: definition.lanes.payment.receiveDescriptor,
    paymentChangeDescriptor: definition.lanes.payment.changeDescriptor,
    ordinalsReceiveDescriptor: definition.lanes.ordinals.receiveDescriptor,
    ordinalsChangeDescriptor: definition.lanes.ordinals.changeDescriptor,
    ...expectation,
  });
  const session = await getSession(harness.session);
  if (!session) throw new Error('missing session');
  return {
    ...harness,
    vaultId,
    expectation,
    definition,
    dek: base64ToBytes(session.dekB64),
  };
}

describe('descriptor-backed watch-only accounts', () => {
  it('persists public identity separately, derives addresses, gates signing, and purges removal', async () => {
    const cache = new MemoryWalletCache();
    const harness = makeHarness(undefined, { walletCache: cache });
    const { vaultId } = await harness.service.restore({
      name: 'Main', password: PASSWORD, mnemonic: MNEMONIC,
    });
    const { sessionId } = await harness.service.unlock({ vaultId, password: PASSWORD });
    const expectation = { expectedVaultId: vaultId, expectedSessionId: sessionId };
    const software = await harness.service.sessionSnapshot();
    expect(software.locked).toBe(false);
    expect(software.accountSummaries).toHaveLength(1);
    const softwareAccountId = software.activeAccountId!;

    const { seed } = restoreMnemonic(MNEMONIC);
    const softwareDefinition = publicAccountFromSeed(seed, 'mainnet', 0);
    expect((await harness.service.exportPublicAccount({
      accountId: softwareAccountId,
      password: PASSWORD,
      ...expectation,
    })).definition).toEqual(softwareDefinition);
    const definition = publicAccountFromSeed(seed, 'mainnet', 7);
    seed.fill(0);
    const imported = await harness.service.importWatchAccount({
      name: 'Cold observer',
      network: 'mainnet',
      paymentReceiveDescriptor: definition.lanes.payment.receiveDescriptor,
      paymentChangeDescriptor: definition.lanes.payment.changeDescriptor,
      ordinalsReceiveDescriptor: definition.lanes.ordinals.receiveDescriptor,
      ordinalsChangeDescriptor: definition.lanes.ordinals.changeDescriptor,
      ...expectation,
    });
    expect(imported.accountId).toBe(definition.accountId);

    const restarted = harness.rebuild();
    const snapshot = await restarted.sessionSnapshot();
    expect(snapshot.activeAccountId).toBe(definition.accountId);
    expect(snapshot.accountSummaries.map((account) => account.accountId)).toEqual([
      softwareAccountId,
      definition.accountId,
    ]);
    expect(snapshot.accountSummaries).toContainEqual({
      accountId: definition.accountId,
      account: 7,
      name: 'Cold observer',
      signingSource: 'none',
    });
    expect(snapshot.capabilities).toMatchObject({
      canView: true,
      canDeriveAddresses: true,
      canPlanTransactions: true,
      canBuildUnsignedPsbt: true,
      canSignTransactions: false,
      canBroadcast: false,
      canExposeToProviders: false,
      canUseMarketplaces: false,
      canExportPublicAccount: true,
    });
    const received = await restarted.receiveAddress({
      accountId: definition.accountId,
      kind: 'payment',
      ...expectation,
    });
    expect(received.address).toBe(derivePublicAccountAddress(definition, 'payment', 0, 0).address);
    await expect(restarted.exportPublicAccount({
      accountId: definition.accountId,
      password: 'not the password',
      ...expectation,
    })).rejects.toBeDefined();
    expect((await restarted.exportPublicAccount({
      accountId: definition.accountId,
      password: PASSWORD,
      ...expectation,
    })).definition).toEqual(definition);
    await expect(restarted.revealMnemonic({ password: PASSWORD, ...expectation }))
      .rejects.toMatchObject({ code: 'ERR_UNSAFE_TRANSACTION' });
    await expect(restarted.verifyBackup({
      words: [{ index: 0, word: 'abandon' }],
      wordCount: 12,
      ...expectation,
    })).rejects.toMatchObject({ code: 'ERR_UNSAFE_TRANSACTION' });
    await expect(restarted.addAccount({ ...expectation, acknowledgeEmptyAccountRisk: false }))
      .rejects.toMatchObject({ code: 'ERR_UNSAFE_TRANSACTION' });
    await expect(restarted.providerAccountView()).rejects.toMatchObject({
      code: 'ERR_UNAUTHORIZED_CONTEXT',
    });

    await restarted.removeWatchAccount({ accountId: definition.accountId, ...expectation });
    const after = await restarted.sessionSnapshot();
    expect(after.activeAccountId).toBe(softwareAccountId);
    expect(after.accountSummaries).not.toContainEqual(expect.objectContaining({
      accountId: definition.accountId,
    }));
    expect(await cache.listKeys(vaultId, 'mainnet', 'publicAccountDefinition'))
      .not.toContain(definition.accountId);
    expect(await cache.listKeys(vaultId, 'mainnet', 'accountSigningBinding'))
      .not.toContain(definition.accountId);
  });

  it('refuses removal while an exact target-account v4 plan remains pending and preserves it', async () => {
    const cache = new MemoryWalletCache();
    const h = await setupWatch(cache);
    const plan = pendingPlan(h.definition.accountId, h.definition.derivationAccountIndex, h.clock.now);
    await cache.put(sealRecord(
      h.dek,
      plan,
      { vaultId: h.vaultId, network: 'mainnet', type: 'plans', key: plan.planId },
      new Uint8Array(24).fill(41),
      h.clock.now,
    ));
    h.dek.fill(0);

    await expect(h.service.removeWatchAccount({
      accountId: h.definition.accountId,
      ...h.expectation,
    })).rejects.toMatchObject({ code: 'ERR_PLAN_CHANGED' });
    expect(await cache.listKeys(h.vaultId, 'mainnet', 'plans')).toEqual([plan.planId]);
    expect((await h.service.sessionSnapshot()).activeAccountId).toBe(h.definition.accountId);
  });

  it('refuses removal when broadcast recovery attribution is orphaned and preserves the journal', async () => {
    const cache = new MemoryWalletCache();
    const h = await setupWatch(cache);
    const recoveryId = 'orphan-recovery';
    await cache.put(sealRecord(
      h.dek,
      {
        planId: recoveryId,
        transactionHex: '00',
        txid: '8'.repeat(64),
        wtxid: '9'.repeat(64),
        network: 'mainnet',
        backend: 'fixture',
        attempts: 0,
        nextRetryAt: h.clock.now,
        lastFailure: null,
        feeTarget: 2,
        feeQuote: FEES,
      },
      { vaultId: h.vaultId, network: 'mainnet', type: 'broadcastRecovery', key: recoveryId },
      new Uint8Array(24).fill(42),
      h.clock.now,
    ));
    h.dek.fill(0);

    await expect(h.service.removeWatchAccount({
      accountId: h.definition.accountId,
      ...h.expectation,
    })).rejects.toMatchObject({ code: 'ERR_PLAN_CHANGED' });
    expect(await cache.listKeys(h.vaultId, 'mainnet', 'broadcastRecovery')).toEqual([recoveryId]);
    expect((await h.service.sessionSnapshot()).activeAccountId).toBe(h.definition.accountId);
  });

  it.each(['unreadable', 'legacy'] as const)(
    'fails closed on an %s pending plan record before deleting account state',
    async (kind) => {
      const cache = new MemoryWalletCache();
      const h = await setupWatch(cache);
      const current = pendingPlan(h.definition.accountId, h.definition.derivationAccountIndex, h.clock.now);
      const legacy = { ...current, version: 3 } as Record<string, unknown>;
      delete legacy.accountId;
      const value = kind === 'legacy' ? legacy : { version: 99, ambiguous: true };
      await cache.put(sealRecord(
        h.dek,
        value,
        { vaultId: h.vaultId, network: 'mainnet', type: 'plans', key: `${kind}-plan` },
        new Uint8Array(24).fill(kind === 'legacy' ? 43 : 44),
        h.clock.now,
      ));
      h.dek.fill(0);

      await expect(h.service.removeWatchAccount({
        accountId: h.definition.accountId,
        ...h.expectation,
      })).rejects.toMatchObject({ code: 'ERR_PLAN_CHANGED' });
      expect(await cache.listKeys(h.vaultId, 'mainnet', 'plans')).toEqual([`${kind}-plan`]);
      expect((await h.service.sessionSnapshot()).activeAccountId).toBe(h.definition.accountId);
    },
  );

  it('purges terminal transactions and scoped activity evidence before same-ID reimport', async () => {
    const cache = new MemoryWalletCache();
    const h = await setupWatch(cache);
    const plan = pendingPlan(h.definition.accountId, h.definition.derivationAccountIndex, h.clock.now);
    const transactionTxid = 'b'.repeat(64);
    await cache.put(sealRecord(
      h.dek,
      {
        planId: plan.planId,
        kind: plan.kind,
        txid: transactionTxid,
        createdAt: plan.createdAt,
        amountSats: 1_000n,
        feeSats: plan.feeSats,
        status: 'confirmed',
        detail: null,
        parentTxid: null,
        replacesTxid: null,
        plan,
      },
      { vaultId: h.vaultId, network: 'mainnet', type: 'transactions', key: transactionTxid },
      new Uint8Array(24).fill(45),
      h.clock.now,
    ));
    const removedInscriptionId = `${'c'.repeat(64)}i0`;
    const retainedInscriptionId = `${'d'.repeat(64)}i0`;
    const middleTxid = 'f'.repeat(64);
    const laterTxid = 'a'.repeat(64);
    const unrelatedSourceTxid = 'e'.repeat(64);
    await cache.put(sealRecord(
      h.dek,
      [{
        txid: middleTxid,
        height: 1,
        timestamp: null,
        fundedScriptHashes: [],
        spentScriptHashes: [],
        deltaSats: '-1',
        replacesTxid: null,
        replacedByTxid: null,
        confirmationState: 'confirmed',
        feeSats: null,
        vsize: null,
        replaceable: false,
        packageFeeSats: null,
        packageVsize: null,
        cpfpEligible: false,
        ordinalFlow: {
          kind: 'complete',
          edges: [{
            source: { txid: plan.inputs[0]!.txid, vout: plan.inputs[0]!.vout, offsetSats: '0' },
            destination: { txid: middleTxid, vout: 2, offsetSats: '0' },
            lengthSats: '1',
            sourceRequested: true,
            destinationRequested: false,
          }],
        },
      }],
      {
        vaultId: h.vaultId,
        network: 'mainnet',
        type: 'history',
        key: `pub:${h.definition.accountId}:payment`,
      },
      new Uint8Array(24).fill(47),
      h.clock.now,
    ));
    await cache.put(sealRecord(
      h.dek,
      [{
        txid: laterTxid,
        height: 2,
        timestamp: null,
        fundedScriptHashes: [],
        spentScriptHashes: [],
        deltaSats: '0',
        replacesTxid: null,
        replacedByTxid: null,
        confirmationState: 'confirmed',
        feeSats: null,
        vsize: null,
        replaceable: false,
        packageFeeSats: null,
        packageVsize: null,
        cpfpEligible: false,
        ordinalFlow: {
          kind: 'complete',
          edges: [
            {
              source: { txid: middleTxid, vout: 2, offsetSats: '0' },
              destination: { txid: laterTxid, vout: 2, offsetSats: '0' },
              lengthSats: '1',
              sourceRequested: true,
              destinationRequested: false,
            },
            {
              source: { txid: unrelatedSourceTxid, vout: 1, offsetSats: '0' },
              destination: { txid: laterTxid, vout: 3, offsetSats: '0' },
              lengthSats: '1',
              sourceRequested: true,
              destinationRequested: false,
            },
          ],
        },
      }],
      { vaultId: h.vaultId, network: 'mainnet', type: 'history', key: 'a0:payment' },
      new Uint8Array(24).fill(48),
      h.clock.now,
    ));
    await cache.put(sealRecord(
      h.dek,
      {
        version: 1,
        entries: [
          {
            inscriptionId: removedInscriptionId,
            number: 1,
            outpoint: { txid: laterTxid, vout: 2 },
            offsetSats: 0n,
            observedAt: h.clock.now,
          },
          {
            inscriptionId: retainedInscriptionId,
            number: 2,
            outpoint: { txid: laterTxid, vout: 3 },
            offsetSats: 0n,
            observedAt: h.clock.now,
          },
        ],
      },
      { vaultId: h.vaultId, network: 'mainnet', type: 'activityEvidence', key: 'all' },
      new Uint8Array(24).fill(46),
      h.clock.now,
    ));
    h.dek.fill(0);

    await h.service.removeWatchAccount({
      accountId: h.definition.accountId,
      ...h.expectation,
    });
    expect(await cache.listKeys(h.vaultId, 'mainnet', 'transactions')).toEqual([]);
    const session = await getSession(h.session);
    if (!session) throw new Error('missing post-removal session');
    const dek = base64ToBytes(session.dekB64);
    const evidenceRecord = await cache.get({
      vaultId: h.vaultId, network: 'mainnet', type: 'activityEvidence', key: 'all',
    });
    if (!evidenceRecord) throw new Error('missing filtered activity evidence');
    expect(openRecord(dek, evidenceRecord, activityEvidenceRecordSchema).entries).toEqual([
      expect.objectContaining({ inscriptionId: retainedInscriptionId }),
    ]);
    dek.fill(0);

    await h.service.importWatchAccount({
      name: 'Cold observer reimported',
      network: 'mainnet',
      paymentReceiveDescriptor: h.definition.lanes.payment.receiveDescriptor,
      paymentChangeDescriptor: h.definition.lanes.payment.changeDescriptor,
      ordinalsReceiveDescriptor: h.definition.lanes.ordinals.receiveDescriptor,
      ordinalsChangeDescriptor: h.definition.lanes.ordinals.changeDescriptor,
      ...h.expectation,
    });
    await expect(h.service.transactionStatus({
      accountId: h.definition.accountId,
      ...h.expectation,
    })).resolves.toMatchObject({ transactions: [] });
  });
});
