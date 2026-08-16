/**
 * Service-level scan tests over the committed gateway scenario fixtures:
 * end-to-end restore → scan → real home balances (§10.2), wrong-lane
 * detection (§12), locked-privacy of the cache, and the MV3 restart
 * simulation (interrupted checkpoint → resume without re-scanning done
 * units).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreFixturesDir } from '../helpers/core-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { Address, OutScript, TEST_NETWORK } from '@scure/btc-signer';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import {
  inscriptionApprovalBatchResponseSchema,
  statusCapabilitiesSchema,
  type SnapshotHistoryEntry,
} from '@drey/core/domain/gateway/contract';
import type { GatewayClient } from '@drey/core/gateway-client';
import { getSession } from '../../src/adapters/session/session-store';
import { MemoryWalletCache } from '../../src/adapters/storage/wallet-cache-idb';
import { openRecord, sealRecord } from '../../src/adapters/storage/wallet-cache';
import {
  GALLERY_MEDIA_LEASE_TTL_MS,
  type WalletService,
} from '../../src/background/wallet-service';
import { buildAccountKeyRing, windowScriptHashes } from '@drey/core/scan/address-window';
import {
  galleryRecordSchema,
  scanCheckpointSchema,
  type GalleryRecord,
} from '@drey/core/scan/cache-schemas';
import { buildScanUnits } from '@drey/core/scan/scan-state';
import { mnemonicToSeed } from '@drey/core/domain/keys/mnemonic';
import { publicAccountFromSeed } from '@drey/core/domain/accounts/public-account';
import { base64ToBytes } from '@drey/core/domain/vault/encoding';
import { makeHarness, type Harness } from './service-helpers';
import {
  GALLERY_PREVIEW_UNAVAILABLE,
  OP_SCHEMAS,
  type GalleryCachedItem,
} from '@drey/core/messaging/ops';
import { GALLERY_PREVIEW_CACHE_KEY } from '../../src/adapters/gateway/preview-cache';
import { VAULTS_KEY } from '../../src/adapters/storage/keys';

const fixturesDir = join(coreFixturesDir, 'gateway');

const DEV_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'correct horse battery staple';

function accountId(account: number, mnemonic = DEV_MNEMONIC): string {
  return publicAccountFromSeed(mnemonicToSeed(mnemonic), 'signet', account).accountId;
}

const addressScript = (address: string): string =>
  Array.from(OutScript.encode(Address(TEST_NETWORK).decode(address)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');

interface Scenario {
  utxosByScriptHash: Record<string, unknown[]>;
  historyByScriptHash: Record<string, unknown[]>;
  classificationsByOutpoint: Record<string, Record<string, unknown>>;
  envelopeOverrides?: { classificationRevision?: string };
}

const scenariosFile = JSON.parse(
  readFileSync(join(fixturesDir, 'snapshot-scenarios.json'), 'utf8'),
) as {
  derived: Record<string, { address: string; scriptHash: string }>;
  scenarios: Record<string, Scenario>;
};

const statusTemplate = statusCapabilitiesSchema.parse(
  JSON.parse(readFileSync(join(fixturesDir, 'status.signed.json'), 'utf8')),
);
const inscriptionBatchTemplate = inscriptionApprovalBatchResponseSchema.parse(
  JSON.parse(readFileSync(join(fixturesDir, 'inscription.approval-batch.signed.json'), 'utf8')),
);

interface FakeGatewayOptions {
  scenario: string;
  clock: { now: number };
  /** Fail this many snapshot calls with a network error before succeeding. */
  failSnapshotsAfter?: number;
  /** Fail any snapshot whose request includes this script hash (until heal()). */
  failWhenRequestIncludes?: string;
  /** Return a skewed classify revision whenever this txid is in the batch. */
  skewClassifyForTxid?: string;
  /** Additional per-script history for synthetic multi-account coverage. */
  extraHistoryByScriptHash?: Record<string, unknown[]>;
  /** Scripts whose history is intentionally bounded but still proves use. */
  limitedHistoryScriptHashes?: string[];
  /** Transform signed classification fixtures before returning them. */
  mutateClassification?: (
    classification: Record<string, unknown>,
  ) => Record<string, unknown>;
  /** Mutable signed status authority for block/revision transition coverage. */
  statusControl?: {
    classificationRevision: string;
    tip: typeof statusTemplate.coreTip;
  };
}

function makeFakeGateway(options: FakeGatewayOptions) {
  const counts = { snapshot: 0, classify: 0, media: 0 };
  const state = {
    failing:
      options.failSnapshotsAfter !== undefined || options.failWhenRequestIncludes !== undefined,
    skewClassifyForTxid: options.skewClassifyForTxid,
  };
  const scenario = scenariosFile.scenarios[options.scenario];
  if (!scenario) throw new Error(`unknown scenario ${options.scenario}`);
  const revision = scenario.envelopeOverrides?.classificationRevision ?? 'rev-0001';
  const currentRevision = () => options.statusControl?.classificationRevision ?? revision;
  const currentActiveRevision = () =>
    options.statusControl?.classificationRevision ?? statusTemplate.activeRevision;
  const currentTip = () => options.statusControl?.tip ?? statusTemplate.coreTip;
  const iso = () => new Date(options.clock.now).toISOString();
  const envelope = () => ({
    instanceId: statusTemplate.instanceId,
    network: 'signet' as const,
    protocolVersion: 1,
    requestNonce: '00'.repeat(16),
    timestamp: iso(),
    coreTip: currentTip(),
    indexTip: currentTip(),
    classificationRevision: currentRevision(),
    capabilities: statusTemplate.capabilities,
    signature: 'aa',
  });
  const gateway = {
    endpoint: 'http://fake-gateway',
    fetchStatus: () =>
      Promise.resolve({
        ok: true as const,
        status: {
          ...statusTemplate,
          timestamp: iso(),
          mempoolObservedAt: iso(),
          serverTime: iso(),
          coreTip: currentTip(),
          indexTip: currentTip(),
          historyTip: currentTip(),
          ordTip: currentTip(),
          classificationRevision: currentActiveRevision(),
          activeRevision: currentActiveRevision(),
        },
        verifiedAtMs: options.clock.now,
      }),
    fetchSnapshot: (req: { scriptHashes: string[] }) => {
      counts.snapshot += 1;
      const countTriggered =
        options.failSnapshotsAfter !== undefined && counts.snapshot > options.failSnapshotsAfter;
      const hashTriggered =
        options.failWhenRequestIncludes !== undefined &&
        req.scriptHashes.includes(options.failWhenRequestIncludes);
      if (state.failing && (countTriggered || hashTriggered)) {
        return Promise.resolve({ ok: false as const, reason: 'network_error' as const });
      }
      const utxos = req.scriptHashes.flatMap((h) => scenario.utxosByScriptHash[h] ?? []);
      const seen = new Set<string>();
      const history = req.scriptHashes
        .flatMap((h) => [
          ...(scenario.historyByScriptHash[h] ?? []),
          ...(options.extraHistoryByScriptHash?.[h] ?? []),
        ])
        .filter((entry) => {
          const txid = (entry as { txid: string }).txid;
          if (seen.has(txid)) return false;
          seen.add(txid);
          return true;
        });
      const limited = req.scriptHashes.filter((hash) =>
        options.limitedHistoryScriptHashes?.includes(hash));
      const activeSet = new Set([
        ...utxos.map((utxo) => (utxo as { scriptHash: string }).scriptHash),
        ...history.flatMap((entry) => [
          ...(entry as { fundedScriptHashes: string[] }).fundedScriptHashes,
          ...(entry as { spentScriptHashes: string[] }).spentScriptHashes,
        ]),
        ...limited,
      ]);
      return Promise.resolve({
        ok: true as const,
        value: {
          ...envelope(),
          requestedScriptHashes: req.scriptHashes,
          utxos,
          history,
          activeScriptHashes: req.scriptHashes.filter((hash) => activeSet.has(hash)),
          historyCoverage: limited.length > 0
            ? { status: 'partial' as const, limitedScriptHashes: limited }
            : { status: 'complete' as const, limitedScriptHashes: [] },
        },
        verifiedAtMs: options.clock.now,
      });
    },
    classifyOutpoints: (req: { outpoints: { txid: string; vout: number }[] }) => {
      counts.classify += 1;
      const skewed =
        state.skewClassifyForTxid !== undefined &&
        req.outpoints.some((o) => o.txid === state.skewClassifyForTxid);
      const classifications: unknown[] = [];
      const unknownOutpoints: unknown[] = [];
      for (const o of req.outpoints) {
        const found = scenario.classificationsByOutpoint[`${o.txid}:${o.vout}`];
        if (found) {
          const current = options.statusControl === undefined
            ? found
            : {
                ...found,
                classifiedTip: currentTip(),
                classificationRevision: currentRevision(),
                confirmations: typeof found['confirmations'] === 'number' &&
                    found['confirmations'] > 0
                  ? found['confirmations'] +
                    (currentTip().height - statusTemplate.coreTip.height)
                  : found['confirmations'],
              };
          classifications.push(options.mutateClassification?.(current) ?? current);
        }
        else unknownOutpoints.push(o);
      }
      return Promise.resolve({
        ok: true as const,
        value: {
          ...envelope(),
          ...(skewed ? { classificationRevision: 'rev-9999' } : {}),
          classifications,
          unknownOutpoints,
        },
        verifiedAtMs: options.clock.now,
      });
    },
    // Model the rolling-upgrade case: the submitted 0.3.0 gateway does not
    // expose the enriched route, so the worker must retain the original signed
    // gallery-batch behavior.
    fetchInscriptionGalleryEnrichedBatch: () =>
      Promise.resolve({
        ok: false as const,
        reason: 'http' as const,
        httpStatus: 404,
      }),
    fetchInscriptionGalleryBatch: (req: { inscriptions: Array<{ inscriptionId: string }> }) =>
      Promise.resolve({
        ok: true as const,
        value: {
          ...envelope(),
          items: req.inscriptions.map((identity) => {
            const found = inscriptionBatchTemplate.items.find(
              (item) => item.metadata.inscriptionId === identity.inscriptionId,
            );
            if (!found) throw new Error(`missing inscription fixture ${identity.inscriptionId}`);
            return found;
          }),
        },
        verifiedAtMs: options.clock.now,
      }),
    fetchInscriptionMedia: (req: { identity: { inscriptionId: string } }) => {
      counts.media += 1;
      const found = inscriptionBatchTemplate.items.find(
        (item) => item.metadata.inscriptionId === req.identity.inscriptionId,
      );
      if (!found) return Promise.resolve({ ok: false as const, reason: 'schema' as const });
      if (found.preview.disposition !== 'raster') {
        // The media route classifies independently of the preview route: HTML
        // and SVG stay active_content there even though previews render them.
        const mime = found.preview.declaredMime;
        const mediaReason = mime === 'text/html' || mime === 'image/svg+xml'
          ? ('active_content' as const)
          : found.preview.disposition === 'placeholder'
            ? found.preview.reason
            : ('unsupported_content' as const);
        return Promise.resolve({
          ok: true as const,
          value: {
            ...envelope(),
            identity: req.identity,
            media: {
              disposition: 'unavailable' as const,
              reason: mediaReason,
              requestedInscriptionId: req.identity.inscriptionId,
              sourceInscriptionId: found.preview.sourceInscriptionId,
              resolvedInscriptionId: found.preview.resolvedInscriptionId,
              delegateInscriptionId: found.preview.delegateInscriptionId,
              declaredMime: found.preview.declaredMime,
              declaredContentLength: found.preview.declaredContentLength,
              detectedMime: null,
              contentSha256: null,
              contentByteLength: null,
              bytesBase64: null,
              policyRevision: 'm11-gallery-media-v2' as const,
            },
          },
          verifiedAtMs: options.clock.now,
        });
      }
      return Promise.resolve({
        ok: true as const,
        value: {
          ...envelope(),
          identity: req.identity,
          media: {
            disposition: 'media' as const,
            reason: null,
            requestedInscriptionId: req.identity.inscriptionId,
            sourceInscriptionId: req.identity.inscriptionId,
            resolvedInscriptionId: req.identity.inscriptionId,
            delegateInscriptionId: null,
            declaredMime: 'image/png' as const,
            declaredContentLength: found.preview.sourceContentLength,
            detectedMime: 'image/png' as const,
            contentSha256: found.preview.sourceContentSha256,
            contentByteLength: found.preview.sourceContentLength,
            bytesBase64: found.preview.bytesBase64,
            policyRevision: 'm11-gallery-media-v2' as const,
          },
        },
        verifiedAtMs: options.clock.now,
      });
    },
  };
  return {
    gateway: gateway as unknown as GatewayClient,
    counts,
    options,
    heal: () => {
      state.failing = false;
    },
    setSkewClassifyForTxid: (txid: string | undefined) => {
      state.skewClassifyForTxid = txid;
    },
  };
}

async function setupWallet(harness: Harness): Promise<{
  service: WalletService;
  expectation: { expectedVaultId: string; expectedSessionId: string; accountId: string };
}> {
  const { service } = harness;
  const { vaultId } = await service.restore({
    name: 'dev',
    password: PASSWORD,
    mnemonic: DEV_MNEMONIC,
  });
  const unlocked = await service.unlock({ vaultId, password: PASSWORD });
  return {
    service,
    expectation: {
      expectedVaultId: vaultId,
      expectedSessionId: unlocked.sessionId,
      accountId: accountId(0),
    },
  };
}

async function waitForScanEnd(
  service: WalletService,
  expectation: { expectedVaultId: string; expectedSessionId: string; accountId: string },
): Promise<string> {
  for (let i = 0; i < 500; i += 1) {
    const status = await service.scanStatus(expectation);
    if (status.kind !== 'running' && status.kind !== 'idle') return status.kind;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('scan did not settle');
}

beforeAll(async () => {
  await installTestCryptoProvider();
});

describe('discovery scan end-to-end (§8.2, §10.2, §12)', () => {
  it('scans the clean scenario into real home balances', async () => {
    const cache = new MemoryWalletCache();
    const harness = makeHarness(Date.parse('2026-07-20T00:00:05.000Z'), {
      network: 'signet',
      walletCache: cache,
    });
    const fake = makeFakeGateway({ scenario: 'clean', clock: harness.clock });
    const harness2 = makeHarness(harness.clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: fake.gateway,
    });
    const { service, expectation } = await setupWallet(harness2);

    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');

    const passiveDeadline = (await getSession(harness2.session))?.deadline;
    harness2.clock.now += 1_000;
    const home = await service.homeView(expectation);
    // clean scenario: payment ext0 123456 + 50000, int0 change 32100 — all
    // confirmed cardinal_clean and fresh; ordinals inscription is Protected.
    expect(home.balances.availableSats).toBe('205556');
    expect(home.balances.protectedSats).toBe('10000');
    expect(home.balances.reservedSats).toBe('0');
    expect(home.collectiblesCount).toBe(1);
    expect(home.wrongLaneCount).toBe(0);
    expect(home.dataGating.state).toBe('fresh');
    expect(home.activity.length).toBeGreaterThan(0);
    expect(home.lastSyncedAt).not.toBeNull();

    // Adaptive restore stops after the first unused standard account instead
    // of scanning the entire supported account range.
    expect(fake.counts.snapshot).toBeLessThan(20);

    const beforeRefresh = fake.counts.snapshot;
    await service.startScan({ mode: 'refresh', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    // Live refresh polls only account 0's known-active lanes; each lane needs
    // at most one gap-window extension for the index-0 activity fixture.
    expect(fake.counts.snapshot - beforeRefresh).toBeLessThanOrEqual(4);
    expect((await service.homeView(expectation)).balances.availableSats).toBe('205556');
    expect((await getSession(harness2.session))?.deadline).toBe(passiveDeadline);
  });

  it('retains one exact session/account Home snapshot and clears it on lock', async () => {
    const cache = new MemoryWalletCache();
    const seeded = makeHarness(Date.parse('2026-07-20T00:00:05.000Z'), {
      network: 'signet', walletCache: cache,
    });
    const fake = makeFakeGateway({ scenario: 'clean', clock: seeded.clock });
    const harness = makeHarness(seeded.clock.now, {
      network: 'signet', walletCache: cache, gateway: fake.gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    const live = await service.homeView(expectation);

    await expect(service.homeSnapshot(expectation)).resolves.toEqual({ home: live });
    const restarted = harness.rebuild();
    await expect(restarted.homeSnapshot(expectation)).resolves.toEqual({ home: live });
    await expect(restarted.homeSnapshot({
      ...expectation,
      expectedSessionId: '00000000-0000-4000-8000-000000000099',
    })).rejects.toMatchObject({ code: 'ERR_LOCKED' });
    await expect(service.homeSnapshot({
      ...expectation,
      accountId: accountId(1),
    })).resolves.toEqual({ home: null });

    // A mismatched read self-repairs the single-slot record rather than ever
    // making one account's balances available under another account identity.
    await expect(service.homeSnapshot(expectation)).resolves.toEqual({ home: null });
    await restarted.homeView(expectation);
    await restarted.lock();
    await expect(restarted.homeSnapshot(expectation)).rejects.toMatchObject({ code: 'ERR_LOCKED' });
  });

  it('reports scanned payment UTXOs as eligible to coin control', async () => {
    const cache = new MemoryWalletCache();
    const seeded = makeHarness(Date.parse('2026-07-20T00:00:05.000Z'), {
      network: 'signet',
      walletCache: cache,
    });
    const fake = makeFakeGateway({ scenario: 'clean', clock: seeded.clock });
    const harness = makeHarness(seeded.clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: fake.gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');

    // Coin control derives eligibility from the verified status cache, which
    // listUtxos primes before reading. Without that priming a cold cache makes
    // freshness all-false and every coin renders unspendable.
    const passiveDeadline = (await getSession(harness.session))?.deadline;
    harness.clock.now += 1_000;
    const { utxos } = await service.listUtxos({ ...expectation, feeRateSatPerKvB: 5000 });
    const payment = utxos.filter((utxo) => utxo.lane === 'payment');
    expect(payment.length).toBeGreaterThan(0);
    expect(payment.every((utxo) => utxo.eligible)).toBe(true);
    expect(payment.every((utxo) => utxo.reasons.length === 0)).toBe(true);
    // The Ordinals-lane inscription stays protected rather than spendable.
    expect(utxos.some((utxo) => utxo.lane === 'ordinals' && !utxo.eligible)).toBe(true);
    expect((await getSession(harness.session))?.deadline).toBe(passiveDeadline);
  });

  it('joins a concurrent scan start instead of launching a second loop', async () => {
    const build = async () => {
      const cache = new MemoryWalletCache();
      const seeded = makeHarness(Date.parse('2026-07-20T00:00:05.000Z'), {
        network: 'signet',
        walletCache: cache,
      });
      const fake = makeFakeGateway({ scenario: 'clean', clock: seeded.clock });
      const harness = makeHarness(seeded.clock.now, {
        network: 'signet',
        walletCache: cache,
        gateway: fake.gateway,
      });
      return { fake, ...(await setupWallet(harness)) };
    };

    // Baseline cost of exactly one scan, measured on an identical fresh wallet.
    const single = await build();
    await single.service.startScan({ mode: 'initial', ...single.expectation });
    expect(await waitForScanEnd(single.service, single.expectation)).toBe('completed');

    // scanRun/currentScanId only publish after an awaited prep section, so two
    // starts racing through it must still produce exactly one scan — a second
    // loop would duplicate every gateway request and interleave checkpoint
    // writes for a different scan id.
    const raced = await build();
    const [first, second] = await Promise.all([
      raced.service.startScan({ mode: 'initial', ...raced.expectation }),
      raced.service.startScan({ mode: 'initial', ...raced.expectation }),
    ]);
    expect(first.scanId).toBe(second.scanId);
    expect(await waitForScanEnd(raced.service, raced.expectation)).toBe('completed');
    expect(raced.fake.counts.snapshot).toBe(single.fake.counts.snapshot);
    expect(raced.fake.counts.classify).toBe(single.fake.counts.classify);
    expect((await raced.service.homeView(raced.expectation)).balances.availableSats)
      .toBe('205556');
  });

  it('does not fail a concurrent fresh scan when an overlapping resume has nothing to resume', async () => {
    const cache = new MemoryWalletCache();
    const seeded = makeHarness(Date.parse('2026-07-20T00:00:05.000Z'), {
      network: 'signet',
      walletCache: cache,
    });
    const fake = makeFakeGateway({ scenario: 'clean', clock: seeded.clock });
    const harness = makeHarness(seeded.clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: fake.gateway,
    });
    const { service, expectation } = await setupWallet(harness);

    // A resume with no checkpoint is rejected during prep. A fresh scan racing
    // it must run on its own terms rather than inheriting that rejection.
    const resume = service.startScan({ mode: 'resume', ...expectation });
    const initial = service.startScan({ mode: 'initial', ...expectation });
    await expect(resume).rejects.toMatchObject({ code: 'ERR_INVALID_PAYLOAD' });
    await expect(initial).resolves.toMatchObject({ scanId: expect.any(String) });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    expect((await service.homeView(expectation)).balances.availableSats).toBe('205556');
  });

  it('discovers more than twenty consecutively used accounts, then refreshes without polling empty lanes', async () => {
    const walletChanges: string[] = [];
    const seed = mnemonicToSeed(DEV_MNEMONIC);
    const units = buildScanUnits('signet', false);
    const ring = buildAccountKeyRing(seed, 'signet', units);
    seed.fill(0);
    const extraHistoryByScriptHash: Record<string, unknown[]> = {};
    for (let account = 0; account < 25; account += 1) {
      const unit = { source: 'standard' as const, account, lane: 'payment' as const };
      const hash = windowScriptHashes(ring, unit, 0, 0, 1)[0]!.scriptHash;
      extraHistoryByScriptHash[hash] = [{
        txid: account.toString(16).padStart(64, '0'),
        height: 249_900,
        timestamp: null,
        fundedScriptHashes: [hash],
        spentScriptHashes: [],
        deltaSats: '1',
        replacesTxid: null,
        replacedByTxid: null,
        confirmationState: 'confirmed',
        feeSats: null,
        vsize: null,
        replaceable: false,
        packageFeeSats: null,
        packageVsize: null,
        cpfpEligible: false,
      }];
    }
    ring.standard.clear();
    ring.legacy.clear();

    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const fake = makeFakeGateway({ scenario: 'clean', clock, extraHistoryByScriptHash });
    const harness = makeHarness(clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: fake.gateway,
      notifyWalletDataChanged: (reason) => walletChanges.push(reason),
    });
    const { service, expectation } = await setupWallet(harness);

    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    expect((await service.sessionSnapshot()).selectableAccounts)
      .toEqual(Array.from({ length: 25 }, (_, account) => account));
    // Active payment lanes take two windows each; the empty ordinal lanes and
    // bounded legacy probes still stop immediately after the first unused account.
    expect(fake.counts.snapshot).toBeLessThan(120);

    walletChanges.length = 0;
    await service.setActiveAccount({ ...expectation, accountId: accountId(24) });
    expect(walletChanges).toEqual(['account']);
    const beforeRefresh = fake.counts.snapshot;
    await service.startScan({ mode: 'refresh', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    // All known-active payment lanes remain fresh; both lanes are additionally
    // probed for account 0 and the selected account. No fixed
    // discovery window is reintroduced.
    expect(fake.counts.snapshot - beforeRefresh).toBeLessThanOrEqual(60);
  }, 15_000);

  it('persists one explicit empty account and blocks skipping or adding past it', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const harness = makeHarness(clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: makeFakeGateway({ scenario: 'clean', clock }).gateway,
    });
    const { service, expectation } = await setupWallet(harness);

    await expect(service.addAccount(expectation)).rejects.toMatchObject({
      code: 'ERR_INVALID_PAYLOAD',
    });
    await expect(
      service.setActiveAccount({ ...expectation, accountId: accountId(1) }),
    ).rejects.toMatchObject({ code: 'ERR_INVALID_PAYLOAD' });

    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    expect(await service.sessionSnapshot()).toMatchObject({
      activeAccount: 0,
      selectableAccounts: [0],
      canAddAccount: true,
    });

    expect(await service.addAccount(expectation)).toEqual({ accountId: accountId(1), account: 1 });
    expect(await service.sessionSnapshot()).toMatchObject({
      activeAccount: 1,
      selectableAccounts: [0, 1],
      canAddAccount: false,
    });
    await expect(service.addAccount(expectation)).rejects.toMatchObject({
      code: 'ERR_INVALID_PAYLOAD',
    });
    await expect(
      service.setActiveAccount({ ...expectation, accountId: accountId(2) }),
    ).rejects.toMatchObject({ code: 'ERR_INVALID_PAYLOAD' });

    await service.startScan({ mode: 'rescan', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    expect((await service.sessionSnapshot()).selectableAccounts).toEqual([0, 1]);

    expect(await service.listAccounts(expectation)).toMatchObject({
      accounts: [
        { account: 0, active: false, hidden: false, hideBlocker: 'holdings' },
        { account: 1, active: true, hidden: false, hideBlocker: 'active' },
      ],
    });
    await expect(
      service.setAccountVisibility({ ...expectation, accountId: accountId(1), hidden: true }),
    ).rejects.toMatchObject({ code: 'ERR_INVALID_PAYLOAD' });

    await service.setActiveAccount({ ...expectation, accountId: accountId(0) });
    expect(await service.listAccounts(expectation)).toMatchObject({
      accounts: [
        { account: 0, active: true, hidden: false, hideBlocker: 'active' },
        { account: 1, active: false, hidden: false, canHide: true, hideBlocker: null },
      ],
    });
    expect(await service.setAccountVisibility({
      ...expectation,
      accountId: accountId(1),
      hidden: true,
    })).toEqual({ accountId: accountId(1), account: 1, hidden: true });
    expect(await service.sessionSnapshot()).toMatchObject({
      activeAccount: 0,
      selectableAccounts: [0],
      canAddAccount: false,
    });
    await expect(
      service.setActiveAccount({ ...expectation, accountId: accountId(1) }),
    ).rejects.toMatchObject({ code: 'ERR_INVALID_PAYLOAD' });
    expect(await service.setAccountVisibility({
      ...expectation,
      accountId: accountId(1),
      hidden: false,
    })).toEqual({ accountId: accountId(1), account: 1, hidden: false });
    expect((await service.sessionSnapshot()).selectableAccounts).toEqual([0, 1]);
  });

  it('automatically shows a hidden account when a later scan finds pending activity', async () => {
    const extraHistoryByScriptHash: Record<string, unknown[]> = {};
    const walletChanges: string[] = [];
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const harness = makeHarness(clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: makeFakeGateway({ scenario: 'clean', clock, extraHistoryByScriptHash }).gateway,
      notifyWalletDataChanged: (reason) => walletChanges.push(reason),
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    await service.addAccount(expectation);
    await service.startScan({ mode: 'rescan', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    await service.setActiveAccount({ ...expectation, accountId: accountId(0) });
    await service.setAccountVisibility({ ...expectation, accountId: accountId(1), hidden: true });
    expect((await service.sessionSnapshot()).selectableAccounts).toEqual([0]);

    const seed = mnemonicToSeed(DEV_MNEMONIC);
    const ring = buildAccountKeyRing(seed, 'signet', buildScanUnits('signet', false));
    seed.fill(0);
    const unit = { source: 'standard' as const, account: 1, lane: 'payment' as const };
    const hash = windowScriptHashes(ring, unit, 0, 0, 1)[0]!.scriptHash;
    ring.standard.clear();
    ring.legacy.clear();
    extraHistoryByScriptHash[hash] = [{
      txid: '9'.repeat(64),
      height: null,
      timestamp: null,
      fundedScriptHashes: [hash],
      spentScriptHashes: [],
      deltaSats: '1',
      replacesTxid: null,
      replacedByTxid: null,
      confirmationState: 'mempool',
      feeSats: null,
      vsize: null,
      replaceable: false,
      packageFeeSats: null,
      packageVsize: null,
      cpfpEligible: false,
    }];

    walletChanges.length = 0;
    await service.startScan({ mode: 'refresh', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    expect((await service.sessionSnapshot()).selectableAccounts).toEqual([0, 1]);
    expect(await service.listAccounts(expectation)).toMatchObject({
      accounts: expect.arrayContaining([expect.objectContaining({
        account: 1,
        active: false,
        hidden: false,
        hasHistory: true,
        canHide: false,
        hideBlocker: 'pending',
      })]),
    });
    expect(walletChanges).toContain('account');
  });

  it('does not hide an account with a pending mempool transaction', async () => {
    const seed = mnemonicToSeed(DEV_MNEMONIC);
    const ring = buildAccountKeyRing(seed, 'signet', buildScanUnits('signet', false));
    seed.fill(0);
    const unit = { source: 'standard' as const, account: 1, lane: 'payment' as const };
    const hash = windowScriptHashes(ring, unit, 0, 0, 1)[0]!.scriptHash;
    ring.standard.clear();
    ring.legacy.clear();

    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const gateway = makeFakeGateway({
      scenario: 'clean',
      clock,
      extraHistoryByScriptHash: {
        [hash]: [{
          txid: '8'.repeat(64),
          height: null,
          timestamp: null,
          fundedScriptHashes: [hash],
          spentScriptHashes: [],
          deltaSats: '0',
          replacesTxid: null,
          replacedByTxid: null,
          confirmationState: 'mempool',
          feeSats: null,
          vsize: null,
          replaceable: false,
          packageFeeSats: null,
          packageVsize: null,
          cpfpEligible: false,
        }],
      },
    });
    const harness = makeHarness(clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: gateway.gateway,
    });
    const { service, expectation } = await setupWallet(harness);

    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    expect(await service.listAccounts(expectation)).toMatchObject({
      accounts: expect.arrayContaining([expect.objectContaining({
        account: 1,
        active: false,
        hidden: false,
        canHide: false,
        hideBlocker: 'pending',
      })]),
    });
    await expect(
      service.setAccountVisibility({ ...expectation, accountId: accountId(1), hidden: true }),
    ).rejects.toMatchObject({ code: 'ERR_INVALID_PAYLOAD' });
  });

  it('detects both §12 wrong-lane states', async () => {
    for (const [scenario, expected] of [
      ['wrong_lane_inscription_at_payment', { wrongLaneCount: 1, reserved: '0' }],
      ['wrong_lane_btc_at_ordinals', { wrongLaneCount: 0, reserved: '200000' }],
    ] as const) {
      const cache = new MemoryWalletCache();
      const harness = makeHarness(Date.parse('2026-07-20T00:00:05.000Z'), {
        network: 'signet',
        walletCache: cache,
        gateway: makeFakeGateway({ scenario, clock: { now: Date.parse('2026-07-20T00:00:05.000Z') } })
          .gateway,
      });
      const { service, expectation } = await setupWallet(harness);
      await service.startScan({ mode: 'initial', ...expectation });
      expect(await waitForScanEnd(service, expectation)).toBe('completed');
      const home = await service.homeView(expectation);
      expect(home.wrongLaneCount, scenario).toBe(expected.wrongLaneCount);
      expect(home.balances.reservedSats, scenario).toBe(expected.reserved);
      if (scenario === 'wrong_lane_inscription_at_payment') {
        expect(home.wrongLane).toHaveLength(1);
        expect(home.wrongLane[0]?.lane).toBe('payment');
        // The wrong-lane inscription counts as Protected, never Available.
        expect(home.balances.protectedSats).toBe('10000');
        expect(home.balances.availableSats).toBe('90000');
        // This fixture sits at payment external index 1, so the selected
        // account summary includes it once even though Home exposes its Rescue
        // state separately from ordinary spendable value.
        expect(await service.sessionSnapshot()).toMatchObject({
          activeRecoveredAddressCount: 1,
        });
        expect((await service.galleryList({ ...expectation })).recoveredAddressCount)
          .toBe(1);
      }
    }
  }, 10_000);

  it('stale revision gates spending but keeps cached reads (§11.4, §18.4)', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const harness = makeHarness(clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: makeFakeGateway({ scenario: 'stale', clock }).gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    const home = await service.homeView(expectation);
    // UTXO revision rev-0000 ≠ activeRevision rev-0001: clean value is
    // visible but NOT spendable-available.
    expect(home.balances.availableSats).toBe('0');
    expect(home.balances.unavailableCleanSats).toBe('123456');
    expect(home.balances.protectedSats).toBe('10000');
    // §11.4 surface: the stale cached revision must GATE, not read as fresh —
    // available=0 with a "fresh" banner would be inexplicable and M7 flows
    // key off blockedActions.
    expect(home.dataGating.state).toBe('index_lag');
    expect(home.dataGating.blockedActions).toContain('native_send');
  });

  it('persists partial-history coverage while keeping used zero-balance addresses active', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const used = scenariosFile.derived['a0:payment:0:18'];
    if (!used) throw new Error('missing bounded-history address fixture');
    const fake = makeFakeGateway({
      scenario: 'clean',
      clock,
      limitedHistoryScriptHashes: [used.scriptHash],
    });
    const harness = makeHarness(clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: fake.gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    await expect(service.scanStatus(expectation)).resolves.toMatchObject({
      kind: 'completed',
      historyPartial: true,
    });
    const home = await service.homeView(expectation);
    expect(home.historyComplete).toBe(false);
    expect(home.balances.availableSats).toBe('205556');
    await expect(service.activityList({
      ...expectation,
      accountId: accountId(0),
    })).resolves.toMatchObject({ historyComplete: false });

    const restarted = harness.rebuild();
    await expect(restarted.homeView(expectation)).resolves.toMatchObject({
      historyComplete: false,
      balances: { availableSats: '205556' },
    });
  });

  it('MV3 restart: failed scan leaves a resumable checkpoint; resume skips done units', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    // Fail after the first 3 snapshot calls; adaptive discovery checkpoints
    // only the unfinished bounded queue and resumes without replaying done work.
    const failing = makeFakeGateway({ scenario: 'clean', clock, failSnapshotsAfter: 3 });
    const harness = makeHarness(clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: failing.gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('failed');

    // Worker restart: fresh service over the SAME stores, cache, and (now
    // healed) gateway. The session rehydrates from the session store.
    failing.heal();
    const callsBeforeResume = failing.counts.snapshot;
    const service2 = harness.rebuild();
    const status = await service2.scanStatus(expectation);
    expect(status.kind).toBe('interrupted');
    expect(status.unitsDone).toBeGreaterThan(0);
    const doneBefore = status.unitsDone;

    await service2.startScan({ mode: 'resume', ...expectation });
    expect(await waitForScanEnd(service2, expectation)).toBe('completed');
    // Resume re-scanned only the remaining units (≤2 rounds each, 2 chains).
    const resumeCalls = failing.counts.snapshot - callsBeforeResume;
    expect(resumeCalls).toBeLessThanOrEqual((43 - doneBefore) * 4);
    const home = await service2.homeView(expectation);
    expect(home.balances.availableSats).toBe('205556');
  });

  it('persists the initial checkpoint before the first gateway request settles', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const fake = makeFakeGateway({ scenario: 'clean', clock });
    const stalledGateway: GatewayClient = new Proxy(fake.gateway, {
      get(target, property, receiver) {
        if (property === 'fetchSnapshot') return () => new Promise<never>(() => undefined);
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const harness = makeHarness(clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: stalledGateway,
    });
    const { service, expectation } = await setupWallet(harness);

    await service.startScan({ mode: 'initial', ...expectation });

    // A new service instance models Chrome terminating the original worker
    // while its first snapshot request is still in flight.
    const serviceAfterTermination = harness.rebuild();
    await expect(serviceAfterTermination.scanStatus(expectation)).resolves.toMatchObject({
      kind: 'interrupted',
      unitsDone: 0,
    });
  });

  it('joins a paused descriptor refresh before removal and cannot resurrect it after restart', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const fake = makeFakeGateway({ scenario: 'clean', clock });
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    let markSnapshotStarted!: () => void;
    const snapshotStarted = new Promise<void>((resolve) => { markSnapshotStarted = resolve; });
    let firstSnapshot = true;
    const gateway = {
      ...fake.gateway,
      fetchSnapshot: async (request: Parameters<typeof fake.gateway.fetchSnapshot>[0]) => {
        if (firstSnapshot) {
          firstSnapshot = false;
          markSnapshotStarted();
          await snapshotGate;
        }
        return fake.gateway.fetchSnapshot(request);
      },
    } as GatewayClient;
    const harness = makeHarness(clock.now, {
      network: 'signet', walletCache: cache, gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    const watchSeed = mnemonicToSeed(
      'legal winner thank year wave sausage worth useful legal winner thank yellow',
    );
    const watch = publicAccountFromSeed(watchSeed, 'signet', 7);
    watchSeed.fill(0);
    await service.importWatchAccount({
      name: 'Paused observer',
      network: 'signet',
      paymentReceiveDescriptor: watch.lanes.payment.receiveDescriptor,
      paymentChangeDescriptor: watch.lanes.payment.changeDescriptor,
      ordinalsReceiveDescriptor: watch.lanes.ordinals.receiveDescriptor,
      ordinalsChangeDescriptor: watch.lanes.ordinals.changeDescriptor,
      ...expectation,
    });

    await service.startScan({ mode: 'refresh', ...expectation });
    await snapshotStarted;
    let removalSettled = false;
    const removal = service.removeWatchAccount({ ...expectation, accountId: watch.accountId })
      .finally(() => { removalSettled = true; });
    await Promise.resolve();
    expect(removalSettled).toBe(false);
    releaseSnapshot();
    await expect(removal).resolves.toEqual({ removed: true });

    const restarted = harness.rebuild();
    const snapshot = await restarted.sessionSnapshot();
    expect(snapshot.accountSummaries).not.toContainEqual(expect.objectContaining({
      accountId: watch.accountId,
    }));
    await expect(restarted.scanStatus(expectation)).resolves.toMatchObject({ kind: 'idle' });
    const session = await getSession(harness.session);
    if (!session) throw new Error('missing session after removal');
    const dek = base64ToBytes(session.dekB64);
    const checkpointRecord = await cache.get({
      vaultId: expectation.expectedVaultId, network: 'signet', type: 'scanState', key: 'all',
    });
    const checkpoint = checkpointRecord
      ? openRecord(dek, checkpointRecord, scanCheckpointSchema)
      : null;
    dek.fill(0);
    if (checkpoint) {
      expect([
        ...checkpoint.queue,
        ...checkpoint.done,
        ...(checkpoint.activeUnits ?? []),
        ...(checkpoint.boundaryUnits ?? []),
      ].some((unit) => unit.accountId === watch.accountId)).toBe(false);
    }
    for (const type of ['utxos', 'history'] as const) {
      expect((await cache.listKeys(expectation.expectedVaultId, 'signet', type))
        .some((key) => key.includes(watch.accountId))).toBe(false);
    }
  });

  it.each(['refresh', 'rescan'] as const)(
    'runs a normal descriptor-selected %s without opening the seed vault',
    async (mode) => {
      const cache = new MemoryWalletCache();
      const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
      const fake = makeFakeGateway({ scenario: 'clean', clock });
      const harness = makeHarness(clock.now, {
        network: 'signet', walletCache: cache, gateway: fake.gateway,
      });
      const { service, expectation } = await setupWallet(harness);
      const watchSeed = mnemonicToSeed(
        'legal winner thank year wave sausage worth useful legal winner thank yellow',
      );
      const watch = publicAccountFromSeed(watchSeed, 'signet', 7);
      watchSeed.fill(0);
      await service.importWatchAccount({
        name: 'Public observer',
        network: 'signet',
        paymentReceiveDescriptor: watch.lanes.payment.receiveDescriptor,
        paymentChangeDescriptor: watch.lanes.payment.changeDescriptor,
        ordinalsReceiveDescriptor: watch.lanes.ordinals.receiveDescriptor,
        ordinalsChangeDescriptor: watch.lanes.ordinals.changeDescriptor,
        ...expectation,
      });

      // Keep the live session and encrypted public-account cache but remove the
      // vault record entirely. Any attempt to open the seed now hard-fails.
      harness.local.store.set(VAULTS_KEY, {});
      await service.startScan({ mode, ...expectation });
      expect(await waitForScanEnd(service, expectation)).toBe('completed');

      const session = await getSession(harness.session);
      if (!session) throw new Error('missing descriptor scan session');
      const dek = base64ToBytes(session.dekB64);
      const checkpointRecord = await cache.get({
        vaultId: expectation.expectedVaultId, network: 'signet', type: 'scanState', key: 'all',
      });
      if (!checkpointRecord) throw new Error('missing descriptor checkpoint');
      const checkpoint = openRecord(dek, checkpointRecord, scanCheckpointSchema);
      dek.fill(0);
      expect(checkpoint.done.length).toBeGreaterThan(0);
      expect(checkpoint.done.every((unit) =>
        unit.source === 'descriptor' && unit.accountId === watch.accountId)).toBe(true);
    },
  );

  it('cache stays sealed without a live session (§7.5)', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const harness = makeHarness(clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: makeFakeGateway({ scenario: 'clean', clock }).gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    await service.lock();
    await expect(service.homeView(expectation)).rejects.toMatchObject({ code: 'ERR_LOCKED' });
    // And the records at rest are ciphertext-only.
    const keys = await cache.listKeys(expectation.expectedVaultId, 'signet', 'utxos');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const record = await cache.get({
        vaultId: expectation.expectedVaultId,
        network: 'signet',
        type: 'utxos',
        key,
      });
      expect(JSON.stringify(record)).not.toContain('123456');
    }
  });

  it('user freeze flips only the flag and moves value out of Available (§14.4)', async () => {
    const walletChanges: string[] = [];
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const harness = makeHarness(clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: makeFakeGateway({ scenario: 'clean', clock }).gateway,
      notifyWalletDataChanged: (reason) => walletChanges.push(reason),
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    await waitForScanEnd(service, expectation);
    const before = await service.homeView(expectation);
    const bigUtxoTxid = Object.keys(
      scenariosFile.scenarios['clean']!.classificationsByOutpoint,
    ).find((k) => {
      const record = scenariosFile.scenarios['clean']!.classificationsByOutpoint[k]!;
      return record['valueSats'] === '123456';
    })!;
    const [txid] = bigUtxoTxid.split(':');
    const result = await service.setUtxoFrozen({ txid: txid!, vout: 0, frozen: true, ...expectation });
    expect(result.updated).toBe(true);
    expect(walletChanges).toEqual(['utxo']);
    const after = await service.homeView(expectation);
    expect(BigInt(before.balances.availableSats) - BigInt(after.balances.availableSats)).toBe(
      123_456n,
    );
    expect(after.balances.frozenSats).toBe('123456');

    // Freezing a protected UTXO is rejected outright.
    const inscribed = Object.entries(
      scenariosFile.scenarios['clean']!.classificationsByOutpoint,
    ).find(([, record]) => record['primaryClass'] === 'inscribed')!;
    await expect(
      service.setUtxoFrozen({ txid: inscribed[0].split(':')[0]!, vout: 0, frozen: true, ...expectation }),
    ).rejects.toMatchObject({ code: 'ERR_INVALID_PAYLOAD' });
    expect(walletChanges).toEqual(['utxo']);

    // A rescan replaces the cached records but must never clear the freeze.
    await service.startScan({ mode: 'rescan', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    const rescanned = await service.homeView(expectation);
    expect(rescanned.balances.frozenSats).toBe('123456');
    expect(rescanned.balances.availableSats).toBe(after.balances.availableSats);
  });

  it('vault switch resets scan state — the new vault starts from idle (§7.3)', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const harness = makeHarness(clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: makeFakeGateway({ scenario: 'clean', clock }).gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');

    const other = await service.restore({
      name: 'other',
      password: PASSWORD,
      mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
    });
    const switched = await service.switchVault({ vaultId: other.vaultId, password: PASSWORD });
    const expectationB = {
      expectedVaultId: other.vaultId,
      expectedSessionId: switched.sessionId,
      accountId: accountId(
        0,
        'legal winner thank year wave sausage worth useful legal winner thank yellow',
      ),
    };

    // Vault A's completed phase must not leak into vault B's view (it would
    // block B's onboarding auto-scan), and A's stale expectation is a locked
    // session, not a data source.
    expect((await service.scanStatus(expectationB)).kind).toBe('idle');
    await expect(service.scanStatus(expectation)).rejects.toMatchObject({ code: 'ERR_LOCKED' });

    await service.startScan({ mode: 'initial', ...expectationB });
    expect(await waitForScanEnd(service, expectationB)).toBe('completed');
    const home = await service.homeView(expectationB);
    expect(home.balances.availableSats).toBe('0');
  });

  it('preserves a recorded source conflict across worker restart (§11.4)', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const conflictTxid = Object.entries(
      scenariosFile.scenarios['clean']!.classificationsByOutpoint,
    )
      .find(([, record]) => record['valueSats'] === '123456')![0]
      .split(':')[0]!;
    const fake = makeFakeGateway({
      scenario: 'clean',
      clock,
      skewClassifyForTxid: conflictTxid,
    });
    const harness = makeHarness(clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: fake.gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    // Discovery stops after the conflicted account instead of spending the
    // remaining request budget on data that cannot make this pass safe.
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    const immediatelyGated = await service.homeView(expectation);
    expect(immediatelyGated.dataGating.state).toBe('conflicting_sources');
    expect(immediatelyGated.balances.availableSats).toBe('0');

    const service2 = harness.rebuild();
    const home = await service2.homeView(expectation);
    expect(home.dataGating.state).toBe('conflicting_sources');
  });

  it('preserves the last consistent cache on conflict and clears the gate only after a clean rescan', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const fake = makeFakeGateway({ scenario: 'clean', clock });
    const harness = makeHarness(clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: fake.gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    const consistent = await service.homeView(expectation);
    expect(consistent.balances.availableSats).toBe('205556');
    const consistentAt = consistent.lastSyncedAt;

    const conflictTxid = Object.entries(
      scenariosFile.scenarios['clean']!.classificationsByOutpoint,
    )
      .find(([, record]) => record['valueSats'] === '123456')![0]
      .split(':')[0]!;
    fake.setSkewClassifyForTxid(conflictTxid);
    clock.now += 60_000;
    harness.clock.now += 60_000;
    const conflictStartedAt = fake.counts.snapshot;
    await service.startScan({ mode: 'rescan', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    expect(fake.counts.snapshot - conflictStartedAt).toBeLessThan(20);
    const conflicted = await service.homeView(expectation);
    expect(conflicted.dataGating.state).toBe('conflicting_sources');
    expect(conflicted.balances.availableSats).toBe('0');
    // The prior unit record remains available for display, but is shifted to
    // the unavailable bucket rather than overwritten or exposed as spendable.
    expect(conflicted.balances.unavailableCleanSats).toBe('205556');
    expect(conflicted.lastSyncedAt).toBe(consistentAt);

    fake.setSkewClassifyForTxid(undefined);
    await service.startScan({ mode: 'rescan', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    const reconciled = await service.homeView(expectation);
    expect(reconciled.dataGating.state).toBe('fresh');
    expect(reconciled.balances.availableSats).toBe('205556');
  });

  it('resume preserves a pending Extended-scan boundary across worker restart (§8.2)', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const fake = makeFakeGateway({
      scenario: 'rare_sat',
      clock,
      failWhenRequestIncludes: scenariosFile.derived['a1:payment:0:0']!.scriptHash,
    });
    const harness = makeHarness(clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: fake.gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    // a0:payment raises the boundary prompt, then a1:payment hits the outage.
    expect(await waitForScanEnd(service, expectation)).toBe('failed');

    fake.heal();
    const service2 = harness.rebuild();
    await service2.startScan({ mode: 'resume', ...expectation });
    expect(await waitForScanEnd(service2, expectation)).toBe('awaiting_extend');
    // The STANDARD unit's pre-restart boundary survived (the coinciding
    // Xverse unit re-adds its own after resume; it alone would mask a drop).
    const status = await service2.scanStatus(expectation);
    expect(status.boundaryUnits.some((unit) => unit.source === 'standard')).toBe(true);
  });

  it('sums per-unit history deltas into active-account activity, once (§10.2)', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    // One tx funds account 0 AND account 1 payment addresses. Each unit's
    // snapshot reports only its own partial delta.
    const crossTxid = 'ab'.repeat(32);
    const h0 = scenariosFile.derived['a0:payment:0:0']!.scriptHash;
    const h1 = scenariosFile.derived['a1:payment:0:0']!.scriptHash;
    const hOrdinals = scenariosFile.derived['a0:ordinals:0:0']!.scriptHash;
    const scripts = new Map([
      [h0, addressScript(scenariosFile.derived['a0:payment:0:0']!.address)],
      [h1, addressScript(scenariosFile.derived['a1:payment:0:0']!.address)],
      [hOrdinals, addressScript(scenariosFile.derived['a0:ordinals:0:0']!.address)],
    ]);
    const iso = () => new Date(clock.now).toISOString();
    const envelope = () => ({
      instanceId: statusTemplate.instanceId,
      network: 'signet' as const,
      protocolVersion: 1,
      requestNonce: '00'.repeat(16),
      timestamp: iso(),
      coreTip: statusTemplate.coreTip,
      indexTip: statusTemplate.indexTip,
      classificationRevision: 'rev-0001',
      capabilities: statusTemplate.capabilities,
      signature: 'aa',
    });
    const utxoFor = (hash: string, vout: number, valueSats: string) => ({
      txid: crossTxid,
      vout,
      valueSats,
      scriptHash: hash,
      scriptPubKey: scripts.get(hash)!,
      height: 249_900,
      fundingSpendsOnlyRequested: false,
    });
    const entryFor = (hash: string, deltaSats: string): SnapshotHistoryEntry => ({
      txid: crossTxid,
      height: 249_900,
      timestamp: null,
      fundedScriptHashes: [hash],
      spentScriptHashes: [],
      deltaSats,
      replacesTxid: null,
      replacedByTxid: null,
      confirmationState: 'confirmed' as const,
      feeSats: null,
      vsize: null,
      replaceable: false,
      packageFeeSats: null,
      packageVsize: null,
      cpfpEligible: false,
    });
    const gateway = {
      endpoint: 'http://fake-gateway',
      fetchStatus: () =>
        Promise.resolve({
          ok: true as const,
          status: {
            ...statusTemplate,
            timestamp: iso(),
            mempoolObservedAt: iso(),
            serverTime: iso(),
          },
          verifiedAtMs: clock.now,
        }),
      fetchSnapshot: (req: { scriptHashes: string[] }) => {
        const utxos: Array<ReturnType<typeof utxoFor>> = [];
        const history: Array<ReturnType<typeof entryFor>> = [];
        if (req.scriptHashes.includes(h0)) {
          utxos.push(utxoFor(h0, 0, '100000'));
          history.push(entryFor(h0, '100000'));
        }
        if (req.scriptHashes.includes(h1)) {
          utxos.push(utxoFor(h1, 1, '200000'));
          history.push(entryFor(h1, '200000'));
        }
        if (req.scriptHashes.includes(hOrdinals)) {
          history.push(entryFor(hOrdinals, '546'));
        }
        return Promise.resolve({
          ok: true as const,
          value: {
            ...envelope(),
            requestedScriptHashes: req.scriptHashes,
            utxos,
            history,
            activeScriptHashes: req.scriptHashes.filter((hash) =>
              utxos.some((utxo) => utxo.scriptHash === hash) ||
              history.some((entry) =>
                entry.fundedScriptHashes.includes(hash) ||
                entry.spentScriptHashes.includes(hash))),
            historyCoverage: { status: 'complete' as const, limitedScriptHashes: [] },
          },
          verifiedAtMs: clock.now,
        });
      },
      classifyOutpoints: (req: { outpoints: { txid: string; vout: number }[] }) =>
        Promise.resolve({
          ok: true as const,
          value: {
            ...envelope(),
            classifications: req.outpoints.map((o) => ({
              txid: o.txid,
              vout: o.vout,
              valueSats: o.vout === 0 ? '100000' : '200000',
              scriptPubKey: scripts.get(o.vout === 0 ? h0 : h1)!,
              confirmations: 101,
              primaryClass: 'cardinal_clean' as const,
              inscriptions: [],
              satRanges: null,
              unsupportedAssetDetected: false,
              confidence: 'authoritative' as const,
              classifiedTip: statusTemplate.coreTip,
              classificationRevision: 'rev-0001',
            })),
            unknownOutpoints: [],
          },
          verifiedAtMs: clock.now,
        }),
    };
    const harness = makeHarness(clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: gateway as unknown as GatewayClient,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');

    const home = await service.homeView(expectation);
    const entry = home.activity.find((a) => a.txid === crossTxid);
    // Account 0's payment plus Ordinals-address receipt are summed once. The
    // coincident Xverse records must be shadowed by the stable public-account
    // keys, and account 1 remains outside this account-scoped projection.
    expect(entry?.deltaSats).toBe('100546');
    expect(entry?.addressContext).toBe('ordinals_received');
    expect(home.balances.availableSats).toBe('100000');
  });
});

describe('Ordinals gallery and ephemeral media authority', () => {
  it('presents a signed pending inscription as unconfirmed and keeps its known number', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const base = makeHarness(clock.now, { network: 'signet', walletCache: cache });
    const fake = makeFakeGateway({ scenario: 'incoming_ordinal_mempool', clock: base.clock });
    const harness = makeHarness(base.clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: fake.gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');

    const gallery = await service.galleryList({ ...expectation });
    expect(gallery.items).toHaveLength(1);
    expect(gallery.items[0]).toMatchObject({
      inscriptionId: '9df87c55dc15d1c7fae8bc17d92cec6480c6f918e35ebf5b6c76d9bbfa8987b3i0',
      number: 1234,
      confirmations: 0,
      preview: { kind: 'placeholder', reason: 'stale_classification' },
      mediaAvailable: false,
      action: { status: 'blocked', kind: 'send', reason: 'unconfirmed' },
    });
    const parsed = OP_SCHEMAS['gallery.list'].response.safeParse(gallery);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
  });

  it('lists only owned inscriptions, persists Hide/Unhide state, and drops leases on restart', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const base = makeHarness(clock.now, {
      network: 'signet',
      walletCache: cache,
    });
    const fake = makeFakeGateway({ scenario: 'mixed', clock: base.clock });
    const harness = makeHarness(base.clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: fake.gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');

    const first = await service.galleryList({ ...expectation });
    // Only the three inscriptions on the wallet-owned mixed outpoint are
    // authoritative for this account; the fourth fixture belongs elsewhere.
    expect(first.items).toHaveLength(3);
    expect(first.items.every((item) => item.state === 'visible')).toBe(true);
    expect(first.items.every((item) => item.ownership !== null)).toBe(true);
    expect(first.items.every((item) => item.ownership?.role === 'primary')).toBe(true);
    expect(first.items.every((item) =>
      item.ownership?.address === scenariosFile.derived['a0:ordinals:0:0']?.address,
    )).toBe(true);
    expect(first.recoveredAddressCount).toBe(0);
    expect(first.items.filter((item) => item.action.status === 'available')).toHaveLength(1);
    expect(first.items.filter((item) =>
      item.action.status === 'blocked' && item.action.reason === 'co_located')).toHaveLength(2);
    const parsedGallery = OP_SCHEMAS['gallery.list'].response.safeParse(first);
    if (!parsedGallery.success) throw new Error(JSON.stringify(parsedGallery.error.issues));
    const raster = first.items.find((item) => item.preview.kind === 'raster');
    const active = first.items.find((item) => item.contentType === 'text/html');
    if (!raster || !active) throw new Error('missing gallery fixtures');

    await service.galleryUpdate({ inscriptionId: active.inscriptionId, state: 'hidden', ...expectation });
    const updated = await service.galleryList({ ...expectation });
    expect(updated.items.find((item) => item.inscriptionId === active.inscriptionId)?.state).toBe('hidden');
    await service.galleryUpdate({ inscriptionId: active.inscriptionId, state: 'visible', ...expectation });
    expect((await service.galleryList({ ...expectation })).items
      .find((item) => item.inscriptionId === active.inscriptionId)?.state).toBe('visible');
    await service.galleryUpdate({ inscriptionId: active.inscriptionId, state: 'hidden', ...expectation });

    const blocked = await service.galleryMediaOpen({ inscriptionId: active.inscriptionId, ...expectation });
    expect(blocked).toMatchObject({ disposition: 'unavailable', reason: 'active_content' });
    const opened = await service.galleryMediaOpen({ inscriptionId: raster.inscriptionId, ...expectation });
    expect(opened.disposition).toBe('media');
    if (opened.disposition !== 'media') throw new Error('media did not open');
    const leases = (service as unknown as { galleryMediaLeases: Map<string, unknown> })
      .galleryMediaLeases;
    expect(leases.size).toBe(1);
    harness.clock.now += GALLERY_MEDIA_LEASE_TTL_MS + 1;
    base.clock.now += GALLERY_MEDIA_LEASE_TTL_MS + 1;
    const reopened = await service.galleryMediaOpen({
      inscriptionId: raster.inscriptionId,
      ...expectation,
    });
    if (reopened.disposition !== 'media') throw new Error('media did not reopen');
    expect(leases.has(opened.leaseId)).toBe(false);
    expect(leases.size).toBe(1);
    expect(await service.galleryMediaLease({ leaseId: reopened.leaseId, ...expectation }))
      .toMatchObject({ valid: true });

    const restarted = harness.rebuild();
    expect(await restarted.galleryMediaLease({ leaseId: reopened.leaseId, ...expectation }))
      .toEqual({ valid: false, expiresAt: null });
    const afterRestart = await restarted.galleryList({ ...expectation });
    expect(afterRestart.items.find((item) => item.inscriptionId === raster.inscriptionId)?.state).toBe('visible');
    expect(afterRestart.items.find((item) => item.inscriptionId === active.inscriptionId)?.state).toBe('hidden');
  });

  it('rejects the old classification revision after a new block and opens only after rescan', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const statusControl = {
      classificationRevision: 'rev-0001',
      tip: statusTemplate.coreTip,
    };
    const fake = makeFakeGateway({
      scenario: 'mixed',
      clock,
      statusControl,
    });
    const harness = makeHarness(clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: fake.gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    const raster = (await service.galleryList(expectation)).items.find(
      (galleryItem) => galleryItem.preview.kind === 'raster',
    );
    if (raster === undefined) throw new Error('missing raster fixture');

    statusControl.classificationRevision = 'rev-0002';
    statusControl.tip = {
      height: statusTemplate.coreTip.height + 1,
      hash: 'ab'.repeat(32),
    };

    await expect(service.galleryMediaOpen({
      inscriptionId: raster.inscriptionId,
      ...expectation,
    })).rejects.toMatchObject({ code: 'ERR_DATA_STALE' });
    // Stale local identity is rejected before any media request can reuse it.
    expect(fake.counts.media).toBe(0);

    await service.startScan({ mode: 'refresh', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    const refreshed = await service.galleryMediaOpen({
      inscriptionId: raster.inscriptionId,
      ...expectation,
    });
    expect(refreshed.disposition).toBe('media');
    expect(fake.counts.media).toBe(1);
  });

  it('distinguishes unverifiable satpoints from genuine co-location', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const fake = makeFakeGateway({
      scenario: 'mixed',
      clock,
      mutateClassification: (classification) => {
        const inscriptions = classification['inscriptions'];
        if (!Array.isArray(inscriptions) || inscriptions.length === 0) return classification;
        return {
          ...classification,
          inscriptions: inscriptions.map((inscription, index) => {
            if (index !== 0) return inscription;
            const record = inscription as Record<string, unknown>;
            const satpoint = record['satpoint'];
            return {
              ...record,
              satpoint: typeof satpoint === 'string'
                ? satpoint.replace(/:[^:]*$/u, ':')
                : '',
            };
          }),
        };
      },
    });
    const harness = makeHarness(clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway: fake.gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');

    const gallery = await service.galleryList({ ...expectation });
    expect(gallery.items).toHaveLength(3);
    expect(gallery.items.every((item) =>
      item.action.status === 'blocked' &&
      item.action.reason === 'unverifiable_location')).toBe(true);
    expect(OP_SCHEMAS['gallery.list'].response.safeParse(gallery).success).toBe(true);
  });

  it('updates distinct recovered ownership and the session summary when an inscription moves', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const base = makeHarness(clock.now, { network: 'signet', walletCache: cache });
    const fake = makeFakeGateway({ scenario: 'mixed', clock: base.clock });
    const primary = scenariosFile.derived['a0:ordinals:0:0'];
    const recovered = scenariosFile.derived['a0:ordinals:0:1'];
    if (!primary || !recovered) throw new Error('missing ordinal address fixtures');
    const mixed = scenariosFile.scenarios['mixed'];
    if (!mixed) throw new Error('missing mixed scenario');
    const original = (mixed.utxosByScriptHash[primary.scriptHash] ?? [])[0] as {
      txid: string;
      vout: number;
      valueSats: string;
      scriptHash: string;
      scriptPubKey: string;
      height: number;
      fundingSpendsOnlyRequested: boolean;
    };
    let heldAtRecovered = true;
    const accountInvalidations: string[] = [];
    const gateway = {
      ...fake.gateway,
      fetchSnapshot: async (
        request: Parameters<typeof fake.gateway.fetchSnapshot>[0],
      ) => {
        const response = await fake.gateway.fetchSnapshot(request);
        if (!response.ok || !heldAtRecovered) return response;
        const utxos = response.value.utxos.filter(
          (candidate) => candidate.txid !== original.txid || candidate.vout !== original.vout,
        );
        if (request.scriptHashes.includes(recovered.scriptHash)) {
          utxos.push({
            ...original,
            scriptHash: recovered.scriptHash,
            scriptPubKey: addressScript(recovered.address),
          });
        }
        return {
          ...response,
          value: { ...response.value, utxos },
        };
      },
      classifyOutpoints: async (
        request: Parameters<typeof fake.gateway.classifyOutpoints>[0],
      ) => {
        const response = await fake.gateway.classifyOutpoints(request);
        if (!response.ok || !heldAtRecovered) return response;
        return {
          ...response,
          value: {
            ...response.value,
            classifications: response.value.classifications.map((classification) =>
              classification.txid === original.txid && classification.vout === original.vout
                ? { ...classification, scriptPubKey: addressScript(recovered.address) }
                : classification),
          },
        };
      },
    } as typeof fake.gateway;
    const harness = makeHarness(base.clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway,
      notifyWalletDataChanged: (reason) => accountInvalidations.push(reason),
    });
    const { service, expectation } = await setupWallet(harness);

    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    const recoveredGallery = await service.galleryList({ ...expectation });
    expect(recoveredGallery.recoveredAddressCount).toBe(1);
    expect(new Set(recoveredGallery.items.map((item) => item.ownership?.address))).toEqual(
      new Set([recovered.address]),
    );
    expect(recoveredGallery.items.every((item) =>
      item.ownership?.lane === 'ordinals' && item.ownership.role === 'recovered',
    )).toBe(true);
    expect(await service.sessionSnapshot()).toMatchObject({
      activeRecoveredAddressCount: 1,
    });

    const invalidationsAfterInitial = accountInvalidations.filter(
      (reason) => reason === 'account',
    ).length;
    await service.startScan({ mode: 'refresh', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    expect(accountInvalidations.filter((reason) => reason === 'account')).toHaveLength(
      invalidationsAfterInitial,
    );

    heldAtRecovered = false;
    await service.startScan({ mode: 'refresh', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    const primaryGallery = await service.galleryList({ ...expectation });
    expect(primaryGallery.recoveredAddressCount).toBe(0);
    expect(primaryGallery.items.every((item) =>
      item.ownership?.address === primary.address && item.ownership.role === 'primary',
    )).toBe(true);
    expect(await service.sessionSnapshot()).toMatchObject({
      activeRecoveredAddressCount: 0,
    });
    expect(accountInvalidations.filter((reason) => reason === 'account')).toHaveLength(
      invalidationsAfterInitial + 1,
    );
  });
});

describe('Ordinals gallery lazy rasters', () => {
  it('backfills pre-collection records in one response and does not retry the warm cache', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const base = makeHarness(clock.now, { network: 'signet', walletCache: cache });
    const fake = makeFakeGateway({ scenario: 'mixed', clock: base.clock });
    const enrichedRequests: string[][] = [];
    const legacyRequests: string[][] = [];
    let serveEnriched = false;
    const collectionRoot =
      '2ebbd9b93006b69714dd517fbe0d4bf7f8462ffe213105e03048d49ed46eba04i0';
    const collectionCatalog = {
      source: 'TheWizardsOfOrd/ordinals-collections' as const,
      revision: '1'.repeat(40),
      sha256: '2'.repeat(64),
      galleryIndexStatus: 'ready' as const,
    };
    const gateway = {
      ...fake.gateway,
      fetchInscriptionGalleryEnrichedBatch: async (
        req: Parameters<typeof fake.gateway.fetchInscriptionGalleryBatch>[0],
      ) => {
        if (!serveEnriched) {
          return { ok: false as const, reason: 'http' as const, httpStatus: 404 };
        }
        enrichedRequests.push(req.inscriptions.map((identity) => identity.inscriptionId));
        const response = await fake.gateway.fetchInscriptionGalleryBatch(req);
        if (!response.ok) return response;
        return {
          ...response,
          value: {
            ...response.value,
            collectionCatalog,
            items: response.value.items.map((item) => ({
              ...item,
              display: {
                title: {
                  text: `Collection item ${item.metadata.inscriptionId.slice(0, 8)}`,
                  source: 'ord_properties' as const,
                },
                collections: [{
                  slug: 'nodemonkes',
                  name: 'NodeMonkes',
                  kind: 'gallery' as const,
                  rootInscriptionIds: [collectionRoot],
                }],
              },
            })),
          },
        };
      },
      fetchInscriptionGalleryBatch: (
        req: Parameters<typeof fake.gateway.fetchInscriptionGalleryBatch>[0],
      ) => {
        legacyRequests.push(req.inscriptions.map((identity) => identity.inscriptionId));
        return fake.gateway.fetchInscriptionGalleryBatch(req);
      },
    } as unknown as GatewayClient;
    const harness = makeHarness(base.clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');

    // First model the older gateway. It writes complete core metadata and
    // display:null, which means "enrichment was attempted" and must not retry
    // the entire wallet on every warm lazy load.
    const legacy = await service.galleryList({ ...expectation, rasterFor: [] });
    expect(legacyRequests.flat()).toHaveLength(legacy.items.length);
    legacyRequests.length = 0;
    await service.galleryList({ ...expectation, rasterFor: [] });
    expect(legacyRequests).toHaveLength(0);

    // Rewrite that valid encrypted record to the exact pre-collection shape:
    // metadata is present but the optional display field did not exist yet.
    const session = await getSession(harness.session);
    if (!session) throw new Error('missing session');
    const dek = base64ToBytes(session.dekB64);
    const recordKey = {
      vaultId: expectation.expectedVaultId,
      network: 'signet' as const,
      type: 'gallery' as const,
      key: accountId(0),
    };
    const encrypted = await cache.get(recordKey);
    if (!encrypted) throw new Error('missing encrypted gallery record');
    const current = openRecord(dek, encrypted, galleryRecordSchema) as GalleryRecord;
    const preCollection = {
      version: 2 as const,
      items: current.items.map((item) => {
        const legacyItem = { ...item };
        delete legacyItem.display;
        return legacyItem;
      }),
    };
    await cache.put(sealRecord(
      dek,
      preCollection,
      recordKey,
      new Uint8Array(24).fill(71),
      clock.now,
    ));
    dek.fill(0);

    serveEnriched = true;
    const upgraded = await service.galleryList({ ...expectation, rasterFor: [] });
    const requested = enrichedRequests.flat();
    expect(requested).toHaveLength(upgraded.items.length);
    expect(new Set(requested)).toEqual(new Set(upgraded.items.map((item) => item.inscriptionId)));
    expect(upgraded.collectionCatalog).toEqual(collectionCatalog);
    expect(upgraded.items.every((item) =>
      item.display.collections.some((collection) => collection.slug === 'nodemonkes'),
    )).toBe(true);
    // Enrichment remains display-only: every locally-derived action verdict is
    // byte-for-byte the same as before the upgrade.
    expect(upgraded.items.map((item) => item.action))
      .toEqual(legacy.items.map((item) => item.action));

    const persisted = await cache.get(recordKey);
    if (!persisted) throw new Error('missing persisted gallery record');
    const persistedDek = base64ToBytes(session.dekB64);
    const decoded = openRecord(persistedDek, persisted, galleryRecordSchema) as GalleryRecord;
    persistedDek.fill(0);
    expect(decoded.items.every((item) => item.display !== undefined)).toBe(true);

    enrichedRequests.length = 0;
    const warm = await service.galleryList({ ...expectation, rasterFor: [] });
    expect(warm.items).toHaveLength(upgraded.items.length);
    expect(enrichedRequests).toHaveLength(0);
  });

  it.each([
    { itemCount: 0, expectedBatches: [] },
    { itemCount: 1, expectedBatches: [1] },
    { itemCount: 20, expectedBatches: [16, 4] },
    { itemCount: 100, expectedBatches: [16, 16, 16, 16, 16, 16, 4] },
  ])(
    'keeps an atomic $itemCount-item display backfill within the 16-item batch budget',
    async ({ itemCount, expectedBatches }) => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const base = makeHarness(clock.now, { network: 'signet', walletCache: cache });
    const fake = makeFakeGateway({ scenario: 'mixed', clock: base.clock });
    const mixedOutpoint =
      '9774a6be060acf35bd43270886b21ee60f5253c1350c68fb11bedcaa12b9e150:0';
    const synthetic = Array.from({ length: itemCount }, (_, index) => ({
      inscriptionId: `${(index + 1).toString(16).padStart(64, '0')}i0`,
      number: 10_000 + index,
      satpoint: `${mixedOutpoint}:${index}`,
    }));
    const batches: string[][] = [];
    const template = inscriptionBatchTemplate.items[0]!;
    const gateway = {
      ...fake.gateway,
      classifyOutpoints: async (
        req: Parameters<typeof fake.gateway.classifyOutpoints>[0],
      ) => {
        const response = await fake.gateway.classifyOutpoints(req);
        if (!response.ok) return response;
        return {
          ...response,
          value: {
            ...response.value,
            classifications: response.value.classifications.map((classification) =>
              `${classification.txid}:${classification.vout}` === mixedOutpoint
                ? { ...classification, inscriptions: synthetic }
                : classification),
          },
        };
      },
      fetchInscriptionGalleryEnrichedBatch: async (
        req: Parameters<typeof fake.gateway.fetchInscriptionGalleryBatch>[0],
      ) => {
        batches.push(req.inscriptions.map((identity) => identity.inscriptionId));
        return {
          ok: true as const,
          value: {
            ...statusTemplate,
            timestamp: new Date(clock.now).toISOString(),
            requestNonce: '00'.repeat(16),
            classificationRevision: 'rev-0001',
            collectionCatalog: {
              source: 'TheWizardsOfOrd/ordinals-collections' as const,
              revision: '1'.repeat(40),
              sha256: '2'.repeat(64),
              galleryIndexStatus: 'ready' as const,
            },
            items: req.inscriptions.map((identity, index) => ({
              ...template,
              metadata: {
                ...template.metadata,
                inscriptionId: identity.inscriptionId,
                number: 10_000 + index,
                satpoint: identity.satpoint,
                outpoint: identity.outpoint,
                classificationRevision: identity.classificationRevision,
              },
              display: {
                title: null,
                collections: [],
              },
            })),
          },
          verifiedAtMs: clock.now,
        };
      },
    } as unknown as GatewayClient;
    const harness = makeHarness(base.clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');

    const listed = await service.galleryList({ ...expectation, rasterFor: [] });
    expect(listed.items).toHaveLength(itemCount);
    expect(batches.map((batch) => batch.length)).toEqual(expectedBatches);
    expect(batches.flat()).toHaveLength(itemCount);
    expect(new Set(batches.flat()).size).toBe(itemCount);
  });

  it('reuses an exact encrypted raster while keeping ownership and actions authoritative', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const base = makeHarness(clock.now, { network: 'signet', walletCache: cache });
    const fake = makeFakeGateway({ scenario: 'mixed', clock: base.clock });
    const requested: string[][] = [];
    let statusRequests = 0;
    const gateway = {
      ...fake.gateway,
      fetchStatus: () => {
        statusRequests += 1;
        return fake.gateway.fetchStatus();
      },
      fetchInscriptionGalleryBatch: (
        req: Parameters<typeof fake.gateway.fetchInscriptionGalleryBatch>[0],
      ) => {
        requested.push(req.inscriptions.map((identity) => identity.inscriptionId));
        return fake.gateway.fetchInscriptionGalleryBatch(req);
      },
    } as typeof fake.gateway;
    const harness = makeHarness(base.clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');

    // A first load has no cached metadata, so it must still fetch everything.
    const full = await service.galleryList({ ...expectation, rasterFor: [] });
    expect(requested.flat()).toHaveLength(full.items.length);
    const target = full.items.find((item) => item.preview.kind === 'raster');
    if (!target) throw new Error('missing raster fixture');

    requested.length = 0;
    const statusesBeforePaint = statusRequests;
    const lazy = await service.galleryList({
      ...expectation,
      rasterFor: [target.inscriptionId],
    });

    // The exact settled preview was sealed by the first response. Current
    // ownership and classification were recomputed, but no preview request had
    // to cross the wire for an unchanged identity.
    expect(requested).toHaveLength(0);
    expect(statusRequests).toBe(statusesBeforePaint);
    const parsed = OP_SCHEMAS['gallery.list'].response.safeParse(lazy);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));

    const fetched = lazy.items.find((item) => item.inscriptionId === target.inscriptionId);
    expect(fetched?.preview.kind).toBe('raster');

    // Everything else is reported as deliberately unfetched, and keeps the
    // cosmetic descriptors already held locally.
    for (const before of full.items) {
      if (before.inscriptionId === target.inscriptionId) continue;
      const after = lazy.items.find((item) => item.inscriptionId === before.inscriptionId);
      if (!after) throw new Error(`item vanished: ${before.inscriptionId}`);
      if (before.preview.kind === 'raster') {
        expect(after.preview).toEqual({ kind: 'placeholder', reason: 'not_requested' });
      }
      expect(after.number).toBe(before.number);
      expect(after.contentType).toBe(before.contentType);
      // The safety-critical part: reusing paint must not change ownership or
      // what gates Send/Rescue.
      expect(after.satpoint).toBe(before.satpoint);
      expect(after.outpoint).toEqual(before.outpoint);
      expect(after.classificationRevision).toBe(before.classificationRevision);
      expect(after.action).toEqual(before.action);
      expect(after.state).toBe(before.state);
    }
  });
});

describe('Ordinals gallery preview degradation', () => {
  /**
   * A gateway shedding load with a 503 used to empty the whole gallery: every
   * batch had to succeed or `galleryList` threw. Above 16 inscriptions that is
   * several sequential unretried requests, so the failure rate grew with the
   * collection size.
   */
  async function withFailingBatches(failWhen: (call: number) => boolean) {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const base = makeHarness(clock.now, { network: 'signet', walletCache: cache });
    const fake = makeFakeGateway({ scenario: 'mixed', clock: base.clock });
    let calls = 0;
    const gateway = {
      ...fake.gateway,
      fetchInscriptionGalleryBatch: (
        req: Parameters<typeof fake.gateway.fetchInscriptionGalleryBatch>[0],
      ) => {
        calls += 1;
        // What a 503 surfaces as at this layer.
        if (failWhen(calls)) {
          return Promise.resolve({ ok: false as const, reason: 'http' as const });
        }
        return fake.gateway.fetchInscriptionGalleryBatch(req);
      },
    } as typeof fake.gateway;
    const harness = makeHarness(base.clock.now, {
      network: 'signet', walletCache: cache, gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    return { service, expectation };
  }

  it('keeps every inscription visible when the preview service is unavailable', async () => {
    const { service, expectation } = await withFailingBatches(() => true);
    const healthy = await makeHealthyGallery();

    const degraded = await service.galleryList({ ...expectation });
    const parsed = OP_SCHEMAS['gallery.list'].response.safeParse(degraded);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));

    // The whole point: the grid is populated, not empty.
    expect(degraded.items.length).toBeGreaterThan(0);
    expect(degraded.items).toHaveLength(healthy.items.length);
    expect(degraded.previewsUnavailable).toBe(true);
  });

  it('never lets a missing preview change what gates Send or Rescue', async () => {
    // The safety invariant. `action` is derived from local authoritative UTXO
    // facts, so losing the signed raster must not alter a single verdict.
    const { service, expectation } = await withFailingBatches(() => true);
    const healthy = await makeHealthyGallery();
    const degraded = await service.galleryList({ ...expectation });

    for (const before of healthy.items) {
      const after = degraded.items.find((item) => item.inscriptionId === before.inscriptionId);
      if (!after) throw new Error(`item vanished: ${before.inscriptionId}`);
      expect(after.action).toEqual(before.action);
      expect(after.satpoint).toBe(before.satpoint);
      expect(after.outpoint).toEqual(before.outpoint);
      expect(after.classificationRevision).toBe(before.classificationRevision);
      expect(after.rareSats).toEqual(before.rareSats);
    }
    expect(degraded.attentionItems).toEqual(healthy.attentionItems);
    expect(degraded.sweepCandidates).toEqual(healthy.sweepCandidates);
  });

  it('marks an unfetchable preview distinctly so the surface does not retry into a failing gateway', async () => {
    const { service, expectation } = await withFailingBatches(() => true);
    const degraded = await service.galleryList({ ...expectation });

    const placeholders = degraded.items.filter((item) => item.preview.kind === 'placeholder');
    expect(placeholders.length).toBeGreaterThan(0);
    for (const item of placeholders) {
      if (item.preview.kind !== 'placeholder') throw new Error('unreachable');
      // `not_requested` is a lazy-load cue that LazyCard acts on; reusing it
      // here would make a scroll re-request rasters from a gateway already
      // shedding load.
      expect(item.preview.reason).toBe(GALLERY_PREVIEW_UNAVAILABLE);
    }
  });

  it('reports success cleanly when every batch is served', async () => {
    const { service, expectation } = await withFailingBatches(() => false);
    const healthy = await service.galleryList({ ...expectation });
    expect(healthy.previewsUnavailable).toBe(false);
    expect(healthy.items.some((item) => item.preview.kind === 'raster')).toBe(true);
  });

  it('still fails closed when the gateway reports a different classification revision', async () => {
    // A revision mismatch is not transient — it means the gateway moved to a
    // classification this wallet never verified, so degrading would be wrong.
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const base = makeHarness(clock.now, { network: 'signet', walletCache: cache });
    const fake = makeFakeGateway({ scenario: 'mixed', clock: base.clock });
    const gateway = {
      ...fake.gateway,
      fetchInscriptionGalleryBatch: async (
        req: Parameters<typeof fake.gateway.fetchInscriptionGalleryBatch>[0],
      ) => {
        const result = await fake.gateway.fetchInscriptionGalleryBatch(req);
        if (!result.ok) return result;
        return {
          ...result,
          value: { ...result.value, classificationRevision: 'rev-from-the-future' },
        };
      },
    } as typeof fake.gateway;
    const harness = makeHarness(base.clock.now, {
      network: 'signet', walletCache: cache, gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');

    await expect(service.galleryList({ ...expectation })).rejects.toMatchObject({
      code: 'ERR_DATA_STALE',
    });
  });

  it('treats a hard signed-batch verification failure as fatal instead of stale identity data', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const base = makeHarness(clock.now, { network: 'signet', walletCache: cache });
    const fake = makeFakeGateway({ scenario: 'mixed', clock: base.clock });
    let rejectSignature = false;
    const gateway = {
      ...fake.gateway,
      fetchInscriptionGalleryBatch: (
        req: Parameters<typeof fake.gateway.fetchInscriptionGalleryBatch>[0],
      ) => rejectSignature
        ? Promise.resolve({ ok: false as const, reason: 'signature' as const })
        : fake.gateway.fetchInscriptionGalleryBatch(req),
    } as typeof fake.gateway;
    const harness = makeHarness(base.clock.now, {
      network: 'signet', walletCache: cache, gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    const warm = await service.galleryList({ ...expectation });
    expect(warm.items.length).toBeGreaterThan(0);

    rejectSignature = true;
    await expect(service.galleryList({ ...expectation })).rejects.toMatchObject({
      code: 'ERR_DATA_STALE',
    });
    const paintOnly = await service.galleryCached({ ...expectation });
    expect(paintOnly.hit).toBe(true);
    if (!paintOnly.hit) throw new Error('expected warm paint cache');
    for (const item of paintOnly.items) expect(item).not.toHaveProperty('action');
  });

  it('never uses a durable preview after a hard status verification failure', async () => {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const base = makeHarness(clock.now, { network: 'signet', walletCache: cache });
    const fake = makeFakeGateway({ scenario: 'mixed', clock: base.clock });
    let rejectStatus = false;
    let galleryBatches = 0;
    const gateway = {
      ...fake.gateway,
      fetchStatus: () => rejectStatus
        ? Promise.resolve({ ok: false as const, reason: 'signature' as const })
        : fake.gateway.fetchStatus(),
      fetchInscriptionGalleryBatch: (
        req: Parameters<typeof fake.gateway.fetchInscriptionGalleryBatch>[0],
      ) => {
        galleryBatches += 1;
        return fake.gateway.fetchInscriptionGalleryBatch(req);
      },
    } as typeof fake.gateway;
    const harness = makeHarness(base.clock.now, {
      network: 'signet', walletCache: cache, gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    const warm = await service.galleryList({ ...expectation, rasterFor: [] });
    const target = warm.items.find((item) => item.preview.kind === 'raster');
    if (!target) throw new Error('missing raster fixture');
    const beforeFailure = galleryBatches;

    rejectStatus = true;
    // Targeted paint reuses a very recent verified status to avoid a duplicate
    // round trip. Age it past that window so this call must observe the hard
    // verification failure before considering durable paint.
    harness.clock.now += 10_001;
    await expect(service.galleryList({
      ...expectation,
      rasterFor: [target.inscriptionId],
    })).rejects.toMatchObject({ code: 'ERR_DATA_STALE' });
    expect(galleryBatches).toBe(beforeFailure);
  });

  /** A control run on an identical wallet with a healthy gateway. */
  async function makeHealthyGallery() {
    const { service, expectation } = await withFailingBatches(() => false);
    return service.galleryList({ ...expectation });
  }
});

describe('Ordinals gallery paint-ahead cache', () => {
  async function warmed(options: { hangBatches?: boolean } = {}) {
    const cache = new MemoryWalletCache();
    const clock = { now: Date.parse('2026-07-20T00:00:05.000Z') };
    const base = makeHarness(clock.now, { network: 'signet', walletCache: cache });
    const fake = makeFakeGateway({ scenario: 'mixed', clock: base.clock });
    let release: (() => void) | null = null;
    let announceHang: (() => void) | null = null;
    // Re-armed per batch so a test can hand off deterministically: wait for the
    // batch to actually be suspended, then let it finish.
    let hanging = new Promise<void>((resolve) => { announceHang = resolve; });
    const batches: string[][] = [];
    const gateway = {
      ...fake.gateway,
      fetchInscriptionGalleryBatch: async (
        req: Parameters<typeof fake.gateway.fetchInscriptionGalleryBatch>[0],
      ) => {
        batches.push(req.inscriptions.map((identity) => identity.inscriptionId));
        if (options.hangBatches) {
          const suspended = new Promise<void>((resolve) => { release = resolve; });
          announceHang?.();
          await suspended;
        }
        return fake.gateway.fetchInscriptionGalleryBatch(req);
      },
    } as typeof fake.gateway;
    const harness = makeHarness(base.clock.now, {
      network: 'signet',
      walletCache: cache,
      gateway,
    });
    const { service, expectation } = await setupWallet(harness);
    await service.startScan({ mode: 'initial', ...expectation });
    expect(await waitForScanEnd(service, expectation)).toBe('completed');
    return {
      harness,
      cache,
      service,
      expectation,
      batches,
      /** Resolves once a batch is genuinely suspended inside the gateway call. */
      waitForHang: async (): Promise<void> => {
        await hanging;
        hanging = new Promise<void>((resolve) => { announceHang = resolve; });
      },
      releaseBatch: (): void => release?.(),
    };
  }

  it('misses before a batch, then serves rasters carrying no authority', async () => {
    const { service, expectation } = await warmed();

    expect(await service.galleryCached({ ...expectation })).toEqual({
      accountId: accountId(0),
      hit: false,
    });

    const listed = await service.galleryList({ ...expectation });
    const cached = await service.galleryCached({ ...expectation });

    const parsed = OP_SCHEMAS['gallery.cached'].response.safeParse(cached);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    if (!cached.hit) throw new Error('expected a cache hit');
    expect(cached.items.some((item) => item.preview !== undefined)).toBe(true);
    // The projection cannot express what gates Send, Rescue, or the viewer.
    for (const item of cached.items) {
      expect(item).not.toHaveProperty('action');
      expect(item).not.toHaveProperty('mediaAvailable');
    }
    // 'mixed' contains genuinely unpreviewable active content; those items are
    // cached for their metadata but must never carry a cached placeholder.
    const unpreviewable = listed.items.filter((item) => item.preview.kind === 'placeholder');
    expect(unpreviewable.length).toBeGreaterThan(0);
    for (const item of unpreviewable) {
      expect(cached.items.find((entry) => entry.inscriptionId === item.inscriptionId)?.preview)
        .toBeUndefined();
    }
  });

  it('serves Home only exact current cached identities and visibility', async () => {
    const { harness, service, expectation } = await warmed();
    const listed = await service.galleryList({ ...expectation });
    const target = listed.items.find((item) => item.preview.kind !== 'placeholder');
    if (target === undefined) throw new Error('missing settled preview fixture');

    const first = await service.galleryHomeCached({ ...expectation });
    if (!first.hit) throw new Error('expected revalidated Home paint');
    expect(first.items.find((item) => item.inscriptionId === target.inscriptionId)?.preview)
      .toEqual(target.preview);
    for (const item of first.items) {
      expect(item).not.toHaveProperty('action');
      expect(item).not.toHaveProperty('mediaAvailable');
    }

    await service.galleryUpdate({
      ...expectation,
      inscriptionId: target.inscriptionId,
      state: 'hidden',
    });
    const hidden = await service.galleryHomeCached({ ...expectation });
    if (!hidden.hit) throw new Error('expected revalidated hidden paint');
    expect(hidden.items.find((item) => item.inscriptionId === target.inscriptionId)?.state)
      .toBe('hidden');

    const raw = structuredClone(harness.session.store.get(GALLERY_PREVIEW_CACHE_KEY)) as {
      items: GalleryCachedItem[];
    };
    const cachedTarget = raw.items.find((item) => item.inscriptionId === target.inscriptionId);
    if (cachedTarget === undefined) throw new Error('missing cached target');
    raw.items = [{ ...cachedTarget, satpoint: `${'f'.repeat(64)}:0:0` }];
    harness.session.store.set(GALLERY_PREVIEW_CACHE_KEY, raw);
    expect(await service.galleryHomeCached({ ...expectation })).toEqual({
      accountId: expectation.accountId,
      hit: false,
    });
  });

  it('survives an MV3 worker restart, which is the whole point of session storage', async () => {
    const { harness, service, expectation } = await warmed();
    await service.galleryList({ ...expectation });

    const restarted = harness.rebuild();

    const cached = await restarted.galleryCached({ ...expectation });
    if (!cached.hit) throw new Error('expected the cache to outlive the worker');
    expect(cached.items.some((item) => item.preview !== undefined)).toBe(true);
  });

  it('repaints from encrypted storage after an extension reload and a new unlock', async () => {
    const { harness, service, expectation, batches } = await warmed();
    const first = await service.galleryList({ ...expectation, rasterFor: [] });
    const target = first.items.find((item) => item.preview.kind === 'raster');
    if (!target) throw new Error('missing raster fixture');
    const beforeReload = batches.length;

    // chrome://extensions Reload clears storage.session and therefore ends the
    // unlock. Model that boundary, rebuild the worker over the same encrypted
    // IndexedDB cache, then establish a distinct session.
    await service.lock();
    const restarted = harness.rebuild();
    const unlocked = await restarted.unlock({
      vaultId: expectation.expectedVaultId,
      password: PASSWORD,
    });
    const reopenedExpectation = {
      ...expectation,
      expectedSessionId: unlocked.sessionId,
    };
    expect(unlocked.sessionId).not.toBe(expectation.expectedSessionId);
    expect(await restarted.galleryCached({ ...reopenedExpectation })).toEqual({
      accountId: expectation.accountId,
      hit: false,
    });

    const reopened = await restarted.galleryList({ ...reopenedExpectation, rasterFor: [] });

    expect(batches).toHaveLength(beforeReload);
    expect(reopened.items.find((item) => item.inscriptionId === target.inscriptionId)?.preview)
      .toEqual(target.preview);
    expect(reopened.items.find((item) => item.inscriptionId === target.inscriptionId)?.action)
      .toEqual(target.action);
    const hydratedSession = await restarted.galleryCached({ ...reopenedExpectation });
    expect(hydratedSession.hit).toBe(true);
  });

  it('drops the cache on lock', async () => {
    const { harness, service, expectation } = await warmed();
    await service.galleryList({ ...expectation });
    expect(harness.session.store.has(GALLERY_PREVIEW_CACHE_KEY)).toBe(true);

    await service.lock();

    expect(harness.session.store.has(GALLERY_PREVIEW_CACHE_KEY)).toBe(false);
    await expect(service.galleryCached({ ...expectation }))
      .rejects.toMatchObject({ code: 'ERR_LOCKED' });
  });

  it('keeps Home responsive and coalesces reopen requests while gallery I/O drains', async () => {
    const { service, expectation, batches, waitForHang, releaseBatch } =
      await warmed({ hangBatches: true });
    const first = service.galleryList({ ...expectation });
    await waitForHang();
    releaseBatch();
    await first;

    const events: string[] = [];
    const beforeReopen = batches.length;
    events.push('gallery:start');
    const abandoned = service.galleryList({ ...expectation });
    await waitForHang();
    events.push('gallery:network-suspended');

    // Model three popup documents asking for the same account after the first
    // caller disappeared. They join the worker flight instead of accumulating
    // serial signed batches.
    const reopened = service.galleryList({ ...expectation });
    const reopenedAgain = service.galleryList({ ...expectation });
    events.push('home:start');
    const home = await service.homeView({ ...expectation });
    events.push('home:resolved');
    expect(home.accountId).toBe(expectation.accountId);
    expect(events).toEqual([
      'gallery:start',
      'gallery:network-suspended',
      'home:start',
      'home:resolved',
    ]);
    expect(batches).toHaveLength(beforeReopen + 1);

    const cached = await service.galleryCached({ ...expectation });
    expect(cached.hit).toBe(true);

    releaseBatch();
    const results = await Promise.all([abandoned, reopened, reopenedAgain]);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
    expect(batches).toHaveLength(beforeReopen + 1);
  });

  it('locks during gallery I/O and rejects the detached commit at the session boundary', async () => {
    const { harness, service, expectation, waitForHang, releaseBatch } =
      await warmed({ hangBatches: true });
    const warm = service.galleryList({ ...expectation });
    await waitForHang();
    releaseBatch();
    await warm;

    const detached = service.galleryList({ ...expectation });
    await waitForHang();
    await expect(service.lock()).resolves.toEqual({ locked: true });
    expect(harness.session.store.has('squirrel:session')).toBe(false);
    expect(harness.session.store.has(GALLERY_PREVIEW_CACHE_KEY)).toBe(false);

    releaseBatch();
    await expect(detached).rejects.toMatchObject({ code: 'ERR_LOCKED' });
    expect(harness.session.store.has(GALLERY_PREVIEW_CACHE_KEY)).toBe(false);
  });

  it('cannot commit vault A gallery data after a vault/session switch', async () => {
    const { harness, service, expectation, waitForHang, releaseBatch } =
      await warmed({ hangBatches: true });
    const other = await service.restore({
      name: 'other',
      password: PASSWORD,
      mnemonic: 'legal winner thank year wave sausage worth useful legal winner thank yellow',
    });
    const detached = service.galleryList({ ...expectation });
    await waitForHang();

    const switched = await service.switchVault({ vaultId: other.vaultId, password: PASSWORD });
    expect(switched.sessionId).not.toBe(expectation.expectedSessionId);
    releaseBatch();
    await expect(detached).rejects.toMatchObject({ code: 'ERR_LOCKED' });
    expect(harness.session.store.has(GALLERY_PREVIEW_CACHE_KEY)).toBe(false);
  });

  it('rejects a response when the same-session encrypted gallery generation changed', async () => {
    const { cache, service, expectation, waitForHang, releaseBatch } =
      await warmed({ hangBatches: true });
    const warm = service.galleryList({ ...expectation });
    await waitForHang();
    releaseBatch();
    await warm;

    const detached = service.galleryList({ ...expectation });
    await waitForHang();
    const key = {
      vaultId: expectation.expectedVaultId,
      network: 'signet' as const,
      type: 'gallery' as const,
      key: expectation.accountId,
    };
    const encrypted = await cache.get(key);
    if (!encrypted) throw new Error('missing encrypted gallery record');
    await cache.put({
      ...encrypted,
      box: { ...encrypted.box, ciphertextB64: `${encrypted.box.ciphertextB64}AA==` },
    });

    releaseBatch();
    await expect(detached).rejects.toMatchObject({ code: 'ERR_DATA_STALE' });
  });

  it('never lets the cache change what gallery.list answers', async () => {
    const { harness, service, expectation, batches } = await warmed();
    const cold = await service.galleryList({ ...expectation });
    const coldBatches = batches.length;

    const reads: string[] = [];
    const get = harness.session.get.bind(harness.session);
    harness.session.get = async (keys: string | string[]): Promise<Record<string, unknown>> => {
      reads.push(...(Array.isArray(keys) ? keys : [keys]));
      return get(keys);
    };
    const warm = await service.galleryList({ ...expectation });

    // Authority is recomputed from local UTXO facts and a freshly verified
    // batch. This unfiltered explicit-Refresh path never reads either paint
    // cache, so it remains the route that supersedes retained previews.
    expect(reads).not.toContain(GALLERY_PREVIEW_CACHE_KEY);
    expect(batches.length).toBeGreaterThan(coldBatches);
    expect(warm.items.map((item) => item.action)).toEqual(cold.items.map((item) => item.action));
    expect(harness.session.store.has(GALLERY_PREVIEW_CACHE_KEY)).toBe(true);
  });

  it('keeps the session record writable when the cache write is rejected', async () => {
    const { harness, service, expectation } = await warmed();
    harness.session.failOnSetKey = GALLERY_PREVIEW_CACHE_KEY;

    const listed = await service.galleryList({ ...expectation });

    expect(listed.items.length).toBeGreaterThan(0);
    expect(harness.session.store.has('squirrel:session')).toBe(true);
    expect(harness.session.store.has(GALLERY_PREVIEW_CACHE_KEY)).toBe(false);
  });

  it('reports the viewer affordance on an item restored during paint-ahead', async () => {
    const { service, expectation } = await warmed();
    const full = await service.galleryList({ ...expectation });
    const raster = full.items.find((item) => item.preview.kind === 'raster');
    if (!raster) throw new Error('missing raster fixture');
    expect(raster.mediaAvailable).toBe(true);

    // An automatic warm load asks for no specific raster. The bounded L2
    // paint-ahead window restores this exact preview without crossing the wire.
    const lazy = await service.galleryList({ ...expectation, rasterFor: [] });

    const skipped = lazy.items.find((item) => item.inscriptionId === raster.inscriptionId);
    expect(skipped?.preview).toEqual(raster.preview);
    expect(skipped?.mediaAvailable).toBe(true);
  });

  it('locks even when the cosmetic cache cannot be removed', async () => {
    const { harness, service, expectation } = await warmed();
    await service.galleryList({ ...expectation });
    const remove = harness.session.remove.bind(harness.session);
    harness.session.remove = async (keys: string | string[]): Promise<void> => {
      const list = Array.isArray(keys) ? keys : [keys];
      if (list.includes(GALLERY_PREVIEW_CACHE_KEY)) throw new Error('storage unavailable');
      await remove(keys);
    };

    // Paint-only pixels must never be able to abort a lock and leave the DEK
    // sitting in session storage while the user believes they locked.
    await expect(service.lock()).resolves.toEqual({ locked: true });
    expect(harness.session.store.has('squirrel:session')).toBe(false);
  });

  it('retries a cache write that was rejected rather than deduplicating it away', async () => {
    const { harness, service, expectation } = await warmed();
    harness.session.failOnSetKey = GALLERY_PREVIEW_CACHE_KEY;
    await service.galleryList({ ...expectation });
    expect(harness.session.store.has(GALLERY_PREVIEW_CACHE_KEY)).toBe(false);

    harness.session.failOnSetKey = null;
    await service.galleryList({ ...expectation });

    // The projection is unchanged, but nothing was ever stored, so the repeat
    // must not be skipped as a duplicate.
    expect(harness.session.store.has(GALLERY_PREVIEW_CACHE_KEY)).toBe(true);
  });

  it('rewrites the cache only when the projection has changed', async () => {
    const { harness, service, expectation } = await warmed();
    const writes: number[] = [];
    const set = harness.session.set.bind(harness.session);
    harness.session.set = async (items: Record<string, unknown>): Promise<void> => {
      if (GALLERY_PREVIEW_CACHE_KEY in items) writes.push(1);
      await set(items);
    };

    // A running scan re-enters galleryList roughly once a second; re-serializing
    // several MiB each time buys nothing when the pixels have not moved.
    const listed = await service.galleryList({ ...expectation });
    await service.galleryList({ ...expectation });

    expect(writes).toHaveLength(1);

    const session = await getSession(harness.session);
    if (session === null) throw new Error('missing session');
    const savePaintCache = (service as unknown as {
      saveGalleryPaintCache(
        activeSession: typeof session,
        activeAccountId: string,
        items: typeof listed.items,
        now: number,
      ): Promise<void>;
    }).saveGalleryPaintCache.bind(service);
    (service as unknown as { lastCachedGalleryPayload: string | null })
      .lastCachedGalleryPayload = null;
    const mature = listed.items.map((item) => ({ ...item, confirmations: 7 }));
    await savePaintCache(session, expectation.accountId, mature, harness.clock.now);
    await savePaintCache(
      session,
      expectation.accountId,
      mature.map((item) => ({ ...item, confirmations: 8 })),
      harness.clock.now,
    );

    // The first mature projection differs from the fixture, but confirmations
    // beyond six do not keep rewriting several MiB every block.
    expect(writes).toHaveLength(2);
  });
});
