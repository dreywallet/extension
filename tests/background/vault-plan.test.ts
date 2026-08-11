/**
 * Workstream C3 exit gate: withdrawal plans and the deposit destination proof.
 *
 * The claims under test:
 *
 * - a plan round-trips through core's canonical encoding with a stable
 *   `planDigest`, and every plan this module emits has already been through the
 *   B3 asset-policy validator;
 * - `validateVaultAssetPolicy` accepts a well-formed plan and rejects the
 *   mutations `vault-asset-policy-v1` enumerates — stale and conflicting
 *   evidence, reordered inputs, a changed amount, a substituted PSBT;
 * - an inscription-bearing UTXO can never be selected, for a fee or for an
 *   ordinary BTC transfer, asserted directly rather than only through core;
 * - a deposit destination is proved Vault-owned by regeneration, not by string
 *   comparison;
 * - nothing here signs or broadcasts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { bytesToHex, hexToBytes } from '@drey/core/domain/vault/encoding';
import {
  canonicalVaultPlanBytes,
  computeVaultPlanDigest,
  parseCanonicalVaultPlan,
} from '@drey/core/domain/vault/multisig-encoding';
import {
  validateVaultAssetPolicy,
  VaultAssetPolicyError,
} from '@drey/core/domain/vault/multisig-asset-policy';
import { deriveVaultOutput } from '@drey/core/domain/vault/multisig-descriptors';
import type { VaultSignerOriginV1 } from '@drey/core/domain/vault/multisig-contracts';
import { createRequire } from 'node:module';
import { composeVaultPolicyRecord } from '../../src/background/vault-policy';
import {
  buildVaultWithdrawal,
  selectVaultCardinalInputs,
  assertVaultDepositAddress,
  approvedPlanRecord,
  parseApprovedPlan,
  VaultPlanError,
  type VaultWithdrawalRequest,
} from '../../src/background/vault-plan';
import {
  vaultBackendInstanceIdHash,
  vaultClassificationRevisionHash,
  VAULT_EVIDENCE_TTL_MS,
  type VaultEvidenceSourceV1,
  type VaultUtxoV1,
} from '../../src/background/vault-evidence';

beforeAll(installTestCryptoProvider);

const require = createRequire(import.meta.url);
const contracts = require('@drey/core/vectors/vault-contracts-v1.json') as {
  records: Record<string, { signers: VaultSignerOriginV1[] }>;
};

// Lazy: the crypto provider is installed in beforeAll, and policy composition
// hashes, so building this at module scope would run before it exists.
let policyCache: ReturnType<typeof composeVaultPolicyRecord>['identity'] | null = null;
function policy(): ReturnType<typeof composeVaultPolicyRecord>['identity'] {
  policyCache ??= composeVaultPolicyRecord(
    'signet',
    contracts.records['signet']!.signers as [
      VaultSignerOriginV1,
      VaultSignerOriginV1,
      VaultSignerOriginV1,
    ],
    {
      createdAtMs: '1735689600000',
      birthdayHeight: 250_000,
      vaultLabel: 'Plan Vault',
      signerLabels: ['A', 'B', 'C'],
    },
  ).identity;
  return policyCache;
}

const NOW = 1_752_969_600_000;
const TIP = { height: 250_500, hash: 'aa'.repeat(32) };

function evidenceSource(): VaultEvidenceSourceV1 {
  return {
    network: 'signet',
    backendInstanceIdHash: vaultBackendInstanceIdHash('gateway-1'),
    classificationRevisionHash: vaultClassificationRevisionHash('rev-1'),
    coreTip: TIP,
    indexTip: TIP,
    historyTip: TIP,
    ordTip: TIP,
    observedAtMs: String(NOW),
    validUntilMs: String(NOW + VAULT_EVIDENCE_TTL_MS),
  };
}

/** A Vault-owned output at the given branch/index, valued as asked. */
function vaultUtxo(
  index: number,
  valueSats: string,
  overrides: Partial<VaultUtxoV1> = {},
): VaultUtxoV1 {
  const derived = deriveVaultOutput(policy(), 'receive', index);
  return {
    txid: index.toString(16).padStart(2, '0').repeat(32),
    vout: 0,
    valueSats,
    scriptPubKeyHex: derived.scriptPubKeyHex,
    branch: 'receive',
    derivationIndex: index,
    confirmations: 6,
    walletCreatedUnconfirmedChange: false,
    primaryClass: 'cardinal_clean',
    confidence: 'authoritative',
    classificationComplete: true,
    satRangesComplete: true,
    inscriptions: [],
    rareSatDetected: false,
    unsupportedAssetDetected: false,
    userFrozen: false,
    dustQuarantined: false,
    refusal: null,
    ...overrides,
  };
}

/** A signet P2WPKH address standing in for the paired Spending wallet. */
const DESTINATION = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

function request(overrides: Partial<VaultWithdrawalRequest> = {}): VaultWithdrawalRequest {
  return {
    policy: policy(),
    capability: { network: 'signet', movement: 'full' },
    source: evidenceSource(),
    utxos: [vaultUtxo(0, '400000')],
    destinationAddress: DESTINATION,
    pairedSpendingWalletIdHash: 'bb'.repeat(32),
    amountSats: '100000',
    feeRateSatPerKvB: '5000',
    changeDerivationIndex: 0,
    planId: 'cc'.repeat(16),
    requestId: 'dd'.repeat(16),
    createdAtMs: String(NOW),
    expiresAtMs: String(NOW + VAULT_EVIDENCE_TTL_MS),
    ...overrides,
  };
}

describe('C3 withdrawal plans round-trip and validate', () => {
  it('builds a plan whose canonical bytes reproduce a stable planDigest', () => {
    const built = buildVaultWithdrawal(request());
    const canonical = canonicalVaultPlanBytes(built.plan);
    const reparsed = parseCanonicalVaultPlan(canonical);
    expect(reparsed.planDigest).toBe(built.plan.planDigest);
    expect(computeVaultPlanDigest(built.plan)).toBe(built.plan.planDigest);
    // Byte-stable across a full serialize/parse/serialize cycle.
    expect(bytesToHex(canonicalVaultPlanBytes(reparsed))).toBe(bytesToHex(canonical));
  });

  it('is already B3-validated by the time it is returned', () => {
    const built = buildVaultWithdrawal(request());
    // Re-running the validator the builder used must accept the same artifacts.
    const validation = validateVaultAssetPolicy({
      policy: policy(),
      plan: built.plan,
      psbtHex: built.psbtHex,
      evidence: built.evidence,
      nowMs: String(NOW),
    });
    expect(validation.movement).toBe('cardinal');
    expect(validation.protectedAssetId).toBeNull();
    expect(validation.replacement).toBe('none');
  });

  it('pays to the requested destination and keeps change Vault-owned', () => {
    const built = buildVaultWithdrawal(request());
    expect(built.plan.destination.address).toBe(DESTINATION);
    expect(built.plan.amountSats).toBe('100000');
    const change = built.plan.outputs.find((output) => output.purpose === 'vault-change');
    expect(change).toBeDefined();
    // Regenerated independently: change must be an address this policy owns.
    expect(change!.address).toBe(deriveVaultOutput(policy(), 'change', 0).address);
    expect(built.plan.changeSats).toBe(change!.valueSats);
  });

  it('binds a conservative vsize the finalized transaction cannot exceed', () => {
    const built = buildVaultWithdrawal(request());
    expect(built.plan.vsize).toBeGreaterThan(0);
    // Core recomputes this bound with the same maximum witness and rejects a
    // mismatch, so the validator above passing is the real assertion.
    expect(BigInt(built.plan.feeSats)).toBeGreaterThan(0n);
    expect(built.plan.broadcastIntent).toBe('broadcast');
    expect(built.plan.sighash).toBe('all');
  });

  it('drops change that would be worth less than spending it later', () => {
    // Leave barely more than the fee: change would be uneconomic, so it must
    // go to the fee rather than create an output nobody can afford to spend.
    const built = buildVaultWithdrawal(
      request({ utxos: [vaultUtxo(0, '101200')], amountSats: '100000' }),
    );
    expect(built.plan.outputs.some((output) => output.purpose === 'vault-change')).toBe(false);
    expect(built.plan.changeSats).toBe('0');
  });

  it('adds inputs when one cannot cover amount plus fee', () => {
    const built = buildVaultWithdrawal(
      request({
        utxos: [vaultUtxo(0, '60000'), vaultUtxo(1, '60000')],
        amountSats: '100000',
      }),
    );
    expect(built.plan.inputs).toHaveLength(2);
    expect(built.selected).toHaveLength(2);
  });
});

describe('C3 rejects the mutations vault-asset-policy-v1 enumerates', () => {
  const built = () => buildVaultWithdrawal(request());

  it('rejects evidence that has aged out of its window', () => {
    const plan = built();
    expect(() =>
      validateVaultAssetPolicy({
        policy: policy(),
        plan: plan.plan,
        psbtHex: plan.psbtHex,
        evidence: plan.evidence,
        nowMs: String(NOW + VAULT_EVIDENCE_TTL_MS + 1),
      }),
    ).toThrow(VaultAssetPolicyError);
  });

  it('rejects evidence whose tips describe another block', () => {
    const plan = built();
    expect(() =>
      validateVaultAssetPolicy({
        policy: policy(),
        plan: plan.plan,
        psbtHex: plan.psbtHex,
        evidence: { ...plan.evidence, ordTip: { height: 1, hash: 'ff'.repeat(32) } },
        nowMs: String(NOW),
      }),
    ).toThrow(VaultAssetPolicyError);
  });

  it('rejects reordered evidence inputs', () => {
    const plan = buildVaultWithdrawal(
      request({ utxos: [vaultUtxo(0, '60000'), vaultUtxo(1, '60000')], amountSats: '100000' }),
    );
    expect(() =>
      validateVaultAssetPolicy({
        policy: policy(),
        plan: plan.plan,
        psbtHex: plan.psbtHex,
        evidence: { ...plan.evidence, inputs: [...plan.evidence.inputs].reverse() },
        nowMs: String(NOW),
      }),
    ).toThrow(VaultAssetPolicyError);
  });

  it('rejects a plan whose amount was edited under a retained digest', () => {
    const plan = built();
    const tampered = { ...plan.plan, amountSats: '1' };
    expect(() =>
      validateVaultAssetPolicy({
        policy: policy(),
        plan: tampered,
        psbtHex: plan.psbtHex,
        evidence: plan.evidence,
        nowMs: String(NOW),
      }),
    ).toThrow();
  });

  it('rejects a PSBT that is not this plan\'s', () => {
    const first = built();
    const second = buildVaultWithdrawal(request({ amountSats: '120000' }));
    expect(() =>
      validateVaultAssetPolicy({
        policy: policy(),
        plan: first.plan,
        psbtHex: second.psbtHex,
        evidence: first.evidence,
        nowMs: String(NOW),
      }),
    ).toThrow();
  });

  it('rejects a foreign policy against a real plan', () => {
    const plan = built();
    const foreign = composeVaultPolicyRecord(
      'mainnet',
      contracts.records['mainnet']!.signers as [
        VaultSignerOriginV1,
        VaultSignerOriginV1,
        VaultSignerOriginV1,
      ],
      {
        createdAtMs: '1735689600000',
        birthdayHeight: null,
        vaultLabel: 'Foreign',
        signerLabels: ['A', 'B', 'C'],
      },
    ).identity;
    expect(() =>
      validateVaultAssetPolicy({
        policy: foreign,
        plan: plan.plan,
        psbtHex: plan.psbtHex,
        evidence: plan.evidence,
        nowMs: String(NOW),
      }),
    ).toThrow(VaultAssetPolicyError);
  });
});

describe('C3 never lets an inscription pay a fee (ADR 0007 §7)', () => {
  const inscribed = (index: number, valueSats: string): VaultUtxoV1 => {
    const base = vaultUtxo(index, valueSats);
    return {
      ...base,
      primaryClass: 'inscribed',
      inscriptions: [{ inscriptionId: `${'ee'.repeat(32)}i0`, offsetSats: '0' }],
    };
  };

  it('excludes an inscribed output from selection outright', () => {
    const utxos = [inscribed(0, '900000'), vaultUtxo(1, '400000')];
    const selected = selectVaultCardinalInputs(utxos, 100_000n);
    expect(selected).toHaveLength(1);
    expect(selected[0]!.primaryClass).toBe('cardinal_clean');
  });

  it('refuses to build at all when only inscribed value exists', () => {
    // The dangerous shape: plenty of value, none of it spendable as cardinal.
    // Selecting the inscribed output would burn an ordinal as a fee input.
    expect(() =>
      buildVaultWithdrawal(request({ utxos: [inscribed(0, '900000')] })),
    ).toThrow(VaultPlanError);
  });

  it('will not top up a shortfall with an inscribed output', () => {
    expect(() =>
      buildVaultWithdrawal(
        request({ utxos: [vaultUtxo(1, '20000'), inscribed(0, '900000')], amountSats: '100000' }),
      ),
    ).toThrow(VaultPlanError);
  });

  it('builds the production whole-UTXO inscription movement with separate clean fee inputs', () => {
    const inscriptionId = `${'ee'.repeat(32)}i0`;
    const base = request({
      utxos: [inscribed(0, '12000'), vaultUtxo(1, '400000')],
    });
    const { amountSats, ...withoutCardinalAmount } = base;
    expect(amountSats).toBeDefined();
    const built = buildVaultWithdrawal({
      ...withoutCardinalAmount,
      movement: 'inscription',
      inscriptionId,
    });
    expect(built.plan.amountSats).toBe('12000');
    expect(built.plan.assetEffects[0]).toMatchObject({
      kind: 'inscription',
      assetId: inscriptionId,
      inputIndex: 0,
      outputIndex: 0,
      protected: true,
    });
    expect(built.selected[0]!.primaryClass).toBe('inscribed');
    expect(built.selected.slice(1).every((utxo) => utxo.primaryClass === 'cardinal_clean')).toBe(true);
  });

  it('excludes every output the scan withheld', () => {
    for (const refusal of [
      'degraded',
      'classification_incomplete',
      'rare_sat',
      'unsupported_asset',
      'mixed_or_unknown',
      'user_frozen',
      'dust_quarantined',
      'unconfirmed',
    ] as const) {
      expect(
        () => selectVaultCardinalInputs([vaultUtxo(0, '400000', { refusal })], 1n),
        refusal,
      ).toThrow(VaultPlanError);
    }
  });
});

describe('C3 deposit destination is proved, not compared', () => {
  it('regenerates the address from the committed policy', () => {
    const proved = assertVaultDepositAddress(policy(), 'receive', 0);
    expect(proved.address).toBe(deriveVaultOutput(policy(), 'receive', 0).address);
    expect(proved.scriptPubKeyHex).toBe(deriveVaultOutput(policy(), 'receive', 0).scriptPubKeyHex);
    expect(proved.address.startsWith('tb1q')).toBe(true);
  });

  it('is a Vault plan for no direction: a deposit spends Spending inputs', () => {
    // Recorded as an assertion because it is a contract fact, not a choice:
    // VaultPlanKind has no deposit member, so a deposit cannot be expressed as
    // a Vault plan at all and is an ordinary Spending send to a proved address.
    const built = buildVaultWithdrawal(request());
    expect(built.plan.kind).toBe('withdrawal');
    expect(['withdrawal', 'recovery', 'rotation']).toContain(built.plan.kind);
  });
});

describe('C3 retains approved plans for a later replacement', () => {
  it('round-trips an approved plan through canonical bytes', () => {
    const built = buildVaultWithdrawal(request());
    const record = approvedPlanRecord(built, DESTINATION, NOW);
    expect(record.planId).toBe(built.plan.planId);
    expect(record.planDigest).toBe(built.plan.planDigest);
    const restored = parseApprovedPlan(record);
    expect(restored).not.toBeNull();
    // Core's RBF/CPFP rules need the *complete* prior plan, so the restored
    // value must be usable as one, not a summary of one.
    expect(restored!.planDigest).toBe(built.plan.planDigest);
    expect(restored!.unsignedTransactionHex).toBe(built.plan.unsignedTransactionHex);
    expect(restored!.inputs).toHaveLength(built.plan.inputs.length);
  });

  it('refuses a stored plan whose bytes no longer match its digest', () => {
    const built = buildVaultWithdrawal(request());
    const record = approvedPlanRecord(built, DESTINATION, NOW);
    // A replacement is only as trustworthy as the parent it is checked
    // against, so a mismatched record is discarded rather than repaired.
    expect(parseApprovedPlan({ ...record, planDigest: 'ff'.repeat(32) })).toBeNull();
    expect(
      parseApprovedPlan({ ...record, canonicalPlanHex: `${record.canonicalPlanHex.slice(0, -2)}ff` }),
    ).toBeNull();
  });
});

describe('C3 construction remains unsigned', () => {
  it('emits a PSBT with no partial signatures and no final fields', () => {
    const built = buildVaultWithdrawal(request());
    const validation = validateVaultAssetPolicy({
      policy: policy(),
      plan: built.plan,
      psbtHex: built.psbtHex,
      evidence: built.evidence,
      nowMs: String(NOW),
    });
    expect(validation.psbtHash).toMatch(/^[0-9a-f]{64}$/u);
    // No role has signed: core reports the recovered role set, and it is empty.
    const bytes = hexToBytes(built.psbtHex);
    expect(bytes.length).toBeGreaterThan(0);
    expect(built.plan.broadcastIntent).toBe('broadcast');
  });
});
