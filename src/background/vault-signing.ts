/**
 * Vault partial signing, combination, and finalization (ADR 0007 §§4, 7, 8,
 * Workstream C5).
 *
 * Two rules shape every function here.
 *
 * **The capability gate comes first.** ADR 0007 §8 pairs network with movement
 * in one indivisible value, and only three pairings exist. That makes an
 * unbounded mainnet signer inexpressible, but an inexpressible thing still has
 * to be *consulted*: `canSignVaultValue` was added in C0 and left unused, which
 * meant mainnet signing was prevented only by the accident that no signing code
 * existed. It exists now, so every entry point below asks first. Combination is
 * gated with signing and finalization, not treated as harmless middle ground —
 * its only purpose is to assemble a quorum for finalization, and an
 * unsigned-only coordinator has no legitimate quorum to assemble.
 *
 * **The §8.1 pilot bound is re-checked here, not inherited.** `vault-plan.ts`
 * already refused to build a plan outside it, and that proves nothing at this
 * point: a plan arrives through a transport, and "something once validated
 * this" is exactly the assurance a signer must not accept. Every entry point
 * therefore re-asserts the bound against the plan in front of it, immediately
 * before the key is used. For a non-pilot capability the check is a no-op.
 *
 * **Signing safety runs through the B3 wrappers, never the raw B2 mechanics.**
 * `vault-asset-policy-v1.md` reserves `signVaultPartialSignature` and
 * `finalizeVaultPsbt` for conformance and provider-independent recovery and
 * requires a production coordinator to use the asset-safe wrappers, which run
 * the full validator — evidence hashes, freshness, tip agreement,
 * protected-asset rules — before any private key is touched. Neither raw
 * function is imported here.
 *
 * The one place that needs care is the hardware door. `combineVaultPsbts` is
 * B2, but it is *combination*, not signing or finalization, and core ships no
 * asset-safe wrapper that accepts raw PSBT hex — the safe combiner takes SQVB
 * result records. Making the envelope the only way in would break the rule the
 * work plan states plainly: the PSBT is the signing truth and the SQVB envelope
 * is transport. `combineVaultSignedPsbts` therefore runs the B3 validator over
 * every incoming PSBT itself and only then calls the B2 combiner, so a plain
 * PSBT from a third-party signer is accepted with exactly the asset safety an
 * enveloped one gets.
 *
 * Nothing here broadcasts or constructs a replacement. The coordinator may
 * supply a signer-local previous plan for a CPFP child, but this module only
 * validates, signs, combines, and finalizes those immutable bytes. A finalized
 * transaction leaves this module as hex and goes nowhere.
 */
import type { HDKey } from '@scure/bip32';
import type {
  VaultPartialSignatureResultV1,
  VaultPolicyIdentityV1,
  VaultSignerRole,
  VaultUnsignedPlanV1,
} from '@drey/core/domain/vault/multisig-contracts';
import {
  combineVaultAssetSafePartialSignatureResults,
  createVaultAssetSafePartialSignatureInput,
  finalizeVaultAssetSafePsbt,
  signVaultAssetSafePartialSignature,
  validateVaultAssetPolicy,
  type VaultAssetPolicyEvidenceV1,
} from '@drey/core/domain/vault/multisig-asset-policy';
import {
  combineVaultPsbts,
  type CombinedVaultPsbt,
  type FinalizedVaultTransaction,
} from '@drey/core/domain/vault/multisig-psbt';
import {
  assertVaultProductionAuthority,
  canSignVaultValue,
  type VaultCoordinatorCapability,
} from './vault-capability';

/**
 * This build may not move Vault value. Distinct from core's asset-policy and
 * PSBT errors because it is not a judgement about the transaction at all — the
 * plan may be perfect; this coordinator still may not sign it.
 */
export class VaultSigningNotPermittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultSigningNotPermittedError';
  }
}

/**
 * ADR 0007 §8: refuse unless this build's capability permits moving value.
 *
 * Exported so a caller that must decide whether to *offer* signing can ask the
 * same question the enforcement asks, rather than reimplementing it.
 */
export function assertVaultSigningAllowed(capability: VaultCoordinatorCapability): void {
  if (!canSignVaultValue(capability)) {
    throw new VaultSigningNotPermittedError(
      `a ${capability.network} Vault coordinator is ${capability.movement} and must not produce a signature, a finalized transaction, or a broadcast`,
    );
  }
}

interface VaultSigningContext {
  capability: VaultCoordinatorCapability;
  policy: VaultPolicyIdentityV1;
  plan: VaultUnsignedPlanV1;
  evidence: VaultAssetPolicyEvidenceV1;
  /** Canonical decimal milliseconds; checked against both freshness windows. */
  nowMs: string;
  /**
   * The complete previous immutable plan, for a replacement. Loaded from this
   * coordinator's own approved-plan store by the caller — a parent supplied by
   * whoever proposed the replacement proves nothing. C5 never *builds* one;
   * this exists so the parameter does not have to be retrofitted in C6.
   */
  previousPlan?: VaultUnsignedPlanV1 | undefined;
}

/**
 * The two gates every entry point below passes, in that order: may this build
 * move Vault value at all, and is the plan in front of it inside the bound it
 * is allowed to move value under. Kept as one function so a later entry point
 * cannot acquire half of the check.
 */
function assertMayActOnPlan(context: VaultSigningContext): void {
  assertVaultSigningAllowed(context.capability);
  assertVaultProductionAuthority(context.capability, context.plan);
}

/** Only pass `previousPlan` through when the caller actually has one. */
function assetPolicyArgs(context: VaultSigningContext) {
  return {
    policy: context.policy,
    plan: context.plan,
    evidence: context.evidence,
    nowMs: context.nowMs,
    ...(context.previousPlan !== undefined ? { previousPlan: context.previousPlan } : {}),
  };
}

/**
 * Add exactly one logical role's signature to an approved plan's PSBT.
 *
 * The request record is built through the asset-safe creator and then consumed
 * by the asset-safe signer, so the B3 validator runs twice over the same plan
 * and PSBT: once to mint the request and once immediately before the key is
 * used. That is deliberate rather than redundant — the two calls can be
 * separated in time and space by a transport, and the signer must not trust a
 * request merely because something once validated it.
 */
export function signVaultPlanAsRole(
  context: VaultSigningContext & { role: VaultSignerRole; signerRoot: HDKey; psbtHex: string },
): VaultPartialSignatureResultV1 {
  assertMayActOnPlan(context);
  const request = createVaultAssetSafePartialSignatureInput({
    ...assetPolicyArgs(context),
    role: context.role,
    psbtHex: context.psbtHex,
  });
  return signVaultAssetSafePartialSignature({
    ...assetPolicyArgs(context),
    request,
    signerRoot: context.signerRoot,
  });
}

/**
 * Combine SQVB partial-signature results from two or three distinct roles.
 *
 * The enveloped path: each result binds the plan, its digest, and the exact
 * prior and signed PSBT hashes, so a result that was produced against some
 * other plan cannot be smuggled in.
 */
export function combineVaultPartialResults(
  context: VaultSigningContext & { results: readonly VaultPartialSignatureResultV1[] },
): CombinedVaultPsbt {
  assertMayActOnPlan(context);
  return combineVaultAssetSafePartialSignatureResults({
    ...assetPolicyArgs(context),
    results: context.results,
  });
}

/**
 * Combine plain signed PSBTs — the third-party-signer door.
 *
 * A device running somebody else's firmware returns a PSBT and nothing else:
 * no plan digest, no SQVB record, no idea what Drey's envelope is. It verified
 * the PSBT, not the plan, and ADR 0007's threat model accepts that trade for
 * cardinal BTC only — such a signer has no concept of inscriptions or Full Sat
 * Safety and would happily sign a protected UTXO as a fee input. The asymmetry
 * is real in both directions: it is a weaker independent reviewer than Mobile B
 * under this plan's reanalysis requirement, and a stronger one against
 * correlated single-vendor risk.
 *
 * Asset safety is not what the envelope was providing, so dropping the envelope
 * does not drop it: the B3 validator runs over every incoming PSBT here, before
 * the B2 combiner sees any of them. What is genuinely lost is the *binding*
 * that the signer reviewed this plan — which is why this path exists for a
 * signer that cannot produce that binding, and not as a shortcut for one that
 * can.
 */
export function combineVaultSignedPsbts(
  context: VaultSigningContext & { psbtHexes: readonly string[] },
): CombinedVaultPsbt {
  assertMayActOnPlan(context);
  for (const psbtHex of context.psbtHexes) {
    validateVaultAssetPolicy({ ...assetPolicyArgs(context), psbtHex });
  }
  return combineVaultPsbts({
    policy: context.policy,
    plan: context.plan,
    psbtHexes: context.psbtHexes,
  });
}

/**
 * Finalize a quorum into a raw transaction, and go no further.
 *
 * Core re-verifies the finalized witness independently: the non-witness bytes
 * must still equal the approved unsigned transaction, the same two logical
 * roles must appear on every input, every signature must be strict-DER low-S
 * `SIGHASH_ALL`, and the actual vsize must not exceed the plan's upper bound.
 * The returned transaction is a value, not an action — this module has no
 * gateway, no network, and no broadcast (C6).
 */
export function finalizeVaultTransaction(
  context: VaultSigningContext & { psbtHex: string },
): FinalizedVaultTransaction {
  assertMayActOnPlan(context);
  return finalizeVaultAssetSafePsbt({ ...assetPolicyArgs(context), psbtHex: context.psbtHex });
}
