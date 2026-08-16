/**
 * A Vault coordinator service standing behind a fake Full Sat Safety gateway.
 *
 * Extracted from the C2 scan suite when C4-C6 needed the same thing: a service
 * with role A generated live, both peers imported, a policy committed, and a
 * gateway seeded with the addresses that policy actually derives. The seeding
 * is deliberately two-pass — commit the policy, *then* seed from its own
 * `deriveVaultOutput` output — so a derivation regression shows up as an empty
 * Vault rather than as a passing test against a hand-written address.
 *
 * All disposable signet fixture material. Nothing here is funded and nothing
 * here reaches a network: `broadcastTransaction` is a recorder.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreFixturesDir } from '../helpers/core-fixtures';
import { PASSWORD } from '@drey/core/testing/vault-helpers';
import {
  statusCapabilitiesSchema,
  type BroadcastRequest,
  type BroadcastResult,
  type StatusCapabilities,
  type Tip,
} from '@drey/core/domain/gateway/contract';
import { deriveVaultOutput } from '@drey/core/domain/vault/multisig-descriptors';
import { VAULT_FULL_SAT_SAFETY_CAPABILITIES } from '@drey/core/domain/vault/multisig-asset-policy';
import { scriptHashFromScriptPubKey } from '@drey/core/domain/keys/script-hash';
import type { GatewayClient } from '@drey/core/gateway-client';
import type { WalletService } from '../../src/background/wallet-service';
import { composeVaultPolicyRecord } from '../../src/background/vault-policy';
import {
  peerOrigin,
  peerOriginHex,
  peerProofHex,
  recoveryCBackupResponseHex,
  recoveryCSetupResponseHex,
} from './vault-peer-signers';
import { makeHarness } from '../background/service-helpers';
import type { FakeArea } from '../adapters/fake-area';

export const statusTemplate = statusCapabilitiesSchema.parse(
  JSON.parse(readFileSync(join(coreFixturesDir, 'gateway', 'status.signed.json'), 'utf8')),
);

export const TIP: Tip = statusTemplate.coreTip;
export const OTHER_TIP: Tip = { height: TIP.height + 1, hash: 'ab'.repeat(32) };

/**
 * The committed dev fixture advertises `standard_ordinals_safety` only — it has
 * no sat index, rarity, rune, or unsupported-asset detection — so a Vault is
 * permanently read-only against it, which is the correct fail-closed answer
 * rather than something to work around. These tests model a backend that does
 * offer Full Sat Safety, because the behaviour under test is what happens once
 * one is available.
 */
const FULL_SAT_SAFETY_CAPABILITIES = [
  ...VAULT_FULL_SAT_SAFETY_CAPABILITIES,
  'preview_service',
  'fee_estimation',
  'broadcast',
];

export interface SeededUtxo {
  scriptHash: string;
  scriptPubKey: string;
  txid: string;
  vout: number;
  valueSats: string;
  height: number | null;
  classification?: Record<string, unknown>;
}

export interface FakeOptions {
  clock: { now: number };
  utxos: SeededUtxo[];
  /** Make the status response describe a different block than the snapshot. */
  statusTip?: Tip;
  /** Drop these from the advertised capability set. */
  dropCapabilities?: string[];
  /** Fail every snapshot request. */
  failSnapshot?: boolean;
  /** Answer classify with a revision the snapshot did not use. */
  skewClassifyRevision?: boolean;
  /** What the composition root injected. Defaults to the signet full pairing. */
  capability?: { network: 'signet'; movement: 'full' };
  /** How the fake gateway answers a broadcast. Defaults to `accepted`. */
  broadcast?: { ok: false } | { ok: true; status: BroadcastResult['status'] };
  /** Optional deferred response for restart-after-dispatch lifecycle tests. */
  broadcastBarrier?: { reached(): void; release: Promise<void> };
  /** Shared controls let a test change only the next read after setup. */
  statusControl?: { failuresRemaining: number };
  reconciliationControl?: {
    txid: string | null;
    confirmationState: 'confirmed' | 'mempool' | 'replaced' | 'conflicted';
  };
}

function makeVaultGateway(
  options: FakeOptions,
  broadcasts: BroadcastRequest[],
  statusFetches: { count: number },
) {
  const iso = () => new Date(options.clock.now).toISOString();
  const revision = 'rev-vault-1';
  const envelope = () => ({
    instanceId: statusTemplate.instanceId,
    network: 'signet' as const,
    protocolVersion: 1,
    requestNonce: '00'.repeat(16),
    timestamp: iso(),
    coreTip: TIP,
    indexTip: TIP,
    classificationRevision: revision,
    capabilities: FULL_SAT_SAFETY_CAPABILITIES,
    signature: 'aa',
  });
  const classificationFor = (utxo: SeededUtxo) => ({
    txid: utxo.txid,
    vout: utxo.vout,
    valueSats: utxo.valueSats,
    scriptPubKey: utxo.scriptPubKey,
    confirmations: utxo.height === null ? 0 : TIP.height - utxo.height + 1,
    primaryClass: 'cardinal_clean',
    inscriptions: [],
    satRanges: [{ start: '100', end: '200', rarity: 'common' }],
    unsupportedAssetDetected: false,
    confidence: 'authoritative',
    classifiedTip: TIP,
    classificationRevision: revision,
    ...utxo.classification,
  });

  return {
    endpoint: 'http://fake-vault-gateway',
    protocolVersions: [1, 2] as const,
    fetchStatus: () => {
      statusFetches.count += 1;
      if ((options.statusControl?.failuresRemaining ?? 0) > 0) {
        options.statusControl!.failuresRemaining -= 1;
        return Promise.resolve({ ok: false as const, reason: 'network_error' as const });
      }
      return Promise.resolve({
        ok: true as const,
        status: {
          ...statusTemplate,
          timestamp: iso(),
          mempoolObservedAt: iso(),
          serverTime: iso(),
          classificationRevision: revision,
          eligibleSafetyModes: ['full_sat_safety', 'standard_ordinals_safety'],
          capabilities: FULL_SAT_SAFETY_CAPABILITIES.filter(
            (capability) => !(options.dropCapabilities ?? []).includes(capability),
          ),
          ...(options.statusTip
            ? {
                coreTip: options.statusTip,
                indexTip: options.statusTip,
                historyTip: options.statusTip,
                ordTip: options.statusTip,
              }
            : { coreTip: TIP, indexTip: TIP, historyTip: TIP, ordTip: TIP }),
        } as StatusCapabilities,
        verifiedAtMs: options.clock.now,
      });
    },
    fetchSnapshot: (req: { scriptHashes: string[] }) => {
      if (options.failSnapshot) {
        return Promise.resolve({ ok: false as const, reason: 'network_error' as const });
      }
      const matched = options.utxos.filter((utxo) => req.scriptHashes.includes(utxo.scriptHash));
      return Promise.resolve({
        ok: true as const,
        value: {
          ...envelope(),
          requestedScriptHashes: req.scriptHashes,
          activeScriptHashes: [
            ...new Set([
              ...matched.map((utxo) => utxo.scriptHash),
              ...(options.reconciliationControl?.txid === null ||
                options.reconciliationControl?.txid === undefined
                ? []
                : req.scriptHashes.slice(0, 1)),
            ]),
          ],
          historyCoverage: { status: 'complete' as const, limitedScriptHashes: [] },
          utxos: matched.map((utxo) => ({
            txid: utxo.txid,
            vout: utxo.vout,
            valueSats: utxo.valueSats,
            scriptHash: utxo.scriptHash,
            scriptPubKey: utxo.scriptPubKey,
            height: utxo.height,
            fundingSpendsOnlyRequested: false,
          })),
          history: [...matched.map((utxo) => ({
            txid: utxo.txid,
            height: utxo.height,
            fundedScriptHashes: [utxo.scriptHash],
            spentScriptHashes: [],
          })), ...(options.reconciliationControl?.txid === null ||
            options.reconciliationControl?.txid === undefined ? [] : [{
              txid: options.reconciliationControl.txid,
              height: options.reconciliationControl.confirmationState === 'confirmed' ? TIP.height : null,
              timestamp: iso(),
              fundedScriptHashes: [],
              spentScriptHashes: req.scriptHashes.slice(0, 1),
              deltaSats: '-1',
              replacesTxid: null,
              replacedByTxid: null,
              confirmationState: options.reconciliationControl.confirmationState,
              feeSats: null,
              vsize: null,
              replaceable: false,
              packageFeeSats: null,
              packageVsize: null,
              cpfpEligible: false,
            }])],
        },
        verifiedAtMs: options.clock.now,
      });
    },
    classifyOutpoints: (req: { outpoints: Array<{ txid: string; vout: number }> }) => {
      const classifications: unknown[] = [];
      const unknownOutpoints: unknown[] = [];
      for (const outpoint of req.outpoints) {
        const found = options.utxos.find(
          (utxo) => utxo.txid === outpoint.txid && utxo.vout === outpoint.vout,
        );
        if (found) classifications.push(classificationFor(found));
        else unknownOutpoints.push(outpoint);
      }
      return Promise.resolve({
        ok: true as const,
        value: {
          ...envelope(),
          ...(options.skewClassifyRevision ? { classificationRevision: 'rev-skewed' } : {}),
          classifications,
          unknownOutpoints,
        },
        verifiedAtMs: options.clock.now,
      });
    },
    broadcastTransaction: async (req: BroadcastRequest) => {
      // Recorded, never sent. What the lifecycle tests care about is whether a
      // second attempt reaches this function at all.
      broadcasts.push(req);
      options.broadcastBarrier?.reached();
      await options.broadcastBarrier?.release;
      const outcome = options.broadcast ?? { ok: true as const, status: 'accepted' as const };
      if (!outcome.ok) return { ok: false as const, reason: 'network_error' as const };
      return {
        ok: true as const,
        value: {
          ...envelope(),
          submittedTxid: req.txid,
          submittedWtxid: req.wtxid,
          status: outcome.status,
          txid: outcome.status === 'rejected' ? null : req.txid,
          errorCode: null,
          detail: null,
        } as BroadcastResult,
        verifiedAtMs: options.clock.now,
      };
    },
  } as unknown as GatewayClient;
}

/** Receive/change scripts regenerated from the committed policy. */
export type ScriptLookup = (
  branch: 'receive' | 'change',
  index: number,
) => { scriptPubKey: string; scriptHash: string };

/** Build a harness whose service already has the gateway wired in. */
export async function withGateway(options: Omit<FakeOptions, 'clock'>): Promise<VaultGatewayHarness> {
  // Two passes: the first commits a policy so its addresses are known, the
  // second rebuilds the same stores behind a gateway seeded with those
  // addresses. The alternative — guessing addresses up front — would let a
  // derivation bug pass unnoticed.
  const clock = { now: 1_752_969_600_000 };
  // One clock for the fake gateway and for the service, so a test can age a
  // plan's evidence past its window simply by moving it.
  let rng = 1;
  const vaultDeps = {
    random: (n: number) => new Uint8Array(n).map((_, i) => (i * 31 + rng++ * 97) % 256),
    now: () => clock.now,
  };
  const bootstrap = makeHarness(undefined, {
    network: 'signet',
    vaultDeps,
    vaultCoordinatorCapability: { network: 'signet', movement: 'full' } as const,
  });
  const { vaultId } = await bootstrap.service.create({ name: 'Main', password: PASSWORD });
  const unlocked = await bootstrap.service.unlock({ vaultId, password: PASSWORD });
  const expectation = { expectedVaultId: vaultId, expectedSessionId: unlocked.sessionId };
  await bootstrap.service.vaultCoordinatorCreateRole({
    password: PASSWORD,
    label: 'A',
    ...expectation,
  });
  const challenge = await bootstrap.service.vaultCoordinatorBeginImport({ ...expectation });
  await bootstrap.service.vaultCoordinatorImportSigner({
    role: 'mobile-b',
    originHex: peerOriginHex('mobile-b'),
    proofResultHex: peerProofHex('mobile-b', challenge),
    ...expectation,
  });
  const recoverySetup = await bootstrap.service.vaultCoordinatorBeginRecoveryCSetup({
    ...expectation,
  });
  await bootstrap.service.vaultCoordinatorImportRecoveryCSetupResponse({
    responseHex: recoveryCSetupResponseHex(recoverySetup.challengeHex),
    ...expectation,
  });
  const { policy } = await bootstrap.service.vaultCoordinatorCreatePolicy({
    password: PASSWORD,
    vaultLabel: 'Test Vault',
    signerLabels: ['A', 'B', 'C'],
    birthdayHeight: null,
    ...expectation,
  });
  await bootstrap.service.vaultCoordinatorAcknowledgeRecoveryKitExport({
    policyId: policy.policyId,
    ...expectation,
  });
  const backupCheck = await bootstrap.service.vaultCoordinatorBeginRecoveryCBackupCheck({
    ...expectation,
  });
  await bootstrap.service.vaultCoordinatorImportRecoveryCBackupCheckResponse({
    responseHex: recoveryCBackupResponseHex(backupCheck.challengeHex),
    ...expectation,
  });
  const roleOrigin = (await bootstrap.service.vaultCoordinatorRoleOrigin({ ...expectation })).role!;
  const identity = composeVaultPolicyRecord(
    'signet',
    [roleOrigin.origin, peerOrigin('mobile-b'), peerOrigin('recovery-c')],
    {
      createdAtMs: '1',
      birthdayHeight: null,
      vaultLabel: 'Test Vault',
      signerLabels: ['A', 'B', 'C'],
    },
  ).identity;
  const script: ScriptLookup = (branch, index) => {
    const output = deriveVaultOutput(identity, branch, index);
    return {
      scriptPubKey: output.scriptPubKeyHex,
      scriptHash: scriptHashFromScriptPubKey(output.scriptPubKeyHex),
    };
  };

  const broadcasts: BroadcastRequest[] = [];
  const statusFetches = { count: 0 };
  const gateway = makeVaultGateway({ ...options, clock }, broadcasts, statusFetches);
  const seeded = makeHarness(undefined, {
    network: 'signet',
    vaultDeps,
    vaultCoordinatorCapability: options.capability ?? { network: 'signet', movement: 'full' },
    local: bootstrap.local,
    session: bootstrap.session,
    gateway,
  });
  const relocked = await seeded.service.unlock({ vaultId, password: PASSWORD });
  const expectationAfter = {
    expectedVaultId: vaultId,
    expectedSessionId: relocked.sessionId,
  };
  return {
    identity,
    script,
    clock,
    utxos: options.utxos,
    broadcasts,
    statusFetches,
    gateway,
    // The bootstrap area, deliberately: `makeHarness` returns the fresh area it
    // created even when the caller overrode it, and the service writes to the
    // override. This is the one the coordinator actually persists through.
    local: bootstrap.local,
    service: seeded.service,
    rebuild: seeded.rebuild,
    expectation: expectationAfter,
    scan: () => seeded.service.vaultCoordinatorScan({ ...expectationAfter }),
  };
}

export interface VaultGatewayHarness {
  /** The committed policy, recomposed from the same origins the service holds. */
  identity: ReturnType<typeof composeVaultPolicyRecord>['identity'];
  script: ScriptLookup;
  /** The service's own storage area, for asserting what was actually persisted. */
  local: FakeArea;
  /** Mutable: advance it to age a plan's evidence past its window. */
  clock: { now: number };
  /** Mutable fake chain view, used to advance a parent into its unconfirmed change. */
  utxos: SeededUtxo[];
  /** Every broadcast the service attempted, in order. */
  broadcasts: BroadcastRequest[];
  /**
   * How many times the status endpoint was hit. The signed status envelope is
   * the fee binding for a custom-rate broadcast and the gateway refuses one
   * older than two minutes, so "did the send re-read it" is a real property.
   */
  statusFetches: { count: number };
  /** Signed fake gateway, exposed for coordinator-neutral peer-plan tests. */
  gateway: GatewayClient;
  service: WalletService;
  /** Fresh MV3 worker over the same coordinator stores and gateway recorder. */
  rebuild: () => WalletService;
  expectation: { expectedVaultId: string; expectedSessionId: string };
  scan: () => ReturnType<WalletService['vaultCoordinatorScan']>;
}
