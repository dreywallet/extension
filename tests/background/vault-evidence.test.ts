/**
 * Workstream C2 exit gate: independent verification of signed gateway evidence.
 *
 * `core/vectors/vault-asset-policy-v1.md` defers this into C — "Workstream C
 * must require every signer to verify signed gateway evidence independently" —
 * because core's B3 validator can check that an evidence record is coherent and
 * binds a plan, but never that it honestly describes what a gateway said.
 *
 * The claims under test:
 *
 * - one incoherent source makes the whole Vault read-only, and each way it can
 *   be incoherent is reported distinctly rather than collapsed into "error";
 * - a per-UTXO problem withholds that output without hiding the balance;
 * - a gateway record that contradicts itself poisons the scan instead of
 *   quietly dropping an inscription, which would turn a protected UTXO into an
 *   apparently clean one;
 * - projected evidence round-trips into core's own hasher and is accepted by
 *   `validateVaultAssetPolicy`'s input-binding rules.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import type { StatusCapabilities, Tip } from '@drey/core/domain/gateway/contract';
import type { WalletUtxo } from '@drey/core/domain/classification/types';
import {
  computeVaultInputAssetEvidenceHash,
  VAULT_FULL_SAT_SAFETY_CAPABILITIES,
} from '@drey/core/domain/vault/multisig-asset-policy';
import {
  buildVaultAssetPolicyEvidence,
  deriveVaultEvidenceSource,
  finalizeVaultUtxoEvidence,
  projectVaultUtxo,
  summarizeVaultBalance,
  vaultBackendInstanceIdHash,
  vaultClassificationRevisionHash,
  vaultEvidenceExpired,
  VAULT_EVIDENCE_TTL_MS,
  type VaultEvidenceSourceV1,
} from '../../src/background/vault-evidence';

beforeAll(installTestCryptoProvider);

const TIP: Tip = { height: 880_000, hash: 'aa'.repeat(32) };
const OTHER_TIP: Tip = { height: 880_001, hash: 'bb'.repeat(32) };
const NOW = 1_752_969_600_000;

function status(overrides: Partial<StatusCapabilities> = {}): StatusCapabilities {
  return {
    instanceId: 'gateway-1',
    network: 'mainnet',
    protocolVersion: 1,
    protocolMin: 1,
    protocolMax: 2,
    requestNonce: 'nonce',
    timestamp: '2026-08-02T00:00:00.000Z',
    coreTip: TIP,
    indexTip: TIP,
    historyTip: TIP,
    ordTip: TIP,
    classificationRevision: 'rev-1',
    capabilities: [...VAULT_FULL_SAT_SAFETY_CAPABILITIES],
    eligibleSafetyModes: ['full_sat_safety'],
    activeRevision: 'rev-1',
    mempoolObservedAt: '2026-08-02T00:00:00.000Z',
    serverTime: '2026-08-02T00:00:00.000Z',
    signature: 'sig',
    ...overrides,
  } as StatusCapabilities;
}

const SCAN = {
  instanceId: 'gateway-1',
  classificationRevision: 'rev-1',
  coreTip: TIP,
  indexTip: TIP,
};

function derive(overrides: {
  status?: StatusCapabilities | null;
  scan?: typeof SCAN | null;
} = {}) {
  return deriveVaultEvidenceSource({
    network: 'mainnet',
    status: overrides.status === undefined ? status() : overrides.status,
    scan: overrides.scan === undefined ? SCAN : overrides.scan,
    nowMs: NOW,
  });
}

function source(): VaultEvidenceSourceV1 {
  const result = derive();
  if (!result.ok) throw new Error('expected a coherent source');
  return result.source;
}

function utxo(overrides: Partial<WalletUtxo> = {}): WalletUtxo {
  return {
    outpoint: { txid: 'cc'.repeat(32), vout: 0 },
    valueSats: 100_000n,
    scriptPubKey: '0020' + 'dd'.repeat(32),
    account: 0,
    lane: 'payment',
    chain: 0,
    addressIndex: 0,
    height: 879_999,
    walletCreatedChange: false,
    facts: {
      primaryClass: 'cardinal_clean',
      inscriptions: [],
      satRanges: [{ start: '1', end: '2', rarity: 'common' }],
      unsupportedAssetDetected: false,
      confidence: 'authoritative',
      classifiedTip: TIP,
      classificationRevision: 'rev-1',
    },
    flags: { userFrozen: false, dustQuarantined: false },
    ...overrides,
  } as WalletUtxo;
}

describe('source coherence makes the whole Vault read-only (ADR 0007 §7)', () => {
  it('accepts one backend, one revision, and one block across every response', () => {
    const result = derive();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.coreTip).toEqual(TIP);
    expect(result.source.backendInstanceIdHash).toBe(vaultBackendInstanceIdHash('gateway-1'));
    expect(result.source.classificationRevisionHash).toBe(
      vaultClassificationRevisionHash('rev-1'),
    );
    expect(Number(result.source.validUntilMs) - Number(result.source.observedAtMs)).toBe(
      VAULT_EVIDENCE_TTL_MS,
    );
  });

  it('refuses when there is no gateway or no completed scan', () => {
    expect(derive({ status: null })).toEqual({ ok: false, refusal: 'gateway_unavailable' });
    expect(derive({ scan: null })).toEqual({ ok: false, refusal: 'scan_incomplete' });
  });

  it('refuses a backend missing any Full Sat Safety capability', () => {
    for (const missing of VAULT_FULL_SAT_SAFETY_CAPABILITIES) {
      const capabilities = VAULT_FULL_SAT_SAFETY_CAPABILITIES.filter((c) => c !== missing);
      expect(derive({ status: status({ capabilities }) }), missing).toEqual({
        ok: false,
        refusal: 'capabilities_insufficient',
      });
    }
    expect(derive({ status: status({ eligibleSafetyModes: ['standard_ordinals_safety'] }) })).toEqual(
      { ok: false, refusal: 'capabilities_insufficient' },
    );
  });

  it('refuses when the status response describes a different block than the scan', () => {
    // The ordinary race: a block lands between the scan and the status read.
    // Picking whichever tip looked current is exactly the guess §7 forbids.
    expect(derive({ status: status({ coreTip: OTHER_TIP, indexTip: OTHER_TIP, historyTip: OTHER_TIP, ordTip: OTHER_TIP }) })).toEqual({
      ok: false,
      refusal: 'conflicting_source',
    });
  });

  it('refuses when the backend disagrees with itself across its own tips', () => {
    for (const key of ['indexTip', 'historyTip', 'ordTip'] as const) {
      expect(derive({ status: status({ [key]: OTHER_TIP }) }), key).toEqual({
        ok: false,
        refusal: 'conflicting_source',
      });
    }
  });

  it('refuses a different backend instance, revision, or network', () => {
    expect(derive({ status: status({ instanceId: 'gateway-2' }) })).toEqual({
      ok: false,
      refusal: 'conflicting_source',
    });
    expect(derive({ status: status({ classificationRevision: 'rev-2' }) })).toEqual({
      ok: false,
      refusal: 'conflicting_source',
    });
    expect(derive({ status: status({ network: 'signet' }) })).toEqual({
      ok: false,
      refusal: 'conflicting_source',
    });
  });

  it('expires on its own declared window', () => {
    const current = source();
    expect(vaultEvidenceExpired(current, NOW)).toBe(false);
    expect(vaultEvidenceExpired(current, NOW + VAULT_EVIDENCE_TTL_MS)).toBe(false);
    expect(vaultEvidenceExpired(current, NOW + VAULT_EVIDENCE_TTL_MS + 1)).toBe(true);
  });

  it('separates its two identity hashes by domain', () => {
    // Same input string must not produce the same hash in both roles, or a
    // revision could be substituted for a backend identity inside a plan.
    expect(vaultBackendInstanceIdHash('x')).not.toBe(vaultClassificationRevisionHash('x'));
  });
});

describe('per-UTXO usability withholds one output, not the balance', () => {
  it('accepts a fully proven confirmed cardinal output', () => {
    const projected = projectVaultUtxo(utxo(), source());
    expect(projected?.refusal).toBeNull();
    expect(projected?.confirmations).toBe(2);
    expect(projected?.branch).toBe('receive');
    expect(projected?.satRangesComplete).toBe(true);
  });

  it('withholds each unusable state with its own reason', () => {
    const cases: Array<[Partial<WalletUtxo>, string]> = [
      [{ facts: { ...utxo().facts!, confidence: 'degraded' } }, 'degraded'],
      [{ facts: { ...utxo().facts!, satRanges: null } }, 'classification_incomplete'],
      [{ facts: { ...utxo().facts!, unsupportedAssetDetected: true } }, 'unsupported_asset'],
      [
        { facts: { ...utxo().facts!, satRanges: [{ start: '1', end: '2', rarity: 'epic' }] } },
        'rare_sat',
      ],
      [{ facts: { ...utxo().facts!, primaryClass: 'mixed' } }, 'mixed_or_unknown'],
      [{ facts: { ...utxo().facts!, primaryClass: 'unknown' } }, 'mixed_or_unknown'],
      [{ facts: { ...utxo().facts!, primaryClass: 'runic_or_unsupported' } }, 'mixed_or_unknown'],
      [{ flags: { userFrozen: true, dustQuarantined: false } }, 'user_frozen'],
      [{ flags: { userFrozen: false, dustQuarantined: true } }, 'dust_quarantined'],
      [{ height: null }, 'unconfirmed'],
    ];
    for (const [override, expected] of cases) {
      expect(projectVaultUtxo(utxo(override), source())?.refusal, expected).toBe(expected);
    }
  });

  it('still counts an unusable output in the total, only not in the movable part', () => {
    const projected = [
      projectVaultUtxo(utxo(), source())!,
      projectVaultUtxo(
        utxo({
          outpoint: { txid: 'ee'.repeat(32), vout: 1 },
          valueSats: 25_000n,
          flags: { userFrozen: true, dustQuarantined: false },
        }),
        source(),
      )!,
    ];
    expect(summarizeVaultBalance(projected)).toEqual({
      totalSats: '125000',
      movableSats: '100000',
      immovableSats: '25000',
      inscriptionCount: 0,
    });
  });

  it('treats an inscribed output as held but present', () => {
    const txid = 'cc'.repeat(32);
    const projected = projectVaultUtxo(
      utxo({
        facts: {
          ...utxo().facts!,
          primaryClass: 'inscribed',
          inscriptions: [{ inscriptionId: `${'ff'.repeat(32)}i0`, satpoint: `${txid}:0:600` }],
        },
      }),
      source(),
    );
    expect(projected?.inscriptions).toEqual([
      { inscriptionId: `${'ff'.repeat(32)}i0`, offsetSats: '600' },
    ]);
    // Inscribed is a supported class: it is movable as a whole UTXO, so it is
    // not withheld here — ADR 0007 §7's restrictions apply when a plan selects.
    expect(projected?.refusal).toBeNull();
  });
});

describe('a self-contradicting gateway record poisons the scan', () => {
  it('refuses an inscription pinned to a different outpoint', () => {
    // The worst possible silent failure would be dropping this inscription and
    // presenting the UTXO as clean, so the projection refuses outright.
    for (const satpoint of [
      `${'99'.repeat(32)}:0:600`,
      `${'cc'.repeat(32)}:7:600`,
      `${'cc'.repeat(32)}:0:notanumber`,
      'malformed',
    ]) {
      expect(
        projectVaultUtxo(
          utxo({
            facts: {
              ...utxo().facts!,
              primaryClass: 'inscribed',
              inscriptions: [{ inscriptionId: `${'ff'.repeat(32)}i0`, satpoint }],
            },
          }),
          source(),
        ),
        satpoint,
      ).toBeNull();
    }
  });

  it('refuses a UTXO confirmed above the tip it was classified against', () => {
    expect(projectVaultUtxo(utxo({ height: TIP.height + 5 }), source())).toBeNull();
  });
});

describe('projected evidence is core-compatible', () => {
  it('finalizes through core, reproducing core\'s own evidence hash', () => {
    const current = source();
    const projected = projectVaultUtxo(utxo(), current)!;
    const evidence = finalizeVaultUtxoEvidence(projected, current, 0);
    expect(evidence.evidenceHash).toBe(computeVaultInputAssetEvidenceHash(evidence));
    expect(evidence.classificationRevisionHash).toBe(current.classificationRevisionHash);
    expect(evidence.classifiedTip).toEqual(current.coreTip);
  });

  it('binds inputIndex, so plan order cannot be reshuffled under a hash', () => {
    const current = source();
    const projected = projectVaultUtxo(utxo(), current)!;
    expect(finalizeVaultUtxoEvidence(projected, current, 0).evidenceHash).not.toBe(
      finalizeVaultUtxoEvidence(projected, current, 1).evidenceHash,
    );
  });

  it('assembles a complete B3 record with the required capability set', () => {
    const current = source();
    const projected = [projectVaultUtxo(utxo(), current)!];
    const evidence = buildVaultAssetPolicyEvidence({
      source: current,
      policyId: '11'.repeat(32),
      planId: '22'.repeat(16),
      planDigest: '33'.repeat(32),
      utxos: projected,
    });
    expect(evidence.safetyMode).toBe('full_sat_safety');
    expect(evidence.capabilities).toEqual([...VAULT_FULL_SAT_SAFETY_CAPABILITIES]);
    expect(evidence.inputs).toHaveLength(1);
    expect(evidence.inputs[0]!.inputIndex).toBe(0);
    expect(evidence.observedAtMs).toBe(current.observedAtMs);
  });
});
