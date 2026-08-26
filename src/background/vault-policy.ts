/**
 * Vault policy composition for the extension coordinator (ADR 0007 §§2-6,
 * Workstream C1).
 *
 * Like `vault-role.ts`, this module is deliberately narrow and free of storage,
 * sessions, and transport: it turns three *public* signer origins into the
 * canonical policy record, the display projection the UI reads, and the public
 * recovery kit. The wallet service owns password reauthentication, persistence,
 * and the channel gate; everything here is a pure function over public data.
 *
 * Keeping it separate is what lets the conformance test drive the exact code
 * path the coordinator uses with `core/vectors/vault-descriptors-v1`'s own
 * origins, instead of asserting against seeded storage or re-deriving the
 * answer a second way and comparing two of our own implementations.
 */
import {
  VAULT_RECOVERY_KIT_TEXT_V1,
  vaultRecoveryKitSchema,
  type VaultPolicyMetadataV1,
  type VaultPolicyRecordV1,
  type VaultRecoveryKitV1,
  type VaultSignerOriginV1,
} from '@drey/core/domain/vault/multisig-contracts';
import {
  assertVaultDescriptorPolicy,
  deriveVaultOutput,
  generateVaultDescriptors,
  generateVaultPolicyIdentity,
  validateVaultPolicyRecordDescriptors,
} from '@drey/core/domain/vault/multisig-descriptors';
import type { VaultCoordinatorPolicySummary } from '../messaging/vault-coordinator-ops';
import type { VaultImportedRole, VaultImportSessionV1 } from '../adapters/storage/vault-coordinator-store';
import type { VaultCoordinatorNetwork } from './vault-capability';

/** The two roles the extension imports rather than generates (ADR 0007 §8). */
export const IMPORTABLE_VAULT_ROLES: readonly VaultImportedRole[] = ['mobile-b', 'recovery-c'];

/** How long a minted proof-of-possession challenge stays answerable. */
export const VAULT_IMPORT_TTL_MS = 30 * 60 * 1000;

/**
 * The all-zero digest a kit carries when no standalone package has been
 * published. Retained permanently, not as a legacy case: every kit minted
 * before the first release carries it, and a reader must keep accepting those
 * for as long as the Vaults they describe exist.
 */
export const VAULT_STANDALONE_TOOL_DIGEST_UNPUBLISHED = '00'.repeat(32);

/**
 * The published ADR 0007 §6 standalone recovery package that this build's kits
 * name (Workstream C7).
 *
 * `coreTag` is part of the record rather than a comment beside it. A kit's
 * digests describe one exact revision of `core/recovery/`, and the source
 * digest covers all of `core/src` — so it changes on *every* core release,
 * including ones that never touch the recovery tool. Bumping the core pin
 * without revisiting these values would therefore mint kits whose source digest
 * names a revision that no longer exists, and nothing about the tool itself
 * would look wrong. `vault-standalone-digest.test.ts` binds this tag to the pin
 * so that drift is a failing test rather than a silent falsehood in a document
 * users are told to verify against.
 *
 * Reproduce both values from a clean checkout:
 *
 *   git clone --branch v0.17.6 https://github.com/dreywallet/core.git
 *   cd core && pnpm install --frozen-lockfile && pnpm recovery:verify
 *
 * The artifact digest is deliberately the narrower claim. It stayed
 * byte-identical from v0.2.7 through v0.2.13, then moved in v0.2.14 because the
 * recovery bundle imports the Vault contracts that now share the non-throwing
 * u64 validator. v0.4.6 is the clean-break Drey release; v0.4.7 additionally
 * binds the renamed marketplace fixture manifest to its compile-time policy;
 * v0.4.8 added the offline Recovery C ceremony; v0.5.0 adds the shared
 * production coordinator, evidence, QR, planning, and crash-safe lifecycle.
 * v0.7.1 adds bounded display-only asset identity to the shared contract and
 * keeps existing cached transaction plans byte-stable. v0.7.2 authorizes the
 * full-page extension surface to request activity previews; v0.7.3 pins the
 * provider-PSBT refusal of `OP_RETURN` outputs before signing. v0.7.5 enables
 * the ord.net single-inscription marketplace templates re-derived from the
 * published Trading API 1.0.0 contract. v0.7.10 bounds provider `signPsbt`
 * input selections to the worker's existing 200-input ceiling. v0.7.11 and
 * v0.7.12 add the public-repository hygiene files and point clone URLs and
 * contact identity at the public release mirror and the company. v0.7.13 adds
 * display-only inscription references to the UTXO list response. v0.7.15 adds
 * atomic multi-inscription planning and final-byte policy checks; v0.7.16
 * hardens the same batch policy. v0.8.0 adds shared native batching, deliberate
 * postage management, and recovery metadata. v0.8.1 adds bounded scan history
 * coverage. v0.8.2 corrects the development lockfile without changing the
 * recovery program. v0.8.3 bounds untrusted recovery inputs and wallet request
 * structures before expensive processing, changing both the reviewed source
 * and recovery artifact. v0.9.0 adds exact-origin OMB Wiki buyer marketplace
 * policy. v0.9.1 adds device-compatible Vault PSBT QR transport. v0.9.2
 * corrects the recovery-kit loss guidance. v0.10.0 adds Spending-account gap
 * policy. v0.10.1 adds the AVIF preview descriptor contract. v0.11.0 limits
 * routine Spending-account refresh planning to the selected account. v0.12.0
 * adds the separately versioned Community Vault policy; the standalone
 * personal Vault recovery artifact remains byte-identical while the reviewed
 * source digest binds the new tag. v0.14.0 adds Community Vault acquisition
 * and exact sale signing. v0.14.1 records its recovery release and stabilizes
 * slow cryptographic drills. v0.14.2 reissues the release under the required
 * annotated private tag and stabilizes the remaining long acquisition drill.
 * v0.14.4 adds the buyer offer provider handshake. v0.15.1 adds complete-position
 * Community Vault transfers and their provider review envelope. v0.16.0 adds
 * regtest to the shared network and Vault signing boundaries, changing both
 * the reviewed source and standalone personal Vault recovery artifact. v0.17.0
 * keeps that artifact byte-identical while binding its source to the activity
 * replacement projection fix. v0.17.1 adds bounded multiple-message signing;
 * v0.17.2 hardens gateway inputs and generic listing broadcast policy. v0.17.3
 * binds terminal broadcast results to the exact submitted request and gateway
 * snapshot before callers may clear recovery evidence. v0.17.5 keeps that
 * artifact byte-identical while adding the profile credential envelope;
 * v0.17.6 reissues the same wallet logic under the required annotated release
 * tag and binds the complete reviewed source snapshot.
 */
export const VAULT_STANDALONE_TOOL_RELEASE = Object.freeze({
  coreTag: 'v0.17.6',
  sourceDigest: '0ac081447d6e89776485bd770f03d9bba348c1aa43d1e5e6cd95cb82fede6332',
  artifactDigest: '642ad7904dc16fefa81757ca6151d392464b0087de2e5044cbb7b6a66776d432',
});

/**
 * Whether this build names a real, checkable standalone package.
 *
 * Derived from the digests rather than hardcoded, so the claim and the evidence
 * for it cannot disagree: a build reverted to the sentinel reports `false`
 * automatically instead of continuing to advertise an exit nobody can verify.
 */
export function vaultStandaloneToolPublished(): boolean {
  return VAULT_STANDALONE_TOOL_RELEASE.sourceDigest !== VAULT_STANDALONE_TOOL_DIGEST_UNPUBLISHED &&
    VAULT_STANDALONE_TOOL_RELEASE.artifactDigest !== VAULT_STANDALONE_TOOL_DIGEST_UNPUBLISHED;
}

export function pendingImportRoles(session: VaultImportSessionV1): VaultImportedRole[] {
  return IMPORTABLE_VAULT_ROLES.filter((role) => session.signers[role] === undefined);
}

export function importedRoles(session: VaultImportSessionV1): VaultImportedRole[] {
  return IMPORTABLE_VAULT_ROLES.filter((role) => session.signers[role] !== undefined);
}

/** A descriptor's BIP380 checksum — the eight characters after the `#`. */
export function descriptorChecksumOf(descriptor: string): string {
  return descriptor.slice(-8);
}

export function sameSignerOrigin(left: VaultSignerOriginV1, right: VaultSignerOriginV1): boolean {
  return left.masterFingerprintHex === right.masterFingerprintHex &&
    left.accountXpub === right.accountXpub;
}

/**
 * ADR 0007 §§1-2: distinct logical roles must be distinct keys. A fingerprint
 * collision alone is not proof of reuse — it is four bytes — but it is never
 * legitimate inside one policy, and core's descriptor grammar rejects it too.
 * Checking here turns that into an explainable import refusal instead of an
 * opaque descriptor error three steps later.
 *
 * What this deliberately does NOT do is verify that a signer's stated master
 * fingerprint belongs to the account xpub beside it. It cannot: the fingerprint
 * hashes a master key four hardened levels above the account, so no holder of
 * the account xpub alone can derive or check it. ADR 0007 §2 already treats a
 * fingerprint as a review label rather than proof of key identity, and the
 * import's proof of possession is taken over the complete origin and the xpub's
 * `/0/0` child, which is the evidence that actually binds.
 *
 * The residual hazard is presentational, not custodial: a mislabelled record
 * could show a familiar fingerprint next to somebody else's key, which is
 * exactly the reassurance the §6 cross-device check relies on. Refusing any
 * collision is the available mitigation — one policy can never contain the same
 * label twice, so that check is never ambiguous — and an attacker gains no
 * signing power from a wrong label, only a misleading one.
 */
export function collidesWithHeldRole(
  candidate: VaultSignerOriginV1,
  held: readonly VaultSignerOriginV1[],
): boolean {
  return held.some(
    (existing) =>
      existing.masterFingerprintHex === candidate.masterFingerprintHex ||
      existing.accountXpub === candidate.accountXpub,
  );
}

/**
 * Compose the canonical policy record from three origins in logical A/B/C
 * order.
 *
 * Core finalizes the identity and its `policyId`; the two assertions after it
 * are core's own round-trips, run here so a record is never handed back — let
 * alone persisted — unless its descriptors regenerate themselves and reparse to
 * the same identity. Reordered, duplicated, foreign-network, and non-canonical
 * origins all fail inside this call rather than at some later display step.
 */
export function composeVaultPolicyRecord(
  network: VaultCoordinatorNetwork,
  signers: readonly [VaultSignerOriginV1, VaultSignerOriginV1, VaultSignerOriginV1],
  metadata: Omit<VaultPolicyMetadataV1, 'version'>,
): VaultPolicyRecordV1 {
  const identity = generateVaultPolicyIdentity(network, signers);
  generateVaultDescriptors(identity);
  assertVaultDescriptorPolicy(identity);
  return validateVaultPolicyRecordDescriptors({
    version: 1,
    identity,
    metadata: { version: 1, ...metadata },
  });
}

/**
 * The non-secret projection the watch-only Vault view renders. The first
 * receive address is derived here rather than stored, so a tampered record
 * cannot make the UI display an address the policy does not actually own.
 */
export function summarizeVaultPolicy(record: VaultPolicyRecordV1): VaultCoordinatorPolicySummary {
  const { identity, metadata } = record;
  if (identity.network === 'regtest') throw new Error('regtest Vault coordinator is disabled');
  const first = deriveVaultOutput(identity, 'receive', 0);
  return {
    policyId: identity.policyId,
    network: identity.network,
    policyVersion: 1,
    threshold: 2,
    createdAt: Number(metadata.createdAtMs),
    vaultLabel: metadata.vaultLabel,
    birthdayHeight: metadata.birthdayHeight,
    signers: identity.signers.map((signer, index) => ({
      ...signer,
      label: metadata.signerLabels[index]!,
    })) as VaultCoordinatorPolicySummary['signers'],
    receiveDescriptor: identity.receiveDescriptor,
    changeDescriptor: identity.changeDescriptor,
    receiveChecksum: descriptorChecksumOf(identity.receiveDescriptor),
    changeChecksum: descriptorChecksumOf(identity.changeDescriptor),
    firstReceiveAddress: first.address,
  };
}

/**
 * The ADR 0007 §6 public recovery kit.
 *
 * Every field comes from the public policy record or from core's own
 * derivation. There is no branch here that can reach a seed, an entropy field,
 * an xprv, or a passkey envelope — the kit test asserts that property by
 * scanning the serialized bytes for every secret the harness holds.
 */
export function buildVaultRecoveryKit(record: VaultPolicyRecordV1): VaultRecoveryKitV1 {
  const { identity, metadata } = record;
  const first = deriveVaultOutput(identity, 'receive', 0);
  return vaultRecoveryKitSchema.parse({
    version: 1,
    network: identity.network,
    policyVersion: 1,
    policyId: identity.policyId,
    signers: identity.signers,
    receiveDescriptor: identity.receiveDescriptor,
    changeDescriptor: identity.changeDescriptor,
    createdAtMs: metadata.createdAtMs,
    birthdayHeight: metadata.birthdayHeight,
    vaultLabel: metadata.vaultLabel,
    signerLabels: metadata.signerLabels,
    firstReceiveAddress: first.address,
    // The prose lives in core, not here. Three programs must agree on it byte
    // for byte — this coordinator writes kits, the standalone package reads
    // them, and `vault-recovery-kit-v1` pins the bytes — and prose duplicated
    // across repositories drifts on the first copy-edit.
    compatibilityRequirements: [...VAULT_RECOVERY_KIT_TEXT_V1.compatibilityRequirements],
    minimumReaderVersion: 1,
    standaloneToolSourceDigest: VAULT_STANDALONE_TOOL_RELEASE.sourceDigest,
    standaloneToolArtifactDigest: VAULT_STANDALONE_TOOL_RELEASE.artifactDigest,
    recoveryInstructions: VAULT_RECOVERY_KIT_TEXT_V1.recoveryInstructions,
    rotationInstructions: VAULT_RECOVERY_KIT_TEXT_V1.rotationInstructions,
    recoveryInstructionsVersion: 1,
  });
}
