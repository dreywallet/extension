import { accountsMetaReadSchema } from '@drey/core/scan/cache-schemas';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { GatewayClient } from '@drey/core/gateway-client';
import { statusCapabilitiesSchema } from '@drey/core/domain/gateway/contract';
import { derivePublicAccountAddress, publicAccountFromSeed } from '@drey/core/domain/accounts/public-account';
import { mnemonicToSeed } from '@drey/core/domain/keys/mnemonic';
import type { WalletUtxo } from '@drey/core/domain/classification/types';
import { base64ToBytes } from '@drey/core/domain/vault/encoding';
import { MemoryWalletCache } from '../../src/adapters/storage/wallet-cache-idb';
import { sealRecord, openRecord } from '../../src/adapters/storage/wallet-cache';
import { getSession } from '../../src/adapters/session/session-store';
import { runeJournalSchema } from '../../src/background/rune-journal';
import { coreFixturesDir } from '../helpers/core-fixtures';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { makeHarness } from './service-helpers';

const globalStatus = statusCapabilitiesSchema.parse(JSON.parse(readFileSync(join(coreFixturesDir, 'gateway/status.signed.json'), 'utf8')));
const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const password = 'public fixture test password';
beforeAll(installTestCryptoProvider);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function setup() {
  const status = structuredClone(globalStatus);
  const cache = new MemoryWalletCache();
  const seed = mnemonicToSeed(phrase);
  const account = publicAccountFromSeed(seed, 'signet', 0);
  const recipient = derivePublicAccountAddress(publicAccountFromSeed(seed, 'signet', 1), 'ordinals', 0, 0).address;
  seed.fill(0);
  const now = Date.parse(status.timestamp) + 1000;
  const broadcasts: string[] = [];
  let onEvidence: (() => Promise<void>) | undefined;
  let historyWait: (() => Promise<void>) | undefined;
  let onHistory: ((response: Record<string, unknown>) => Record<string, unknown>) | undefined;
  let incompleteConfirmed = false;
  const utxos: WalletUtxo[] = ['ordinals', 'payment'].map((rawLane, index) => {
    const lane = rawLane as 'ordinals' | 'payment';
    const derived = derivePublicAccountAddress(account, lane, 0, 0);
    const valueSats = index === 0 ? 546n : 10000n;
    return { outpoint: { txid: String(index + 3).repeat(64), vout: 0 }, valueSats, scriptPubKey: derived.scriptPubKeyHex,
      accountId: account.accountId, account: 0, lane, chain: 0, addressIndex: 0, height: status.coreTip.height - 1,
      walletCreatedChange: false, flags: { userFrozen: false, dustQuarantined: false },
      facts: { primaryClass: index === 0 ? 'runic_or_unsupported' : 'cardinal_clean', inscriptions: [],
        satRanges: [{ start: '100000001', end: (100000001n + valueSats).toString(), rarity: 'common' }],
        unsupportedAssetDetected: index === 0, confidence: 'authoritative', classifiedTip: status.coreTip,
        classificationRevision: status.activeRevision } };
  });
  const gateway = {
    endpoint: 'http://fixture-gateway', protocolVersions: [2],
    fetchStatus: async () => ({ ok: true as const, status, verifiedAtMs: now }),
    fetchRuneOutputs: async (request: { outpoints: Array<{ txid: string; vout: number }> }) => {
      const outputs = request.outpoints.map((point) => {
        const utxo = utxos.find((item) => item.outpoint.txid === point.txid)!;
        // Production shape: ord indexes only confirmed outputs, so every
        // unconfirmed output is reported incomplete with no balances.
        const complete = utxo.height !== null && !incompleteConfirmed;
        return { ...point, valueSats: utxo.valueSats.toString(), scriptPubKey: utxo.scriptPubKey,
          confirmations: utxo.height === null ? 0 : status.coreTip.height - utxo.height + 1,
          complete, balances: utxo.lane === 'payment' || !complete ? [] : [{ id: '840000:1', name: 'TEST•RUNE', amount: '1000', divisibility: 2, symbol: null }] };
      });
      await onEvidence?.();
      return { ok: true as const, value: { instanceId: status.instanceId, network: 'signet', protocolVersion: 2,
        requestNonce: 'fixture', timestamp: status.timestamp, coreTip: status.coreTip, indexTip: status.indexTip,
        classificationRevision: status.activeRevision, capabilities: status.capabilities, signature: status.signature,
        runeProtocol: 'ord-0.27.1/native-v1', outputs, unknownOutpoints: [] }, verifiedAtMs: now };
    },
    fetchRuneHistory: async (request: { scriptHashes: string[]; transactions: Array<{ txid: string; wtxid: string }> }) => {
      await historyWait?.();
      const response = { instanceId: status.instanceId, network: 'signet', protocolVersion: 2, requestNonce: 'fixture', timestamp: status.timestamp,
        coreTip: status.coreTip, indexTip: status.indexTip, classificationRevision: status.activeRevision,
        capabilities: status.capabilities, signature: status.signature, runeProtocol: 'ord-0.27.1/native-v1', requestedScriptHashes: request.scriptHashes,
        historyComplete: false, effects: [], receipts: [], reconciliation: request.transactions.map((tx) => ({ ...tx, status: 'indeterminate', confirmedSpenderTxid: null, conflictedAncestorTxid: null })) };
      return { ok: true as const, value: onHistory?.(response) ?? response, verifiedAtMs: now };
    },
    fetchSnapshot: async (request: { scriptHashes: string[] }) => ({ ok: true as const, value: {
      instanceId: status.instanceId, network: 'signet', protocolVersion: 2, requestNonce: 'fixture', timestamp: status.timestamp,
      coreTip: status.coreTip, indexTip: status.indexTip, classificationRevision: status.activeRevision,
      capabilities: status.capabilities, signature: status.signature, requestedScriptHashes: request.scriptHashes, utxos: [], history: [] }, verifiedAtMs: now }),
    broadcastRuneTransaction: async (request: { transactionHex: string }) => {
      broadcasts.push(request.transactionHex);
      return { ok: false as const, reason: 'network_error' as const };
    },
  } as unknown as GatewayClient;
  const harness = makeHarness(now, { network: 'signet', gateway, walletCache: cache });
  const { vaultId } = await harness.service.restore({ name: 'Rune fixture', password, mnemonic: phrase });
  const session = await harness.service.unlock({ vaultId, password });
  const input = { expectedVaultId: vaultId, expectedSessionId: session.sessionId, accountId: account.accountId };
  const writeUtxos = async () => {
    const session = await getSession(harness.session);
    if (!session) throw new Error('fixture is locked');
    const dek = base64ToBytes(session.dekB64);
    try {
      for (const lane of ['ordinals', 'payment'] as const) {
        await cache.put(sealRecord(dek, utxos.filter((utxo) => utxo.lane === lane), { vaultId, network: 'signet', type: 'utxos', key: `a0:${lane}` }, new Uint8Array(24).fill(1), now));
      }
    } finally { dek.fill(0); }
  };
  await writeUtxos();
  const currentSession = await getSession(harness.session);
  const dek = base64ToBytes(currentSession!.dekB64);
  await cache.put(sealRecord(dek, { lastCompletedScanId: 'scan', lastSyncedAt: now, revision: status.activeRevision,
    hasConflictingSources: false }, { vaultId, network: 'signet', type: 'accountsMeta', key: 'all' }, new Uint8Array(24).fill(2), now));
  dek.fill(0);
  const prepare = () => harness.service.runePrepare({ ...input, runeId: '840000:1', amount: '400', recipient, feeRate: '2' });
  return { setHistoryWait: (fn: () => Promise<void>) => { historyWait = fn; }, ...harness, status, cache, utxos, broadcasts, input, prepare, writeUtxos, setOnHistory: (fn: (response: Record<string, unknown>) => Record<string, unknown>) => { onHistory = fn; }, setOnEvidence: (fn: () => Promise<void>) => { onEvidence = fn; },
    setIncompleteConfirmed: (value: boolean) => { incompleteConfirmed = value; } };
}

describe('Rune service authority and durable dispatch', () => {
  it('detects a freeze applied during the remote evidence read', async () => {
    const fixture = await setup();
    fixture.setOnEvidence(async () => { fixture.utxos[0]!.flags.userFrozen = true; await fixture.writeUtxos(); });
    await expect(fixture.prepare()).rejects.toThrow();
    expect(fixture.broadcasts).toHaveLength(0);
  });
  it('does not create two overlapping reviews from concurrent fresh reads', async () => {
    const fixture = await setup();
    const results = await Promise.allSettled([fixture.prepare(), fixture.prepare()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(fixture.broadcasts).toHaveLength(0);
  });
  it.each(['cancel', 'lock', 'expire', 'status'] as const)('invalidates %s during durable dispatch-marker persistence', async (action) => {
    const fixture = await setup(); const review = await fixture.prepare();
    const reached = deferred(); const resume = deferred(); let writes = 0;
    const original = fixture.cache.put.bind(fixture.cache);
    fixture.cache.put = async (record) => {
      await original(record);
      if (record.type === 'runeTransfers' && ++writes === 2) { reached.resolve(); await resume.promise; }
    };
    const approval = fixture.service.runeApprove({ ...fixture.input, planId: review.planId, planHash: review.planHash });
    const outcome = approval.then(() => 'fulfilled', () => 'rejected');
    await reached.promise;
    const cancellation = action === 'cancel' ? fixture.service.runeCancel({ ...fixture.input, planId: review.planId }) :
      action === 'lock' ? fixture.service.lock() : Promise.resolve();
    if (action === 'expire') fixture.clock.now = review.expiresAt + 1;
    if (action === 'status') { fixture.status.activeRevision += '-changed'; await fixture.service.gatewayStatus({ forceRefresh: true }); }
    resume.resolve();
    expect(await outcome).toBe('rejected'); await cancellation;
    expect(fixture.broadcasts).toHaveLength(0);
  });
  it('preserves approval across an unchanged successful status refresh', async () => {
    const fixture = await setup(); const review = await fixture.prepare();
    const original = fixture.cache.put.bind(fixture.cache); let writes = 0;
    fixture.cache.put = async (record) => {
      await original(record);
      if (record.type === 'runeTransfers' && ++writes === 2) await fixture.service.gatewayStatus({ forceRefresh: true });
    };
    await fixture.service.runeApprove({ ...fixture.input, planId: review.planId, planHash: review.planHash });
    expect(fixture.broadcasts).toHaveLength(1);
  });
  it('retains exact indeterminate bytes across worker restart without redispatch', async () => {
    const fixture = await setup(); const review = await fixture.prepare();
    const result = await fixture.service.runeApprove({ ...fixture.input, planId: review.planId, planHash: review.planHash });
    expect(result.status).toBe('indeterminate'); expect(fixture.broadcasts).toHaveLength(1);
    const session = await getSession(fixture.session); const dek = base64ToBytes(session!.dekB64);
    const record = await fixture.cache.get({ vaultId: fixture.input.expectedVaultId, network: 'signet', type: 'runeTransfers', key: result.txid });
    const journal = openRecord(dek, record!, runeJournalSchema); dek.fill(0);
    expect(journal.transactionHex).toBe(fixture.broadcasts[0]); expect(journal.dispatchState).toBe('dispatched');
    const rebuilt = fixture.rebuild(); const list = await rebuilt.runeList(fixture.input);
    expect(list.transfers.find((entry) => entry.txid === result.txid)?.status).toBe('indeterminate');
    expect(list.holdings[0]?.available).toBe('0'); expect(fixture.broadcasts).toHaveLength(1);
  });
  it('projects current signed receipts separately from outgoing journals', async () => {
    const fixture = await setup(); const list = await fixture.service.runeList(fixture.input);
    expect(list.status).toBe('ready');
    expect(list.transfers).toMatchObject([{ direction: 'received', txid: fixture.utxos[0]!.outpoint.txid, amount: '1000' }]);
  });
  it('drops a never-signed review on worker restart and permits a fresh review', async () => {
    const fixture = await setup(); const review = await fixture.prepare();
    const rebuilt = fixture.rebuild();
    await expect(rebuilt.runeApprove({ ...fixture.input, planId: review.planId, planHash: review.planHash })).rejects.toMatchObject({ code: 'ERR_PLAN_CHANGED' });
    const fresh = await rebuilt.runePrepare({ ...fixture.input, runeId: '840000:1', amount: '400', recipient: review.recipient, feeRate: '2' });
    expect(fresh.planId).not.toBe(review.planId); expect(fresh.amount).toBe('400');
    expect(await fixture.cache.listKeys(fixture.input.expectedVaultId, 'signet', 'runeTransfers')).toEqual([]);
    expect(fixture.broadcasts).toHaveLength(0);
  });
  it('reports an unfinished startup scan as stale and permits review after background completion', async () => {
    const fixture = await setup();
    const changeScan = async (complete: boolean) => {
      const session = await getSession(fixture.session); const dek = base64ToBytes(session!.dekB64);
      const key = { vaultId: fixture.input.expectedVaultId, network: 'signet' as const, type: 'accountsMeta' as const, key: 'all' };
      const record = await fixture.cache.get(key); const meta = openRecord(dek, record!, accountsMetaReadSchema);
      try { await fixture.cache.put(sealRecord(dek, { ...meta, lastCompletedScanId: complete ? 'completed-background-scan' : null }, key, new Uint8Array(24).fill(7), fixture.clock.now)); }
      finally { dek.fill(0); }
    };
    await changeScan(false);
    await expect(fixture.prepare()).rejects.toMatchObject({ code: 'ERR_DATA_STALE' });
    expect(fixture.broadcasts).toHaveLength(0);
    await changeScan(true);
    expect((await fixture.prepare()).amount).toBe('400');
    expect(fixture.broadcasts).toHaveLength(0);
  });
  it('restores native outgoing history without local signing journals', async () => {
    const fixture = await setup(); const txid = '8'.repeat(64);
    fixture.setOnHistory((response) => ({ ...response, historyComplete: true, effects: [{ txid, wtxid: '9'.repeat(64), anchor: fixture.status.coreTip,
      rune: { id: '840000:1', name: 'TEST•RUNE', divisibility: 2, symbol: null },
      inputs: [{ ...fixture.utxos[0]!.outpoint, scriptPubKey: fixture.utxos[0]!.scriptPubKey, amount: '1000' }],
      outputs: [{ vout: 1, scriptPubKey: fixture.utxos[1]!.scriptPubKey, amount: '400' }, { vout: 2, scriptPubKey: fixture.utxos[0]!.scriptPubKey, amount: '600' }], status: 'confirmed', timestamp: fixture.status.timestamp }] }));
    const list = await fixture.service.runeList(fixture.input);
    expect(list.transfers.find((item) => item.txid === txid)).toMatchObject({ amount: '400', direction: 'sent', status: 'confirmed' });
    expect(fixture.broadcasts).toHaveLength(0);
  });
  it('deduplicates preserved historical receipts against current owned outputs', async () => {
    const fixture = await setup(); const point = fixture.utxos[0]!;
    fixture.setOnHistory((response) => ({ ...response, receipts: [{ ...point.outpoint, scriptPubKey: point.scriptPubKey,
      rune: { id: '840000:1', name: 'TEST•RUNE', divisibility: 2, symbol: null, amount: '1000' }, timestamp: fixture.status.timestamp }] }));
    const list = await fixture.service.runeList(fixture.input);
    expect(list.transfers.filter((item) => item.txid === point.outpoint.txid)).toHaveLength(1);
    expect(list.transfers.find((item) => item.txid === point.outpoint.txid)?.amount).toBe('1000');
  });
  it('rejects history responses for a different request without hiding current holdings', async () => {
    const fixture = await setup(); fixture.setOnHistory((response) => ({ ...response, requestedScriptHashes: ['f'.repeat(64)], historyComplete: true }));
    const list = await fixture.service.runeList(fixture.input);
    expect(list.status).toBe('ready'); expect(list.historyComplete).toBe(false); expect(list.holdings).toHaveLength(1);
  });
  it('records a fresh confirmed exact-input conflict without another dispatch', async () => {
    const fixture = await setup(); const review = await fixture.prepare();
    const sent = await fixture.service.runeApprove({ ...fixture.input, planId: review.planId, planHash: review.planHash });
    fixture.setOnHistory((response) => ({ ...response, reconciliation: (response.reconciliation as Array<Record<string, unknown>>).map((item) => ({ ...item, status: 'conflicted', confirmedSpenderTxid: 'f'.repeat(64) })) }));
    const list = await fixture.service.runeList(fixture.input);
    expect(list.transfers.find((item) => item.txid === sent.txid)?.status).toBe('conflicted');
    const session = await getSession(fixture.session); const dek = base64ToBytes(session!.dekB64);
    const record = await fixture.cache.get({ vaultId: fixture.input.expectedVaultId, network: 'signet', type: 'runeTransfers', key: sent.txid });
    expect(openRecord(dek, record!, runeJournalSchema).resolution?.status).toBe('conflicted'); dek.fill(0);
    expect(fixture.broadcasts).toHaveLength(1);
  });

});

describe('Rune display latency', () => {
  it('exposes fresh holdings before history returns and clears them on lock', async () => {
    const fixture = await setup();
    const reached = deferred(); const resume = deferred();
    fixture.setHistoryWait(async () => { reached.resolve(); await resume.promise; });
    const list = fixture.service.runeList(fixture.input);
    await reached.promise;
    const snapshot = await fixture.service.runeSnapshot(fixture.input);
    expect(snapshot.data?.holdings[0]?.total).toBe('1000');
    expect(snapshot.data?.historyComplete).toBe(false);
    resume.resolve(); await list;
    await fixture.service.lock();
    await expect(fixture.service.runeSnapshot(fixture.input)).rejects.toThrow();
    expect(fixture.session.store.has('drey:runeSnapshot')).toBe(false);
  });
});

describe('Rune display with unconfirmed outputs', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  async function withPending() {
    const fixture = await setup();
    for (const [index, lane] of (['payment', 'ordinals'] as const).entries()) {
      const derived = derivePublicAccountAddress(publicAccountFromSeed(mnemonicToSeed(phrase), 'signet', 0), lane, 1, index);
      fixture.utxos.push({ outpoint: { txid: String(index + 7).repeat(64), vout: 0 }, valueSats: lane === 'payment' ? 50000n : 546n,
        scriptPubKey: derived.scriptPubKeyHex, accountId: fixture.input.accountId, account: 0, lane, chain: 1, addressIndex: index, height: null,
        walletCreatedChange: lane === 'payment', flags: { userFrozen: false, dustQuarantined: false },
        // Real scan facts: proven own payment change (core paymentChangeFacts)
        // versus any other mempool output (degraded, identity unknown).
        facts: lane === 'payment'
          ? { primaryClass: 'cardinal_clean', inscriptions: [], satRanges: null, unsupportedAssetDetected: false, detectedAssets: [], detectedAssetCount: 0,
            assetIdentityComplete: true, confidence: 'authoritative', classifiedTip: fixture.status.coreTip, classificationRevision: fixture.status.activeRevision }
          : { primaryClass: 'unknown', inscriptions: [], satRanges: null, unsupportedAssetDetected: false,
            confidence: 'degraded', classifiedTip: fixture.status.coreTip, classificationRevision: fixture.status.activeRevision } });
    }
    await fixture.writeUtxos();
    return fixture;
  }
  it('keeps confirmed balances visible and reports unconfirmed outputs', async () => {
    const fixture = await withPending();
    const list = await fixture.service.runeList(fixture.input);
    expect(list.status).toBe('ready');
    expect(list.holdings).toMatchObject([{ name: 'TEST•RUNE', total: '1000', available: '1000', constrained: [] }]);
    expect(list.unconfirmedOutputs).toBe(2);
    // Unconfirmed wallet change is never Rune fee funding (core cleanFunding).
    expect(list.feeFundingSats).toBe('10000');
    expect((await fixture.service.runeSnapshot(fixture.input)).data?.unconfirmedOutputs).toBe(2);
  });
  it('reports no unconfirmed outputs when everything is confirmed', async () => {
    const fixture = await setup();
    expect((await fixture.service.runeList(fixture.input)).unconfirmedOutputs).toBe(0);
  });
  it('reviews a transfer while an unrelated output is unconfirmed', async () => {
    const fixture = await withPending();
    expect((await fixture.prepare()).amount).toBe('400');
    expect(fixture.broadcasts).toHaveLength(0);
  });
  it('still refuses incomplete evidence for a confirmed output', async () => {
    const fixture = await setup(); fixture.setIncompleteConfirmed(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await fixture.service.runeList(fixture.input)).status).toBe('unavailable');
    expect(warn.mock.calls).toEqual([['Rune balances unavailable: ERR_DATA_STALE/binding_mismatch']]);
  });
  it('logs a bounded reason once per change without wallet data', async () => {
    const fixture = await setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const setScanComplete = async (complete: boolean) => {
      const session = await getSession(fixture.session); const dek = base64ToBytes(session!.dekB64);
      const key = { vaultId: fixture.input.expectedVaultId, network: 'signet' as const, type: 'accountsMeta' as const, key: 'all' };
      const meta = openRecord(dek, (await fixture.cache.get(key))!, accountsMetaReadSchema);
      try { await fixture.cache.put(sealRecord(dek, { ...meta, lastCompletedScanId: complete ? 'scan' : null }, key, new Uint8Array(24).fill(7), fixture.clock.now)); }
      finally { dek.fill(0); }
    };
    await setScanComplete(false);
    expect((await fixture.service.runeList(fixture.input)).status).toBe('unavailable');
    expect((await fixture.service.runeList(fixture.input)).status).toBe('unavailable');
    expect(warn.mock.calls).toEqual([['Rune balances unavailable: ERR_DATA_STALE/scan_incomplete']]);
    await setScanComplete(true);
    expect((await fixture.service.runeList(fixture.input)).status).toBe('ready');
    fixture.setIncompleteConfirmed(true);
    await fixture.service.runeList(fixture.input);
    expect(warn.mock.calls.map(([message]) => message)).toEqual([
      'Rune balances unavailable: ERR_DATA_STALE/scan_incomplete', 'Rune balances unavailable: ERR_DATA_STALE/binding_mismatch']);
    for (const [message] of warn.mock.calls) expect(String(message)).not.toMatch(/[0-9a-f]{16}|bc1|tb1|[0-9]{3,}/u);
  });
});

describe('Rune refresh after a new block', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  it('starts one refresh scan per gateway source while stored facts lag it', async () => {
    const fixture = await setup();
    fixture.utxos[0]!.facts!.classifiedTip = { height: fixture.status.coreTip.height - 1, hash: 'f'.repeat(64) };
    await fixture.writeUtxos();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const scans = vi.spyOn(fixture.service, 'startScan').mockResolvedValue({ scanId: 'refresh' });
    const request = { mode: 'refresh', expectedVaultId: fixture.input.expectedVaultId, expectedSessionId: fixture.input.expectedSessionId };
    expect((await fixture.service.runeList(fixture.input)).status).toBe('unavailable');
    await fixture.service.runeList(fixture.input);
    expect(scans.mock.calls).toEqual([[request]]);
    const tip = { height: fixture.status.coreTip.height + 1, hash: 'e'.repeat(64) };
    Object.assign(fixture.status, { coreTip: tip, indexTip: tip, historyTip: tip, ordTip: tip });
    await fixture.service.runeList(fixture.input);
    expect(scans.mock.calls).toEqual([[request], [request]]);
  });
  it('does not rescan a refusal while stored facts are current', async () => {
    const fixture = await setup(); fixture.setIncompleteConfirmed(true);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const scans = vi.spyOn(fixture.service, 'startScan');
    expect((await fixture.service.runeList(fixture.input)).status).toBe('unavailable');
    expect(scans).not.toHaveBeenCalled();
  });
});
