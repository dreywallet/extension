/**
 * The Vault coordinator surface (ADR 0007, Workstream C), extracted from
 * WalletService following the passkey-service.ts precedent.
 *
 * Lock contract: unlike the passkey helpers, the exported op functions here
 * take the WalletService serialization queue themselves — but only ever the
 * service's own queue, borrowed through `ctx.runExclusive`. There is exactly
 * ONE queue instance and it lives on WalletService; nothing here creates a
 * second one. The module-local helpers below each state whether they expect
 * the queue to be held already (`activeRecord`, `touchSessionLocked`, and
 * every storage read-modify-write assume it is).
 *
 * The context object is a slice of the service's injected deps plus the four
 * service hooks the coordinator shares with the Spending surface
 * (`runExclusive`, `activeRecord`/`touchSessionLocked`, `withActiveDek`, and
 * the single-flight `gatewayStatus`). WalletService keeps one-line delegating
 * methods so the op registry and dispatch table are unchanged.
 */
import { entropyToMnemonic, restoreMnemonic, generateMnemonic, mnemonicToSeed } from '@drey/core/domain/keys/mnemonic';
import { stableExternalAddress, type Network } from '@drey/core/domain/keys/derivation';
import { Transaction } from '@scure/btc-signer';
import { HDKey } from '@scure/bip32';
import { base64ToBytes, bytesToHex, hexToBytes } from '@drey/core/domain/vault/encoding';
import {
  PASSKEY_HKDF_SALT_BYTES,
} from '@drey/core/domain/vault/passkey-envelope';
import { NONCE_BYTES } from '@drey/core/domain/vault/crypto';
import type { Argon2idParams, VaultPayloadV1, VaultRecordV1 } from '@drey/core/domain/vault/record';
import {
  createVaultRecord,
  openVaultPayload,
  unlockVault,
  zeroize,
  type VaultDeps,
} from '@drey/core/domain/vault/vault';
import { getCryptoProvider } from '@drey/core/domain/vault/crypto-provider';
import {
  parseVaultProofResult,
  parseRecoveryCBackupCheckChallenge,
  parseRecoveryCBackupCheckResponse,
  parseRecoveryCSetupChallenge,
  parseRecoveryCSetupResponse,
  recoveryCBackupCheckChallengeDigest,
  recoveryCChallengeFingerprint,
  recoveryCSetupChallengeDigest,
  serializeRecoveryCBackupCheckChallenge,
  serializeRecoveryCSetupChallenge,
  parseVaultSignerOrigin,
  serializeVaultPartialSignatureResult,
  serializeVaultPartialSignatureInput,
  serializeVaultPsbtApprovalEnvelope,
  parseVaultPartialSignatureResult,
  parseVaultPartialSignatureInput,
  parseCanonicalVaultPlan,
  serializeVaultProofResult,
  serializeVaultRecoveryKit,
  verifyVaultProofOfPossession,
  serializeVaultProofInput,
  signVaultPairingEnvelope,
  canonicalVaultPolicyBytes,
  finalizeVaultPsbtApprovalEnvelope,
  signVaultPsbtApprovalEnvelope,
  verifyVaultPairingEnvelopeAuthentication,
  verifyVaultPsbtApprovalEnvelopeAuthentication,
  vaultTransportChannelId,
} from '@drey/core/domain/vault/multisig-encoding';
import {
  vaultPairingContextUrEncoder,
  vaultApprovalContextUrEncoder,
  vaultPsbtUrEncoder,
} from '@drey/core/domain/vault/multisig-qr';
import { createVaultAssetSafePartialSignatureInput } from '@drey/core/domain/vault/multisig-asset-policy';
import { buildVaultAssetPolicyEvidence } from '@drey/core/domain/vault/multisig-evidence';
import {
  isVaultCoordinatorChangeIndex,
  reserveVaultCoordinatorChangeIndex,
  vaultPlanTxid,
} from '@drey/core/domain/vault/multisig-planning';
import { bip32Versions } from '@drey/core/domain/vault/multisig-contracts';
import type {
  RecoveryCBackupCheckChallengeV1,
  RecoveryCSetupChallengeV1,
  VaultPolicyIdentityV1,
  VaultPolicyRecordV1,
  VaultSignerOriginV1,
  VaultUnsignedPlanV1,
} from '@drey/core/domain/vault/multisig-contracts';
import { RECOVERY_C_MAX_CHALLENGE_LIFETIME_MS } from '@drey/core/domain/vault/multisig-contracts';
import {
  verifyRecoveryCBackupCheckResponse,
  verifyRecoveryCSetupResponse,
} from '@drey/core/domain/vault/recovery-c-ceremony';
import { assertVaultDescriptorPolicy } from '@drey/core/domain/vault/multisig-descriptors';
import type { GatewayClient } from '@drey/core/gateway-client';
import type { GatewayStatusView } from '@drey/core/domain/gateway/status-view';
import type { ActiveSessionRequest } from '@drey/core/messaging/ops';
import type { StorageArea } from '../adapters/storage/area';
import {
  loadPasskeyCredentials,
  passkeyCredentialFor,
} from '../adapters/storage/passkey-credentials';
import type { SessionArea, UnlockSession } from '../adapters/session/session-store';
import { loadCachedStatus } from '../adapters/gateway/status-cache';
import {
  deriveVaultEvidenceSource,
  projectVaultUtxo,
  recognizeVaultCreatedUnconfirmedChange,
  summarizeVaultBalance,
  type VaultEvidenceRefusal,
  type VaultEvidenceSourceV1,
  type VaultUtxoV1,
} from './vault-evidence';
import { scanVaultPolicy } from './vault-scan';
import {
  VAULT_STANDALONE_TOOL_RELEASE,
  buildVaultRecoveryKit,
  vaultStandaloneToolPublished,
  collidesWithHeldRole,
  composeVaultPolicyRecord,
  importedRoles,
  IMPORTABLE_VAULT_ROLES,
  pendingImportRoles,
  sameSignerOrigin,
  summarizeVaultPolicy,
  VAULT_IMPORT_TTL_MS,
} from './vault-policy';
import {
  clearVaultImportSession,
  clearVaultPolicy,
  clearVaultRecoveryCCeremony,
  clearVaultRole,
  loadVaultApprovedPlans,
  loadVaultImportSession,
  loadVaultPolicy,
  loadVaultRecoveryCCeremony,
  loadVaultRole,
  removeVaultApprovedPlan,
  saveVaultApprovedPlan,
  saveVaultPolicyAndApprovedPlan,
  saveVaultImportWithRecoveryCCeremony,
  saveVaultImportSession,
  saveVaultPolicyWithRecoveryCCeremony,
  saveVaultPolicy,
  saveVaultRecoveryCCeremony,
  saveVaultRole,
  vaultRoleSummary,
  type VaultApprovedPlanV1,
  type VaultCoordinatorRoleRecordV1,
  type VaultCoordinatorPolicyRecordV1,
  type VaultImportSessionV1,
  type VaultRecoveryCCeremonyStateV1,
} from '../adapters/storage/vault-coordinator-store';
import {
  assertVaultRoleIndependence,
  deriveVaultRoleOrigin,
  signVaultProofOfPossession,
  VaultRoleIndependenceError,
} from '@drey/core/domain/vault/multisig-role';
import type {
  VaultCoordinatorCapability,
  VaultCoordinatorNetwork,
} from './vault-capability';
import {
  approvedPlanRecord,
  assertVaultDepositAddress,
  buildVaultWithdrawal,
  buildVaultCpfp,
  parseApprovedPlan,
  summarizeVaultPlan,
  VaultPlanError,
} from './vault-plan';
import {
  combineVaultSignedPsbts,
  finalizeVaultTransaction,
  signVaultPlanAsRole,
  VaultSigningNotPermittedError,
} from './vault-signing';
import type {
  VaultCoordinatorBeginImportRequest,
  VaultCoordinatorBeginImportResult,
  VaultCoordinatorBeginRoleRecoveryExportRequest,
  VaultCoordinatorBeginRoleRecoveryExportResult,
  VaultCoordinatorBeginRecoveryCBackupCheckRequest,
  VaultCoordinatorBeginRecoveryCSetupRequest,
  VaultCoordinatorCancelRecoveryCSetupRequest,
  VaultCoordinatorCreatePolicyRequest,
  VaultCoordinatorCreatePolicyResult,
  VaultCoordinatorCreateRoleRequest,
  VaultCoordinatorCreateRoleResult,
  VaultCoordinatorImportSignerRequest,
  VaultCoordinatorImportSignerResult,
  VaultCoordinatorImportRecoveryCBackupCheckResponseRequest,
  VaultCoordinatorImportRecoveryCSetupResponseRequest,
  VaultCoordinatorPolicyRequest,
  VaultCoordinatorPolicyResult,
  VaultCoordinatorProveRoleRequest,
  VaultCoordinatorProveRoleResult,
  VaultCoordinatorRecoveryKitRequest,
  VaultCoordinatorRecoveryKitResult,
  VaultCoordinatorRecoveryCChallengeResult,
  VaultCoordinatorRecoveryCReadinessRequest,
  VaultCoordinatorRecoveryCReadinessResult,
  VaultCoordinatorAcknowledgeRecoveryKitExportRequest,
  VaultCoordinatorRemovePolicyRequest,
  VaultCoordinatorScanRequest,
  VaultCoordinatorScanResult,
  VaultCoordinatorBroadcastPlanRequest,
  VaultCoordinatorReconcilePlanRequest,
  VaultCoordinatorBuildPlanRequest,
  VaultCoordinatorBuildPlanResult,
  VaultCoordinatorBuildCpfpRequest,
  VaultCoordinatorCombinePlanRequest,
  VaultCoordinatorCombinePlanResult,
  VaultCoordinatorDepositAddressRequest,
  VaultCoordinatorDepositAddressResult,
  VaultCoordinatorDiscardPlanRequest,
  VaultCoordinatorFinalizePlanRequest,
  VaultCoordinatorFinalizePlanResult,
  VaultCoordinatorPlanBroadcast,
  VaultCoordinatorPlanRequest,
  VaultCoordinatorPlanResult,
  VaultCoordinatorSignPlanRequest,
  VaultCoordinatorSignPlanResult,
  VaultCoordinatorSignMobileRequestRequest,
  VaultCoordinatorSignMobileRequestResult,
  VaultCoordinatorRemoveRoleRequest,
  VaultCoordinatorRestoreRoleRequest,
  VaultCoordinatorRestoreRoleResult,
  VaultCoordinatorRevealRoleRequest,
  VaultCoordinatorExportRoleRecoveryRequest,
  VaultCoordinatorExportRoleRecoveryResult,
  VaultCoordinatorRoleOriginRequest,
  VaultCoordinatorRoleOriginResult,
  VaultCoordinatorStatusRequest,
  VaultCoordinatorStatusResult,
} from '../messaging/vault-coordinator-ops';
import { RpcError } from './errors';
import { verifyAssertion, WebAuthnVerifyError } from './webauthn-verify';
import {
  createVaultRoleARecoveryPackage,
  encodeVaultRoleARecoveryPackage,
} from '../vault-recovery/role-a-recovery-package';
import {
  completeVaultBroadcast,
  consumeVaultBroadcastAttempt,
  prepareVaultBroadcast,
  vaultBroadcastRecoveryPosture,
} from '@drey/core/domain/vault/multisig-lifecycle';

/**
 * The slice of WalletService these functions operate on. The four function
 * members are the service's own methods, passed as closures — the coordinator
 * borrows the service's single serialization queue and session machinery, it
 * never re-implements either.
 */
export interface VaultCoordinatorContext {
  local: StorageArea;
  session: SessionArea;
  network: Network;
  vaultDeps: VaultDeps;
  gateway: GatewayClient | undefined;
  /** `WalletServiceDeps.vaultCoordinatorCapability` (ADR 0007 §8), verbatim. */
  capability: VaultCoordinatorCapability | undefined;
  /** Stable production/test extension RP; absent channels cannot make a recoverable A package. */
  passkeyRpOrigin: string | undefined;
  newVaultId(): string;
  calibrateKdf(): Promise<Argon2idParams>;
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
  activeRecord(
    expectation: ActiveSessionRequest,
  ): Promise<{ record: VaultRecordV1; session: UnlockSession }>;
  touchSessionLocked(session: UnlockSession): Promise<void>;
  withActiveDek<T>(
    expectation: ActiveSessionRequest,
    fn: (payload: VaultPayloadV1, vaultId: string, session: UnlockSession) => Promise<T> | T,
  ): Promise<T>;
  /** The service's single-flight gateway status op; used for its forced
   * revalidation side effect only, so the view is deliberately opaque here. */
  gatewayStatus(input: { forceRefresh: true }): Promise<GatewayStatusView>;
  /** Worker-memory, expiring and single-use WebAuthn challenge authority. */
  mintPasskeyChallenge(vaultId: string): string;
  consumePasskeyChallenge(clientDataJSONB64: string, vaultId: string): string | null;
}

/** Wtxid of a raw transaction: double-SHA256 over the full serialization. */
export function transactionWtxid(transactionHex: string): string {
  const raw = hexToBytes(transactionHex);
  const digest = getCryptoProvider().sha256(getCryptoProvider().sha256(raw));
  return bytesToHex(Uint8Array.from(digest).reverse());
}

// ---- Vault coordinator, Desktop role A (ADR 0007 §§1-3) -------------------
//
// The whole surface is refused unless the build channel injected
// `vaultCoordinatorCapability` (ADR 0007 §8). Mainnet signing exists only in
// the reviewed `production-mainnet` arm; the legacy `unsigned-only` arm can
// observe and prepare but cannot sign. No request field, stored value,
// environment variable, or gateway response participates in either decision.
//
// Role A is NOT a Spending wallet. It never enters the `squirrel:vaults`
// map, never gets a session, and never shares a DEK with S: it carries its
// own encrypted record with its own Argon2id salt, its own random DEK, and
// its own roleId-bound AEAD associated data. Every use of its seed therefore
// costs a fresh password reauthentication, and the Spending session DEK
// cannot open it even while the wallet is unlocked.

/** The coordinator network for this build, or a typed refusal. */
function requireVaultCoordinator(ctx: VaultCoordinatorContext): VaultCoordinatorNetwork {
  return requireVaultCoordinatorCapability(ctx).network;
}

/** The complete capability, for callers that also need the movement half. */
function requireVaultCoordinatorCapability(ctx: VaultCoordinatorContext): VaultCoordinatorCapability {
  const capability = ctx.capability;
  if (capability === undefined) {
    throw new RpcError(
      'ERR_VAULT_COORDINATOR_UNAVAILABLE',
      'this build has no Vault coordinator',
    );
  }
  return capability;
}

/** Non-secret coordinator availability and whether a role is stored. */
export async function vaultCoordinatorStatus(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorStatusRequest,
): Promise<VaultCoordinatorStatusResult> {
  return ctx.runExclusive(async () => {
    const { session } = await ctx.activeRecord(input);
    const capability = ctx.capability;
    if (capability === undefined) {
      return {
        available: false,
        network: null,
        movement: null,
        bound: null,
        role: 'absent' as const,
        policy: 'absent' as const,
        importPending: [],
      };
    }
    const stored = await loadVaultRole(ctx.local);
    const policy = await loadVaultPolicy(ctx.local);
    const importSession = await loadVaultImportSession(ctx.local);
    await ctx.touchSessionLocked(session);
    return {
      available: true,
      network: capability.network,
      movement: capability.movement,
      bound: null,
      role: stored.state === 'valid' ? ('present' as const) : (stored.state as 'absent' | 'unusable'),
      policy: policy.state === 'valid' ? ('present' as const) : (policy.state as 'absent' | 'unusable'),
      importPending: importSession === null ? [] : pendingImportRoles(importSession),
    };
  });
}

/**
 * Refuse unless the coordinator holds no role at all, and no policy either.
 *
 * A stored-but-unusable role blocks establishment as hard as a valid one:
 * overwriting it would destroy whatever role it holds, and removal is
 * explicit. A committed policy blocks it for a different reason — the policy
 * names a specific signer A, so writing a new role underneath it would swap
 * the local signing root without the policy noticing. ADR 0007 §2 makes
 * replacing a role its own ceremony; this is not it.
 */
async function requireNoVaultRoleOrPolicy(ctx: VaultCoordinatorContext): Promise<void> {
  if ((await loadVaultRole(ctx.local)).state !== 'absent') {
    throw new RpcError('ERR_VAULT_ROLE_EXISTS', 'a Vault role is already stored');
  }
  if ((await loadVaultPolicy(ctx.local)).state !== 'absent') {
    throw new RpcError(
      'ERR_VAULT_POLICY_EXISTS',
      'a Vault policy already names a signer A — remove the policy first',
    );
  }
}

/**
 * Establish role A from entropy that already exists, whatever produced it.
 *
 * Shared by generation and restore precisely so the two cannot drift apart.
 * A restore that skipped an independence check, used a weaker AEAD binding,
 * or wrote a record a later load could not open would be a second, quieter
 * way to create a role — and the difference would only surface the day
 * somebody needed the role back. The one thing this does not decide is where
 * the bytes came from; the caller owns them and zeroizes them.
 */
async function establishVaultRole(ctx: VaultCoordinatorContext, input: {
  network: VaultCoordinatorNetwork;
  entropyHex: string;
  seed: Uint8Array;
  seedHex: string;
  label: string;
  password: string;
  spending: { entropyHex: string; seedHex: string };
}): Promise<VaultCoordinatorRoleRecordV1> {
  const origin = deriveVaultRoleOrigin(input.seed, 'desktop-a', input.network);
  assertVaultRoleIndependence({
    role: origin,
    roleEntropyHex: input.entropyHex,
    roleSeedHex: input.seedHex,
    spendingEntropyHex: input.spending.entropyHex,
    spendingSeedHex: input.spending.seedHex,
    network: input.network,
  });
  const roleId = ctx.newVaultId();
  const secret = await createVaultRecord(
    {
      vaultId: roleId,
      name: 'vault-role-desktop-a',
      password: input.password,
      payload: { version: 1, entropyHex: input.entropyHex, seedHex: input.seedHex },
      kdfParams: await ctx.calibrateKdf(),
    },
    ctx.vaultDeps,
  );
  const roleRecord = {
    schemaVersion: 1 as const,
    roleId,
    role: 'desktop-a' as const,
    network: input.network,
    createdAt: ctx.vaultDeps.now(),
    label: input.label,
    origin,
    secret,
  };
  await saveVaultRole(ctx.local, roleRecord);
  return roleRecord;
}

/**
 * Generate a disposable Desktop role A (ADR 0007 §1).
 *
 * The entropy comes from one dedicated CSPRNG invocation through the same
 * injected boundary the Spending wallet uses — not from S, not from a BIP85
 * child of S, not from passkey output, and not from any remote value. The
 * ADR §1 independence checks then run against the live Spending payload,
 * which is why this op takes the password: it needs both a reauthentication
 * and S itself to compare. Those checks catch accidental reuse; ADR §1 is
 * explicit that they cannot prove two CSPRNG draws were independent.
 */
export async function vaultCoordinatorCreateRole(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorCreateRoleRequest,
): Promise<VaultCoordinatorCreateRoleResult> {
  return ctx.runExclusive(async () => {
    const network = requireVaultCoordinator(ctx);
    const { record, session } = await ctx.activeRecord(input);
    await requireNoVaultRoleOrPolicy(ctx);
    const unlocked = await unlockVault(record, input.password); // throws on wrong-password
    const generated = generateMnemonic((n) => ctx.vaultDeps.random(n));
    const roleSeed = mnemonicToSeed(generated.mnemonic);
    try {
      const roleRecord = await establishVaultRole(ctx, {
        network,
        entropyHex: bytesToHex(generated.entropy),
        seed: roleSeed,
        seedHex: bytesToHex(roleSeed),
        label: input.label,
        password: input.password,
        spending: unlocked.payload,
      });
      await clearVaultImportSession(ctx.local);
      await clearVaultRecoveryCCeremony(ctx.local);
      await ctx.touchSessionLocked(session);
      return { role: vaultRoleSummary(roleRecord) };
    } catch (err) {
      if (err instanceof VaultRoleIndependenceError) {
        throw new RpcError('ERR_VAULT_ROLE_NOT_INDEPENDENT', err.message);
      }
      throw err;
    } finally {
      zeroize(unlocked.dek);
      zeroize(generated.entropy);
      zeroize(roleSeed);
    }
  });
}

/**
 * Put a previously revealed role A back (ADR 0007 §1, Workstream R1).
 *
 * Without this, role A is generation-only: `revealRole` can write the words
 * down but nothing can read them back, so a funded Vault is one browser
 * profile away from unrecoverable — and unlike the Spending wallet there is
 * no single phrase to fall back on, only two of three roots plus the policy.
 *
 * The posture is `createRole`'s exactly, and for the same reasons: the same
 * password reauthentication, the same ADR §1 independence checks against S
 * (a user who pastes their Spending phrase here has made precisely the
 * mistake §1 exists to catch), the same encrypted record with its own salt,
 * DEK, and roleId-bound AEAD, and the same refusal when a role is already
 * stored. The phrase's checksum was validated at the wire boundary.
 *
 * A restore succeeds only if it reproduces the *same* origin the words
 * originally described — that is what makes it a restore rather than a
 * second creation — and it does so structurally: the origin is derived from
 * the seed, so identical words yield an identical fingerprint and account
 * xpub, and a policy recomposed over it reproduces the same `policyId`. The
 * `roleId` and `createdAt` are deliberately new: they identify this local
 * record and its AEAD binding, not the Bitcoin root.
 */
export async function vaultCoordinatorRestoreRole(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorRestoreRoleRequest,
): Promise<VaultCoordinatorRestoreRoleResult> {
  return ctx.runExclusive(async () => {
    const network = requireVaultCoordinator(ctx);
    const { record, session } = await ctx.activeRecord(input);
    await requireNoVaultRoleOrPolicy(ctx);
    const unlocked = await unlockVault(record, input.password); // throws on wrong-password
    // Re-derived rather than trusted: the schema proved the checksum, this
    // produces the canonical entropy and seed the record will actually hold.
    const restored = restoreMnemonic(input.mnemonic);
    try {
      const roleRecord = await establishVaultRole(ctx, {
        network,
        entropyHex: bytesToHex(restored.entropy),
        seed: restored.seed,
        seedHex: bytesToHex(restored.seed),
        label: input.label,
        password: input.password,
        spending: unlocked.payload,
      });
      // Any import ceremony still open was minted against a role A that is
      // gone: its transcript binds that origin, so the half-proven peers in
      // it were never proven to this one. Restarting the import is the
      // cheap, correct outcome; merging is the dangerous one.
      await clearVaultImportSession(ctx.local);
      await clearVaultRecoveryCCeremony(ctx.local);
      await ctx.touchSessionLocked(session);
      return { role: vaultRoleSummary(roleRecord) };
    } catch (err) {
      if (err instanceof VaultRoleIndependenceError) {
        throw new RpcError('ERR_VAULT_ROLE_NOT_INDEPENDENT', err.message);
      }
      throw err;
    } finally {
      zeroize(unlocked.dek);
      zeroize(restored.entropy);
      zeroize(restored.seed);
    }
  });
}

/** The stored role's public BIP48 origin. Never its seed. */
export async function vaultCoordinatorRoleOrigin(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorRoleOriginRequest,
): Promise<VaultCoordinatorRoleOriginResult> {
  return ctx.runExclusive(async () => {
    requireVaultCoordinator(ctx);
    const { session } = await ctx.activeRecord(input);
    const stored = await loadVaultRole(ctx.local);
    await ctx.touchSessionLocked(session);
    return { role: stored.state === 'valid' ? vaultRoleSummary(stored.record) : null };
  });
}

/**
 * Answer a peer's proof-of-possession challenge (ADR 0007 §2). The challenge
 * is supplied by the verifier; a self-chosen nonce would prove nothing. The
 * signature binds the complete origin and account xpub through core's
 * digest, not the four-byte fingerprint.
 */
export async function vaultCoordinatorProveRole(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorProveRoleRequest,
): Promise<VaultCoordinatorProveRoleResult> {
  return ctx.runExclusive(async () => {
    requireVaultCoordinator(ctx);
    const { session } = await ctx.activeRecord(input);
    const stored = await loadVaultRole(ctx.local);
    if (stored.state !== 'valid') {
      throw new RpcError('ERR_VAULT_ROLE_MISSING', 'no usable Vault role is stored');
    }
    const roleUnlocked = await unlockVault(stored.record.secret, input.password);
    const roleSeed = hexToBytes(roleUnlocked.payload.seedHex);
    try {
      const proofInput = {
        version: 1 as const,
        origin: stored.record.origin,
        sessionIdHex: input.sessionIdHex,
        challengeNonceHex: input.challengeNonceHex,
        transcriptHashHex: input.transcriptHashHex,
        expiresAtMs: input.expiresAtMs,
      };
      const result = signVaultProofOfPossession(
        roleSeed,
        proofInput,
        String(ctx.vaultDeps.now()),
      );
      await ctx.touchSessionLocked(session);
      return {
        role: 'desktop-a' as const,
        inputDigestHex: result.inputDigestHex,
        proofPublicKeyHex: result.proofPublicKeyHex,
        signatureHex: result.signatureHex,
        scheme: result.scheme,
        resultHex: bytesToHex(serializeVaultProofResult(result)),
      };
    } catch (err) {
      if (err instanceof VaultRoleIndependenceError) {
        throw new RpcError('ERR_VAULT_ROLE_MISSING', err.message);
      }
      throw err;
    } finally {
      zeroize(roleUnlocked.dek);
      zeroize(roleSeed);
    }
  });
}

/**
 * Reveal the role's recovery words after password
 * reauthentication (ADR 0007 §5). These are Vault role-A words, not the
 * Spending Recovery Phrase, and they are one role of a 2-of-3 policy: they
 * cannot spend alone. The UI copy must say so.
 */
export async function vaultCoordinatorRevealRole(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorRevealRoleRequest,
): Promise<{ mnemonic: string }> {
  return ctx.runExclusive(async () => {
    requireVaultCoordinator(ctx);
    const { session } = await ctx.activeRecord(input);
    const stored = await loadVaultRole(ctx.local);
    if (stored.state !== 'valid') {
      throw new RpcError('ERR_VAULT_ROLE_MISSING', 'no usable Vault role is stored');
    }
    const roleUnlocked = await unlockVault(stored.record.secret, input.password);
    const entropy = hexToBytes(roleUnlocked.payload.entropyHex);
    try {
      const result = { mnemonic: entropyToMnemonic(entropy) };
      await ctx.touchSessionLocked(session);
      return result;
    } finally {
      zeroize(roleUnlocked.dek);
      zeroize(entropy);
    }
  });
}

export async function vaultCoordinatorBeginRoleRecoveryExport(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorBeginRoleRecoveryExportRequest,
): Promise<VaultCoordinatorBeginRoleRecoveryExportResult> {
  return ctx.runExclusive(async () => {
    requireVaultCoordinator(ctx);
    if (ctx.passkeyRpOrigin === undefined) {
      throw new RpcError('ERR_PASSKEY_UNAVAILABLE', 'this build has no stable passkey identity');
    }
    const { record, session } = await ctx.activeRecord(input);
    const challengeB64 = ctx.mintPasskeyChallenge(record.vaultId);
    await ctx.touchSessionLocked(session);
    return { challengeB64 };
  });
}

/**
 * Export Role A as a passkey-encrypted, provider-independent recovery package.
 *
 * The WebAuthn assertion is verified before Role A's DEK is opened. The app
 * password is re-verified in the same serialized operation, so a captured PRF
 * output or assertion cannot export the role after lock/restart. The returned
 * JSON contains ciphertext and public identity only; the offline extension
 * page is the sole surface that turns it back into words.
 */
export async function vaultCoordinatorExportRoleRecovery(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorExportRoleRecoveryRequest,
): Promise<VaultCoordinatorExportRoleRecoveryResult> {
  return ctx.runExclusive(async () => {
    requireVaultCoordinator(ctx);
    const rpOrigin = ctx.passkeyRpOrigin;
    if (rpOrigin === undefined) {
      throw new RpcError('ERR_PASSKEY_UNAVAILABLE', 'this build has no stable passkey identity');
    }
    const { record: spendingRecord, session } = await ctx.activeRecord(input);
    // Consume before any credential lookup, signature verification, password
    // check, or Role A access. Failure, cancellation-after-RPC, replay and an
    // MV3 restart all require a newly minted challenge.
    const challengeB64 = ctx.consumePasskeyChallenge(
      input.assertionClientDataJSONB64,
      spendingRecord.vaultId,
    );
    if (challengeB64 === null) {
      throw new RpcError('ERR_PASSKEY_UNAVAILABLE', 'unknown or expired recovery challenge');
    }
    const stored = await loadVaultRole(ctx.local);
    if (stored.state !== 'valid') {
      throw new RpcError('ERR_VAULT_ROLE_MISSING', 'no usable Vault role is stored');
    }
    const credential = passkeyCredentialFor(
      await loadPasskeyCredentials(ctx.local),
      spendingRecord.vaultId,
      input.credentialIdB64,
    );
    if (credential === null) {
      throw new RpcError('ERR_PASSKEY_UNAVAILABLE', 'credential has no bound public key');
    }
    try {
      await verifyAssertion({
        publicKeySpkiB64: credential.publicKeySpkiB64,
        publicKeyAlg: credential.publicKeyAlg,
        clientDataJSONB64: input.assertionClientDataJSONB64,
        authenticatorDataB64: input.assertionAuthenticatorDataB64,
        signatureB64: input.assertionSignatureB64,
        challengeB64,
        rpOrigin,
      });
    } catch (error) {
      if (error instanceof WebAuthnVerifyError) {
        throw new RpcError('ERR_PASSKEY_INVALID_PRF', 'webauthn assertion rejected');
      }
      throw error;
    }
    const unlocked = await unlockVault(stored.record.secret, input.password);
    const prfOutput = base64ToBytes(input.prfOutputB64);
    const prfSalt = base64ToBytes(input.prfSaltB64);
    try {
      const recoveryPackage = createVaultRoleARecoveryPackage({
        network: stored.record.network,
        roleId: stored.record.roleId,
        origin: stored.record.origin,
        secret: stored.record.secret,
        dek: unlocked.dek,
        prfOutput,
        rpOrigin,
        credentialIdB64: credential.credentialIdB64,
        prfSalt,
        hkdfSalt: ctx.vaultDeps.random(PASSKEY_HKDF_SALT_BYTES),
        nonce: ctx.vaultDeps.random(NONCE_BYTES),
        createdAtMs: ctx.vaultDeps.now(),
      });
      await ctx.touchSessionLocked(session);
      return {
        packageJson: encodeVaultRoleARecoveryPackage(recoveryPackage),
        fileName: 'drey-vault-role-a-recovery.json',
        credentialIdB64: credential.credentialIdB64,
        rpOrigin,
      };
    } finally {
      zeroize(unlocked.dek);
      zeroize(prfOutput);
      zeroize(prfSalt);
    }
  });
}

/**
 * Erase the local disposable role. ADR 0007 §2: this is not cryptographic
 * revocation. If the role ever protected funds, recovery requires a new root,
 * a new policy identity, and an on-chain move — not a delete. The roleId must
 * be restated, and an unusable stored value is removable by naming the roleId
 * the UI showed for it.
 */
export async function vaultCoordinatorRemoveRole(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorRemoveRoleRequest,
): Promise<{ removed: boolean }> {
  return ctx.runExclusive(async () => {
    requireVaultCoordinator(ctx);
    const { record, session } = await ctx.activeRecord(input);
    const stored = await loadVaultRole(ctx.local);
    if (stored.state === 'absent') {
      throw new RpcError('ERR_VAULT_ROLE_MISSING', 'no Vault role is stored');
    }
    // Reauthenticate against the Spending record: an unusable role record
    // cannot verify a password, and requiring one there would strand it.
    const unlocked = await unlockVault(record, input.password);
    zeroize(unlocked.dek);
    if (stored.state === 'valid' && stored.record.roleId !== input.roleId) {
      throw new RpcError('ERR_VAULT_ROLE_MISSING', 'roleId does not match the stored role');
    }
    if (stored.state === 'unusable' && input.purgeUnusable !== true) {
      throw new RpcError('ERR_VAULT_ROLE_MISSING', 'stored Vault role is unusable — purge it explicitly');
    }
    // A committed policy names this role as signer A. Deleting the role under
    // it would leave a watch-only Vault nothing can ever sign for, and would
    // read as a working Vault right up until someone tried to spend. Removing
    // the policy is its own explicit act.
    if ((await loadVaultPolicy(ctx.local)).state !== 'absent') {
      throw new RpcError(
        'ERR_VAULT_POLICY_EXISTS',
        'a Vault policy still names this role — remove the policy first',
      );
    }
    await clearVaultRole(ctx.local);
    await clearVaultImportSession(ctx.local);
    await clearVaultRecoveryCCeremony(ctx.local);
    await ctx.touchSessionLocked(session);
    return { removed: true };
  });
}

// ---- Vault coordinator policy import (ADR 0007 §§2-4, Workstream C1) ------
//
// The import is challenge-first. This coordinator mints the nonce, stores it,
// and only then shows it to a peer, because a proof of possession is worth
// something exactly when the verifier chose what was signed. A challenge that
// arrived with the proof would let anyone replay a transcript captured from
// some other session, so the stored session is the only thing an incoming
// proof is ever checked against.
//
// Only roles B and C can be imported. Role A comes from local generation and
// nothing else: admitting it here would turn "import a peer" into "replace the
// signing root with a foreign xpub", which is the whole attack this ceremony
// exists to prevent.

/** Load the stored role, or refuse. Every policy op needs role A present. */
async function requireVaultRole(ctx: VaultCoordinatorContext): Promise<
  Extract<Awaited<ReturnType<typeof loadVaultRole>>, { state: 'valid' }>['record']
> {
  const stored = await loadVaultRole(ctx.local);
  if (stored.state !== 'valid') {
    throw new RpcError('ERR_VAULT_ROLE_MISSING', 'no usable Vault role is stored');
  }
  return stored.record;
}

/** Refuse while a policy is already committed. Replacement is separate. */
async function requireNoVaultPolicy(ctx: VaultCoordinatorContext): Promise<void> {
  if ((await loadVaultPolicy(ctx.local)).state !== 'absent') {
    throw new RpcError('ERR_VAULT_POLICY_EXISTS', 'a Vault policy is already committed');
  }
}

/**
 * Mint the proof-of-possession challenge peers B and C must answer.
 *
 * `transcriptHashHex` binds this coordinator's own role-A origin, so a proof
 * produced for somebody else's setup cannot be replayed into this one even if
 * its nonce were somehow reused. Starting an import replaces any earlier
 * pending one outright — a half-finished ceremony is never merged into a new
 * challenge, because the two halves would then have been proven against
 * different transcripts.
 */
export async function vaultCoordinatorBeginImport(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorBeginImportRequest,
): Promise<VaultCoordinatorBeginImportResult> {
  return ctx.runExclusive(async () => {
    const network = requireVaultCoordinator(ctx);
    const { session } = await ctx.activeRecord(input);
    const role = await requireVaultRole(ctx);
    await requireNoVaultPolicy(ctx);
    const now = ctx.vaultDeps.now();
    const sessionIdHex = bytesToHex(ctx.vaultDeps.random(16));
    const transcriptHashHex = vaultImportTranscriptHash(network, sessionIdHex, role.origin);
    const importSession: VaultImportSessionV1 = {
      schemaVersion: 1,
      network,
      createdAt: now,
      sessionIdHex,
      challengeNonceHex: bytesToHex(ctx.vaultDeps.random(32)),
      transcriptHashHex,
      expiresAtMs: String(now + VAULT_IMPORT_TTL_MS),
      signers: {},
    };
    let challengeQrFrames: string[] | null = null;
    if (input.mobileOriginHex !== undefined) {
      let mobileOrigin: VaultSignerOriginV1;
      try {
        mobileOrigin = parseVaultSignerOrigin(hexToBytes(input.mobileOriginHex));
      } catch {
        throw new RpcError('ERR_VAULT_SIGNER_REJECTED', 'Mobile B origin is not canonical');
      }
      if (mobileOrigin.role !== 'mobile-b' || mobileOrigin.network !== network) {
        throw new RpcError('ERR_VAULT_SIGNER_REJECTED', 'origin is not Mobile B on this network');
      }
      const proofInput = {
        version: 1 as const,
        origin: mobileOrigin,
        sessionIdHex: importSession.sessionIdHex,
        challengeNonceHex: importSession.challengeNonceHex,
        transcriptHashHex: importSession.transcriptHashHex,
        expiresAtMs: importSession.expiresAtMs,
      };
      const unlocked = await unlockVault(role.secret, input.password!);
      const seed = hexToBytes(unlocked.payload.seedHex);
      const signerRoot = HDKey.fromMasterSeed(seed, bip32Versions(network));
      try {
        const envelope = signVaultPairingEnvelope({
          version: 1,
          network,
          sessionIdHex: importSession.sessionIdHex,
          senderChannelIdHex: vaultTransportChannelId(role.origin),
          recipientChannelIdHex: vaultTransportChannelId(mobileOrigin),
          counter: '1',
          createdAtMs: String(now),
          expiresAtMs: importSession.expiresAtMs,
          antiReplayNonceHex: bytesToHex(ctx.vaultDeps.random(32)),
          transcriptHashHex: importSession.transcriptHashHex,
          messageType: 'pop-input',
          payloadHex: bytesToHex(serializeVaultProofInput(proofInput)),
        }, signerRoot, role.origin);
        challengeQrFrames = [...vaultPairingContextUrEncoder(envelope).frames];
      } finally {
        signerRoot.wipePrivateData();
        zeroize(seed);
        zeroize(unlocked.dek);
      }
    }
    // Restarting the shared A/B/C enrollment invalidates every earlier C
    // challenge and completion in the same storage mutation. A worker stop
    // cannot leave a new import session paired with an old C proof.
    await saveVaultImportWithRecoveryCCeremony(
      ctx.local,
      importSession,
      emptyRecoveryCCeremony(null),
    );
    await ctx.touchSessionLocked(session);
    return {
      sessionIdHex: importSession.sessionIdHex,
      challengeNonceHex: importSession.challengeNonceHex,
      transcriptHashHex: importSession.transcriptHashHex,
      expiresAtMs: importSession.expiresAtMs,
      imported: [],
      pending: [...IMPORTABLE_VAULT_ROLES],
      challengeQrFrames,
    };
  });
}

function emptyRecoveryCCeremony(open: VaultRecoveryCCeremonyStateV1['setup']['open']): VaultRecoveryCCeremonyStateV1 {
  return {
    schemaVersion: 1,
    setup: { open, completed: null },
    policy: null,
  };
}

function vaultImportTranscriptHash(
  network: VaultCoordinatorNetwork,
  sessionIdHex: string,
  desktopOrigin: VaultSignerOriginV1,
): string {
  return bytesToHex(
    getCryptoProvider().sha256(
      new TextEncoder().encode(
        `drey-vault-import-transcript-v1\0${network}\0${sessionIdHex}\0${desktopOrigin.masterFingerprintHex}\0${desktopOrigin.accountXpub}`,
      ),
    ),
  );
}

function isCurrentVaultImportSession(
  importSession: VaultImportSessionV1,
  network: VaultCoordinatorNetwork,
  desktopOrigin: VaultSignerOriginV1,
): boolean {
  return importSession.network === network &&
    importSession.transcriptHashHex === vaultImportTranscriptHash(
      network,
      importSession.sessionIdHex,
      desktopOrigin,
    );
}

export async function vaultCoordinatorBeginRecoveryCSetup(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorBeginRecoveryCSetupRequest,
): Promise<VaultCoordinatorRecoveryCChallengeResult> {
  return ctx.runExclusive(async () => {
    const network = requireVaultCoordinator(ctx);
    const { session } = await ctx.activeRecord(input);
    const role = await requireVaultRole(ctx);
    await requireNoVaultPolicy(ctx);
    const importSession = await loadVaultImportSession(ctx.local);
    const now = ctx.vaultDeps.now();
    if (importSession === null || !isCurrentVaultImportSession(importSession, network, role.origin) ||
        BigInt(String(now)) > BigInt(importSession.expiresAtMs) ||
        importSession.signers['recovery-c'] !== undefined) {
      throw new RpcError(
        'ERR_VAULT_RECOVERY_C_SESSION_MISSING',
        'start or restart Vault enrollment before creating an offline Recovery C challenge',
      );
    }
    const existing = await loadVaultRecoveryCCeremony(ctx.local);
    if (existing.state === 'unusable' || existing.state === 'valid' && existing.record.setup.completed !== null) {
      throw new RpcError(
        'ERR_VAULT_RECOVERY_C_RESPONSE_REJECTED',
        'Recovery C setup state is already completed or cannot be verified',
      );
    }
    const challenge: RecoveryCSetupChallengeV1 = {
      version: 1,
      role: 'recovery-c',
      network,
      sessionIdHex: bytesToHex(ctx.vaultDeps.random(16)),
      challengeNonceHex: bytesToHex(ctx.vaultDeps.random(32)),
      transcriptHashHex: importSession.transcriptHashHex,
      desktopOrigin: role.origin,
      createdAtMs: String(now),
      expiresAtMs: String(BigInt(now) + RECOVERY_C_MAX_CHALLENGE_LIFETIME_MS),
    };
    const challengeHex = bytesToHex(serializeRecoveryCSetupChallenge(challenge));
    const challengeDigestHex = recoveryCSetupChallengeDigest(challenge);
    await saveVaultRecoveryCCeremony(ctx.local, emptyRecoveryCCeremony({
      challengeHex, challengeDigestHex, createdAt: now, expiresAtMs: challenge.expiresAtMs,
    }));
    await ctx.touchSessionLocked(session);
    return {
      challengeHex,
      challengeDigestHex,
      fingerprint: recoveryCChallengeFingerprint(challenge),
      network,
      expiresAtMs: challenge.expiresAtMs,
      fileName: `drey-vault-recovery-c-setup-${challenge.sessionIdHex.slice(0, 12)}.sqvb`,
    };
  });
}

export async function vaultCoordinatorCancelRecoveryCSetup(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorCancelRecoveryCSetupRequest,
): Promise<{ cancelled: true }> {
  return ctx.runExclusive(async () => {
    requireVaultCoordinator(ctx);
    const { session } = await ctx.activeRecord(input);
    const stored = await loadVaultRecoveryCCeremony(ctx.local);
    if (stored.state === 'valid' && stored.record.setup.completed === null) {
      await saveVaultRecoveryCCeremony(ctx.local, {
        ...stored.record,
        setup: { ...stored.record.setup, open: null },
      });
    } else if (stored.state === 'unusable') {
      throw new RpcError(
        'ERR_VAULT_RECOVERY_C_SESSION_MISSING',
        'Recovery C setup state cannot be verified; restart Vault enrollment',
      );
    }
    await ctx.touchSessionLocked(session);
    return { cancelled: true };
  });
}

export async function vaultCoordinatorImportRecoveryCSetupResponse(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorImportRecoveryCSetupResponseRequest,
): Promise<VaultCoordinatorImportSignerResult> {
  return ctx.runExclusive(async () => {
    const network = requireVaultCoordinator(ctx);
    const { session } = await ctx.activeRecord(input);
    const role = await requireVaultRole(ctx);
    await requireNoVaultPolicy(ctx);
    const importSession = await loadVaultImportSession(ctx.local);
    const ceremony = await loadVaultRecoveryCCeremony(ctx.local);
    if (importSession === null || !isCurrentVaultImportSession(importSession, network, role.origin) ||
        ceremony.state !== 'valid' || ceremony.record.setup.open === null) {
      throw new RpcError(
        'ERR_VAULT_RECOVERY_C_SESSION_MISSING',
        'no open Recovery C setup challenge; create a fresh challenge and response',
      );
    }
    const reject = (why: string): never => {
      throw new RpcError('ERR_VAULT_RECOVERY_C_RESPONSE_REJECTED', why);
    };
    let challenge: RecoveryCSetupChallengeV1;
    let response: ReturnType<typeof parseRecoveryCSetupResponse>;
    try {
      challenge = parseRecoveryCSetupChallenge(hexToBytes(ceremony.record.setup.open.challengeHex));
      response = parseRecoveryCSetupResponse(hexToBytes(input.responseHex));
    } catch {
      return reject('the setup response is not a canonical bounded Recovery C record');
    }
    const now = ctx.vaultDeps.now();
    if (challenge.network !== network ||
        challenge.transcriptHashHex !== importSession.transcriptHashHex ||
        !sameSignerOrigin(challenge.desktopOrigin, role.origin) ||
        recoveryCSetupChallengeDigest(challenge) !== ceremony.record.setup.open.challengeDigestHex ||
        !verifyRecoveryCSetupResponse(challenge, response, String(now))) {
      return reject('the setup response is expired, replaced, or does not verify against this challenge');
    }
    const held: VaultSignerOriginV1[] = [
      role.origin,
      ...importedRoles(importSession)
        .filter((candidate) => candidate !== 'recovery-c')
        .map((candidate) => importSession.signers[candidate]!),
    ];
    if (collidesWithHeldRole(response.origin, held)) {
      return reject('Recovery C duplicates a fingerprint or account xpub already held');
    }
    const already = importSession.signers['recovery-c'];
    if (already !== undefined && !sameSignerOrigin(already, response.origin)) {
      return reject('a different Recovery C is already imported');
    }
    const next: VaultImportSessionV1 = {
      ...importSession,
      signers: { ...importSession.signers, 'recovery-c': response.origin },
    };
    // The accepted public origin and completion marker land together. A worker
    // stop cannot produce a completed import that the UI cannot finish or a
    // ceremony marker that names a signer the import session never accepted.
    await saveVaultImportWithRecoveryCCeremony(ctx.local, next, {
      ...ceremony.record,
      setup: {
        open: null,
        completed: {
          challengeDigestHex: response.challengeDigestHex,
          origin: response.origin,
          completedAt: now,
        },
      },
    });
    await ctx.touchSessionLocked(session);
    const pending = pendingImportRoles(next);
    return {
      role: 'recovery-c',
      origin: response.origin as VaultCoordinatorImportSignerResult['origin'],
      imported: importedRoles(next),
      pending,
      complete: pending.length === 0,
    };
  });
}

/**
 * Accept one peer signer origin, but only against a proof of possession over
 * this coordinator's own live challenge (ADR 0007 §2).
 *
 * Every rejection returns the same code. Which check failed — malformed
 * record, wrong role, wrong network, key collision, bad signature — is a free
 * oracle over the policy for anyone probing it, and the caller can do nothing
 * differently with the distinction.
 */
export async function vaultCoordinatorImportSigner(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorImportSignerRequest,
): Promise<VaultCoordinatorImportSignerResult> {
  return ctx.runExclusive(async () => {
    const network = requireVaultCoordinator(ctx);
    const { session } = await ctx.activeRecord(input);
    const role = await requireVaultRole(ctx);
    await requireNoVaultPolicy(ctx);
    const importSession = await loadVaultImportSession(ctx.local);
    const now = ctx.vaultDeps.now();
    if (importSession === null || !isCurrentVaultImportSession(importSession, network, role.origin) ||
        BigInt(String(now)) > BigInt(importSession.expiresAtMs)) {
      throw new RpcError(
        'ERR_VAULT_IMPORT_SESSION_MISSING',
        'no open Vault import challenge — start the import again',
      );
    }
    const reject = (why: string): never => {
      throw new RpcError('ERR_VAULT_SIGNER_REJECTED', why);
    };
    if (input.role === 'recovery-c') {
      return reject('Recovery C must use the offline setup challenge/response ceremony');
    }
    let origin: VaultSignerOriginV1;
    try {
      // Parsed from the peer's own bytes, then re-serialized by core's
      // canonical encoder inside the digest below: the bytes that were signed
      // are the bytes that get verified.
      origin = parseVaultSignerOrigin(hexToBytes(input.originHex));
    } catch {
      return reject('signer origin is not a canonical SQVB v1 record');
    }
    if (origin.role !== input.role) reject('signer origin is for a different role');
    if (origin.network !== network) reject('signer origin is for a different network');
    const held: VaultSignerOriginV1[] = [
      role.origin,
      ...importedRoles(importSession)
        .filter((candidate) => candidate !== input.role)
        .map((candidate) => importSession.signers[candidate]!),
    ];
    if (collidesWithHeldRole(origin, held)) {
      reject('signer origin duplicates a fingerprint or account xpub already held');
    }
    const originEnvelope = input.originEnvelope;
    const proofEnvelope = input.proofEnvelope;
    if ((originEnvelope === undefined) !== (proofEnvelope === undefined)) {
      reject('both authenticated Mobile B response envelopes are required together');
    }
    if ((originEnvelope === undefined || proofEnvelope === undefined) && network === 'mainnet') {
      reject('mainnet Mobile B import requires authenticated QR response envelopes');
    }
    if (originEnvelope !== undefined && proofEnvelope !== undefined) {
      const expectedSenderChannel = vaultTransportChannelId(origin);
      const expectedRecipientChannel = vaultTransportChannelId(role.origin);
      if (!verifyVaultPairingEnvelopeAuthentication(originEnvelope, origin) ||
        !verifyVaultPairingEnvelopeAuthentication(proofEnvelope, origin) ||
        originEnvelope.messageType !== 'signer-origin' || proofEnvelope.messageType !== 'pop-result' ||
        originEnvelope.payloadHex !== input.originHex || proofEnvelope.payloadHex !== input.proofResultHex ||
        originEnvelope.network !== network || proofEnvelope.network !== network ||
        originEnvelope.sessionIdHex !== importSession.sessionIdHex ||
        proofEnvelope.sessionIdHex !== importSession.sessionIdHex ||
        originEnvelope.senderChannelIdHex !== expectedSenderChannel ||
        proofEnvelope.senderChannelIdHex !== expectedSenderChannel ||
        originEnvelope.recipientChannelIdHex !== expectedRecipientChannel ||
        proofEnvelope.recipientChannelIdHex !== expectedRecipientChannel ||
        originEnvelope.transcriptHashHex !== importSession.transcriptHashHex ||
        proofEnvelope.transcriptHashHex !== importSession.transcriptHashHex ||
        originEnvelope.expiresAtMs !== importSession.expiresAtMs ||
        proofEnvelope.expiresAtMs !== importSession.expiresAtMs ||
        BigInt(originEnvelope.counter) !== 2n || BigInt(proofEnvelope.counter) !== 3n ||
          originEnvelope.antiReplayNonceHex === proofEnvelope.antiReplayNonceHex) {
        reject('authenticated Mobile B pairing envelopes do not match this challenge');
      }
    }
    let verified = false;
    try {
      const proofResult = parseVaultProofResult(hexToBytes(input.proofResultHex));
      verified = verifyVaultProofOfPossession(
        {
          version: 1,
          origin,
          sessionIdHex: importSession.sessionIdHex,
          challengeNonceHex: importSession.challengeNonceHex,
          transcriptHashHex: importSession.transcriptHashHex,
          expiresAtMs: importSession.expiresAtMs,
        },
        proofResult,
        String(now),
      );
    } catch {
      verified = false;
    }
    // A fingerprint match is not possession. The proof is over the complete
    // origin and the account xpub's /0/0 child, so a record that borrows a
    // real fingerprint and substitutes an xpub fails right here.
    if (!verified) reject('proof of possession did not verify against this challenge');
    const next: VaultImportSessionV1 = {
      ...importSession,
      signers: { ...importSession.signers, [input.role]: origin },
    };
    await saveVaultImportSession(ctx.local, next);
    await ctx.touchSessionLocked(session);
    const pending = pendingImportRoles(next);
    return {
      role: input.role,
      origin: origin as VaultCoordinatorImportSignerResult['origin'],
      imported: importedRoles(next),
      pending,
      complete: pending.length === 0,
    };
  });
}

/**
 * Compose and commit the watch-only policy (ADR 0007 §§3-4).
 *
 * The password buys one thing that public records cannot: proof that the
 * stored role-A *secret* really holds the key its stored public origin
 * advertises. `signVaultProofOfPossession` compares the seed-derived /0/0 key
 * against the one the origin's xpub yields and throws when they differ, so a
 * grafted or swapped origin is caught before it can be baked into a policyId
 * that outlives it.
 */
export async function vaultCoordinatorCreatePolicy(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorCreatePolicyRequest,
): Promise<VaultCoordinatorCreatePolicyResult> {
  return ctx.runExclusive(async () => {
    const network = requireVaultCoordinator(ctx);
    const { session } = await ctx.activeRecord(input);
    const role = await requireVaultRole(ctx);
    await requireNoVaultPolicy(ctx);
    const importSession = await loadVaultImportSession(ctx.local);
    if (importSession === null || !isCurrentVaultImportSession(importSession, network, role.origin) ||
        pendingImportRoles(importSession).length > 0) {
      throw new RpcError(
        'ERR_VAULT_POLICY_INCOMPLETE',
        'both peer signer roles must be imported before a policy exists',
      );
    }
    const recoveryC = await loadVaultRecoveryCCeremony(ctx.local);
    if (recoveryC.state !== 'valid' || recoveryC.record.setup.completed === null ||
        !sameSignerOrigin(recoveryC.record.setup.completed.origin, importSession.signers['recovery-c']!)) {
      throw new RpcError(
        'ERR_VAULT_POLICY_INCOMPLETE',
        'Recovery C must complete the offline challenge/response ceremony before policy creation',
      );
    }
    const roleUnlocked = await unlockVault(role.secret, input.password); // throws on wrong password
    const roleSeed = hexToBytes(roleUnlocked.payload.seedHex);
    try {
      // The peer proofs were accepted while their own import challenges were
      // live. This check has a different purpose: prove that the encrypted
      // local role still holds the public origin about to enter the policy.
      // Do not re-apply the 30-minute peer-import clock here — Recovery C's
      // deliberately offline ceremony may take up to its bounded 24 hours.
      signVaultProofOfPossession(
        roleSeed,
        {
          version: 1,
          origin: role.origin,
          sessionIdHex: importSession.sessionIdHex,
          challengeNonceHex: importSession.challengeNonceHex,
          transcriptHashHex: importSession.transcriptHashHex,
          expiresAtMs: importSession.expiresAtMs,
        },
      );
    } catch (err) {
      if (err instanceof VaultRoleIndependenceError) {
        throw new RpcError('ERR_VAULT_ROLE_MISSING', err.message);
      }
      throw err;
    } finally {
      zeroize(roleUnlocked.dek);
      zeroize(roleSeed);
    }
    const now = ctx.vaultDeps.now();
    const record: VaultPolicyRecordV1 = composeVaultPolicyRecord(
      network,
      [role.origin, importSession.signers['mobile-b']!, importSession.signers['recovery-c']!],
      {
        createdAtMs: String(now),
        birthdayHeight: input.birthdayHeight,
        vaultLabel: input.vaultLabel,
        signerLabels: input.signerLabels,
      },
    );
    const envelopeUnlocked = await unlockVault(role.secret, input.password);
    const envelopeSeed = hexToBytes(envelopeUnlocked.payload.seedHex);
    const envelopeRoot = HDKey.fromMasterSeed(envelopeSeed, bip32Versions(network));
    let policyEnvelope: ReturnType<typeof signVaultPairingEnvelope>;
    try {
      policyEnvelope = signVaultPairingEnvelope({
        version: 1,
        network,
        sessionIdHex: importSession.sessionIdHex,
        senderChannelIdHex: vaultTransportChannelId(role.origin),
        recipientChannelIdHex: vaultTransportChannelId(importSession.signers['mobile-b']!),
        counter: '4',
        createdAtMs: String(now),
        // Recovery C may intentionally finish after the shorter peer-proof
        // window. The proofs are already durably accepted; this fresh response
        // window exists only to deliver the now-committed public policy.
        expiresAtMs: String(now + VAULT_IMPORT_TTL_MS),
        antiReplayNonceHex: bytesToHex(ctx.vaultDeps.random(32)),
        transcriptHashHex: importSession.transcriptHashHex,
        messageType: 'policy',
        payloadHex: bytesToHex(canonicalVaultPolicyBytes(record.identity)),
      }, envelopeRoot, role.origin);
    } finally {
      envelopeRoot.wipePrivateData();
      zeroize(envelopeSeed);
      zeroize(envelopeUnlocked.dek);
    }
    const policyQrFrames = [...vaultPairingContextUrEncoder(policyEnvelope).frames];
    await saveVaultPolicyWithRecoveryCCeremony(
      ctx.local,
      {
        schemaVersion: 1,
        roleId: role.roleId,
        network,
        createdAt: now,
        record,
        nextChangeIndex: 0,
        transport: {
          extensionChannelIdHex: vaultTransportChannelId(role.origin),
          mobileChannelIdHex: vaultTransportChannelId(importSession.signers['mobile-b']!),
          transcriptHashHex: importSession.transcriptHashHex,
          highestInboundCounter: '3',
          nextOutboundCounter: '5',
          pendingMobileResponse: null,
        },
      },
      {
        ...recoveryC.record,
        setup: { ...recoveryC.record.setup, open: null },
        policy: {
          policyId: record.identity.policyId,
          ceremony: 'paper-mnemonic-offline-v1',
          kitExportedAt: null,
          backupCheck: { open: null, completedAt: null },
        },
      },
    );
    await clearVaultImportSession(ctx.local);
    await ctx.touchSessionLocked(session);
    return {
      policy: { ...summarizeVaultPolicy(record), firstReceiveAddress: null },
      policyQrFrames,
    };
  });
}

/** The committed watch-only Vault, or the reason there is not one. */
export async function vaultCoordinatorPolicy(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorPolicyRequest,
): Promise<VaultCoordinatorPolicyResult> {
  return ctx.runExclusive(async () => {
    requireVaultCoordinator(ctx);
    const { session } = await ctx.activeRecord(input);
    const resolved = await resolveVaultPolicy(ctx);
    await ctx.touchSessionLocked(session);
    if (resolved === null) {
      const stored = await loadVaultPolicy(ctx.local);
      return { state: stored.state === 'absent' ? 'absent' : 'unusable', policy: null };
    }
    const readiness = projectRecoveryCReadiness(
      resolved.identity.policyId,
      await loadVaultRecoveryCCeremony(ctx.local),
    );
    const summary = summarizeVaultPolicy(resolved.record);
    return {
      state: 'present',
      policy: {
        ...summary,
        firstReceiveAddress: readiness.ready ? summary.firstReceiveAddress : null,
      },
    };
  });
}

/**
 * Re-verify the stored policy on every read rather than trusting what was
 * written. A record can be edited underneath us, and a Vault whose descriptors
 * no longer reproduce their own policyId — or that no longer names the role
 * this profile actually holds — must read as unusable, never as watchable.
 */
async function resolveVaultPolicy(ctx: VaultCoordinatorContext): Promise<{
  record: VaultPolicyRecordV1;
  identity: VaultPolicyIdentityV1;
} | null> {
  const stored = await loadVaultPolicy(ctx.local);
  if (stored.state !== 'valid') return null;
  const role = await loadVaultRole(ctx.local);
  if (role.state !== 'valid' || role.record.roleId !== stored.stored.roleId) return null;
  const identity = stored.stored.record.identity;
  if (!sameSignerOrigin(identity.signers[0], role.record.origin)) return null;
  try {
    assertVaultDescriptorPolicy(identity);
  } catch {
    return null;
  }
  return { record: stored.stored.record, identity };
}

/**
 * The ADR 0007 §6 public recovery kit.
 *
 * Everything in it is derived from the stored *public* policy record and
 * core's own serializer. No branch of this method can reach a seed, an xprv,
 * an entropy field, or a passkey envelope — which is the property the kit's
 * test asserts by scanning the serialized bytes for every secret the harness
 * holds.
 */
export async function vaultCoordinatorRecoveryKit(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorRecoveryKitRequest,
): Promise<VaultCoordinatorRecoveryKitResult> {
  return ctx.runExclusive(async () => {
    requireVaultCoordinator(ctx);
    const { session } = await ctx.activeRecord(input);
    const resolved = await resolveVaultPolicy(ctx);
    if (resolved === null) {
      throw new RpcError('ERR_VAULT_POLICY_MISSING', 'no usable Vault policy is stored');
    }
    const kit = buildVaultRecoveryKit(resolved.record);
    await ctx.touchSessionLocked(session);
    return {
      kit: kit as VaultCoordinatorRecoveryKitResult['kit'],
      kitHex: bytesToHex(serializeVaultRecoveryKit(kit)),
      standaloneToolPublished: vaultStandaloneToolPublished(),
      standaloneToolCoreTag: VAULT_STANDALONE_TOOL_RELEASE.coreTag,
    };
  });
}

export async function vaultCoordinatorAcknowledgeRecoveryKitExport(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorAcknowledgeRecoveryKitExportRequest,
): Promise<{ policyId: string; kitExported: true }> {
  return ctx.runExclusive(async () => {
    requireVaultCoordinator(ctx);
    const { session } = await ctx.activeRecord(input);
    const resolved = await resolveVaultPolicy(ctx);
    const ceremony = await loadVaultRecoveryCCeremony(ctx.local);
    if (resolved === null || resolved.identity.policyId !== input.policyId || ceremony.state !== 'valid' ||
        ceremony.record.policy?.policyId !== input.policyId) {
      throw new RpcError('ERR_VAULT_RECOVERY_C_KIT_REQUIRED', 'the recovery kit does not match this Vault policy');
    }
    await saveVaultRecoveryCCeremony(ctx.local, {
      ...ceremony.record,
      policy: {
        ...ceremony.record.policy,
        kitExportedAt: ceremony.record.policy.kitExportedAt ?? ctx.vaultDeps.now(),
      },
    });
    await ctx.touchSessionLocked(session);
    return { policyId: input.policyId, kitExported: true };
  });
}

export async function vaultCoordinatorBeginRecoveryCBackupCheck(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorBeginRecoveryCBackupCheckRequest,
): Promise<VaultCoordinatorRecoveryCChallengeResult> {
  return ctx.runExclusive(async () => {
    const network = requireVaultCoordinator(ctx);
    const { session } = await ctx.activeRecord(input);
    const resolved = await resolveVaultPolicy(ctx);
    const ceremony = await loadVaultRecoveryCCeremony(ctx.local);
    if (resolved === null || ceremony.state !== 'valid' ||
        ceremony.record.policy?.policyId !== resolved.identity.policyId ||
        ceremony.record.policy.kitExportedAt === null) {
      throw new RpcError(
        'ERR_VAULT_RECOVERY_C_KIT_REQUIRED',
        'save and acknowledge the public recovery kit before checking the paper Recovery Key',
      );
    }
    if (ceremony.record.policy.backupCheck.completedAt !== null) {
      throw new RpcError(
        'ERR_VAULT_RECOVERY_C_RESPONSE_REJECTED',
        'the paper Recovery C check is already complete for this policy',
      );
    }
    const now = ctx.vaultDeps.now();
    const challenge: RecoveryCBackupCheckChallengeV1 = {
      version: 1,
      role: 'recovery-c',
      network,
      policyId: resolved.identity.policyId,
      recoveryOrigin: resolved.identity.signers[2] as RecoveryCBackupCheckChallengeV1['recoveryOrigin'],
      sessionIdHex: bytesToHex(ctx.vaultDeps.random(16)),
      challengeNonceHex: bytesToHex(ctx.vaultDeps.random(32)),
      standaloneToolVersion: 'drey-vault-recovery-v1',
      standaloneToolSourceDigest: VAULT_STANDALONE_TOOL_RELEASE.sourceDigest,
      standaloneToolArtifactDigest: VAULT_STANDALONE_TOOL_RELEASE.artifactDigest,
      createdAtMs: String(now),
      expiresAtMs: String(BigInt(now) + RECOVERY_C_MAX_CHALLENGE_LIFETIME_MS),
    };
    const challengeHex = bytesToHex(serializeRecoveryCBackupCheckChallenge(challenge));
    const challengeDigestHex = recoveryCBackupCheckChallengeDigest(challenge);
    await saveVaultRecoveryCCeremony(ctx.local, {
      ...ceremony.record,
      policy: {
        ...ceremony.record.policy,
        backupCheck: {
          open: { challengeHex, challengeDigestHex, createdAt: now, expiresAtMs: challenge.expiresAtMs },
          completedAt: null,
        },
      },
    });
    await ctx.touchSessionLocked(session);
    return {
      challengeHex,
      challengeDigestHex,
      fingerprint: recoveryCChallengeFingerprint(challenge),
      network,
      expiresAtMs: challenge.expiresAtMs,
      fileName: `drey-vault-recovery-c-backup-${challenge.policyId.slice(0, 12)}.sqvb`,
    };
  });
}

export async function vaultCoordinatorImportRecoveryCBackupCheckResponse(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorImportRecoveryCBackupCheckResponseRequest,
): Promise<{ policyId: string; completed: true }> {
  return ctx.runExclusive(async () => {
    const network = requireVaultCoordinator(ctx);
    const { session } = await ctx.activeRecord(input);
    const resolved = await resolveVaultPolicy(ctx);
    const ceremony = await loadVaultRecoveryCCeremony(ctx.local);
    const open = ceremony.state === 'valid' ? ceremony.record.policy?.backupCheck.open : null;
    if (resolved === null || ceremony.state !== 'valid' || open === null || open === undefined) {
      throw new RpcError(
        'ERR_VAULT_RECOVERY_C_SESSION_MISSING',
        'no open Recovery C backup-check challenge; create a fresh challenge',
      );
    }
    const reject = (why: string): never => {
      throw new RpcError('ERR_VAULT_RECOVERY_C_RESPONSE_REJECTED', why);
    };
    let challenge: RecoveryCBackupCheckChallengeV1;
    let response: ReturnType<typeof parseRecoveryCBackupCheckResponse>;
    try {
      challenge = parseRecoveryCBackupCheckChallenge(hexToBytes(open.challengeHex));
      response = parseRecoveryCBackupCheckResponse(hexToBytes(input.responseHex));
    } catch {
      return reject('the backup-check response is not a canonical bounded Recovery C record');
    }
    const now = ctx.vaultDeps.now();
    const recoveryOrigin = resolved.identity.signers[2]!;
    if (challenge.network !== network ||
        challenge.policyId !== resolved.identity.policyId ||
        !sameSignerOrigin(challenge.recoveryOrigin, recoveryOrigin) ||
        challenge.standaloneToolVersion !== 'drey-vault-recovery-v1' ||
        challenge.standaloneToolSourceDigest !== VAULT_STANDALONE_TOOL_RELEASE.sourceDigest ||
        challenge.standaloneToolArtifactDigest !== VAULT_STANDALONE_TOOL_RELEASE.artifactDigest ||
        recoveryCBackupCheckChallengeDigest(challenge) !== open.challengeDigestHex ||
        !verifyRecoveryCBackupCheckResponse(challenge, response, String(now))) {
      return reject('the backup-check response is expired, replayed, replaced, or for another Vault');
    }
    await saveVaultRecoveryCCeremony(ctx.local, {
      ...ceremony.record,
      policy: {
        ...ceremony.record.policy!,
        backupCheck: { open: null, completedAt: now },
      },
    });
    await ctx.touchSessionLocked(session);
    return { policyId: resolved.identity.policyId, completed: true };
  });
}

function projectRecoveryCReadiness(
  policyId: string | null,
  stored: Awaited<ReturnType<typeof loadVaultRecoveryCCeremony>>,
): VaultCoordinatorRecoveryCReadinessResult {
  if (stored.state === 'unusable') {
    return {
      state: 'unusable', policyId, setupComplete: false, kitExported: false,
      backupCheckComplete: false, ready: false,
    };
  }
  if (stored.state === 'absent') {
    return {
      state: 'not_started', policyId, setupComplete: false, kitExported: false,
      backupCheckComplete: false, ready: false,
    };
  }
  const setupComplete = stored.record.setup.completed !== null;
  const boundPolicy = stored.record.policy;
  if (policyId !== null && (boundPolicy === null || boundPolicy.policyId !== policyId)) {
    return {
      state: 'unusable', policyId, setupComplete, kitExported: false,
      backupCheckComplete: false, ready: false,
    };
  }
  const kitExported = boundPolicy?.kitExportedAt !== null && boundPolicy?.kitExportedAt !== undefined;
  const backupCheckComplete = boundPolicy?.backupCheck.completedAt !== null &&
    boundPolicy?.backupCheck.completedAt !== undefined;
  const ready = policyId !== null && setupComplete && kitExported && backupCheckComplete;
  const state = ready
    ? 'ready'
    : stored.record.setup.open !== null
      ? 'setup_open'
      : !setupComplete
        ? 'not_started'
        : policyId === null
          ? 'setup_complete'
          : !kitExported
            ? 'kit_required'
            : boundPolicy?.backupCheck.open !== null
              ? 'backup_open'
              : 'backup_required';
  return { state, policyId, setupComplete, kitExported, backupCheckComplete, ready };
}

export async function vaultCoordinatorRecoveryCReadiness(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorRecoveryCReadinessRequest,
): Promise<VaultCoordinatorRecoveryCReadinessResult> {
  return ctx.runExclusive(async () => {
    requireVaultCoordinator(ctx);
    const { session } = await ctx.activeRecord(input);
    const resolved = await resolveVaultPolicy(ctx);
    const readiness = projectRecoveryCReadiness(
      resolved?.identity.policyId ?? null,
      await loadVaultRecoveryCCeremony(ctx.local),
    );
    await ctx.touchSessionLocked(session);
    return readiness;
  });
}

async function requireRecoveryCReady(ctx: VaultCoordinatorContext): Promise<void> {
  const resolved = await resolveVaultPolicy(ctx);
  const readiness = projectRecoveryCReadiness(
    resolved?.identity.policyId ?? null,
    await loadVaultRecoveryCCeremony(ctx.local),
  );
  if (!readiness.ready) {
    throw new RpcError(
      'ERR_VAULT_RECOVERY_C_BACKUP_REQUIRED',
      'the Vault is not ready to fund until its public kit is saved and the paper Recovery Key passes a fresh restore check',
    );
  }
}

/**
 * Forget the local watch-only policy. ADR 0007 §2 again: this deletes a
 * description, not a capability. The descriptors it forgets still control
 * whatever those addresses hold, and every signer still holds its key.
 */
export async function vaultCoordinatorRemovePolicy(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorRemovePolicyRequest,
): Promise<{ removed: boolean }> {
  return ctx.runExclusive(async () => {
    requireVaultCoordinator(ctx);
    const { record, session } = await ctx.activeRecord(input);
    const stored = await loadVaultPolicy(ctx.local);
    if (stored.state === 'absent') {
      throw new RpcError('ERR_VAULT_POLICY_MISSING', 'no Vault policy is stored');
    }
    const unlocked = await unlockVault(record, input.password); // throws on wrong password
    zeroize(unlocked.dek);
    if (stored.state === 'valid' && stored.stored.record.identity.policyId !== input.policyId) {
      throw new RpcError('ERR_VAULT_POLICY_MISSING', 'policyId does not match the stored policy');
    }
    if (stored.state === 'unusable' && input.purgeUnusable !== true) {
      throw new RpcError(
        'ERR_VAULT_POLICY_MISSING',
        'stored Vault policy is unusable — purge it explicitly',
      );
    }
    await clearVaultPolicy(ctx.local);
    await clearVaultRecoveryCCeremony(ctx.local);
    await ctx.touchSessionLocked(session);
    return { removed: true };
  });
}

/**
 * Scan the Vault's descriptor addresses and classify what it holds
 * (ADR 0007 §7, Workstream C2).
 *
 * Two independent things have to hold before anything here is usable, and
 * they fail in different ways. The *source* must be coherent — one backend,
 * one classification revision, and one block across the separate signed
 * status, snapshot, and classify responses — or the whole Vault is read-only.
 * Then each output is judged on its own, so one frozen or unsupported UTXO
 * makes that output immovable without hiding the rest of the balance.
 *
 * The status response is deliberately re-read after the scan rather than
 * before it: it is the only place `historyTip` and `ordTip` exist, and the
 * question is whether it describes the same block the scan just saw. A tip
 * that advanced mid-scan is an ordinary outcome and still a refusal — picking
 * whichever tip looked current would be exactly the guess §7 forbids.
 *
 * Runs outside `runExclusive` like the Spending scan: a network loop must not
 * hold the vault lock. Nothing is persisted, so there is no checkpoint to
 * race — a refusal simply means the caller scans again.
 */
export async function vaultCoordinatorScan(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorScanRequest,
): Promise<VaultCoordinatorScanResult> {
  const scanned = await scanVaultLive(ctx, input);
  // Rebuilt per refusal rather than shared: the response type wants a mutable
  // array, and a shared frozen one would be a caller-visible alias.
  const empty = (): Omit<VaultCoordinatorScanResult, 'refusal'> => ({
    scannedAt: null,
    balance: null,
    tip: null,
    utxos: [],
  });
  if (!scanned.ok) return { refusal: scanned.refusal, ...empty() };
  return {
    refusal: null,
    scannedAt: Number(scanned.source.observedAtMs),
    balance: summarizeVaultBalance(scanned.utxos),
    tip: scanned.source.coreTip,
    utxos: scanned.utxos.map((utxo) => ({
      txid: utxo.txid,
      vout: utxo.vout,
      valueSats: utxo.valueSats,
      branch: utxo.branch,
      derivationIndex: utxo.derivationIndex,
      confirmations: utxo.confirmations,
      primaryClass: utxo.primaryClass,
      inscriptionCount: utxo.inscriptions.length,
      refusal: utxo.refusal,
    })),
  };
}

/**
 * One live scan: classified outputs plus the coherent source behind them.
 *
 * Shared by the scan op and by plan construction rather than having the
 * latter reuse a cached result. A plan must be built from the same evidence
 * snapshot that justified the balance it spends, and a plan built against a
 * scan the caller happened to have lying around would be exactly the guess
 * ADR 0007 §7 forbids.
 */
async function scanVaultLive(ctx: VaultCoordinatorContext, input: ActiveSessionRequest): Promise<
  | { ok: true; capability: VaultCoordinatorCapability; policy: VaultPolicyIdentityV1; source: VaultEvidenceSourceV1; utxos: VaultUtxoV1[] }
  | { ok: false; refusal: VaultEvidenceRefusal }
> {
  const capability = await ctx.runExclusive(async () => {
    const found = requireVaultCoordinatorCapability(ctx);
    const { session } = await ctx.activeRecord(input);
    await ctx.touchSessionLocked(session);
    return found;
  });
  const resolved = await ctx.runExclusive(() => resolveVaultPolicy(ctx));
  if (resolved === null) {
    throw new RpcError('ERR_VAULT_POLICY_MISSING', 'no usable Vault policy is stored');
  }
  const gateway = ctx.gateway;
  if (!gateway) return { ok: false, refusal: 'gateway_unavailable' };

  const outcome = await scanVaultPolicy({
    policy: resolved.identity,
    network: capability.network,
    gateway,
  });
  if (!outcome.result.ok) {
    return {
      ok: false,
      refusal:
        outcome.result.failure === 'conflicting_sources' ? 'conflicting_source' : 'scan_incomplete',
    };
  }
  // Force a fresh status read: a cached one could predate the scan and agree
  // with nothing, and the whole point of this comparison is simultaneity.
  const statusView = await ctx.gatewayStatus({ forceRefresh: true });
  if (statusView.lastReason !== null) return { ok: false, refusal: 'gateway_unavailable' };
  const cached = await loadCachedStatus(
    ctx.session,
    gateway.endpoint,
    gateway.protocolVersions,
  );
  const source = deriveVaultEvidenceSource({
    network: capability.network,
    status: cached?.status ?? null,
    // Straight from the snapshot envelope scanUnit verified, so an empty
    // Vault is held to the same tip comparison as a funded one.
    scan: outcome.source,
    nowMs: ctx.vaultDeps.now(),
  });
  if (!source.ok) return { ok: false, refusal: source.refusal };

  const projected: VaultUtxoV1[] = [];
  for (const utxo of outcome.result.utxos) {
    const record = projectVaultUtxo(utxo, source.source);
    // A record the gateway contradicted itself about poisons the scan rather
    // than being dropped: silently discarding an inscription would turn a
    // protected UTXO into an apparently clean one.
    if (record === null) return { ok: false, refusal: 'conflicting_source' };
    projected.push(record);
  }
  return {
    ok: true,
    capability,
    policy: resolved.identity,
    source: source.source,
    utxos: projected,
  };
}

// ---- C3-C6: the plan lifecycle -------------------------------------------
//
// A plan is the one thing in this surface that can become irreversible, so
// every step below re-derives rather than trusts: the destination is
// regenerated from the Spending seed, the stored plan is re-parsed from its
// canonical bytes and re-checked against its own digest, the ADR 0007 §8.1
// bound is re-asserted before any key is used, and the transaction handed to
// the broadcaster is compared against one finalized here from that plan.

/**
 * The paired Spending wallet's stable receive address, regenerated.
 *
 * ADR 0007 §8.1 restricts the pilot's destination to the paired Spending
 * wallet and requires that to be proved by regeneration. Deriving it here,
 * with no caller-supplied address anywhere in the request, is the strongest
 * available form of that: there is no string for a caller to get wrong, and
 * a coordinator that has been fooled about its own Spending seed has already
 * lost.
 */
async function pairedSpendingDestination(
  ctx: VaultCoordinatorContext,
  input: ActiveSessionRequest,
): Promise<{ address: string; walletIdHash: string }> {
  return ctx.runExclusive(async () => {
    await requireRecoveryCReady(ctx);
    const { result, session } = await ctx.withActiveDek(input, async (payload, vaultId, active) => {
      const seed = hexToBytes(payload.seedHex);
      try {
        return {
          result: {
            address: stableExternalAddress(seed, 'payment', ctx.network, 0).address,
            // Identifies the paired wallet inside the plan without naming it.
            walletIdHash: bytesToHex(
              getCryptoProvider().sha256(
                new TextEncoder().encode(`drey-vault-paired-spending-v1\0${vaultId}`),
              ),
            ),
          },
          session: active,
        };
      } finally {
        zeroize(seed);
      }
    });
    await ctx.touchSessionLocked(session);
    return result;
  });
}

/**
 * Prove a deposit destination is Vault-owned (ADR 0007 §7).
 *
 * The whole of the Vault's part in a deposit. The Spending wallet then sends
 * to this address through its own reviewed path — the inputs are S's, so no
 * Vault plan exists or could exist. What must not happen is a deposit to an
 * address that merely looks like the Vault's, so it is regenerated from the
 * committed policy and proved, never compared as a string.
 */
export async function vaultCoordinatorDepositAddress(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorDepositAddressRequest,
): Promise<VaultCoordinatorDepositAddressResult> {
  return ctx.runExclusive(async () => {
    requireVaultCoordinatorCapability(ctx);
    const { session } = await ctx.activeRecord(input);
    await requireRecoveryCReady(ctx);
    const resolved = await resolveVaultPolicy(ctx);
    if (resolved === null) {
      throw new RpcError('ERR_VAULT_POLICY_MISSING', 'no usable Vault policy is stored');
    }
    const proved = assertVaultDepositAddress(resolved.identity, 'receive', input.index);
    await ctx.touchSessionLocked(session);
    return { ...proved, branch: 'receive' as const, index: input.index };
  });
}

/** Build a withdrawal to the paired Spending wallet from a fresh scan. */
export async function vaultCoordinatorBuildPlan(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorBuildPlanRequest,
): Promise<VaultCoordinatorBuildPlanResult> {
  const destination = await pairedSpendingDestination(ctx, input);
  const scanned = await scanVaultLive(ctx, input);
  if (!scanned.ok) {
    throw new RpcError(
      'ERR_VAULT_PLAN_REJECTED',
      `Vault is read-only: ${scanned.refusal}`,
    );
  }
  const now = ctx.vaultDeps.now();
  const reservation = await ctx.runExclusive(async () => {
    const loaded = await loadVaultPolicy(ctx.local);
    if (loaded.state !== 'valid' || loaded.stored.record.identity.policyId !== scanned.policy.policyId) {
      throw new RpcError('ERR_VAULT_POLICY_MISSING', 'Vault policy changed during the live scan');
    }
    if (loaded.stored.transport === null) {
      throw new RpcError('ERR_VAULT_SIGNER_REJECTED', 'Vault has no authenticated Mobile B channel');
    }
    const reservation = reserveVaultCoordinatorChangeIndex(
      loaded.stored.nextChangeIndex,
      'extension',
    );
    await saveVaultPolicy(ctx.local, {
      ...loaded.stored,
      nextChangeIndex: reservation.nextIndex,
    });
    return { changeDerivationIndex: reservation.index };
  });
  let built;
  try {
    built = buildVaultWithdrawal({
      policy: scanned.policy,
      capability: scanned.capability,
      source: scanned.source,
      utxos: scanned.utxos,
      destinationAddress: destination.address,
      pairedSpendingWalletIdHash: destination.walletIdHash,
      ...(input.movement === undefined ? {} : { movement: input.movement }),
      ...(input.amountSats === undefined ? {} : { amountSats: input.amountSats }),
      ...(input.inscriptionId === undefined ? {} : { inscriptionId: input.inscriptionId }),
      feeRateSatPerKvB: input.feeRateSatPerKvB,
      changeDerivationIndex: reservation.changeDerivationIndex,
      planId: bytesToHex(ctx.vaultDeps.random(16)),
      requestId: bytesToHex(ctx.vaultDeps.random(16)),
      createdAtMs: String(now),
      // The plan cannot outlive the evidence its own input hashes commit to.
      expiresAtMs: scanned.source.validUntilMs,
    });
  } catch (error) {
    if (error instanceof VaultPlanError) {
      throw new RpcError('ERR_VAULT_PLAN_REJECTED', (error as Error).message);
    }
    throw error;
  }
  return ctx.runExclusive(async () => {
    const { session } = await ctx.activeRecord(input);
    await saveVaultApprovedPlan(
      ctx.local,
      approvedPlanRecord(built, destination.address, now),
    );
    await ctx.touchSessionLocked(session);
    return {
      plan: summarizeVaultPlan(built.plan, destination.address),
      psbtHex: built.psbtHex,
    };
  });
}

/** Build a CPFP child from a freshly scanned, signer-local parent change. */
export async function vaultCoordinatorBuildCpfp(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorBuildCpfpRequest,
): Promise<VaultCoordinatorBuildPlanResult> {
  const parent = await ctx.runExclusive(async () => {
    const { session } = await ctx.activeRecord(input);
    const held = await loadCurrentVaultPlan(ctx);
    if (held === null) throw new RpcError('ERR_VAULT_PLAN_MISSING', 'no parent Vault plan is stored');
    if (held.plan.replacement.kind !== 'none' ||
        (held.record.broadcast?.status !== 'accepted' &&
          held.record.broadcast?.status !== 'already_known')) {
      throw new RpcError(
        'ERR_VAULT_PLAN_REJECTED',
        'CPFP requires one unconfirmed accepted parent plan that has not already been accelerated',
      );
    }
    await ctx.touchSessionLocked(session);
    return held;
  });
  const destination = await pairedSpendingDestination(ctx, input);
  const scanned = await scanVaultLive(ctx, input);
  if (!scanned.ok) {
    throw new RpcError('ERR_VAULT_PLAN_REJECTED', `Vault is read-only: ${scanned.refusal}`);
  }
  const recognized = scanned.utxos.map((utxo) =>
    recognizeVaultCreatedUnconfirmedChange(utxo, parent.plan));
  const changeIndex = parent.plan.outputs.find(
    (output) => output.purpose === 'vault-change',
  )?.derivationIndex;
  if (changeIndex === null || changeIndex === undefined) {
    throw new RpcError('ERR_VAULT_PLAN_REJECTED', 'the parent has no Vault change to accelerate');
  }
  const now = ctx.vaultDeps.now();
  let built;
  try {
    built = buildVaultCpfp({
      policy: scanned.policy,
      source: scanned.source,
      utxos: recognized,
      destinationAddress: destination.address,
      pairedSpendingWalletIdHash: destination.walletIdHash,
      feeRateSatPerKvB: input.feeRateSatPerKvB,
      changeDerivationIndex: changeIndex,
      planId: bytesToHex(ctx.vaultDeps.random(16)),
      requestId: bytesToHex(ctx.vaultDeps.random(16)),
      createdAtMs: String(now),
      expiresAtMs: scanned.source.validUntilMs,
      broadcastIntent: 'broadcast',
      previousPlan: parent.plan,
    });
  } catch (error) {
    if (error instanceof VaultPlanError) {
      throw new RpcError('ERR_VAULT_PLAN_REJECTED', error.message);
    }
    throw error;
  }
  return ctx.runExclusive(async () => {
    const { session } = await ctx.activeRecord(input);
    const current = await loadCurrentVaultPlan(ctx);
    if (current === null || current.record.planId !== parent.record.planId ||
        current.record.broadcast?.status !== parent.record.broadcast?.status) {
      throw new RpcError('ERR_VAULT_PLAN_REJECTED', 'the parent changed during CPFP construction');
    }
    await saveVaultApprovedPlan(ctx.local, approvedPlanRecord(built, destination.address, now));
    await ctx.touchSessionLocked(session);
    return { plan: summarizeVaultPlan(built.plan, destination.address), psbtHex: built.psbtHex };
  });
}

/** The plan currently held, whether it is still usable, and where it got to. */
export async function vaultCoordinatorPlan(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorPlanRequest,
): Promise<VaultCoordinatorPlanResult> {
  return ctx.runExclusive(async () => {
    requireVaultCoordinatorCapability(ctx);
    const { session } = await ctx.activeRecord(input);
    const held = await loadCurrentVaultPlan(ctx);
    const storedPolicy = await loadVaultPolicy(ctx.local);
    const pending = storedPolicy.state === 'valid'
      ? storedPolicy.stored.transport?.pendingMobileResponse ?? null
      : null;
    const mobileResponse = pending === null ? null : {
      approvalContextQrFrames: [...vaultApprovalContextUrEncoder(pending.responseEnvelope).frames],
      psbtQrFrames: [...vaultPsbtUrEncoder(pending.signedPsbtHex).frames],
    };
    await ctx.touchSessionLocked(session);
    if (held === null) return {
      plan: null,
      psbtHex: null,
      combinedPsbtHex: null,
      stale: false,
      broadcast: null,
      transactionHex: null,
      txid: null,
      broadcastPosture: 'none',
      mobileResponse,
    };
    const lifecycle = held.record.broadcastLifecycle;
    const broadcastPosture = held.record.broadcast !== null && held.record.broadcast.status !== 'indeterminate'
      ? 'terminal'
      : lifecycle === null
      ? (held.record.broadcast?.status === 'indeterminate' ? 'reconcile-only' :
          held.record.broadcast === null ? 'none' : 'terminal')
      : lifecycle.phase === 'terminal' && lifecycle.terminal.status === 'indeterminate'
        ? 'reconcile-only'
        : vaultBroadcastRecoveryPosture(lifecycle);
    return {
      plan: summarizeVaultPlan(held.plan, held.record.destinationAddress),
      psbtHex: held.record.psbtHex,
      combinedPsbtHex: held.record.combinedPsbtHex,
      stale: ctx.vaultDeps.now() > Number(held.plan.expiresAtMs),
      broadcast: held.record.broadcast,
      transactionHex: lifecycle?.transactionHex ?? null,
      txid: lifecycle?.txid ?? held.record.broadcast?.txid ?? null,
      broadcastPosture,
      mobileResponse,
    };
  });
}

function storedMobileResponseForInput(
  transport: NonNullable<VaultCoordinatorPolicyRecordV1['transport']>,
  input: VaultCoordinatorSignMobileRequestRequest,
): VaultCoordinatorSignMobileRequestResult | null {
  const pending = transport.pendingMobileResponse;
  if (pending === null || pending.requestPsbtHex !== input.psbtHex) return null;
  const supplied = finalizeVaultPsbtApprovalEnvelope(input.approvalEnvelope);
  if (bytesToHex(serializeVaultPsbtApprovalEnvelope(supplied)) !==
      bytesToHex(serializeVaultPsbtApprovalEnvelope(pending.requestEnvelope))) {
    return null;
  }
  return {
    approvalContextQrFrames: [...vaultApprovalContextUrEncoder(pending.responseEnvelope).frames],
    psbtQrFrames: [...vaultPsbtUrEncoder(pending.signedPsbtHex).frames],
  };
}

/**
 * The stored plan, re-parsed from its canonical bytes and re-checked against
 * the digest it was filed under. A plan is only as trustworthy as the bytes
 * that reproduce its identity, so a record whose bytes no longer hash to its
 * own digest is not repaired — it does not exist.
 */
async function loadCurrentVaultPlan(ctx: VaultCoordinatorContext): Promise<{
  record: VaultApprovedPlanV1;
  plan: VaultUnsignedPlanV1;
} | null> {
  const stored = (await loadVaultApprovedPlans(ctx.local))[0];
  if (stored === undefined) return null;
  const plan = parseApprovedPlan(stored);
  if (plan === null) return null;
  const changeIndexes = plan.outputs
    .filter((output) => output.purpose === 'vault-change')
    .map((output) => output.derivationIndex!);
  if (changeIndexes.length > 1 ||
      changeIndexes.some((index) => !isVaultCoordinatorChangeIndex(index, 'extension'))) {
    return null;
  }
  return { record: stored, plan };
}

/**
 * Everything a signing, combining, or finalizing step needs, refused if the
 * plan is absent, no longer matches the committed policy, or has aged out.
 *
 * Staleness is checked here rather than left to core's freshness window so
 * the caller gets `ERR_VAULT_PLAN_STALE` — a state it can act on by
 * rebuilding — instead of an opaque validator failure. Core still checks it
 * again; this is the explanation, not the enforcement.
 */
async function requireLiveVaultPlan(ctx: VaultCoordinatorContext, input: ActiveSessionRequest): Promise<{
  capability: VaultCoordinatorCapability;
  policy: VaultPolicyIdentityV1;
  record: VaultApprovedPlanV1;
  plan: VaultUnsignedPlanV1;
  previousPlan?: VaultUnsignedPlanV1;
  nowMs: number;
}> {
  const capability = requireVaultCoordinatorCapability(ctx);
  await requireRecoveryCReady(ctx);
  const resolved = await resolveVaultPolicy(ctx);
  if (resolved === null) {
    throw new RpcError('ERR_VAULT_POLICY_MISSING', 'no usable Vault policy is stored');
  }
  const held = await loadCurrentVaultPlan(ctx);
  if (held === null) throw new RpcError('ERR_VAULT_PLAN_MISSING', 'no usable Vault plan is stored');
  if (held.plan.policyId !== resolved.identity.policyId) {
    throw new RpcError('ERR_VAULT_PLAN_MISSING', 'the stored plan belongs to another policy');
  }
  const nowMs = ctx.vaultDeps.now();
  if (nowMs > Number(held.plan.expiresAtMs)) {
    throw new RpcError(
      'ERR_VAULT_PLAN_STALE',
      'the classification evidence behind this plan has expired — rebuild it from a fresh scan',
    );
  }
  const parentTxid = held.plan.replacement.kind === 'cpfp'
    ? held.plan.replacement.parentTxid
    : held.plan.replacement.kind === 'rbf'
      ? held.plan.replacement.replacesTxid
      : null;
  let previousPlan: VaultUnsignedPlanV1 | undefined;
  if (parentTxid !== null) {
    previousPlan = (await loadVaultApprovedPlans(ctx.local))
      .flatMap((record) => {
        const plan = parseApprovedPlan(record);
        return plan === null ? [] : [plan];
      })
      .find((plan) => vaultPlanTxid(plan) === parentTxid);
    if (previousPlan === undefined || previousPlan.planId === held.plan.planId) {
      throw new RpcError('ERR_VAULT_PLAN_MISSING', 'replacement parent is absent from signer-local history');
    }
  }
  void input;
  return {
    capability,
    policy: resolved.identity,
    ...held,
    nowMs,
    ...(previousPlan === undefined ? {} : { previousPlan }),
  };
}

/** Add role A's signature. Role A's record is its own, so this needs its password. */
export async function vaultCoordinatorSignPlan(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorSignPlanRequest,
): Promise<VaultCoordinatorSignPlanResult> {
  return ctx.runExclusive(async () => {
    const { session } = await ctx.activeRecord(input);
    const live = await requireLiveVaultPlan(ctx, input);
    const role = await loadVaultRole(ctx.local);
    if (role.state !== 'valid') {
      throw new RpcError('ERR_VAULT_ROLE_MISSING', 'no usable Vault role is stored');
    }
    const unlocked = await unlockVault(role.record.secret, input.password); // throws on wrong password
    const payload = openVaultPayload(role.record.secret, unlocked.dek);
    const seed = hexToBytes(payload.seedHex);
    const signerRoot = HDKey.fromMasterSeed(seed, bip32Versions(live.capability.network));
    try {
      const result = signVaultPlanAsRole({
        capability: live.capability,
        policy: live.policy,
        plan: live.plan,
        evidence: live.record.evidence,
        nowMs: String(live.nowMs),
        ...(live.previousPlan === undefined ? {} : { previousPlan: live.previousPlan }),
        role: 'desktop-a',
        signerRoot,
        psbtHex: live.record.psbtHex,
      });
      const stored = await loadVaultPolicy(ctx.local);
      if (stored.state !== 'valid' || stored.stored.transport === null ||
          stored.stored.record.identity.policyId !== live.plan.policyId) {
        throw new RpcError('ERR_VAULT_POLICY_MISSING', 'authenticated Vault policy changed before QR signing');
      }
      const transport = stored.stored.transport;
      const approvalInput = createVaultAssetSafePartialSignatureInput({
        policy: live.policy,
        plan: live.plan,
        role: 'mobile-b',
        psbtHex: result.signedPsbtHex,
        evidence: live.record.evidence,
        nowMs: String(live.nowMs),
        ...(live.previousPlan === undefined ? {} : { previousPlan: live.previousPlan }),
      });
      const approvalEnvelope = signVaultPsbtApprovalEnvelope({
        version: 1,
        network: live.plan.network,
        policyId: live.plan.policyId,
        planId: live.plan.planId,
        planDigest: live.plan.planDigest,
        senderChannelIdHex: transport.extensionChannelIdHex,
        recipientChannelIdHex: transport.mobileChannelIdHex,
        counter: transport.nextOutboundCounter,
        expiresAtMs: live.plan.expiresAtMs,
        antiReplayNonceHex: bytesToHex(ctx.vaultDeps.random(32)),
        transcriptHashHex: transport.transcriptHashHex,
        stage: 'request',
        payloadHex: bytesToHex(serializeVaultPartialSignatureInput(approvalInput)),
      }, signerRoot, role.record.origin);
      await saveVaultPolicy(ctx.local, {
        ...stored.stored,
        transport: {
          ...transport,
          nextOutboundCounter: String(BigInt(transport.nextOutboundCounter) + 1n),
        },
      });
      await ctx.touchSessionLocked(session);
      return {
        roleAdded: 'desktop-a' as const,
        signedPsbtHex: result.signedPsbtHex,
        resultHex: bytesToHex(serializeVaultPartialSignatureResult(result)),
        approvalContextQrFrames: [...vaultApprovalContextUrEncoder(approvalEnvelope).frames],
        psbtQrFrames: [...vaultPsbtUrEncoder(result.signedPsbtHex).frames],
      };
    } catch (error) {
      throw vaultPlanActionError(error);
    } finally {
      signerRoot.wipePrivateData();
      zeroize(seed);
      zeroize(unlocked.dek);
    }
  });
}

/** Independently validate and sign a mobile-coordinated request as Desktop A. */
export async function vaultCoordinatorSignMobileRequest(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorSignMobileRequestRequest,
): Promise<VaultCoordinatorSignMobileRequestResult> {
  // Reissuing an already-created response is not a new signing authority.
  // Return the exact durably committed bytes before any live gateway scan, so
  // a worker restart or missed QR does not strand the Mobile-owned plan.
  const resumed = await ctx.runExclusive(async () => {
    const { session } = await ctx.activeRecord(input);
    const stored = await loadVaultPolicy(ctx.local);
    if (stored.state !== 'valid' || stored.stored.transport === null) return null;
    const response = storedMobileResponseForInput(stored.stored.transport, input);
    if (response !== null) await ctx.touchSessionLocked(session);
    return response;
  });
  if (resumed !== null) return resumed;
  const destination = await pairedSpendingDestination(ctx, input);
  const scanned = await scanVaultLive(ctx, input);
  if (!scanned.ok) {
    throw new RpcError('ERR_VAULT_PLAN_REJECTED', `Vault is read-only: ${scanned.refusal}`);
  }
  return ctx.runExclusive(async () => {
    const { session } = await ctx.activeRecord(input);
    const stored = await loadVaultPolicy(ctx.local);
    if (stored.state !== 'valid' || stored.stored.transport === null ||
        stored.stored.record.identity.policyId !== scanned.policy.policyId) {
      throw new RpcError('ERR_VAULT_POLICY_MISSING', 'authenticated Vault policy changed during scan');
    }
    if (await loadCurrentVaultPlan(ctx) !== null) {
      throw new RpcError(
        'ERR_VAULT_PLAN_REJECTED',
        'a Desktop-coordinated plan must be explicitly discarded before approving a Mobile plan',
      );
    }
    const transport = stored.stored.transport;
    const concurrentlyPersisted = storedMobileResponseForInput(transport, input);
    if (concurrentlyPersisted !== null) {
      await ctx.touchSessionLocked(session);
      return concurrentlyPersisted;
    }
    const supplied = input.approvalEnvelope;
    const envelope = finalizeVaultPsbtApprovalEnvelope(supplied);
    const mobileOrigin = scanned.policy.signers.find((signer) => signer.role === 'mobile-b');
    if (envelope.payloadHash !== supplied.payloadHash || envelope.stage !== 'request' ||
        mobileOrigin === undefined ||
        !verifyVaultPsbtApprovalEnvelopeAuthentication(envelope, mobileOrigin) ||
        envelope.network !== scanned.policy.network || envelope.policyId !== scanned.policy.policyId ||
        envelope.senderChannelIdHex !== transport.mobileChannelIdHex ||
        envelope.recipientChannelIdHex !== transport.extensionChannelIdHex ||
        envelope.transcriptHashHex !== transport.transcriptHashHex ||
        BigInt(envelope.counter) !== BigInt(transport.highestInboundCounter) + 1n ||
        BigInt(String(ctx.vaultDeps.now())) > BigInt(envelope.expiresAtMs)) {
      throw new RpcError('ERR_VAULT_SIGNER_REJECTED', 'mobile approval request is stale, replayed, or belongs elsewhere');
    }
    const request = parseVaultPartialSignatureInput(hexToBytes(envelope.payloadHex));
    const plan = parseCanonicalVaultPlan(hexToBytes(request.canonicalPlanHex));
    const peerChangeIndexes = plan.outputs
      .filter((output) => output.purpose === 'vault-change')
      .map((output) => output.derivationIndex!);
    if (request.role !== 'desktop-a' || request.psbtHex !== input.psbtHex ||
        request.policyId !== plan.policyId || request.planId !== plan.planId ||
        request.planDigest !== plan.planDigest || envelope.planId !== plan.planId ||
        envelope.planDigest !== plan.planDigest ||
        plan.destination.address !== destination.address ||
        plan.destination.pairedSpendingWalletIdHash !== destination.walletIdHash ||
        peerChangeIndexes.length > 1 ||
        peerChangeIndexes.some((index) => !isVaultCoordinatorChangeIndex(index, 'mobile'))) {
      throw new RpcError('ERR_VAULT_PLAN_REJECTED', 'mobile context, destination, plan, and PSBT differ');
    }
    const selected = plan.inputs.map((planned) => {
      const found = scanned.utxos.find((utxo) => utxo.txid === planned.txid && utxo.vout === planned.vout);
      if (found === undefined) throw new RpcError('ERR_VAULT_PLAN_REJECTED', 'planned input is absent from Desktop A scan');
      return found;
    });
    const evidence = buildVaultAssetPolicyEvidence({
      source: scanned.source,
      policyId: plan.policyId,
      planId: plan.planId,
      planDigest: plan.planDigest,
      utxos: selected,
    });
    const reconstructed = createVaultAssetSafePartialSignatureInput({
      policy: scanned.policy,
      plan,
      role: 'desktop-a',
      psbtHex: input.psbtHex,
      evidence,
      nowMs: String(ctx.vaultDeps.now()),
    });
    if (bytesToHex(serializeVaultPartialSignatureInput(reconstructed)) !== envelope.payloadHex) {
      throw new RpcError('ERR_VAULT_PLAN_REJECTED', 'Desktop A independent reconstruction differs');
    }
    const role = await loadVaultRole(ctx.local);
    if (role.state !== 'valid') throw new RpcError('ERR_VAULT_ROLE_MISSING', 'Desktop A is unavailable');
    const unlocked = await unlockVault(role.record.secret, input.password);
    const payload = openVaultPayload(role.record.secret, unlocked.dek);
    const seed = hexToBytes(payload.seedHex);
    const signerRoot = HDKey.fromMasterSeed(seed, bip32Versions(scanned.policy.network));
    try {
      const result = signVaultPlanAsRole({
        capability: scanned.capability,
        policy: scanned.policy,
        plan,
        evidence,
        nowMs: String(ctx.vaultDeps.now()),
        role: 'desktop-a',
        signerRoot,
        psbtHex: input.psbtHex,
      });
      const counter = transport.nextOutboundCounter;
      const response = signVaultPsbtApprovalEnvelope({
        version: 1,
        network: plan.network,
        policyId: plan.policyId,
        planId: plan.planId,
        planDigest: plan.planDigest,
        senderChannelIdHex: transport.extensionChannelIdHex,
        recipientChannelIdHex: transport.mobileChannelIdHex,
        counter,
        expiresAtMs: plan.expiresAtMs,
        antiReplayNonceHex: bytesToHex(ctx.vaultDeps.random(32)),
        transcriptHashHex: transport.transcriptHashHex,
        stage: 'partial-signature',
        payloadHex: bytesToHex(serializeVaultPartialSignatureResult(result)),
      }, signerRoot, role.record.origin);
      await saveVaultPolicy(ctx.local, {
        ...stored.stored,
        // Mobile owns the odd branch-1 lane. Desktop's even reservation state
        // never advances from peer input, so simultaneous builds cannot collide.
        nextChangeIndex: stored.stored.nextChangeIndex,
        transport: {
          ...transport,
          highestInboundCounter: envelope.counter,
          nextOutboundCounter: String(BigInt(counter) + 1n),
          pendingMobileResponse: {
            requestEnvelope: envelope,
            requestPsbtHex: input.psbtHex,
            responseEnvelope: response,
            signedPsbtHex: result.signedPsbtHex,
          },
        },
      });
      await ctx.touchSessionLocked(session);
      return {
        approvalContextQrFrames: [...vaultApprovalContextUrEncoder(response).frames],
        psbtQrFrames: [...vaultPsbtUrEncoder(result.signedPsbtHex).frames],
      };
    } catch (error) {
      throw vaultPlanActionError(error);
    } finally {
      signerRoot.wipePrivateData();
      zeroize(seed);
      zeroize(unlocked.dek);
    }
  });
}

/**
 * Assemble a quorum from signed PSBTs (C4 transport, C5 combination).
 *
 * Plain PSBT hex is the interface because the PSBT is the signing truth and
 * the SQVB envelope is transport — a third-party signer returns a PSBT and
 * has never heard of the envelope. Asset safety is not what the envelope was
 * providing: the B3 validator runs over every incoming PSBT before the
 * combiner sees any of them.
 */
export async function vaultCoordinatorCombinePlan(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorCombinePlanRequest,
): Promise<VaultCoordinatorCombinePlanResult> {
  return ctx.runExclusive(async () => {
    const { session } = await ctx.activeRecord(input);
    const live = await requireLiveVaultPlan(ctx, input);
    try {
      let policyUpdate: VaultCoordinatorPolicyRecordV1 | null = null;
      if (input.mobileApprovalEnvelope !== undefined) {
        const stored = await loadVaultPolicy(ctx.local);
        if (stored.state !== 'valid' || stored.stored.transport === null) {
          throw new Error('authenticated Mobile B transport is unavailable');
        }
        const transport = stored.stored.transport;
        const supplied = input.mobileApprovalEnvelope;
        const envelope = finalizeVaultPsbtApprovalEnvelope(supplied);
        const mobileOrigin = live.policy.signers.find((signer) => signer.role === 'mobile-b');
        if (envelope.payloadHash !== supplied.payloadHash ||
            mobileOrigin === undefined ||
            !verifyVaultPsbtApprovalEnvelopeAuthentication(envelope, mobileOrigin) ||
            envelope.stage !== 'partial-signature' ||
            envelope.network !== live.plan.network ||
            envelope.policyId !== live.plan.policyId ||
            envelope.planId !== live.plan.planId ||
            envelope.planDigest !== live.plan.planDigest ||
            envelope.senderChannelIdHex !== transport.mobileChannelIdHex ||
            envelope.recipientChannelIdHex !== transport.extensionChannelIdHex ||
            envelope.transcriptHashHex !== transport.transcriptHashHex ||
            BigInt(envelope.counter) !== BigInt(transport.highestInboundCounter) + 1n ||
            BigInt(String(live.nowMs)) > BigInt(envelope.expiresAtMs)) {
          throw new Error('Mobile B approval is stale, replayed, or belongs to another plan');
        }
        const result = parseVaultPartialSignatureResult(hexToBytes(envelope.payloadHex));
        if (result.roleAdded !== 'mobile-b' || !input.psbtHexes.includes(result.signedPsbtHex)) {
          throw new Error('Mobile B approval context and signed PSBT differ');
        }
        policyUpdate = {
          ...stored.stored,
          transport: { ...transport, highestInboundCounter: envelope.counter },
        };
      }
      const combined = combineVaultSignedPsbts({
        capability: live.capability,
        policy: live.policy,
        plan: live.plan,
        evidence: live.record.evidence,
        nowMs: String(live.nowMs),
        ...(live.previousPlan === undefined ? {} : { previousPlan: live.previousPlan }),
        psbtHexes: input.psbtHexes,
      });
      const planUpdate = { ...live.record, combinedPsbtHex: combined.psbtHex };
      // The authenticated peer counter and the exact quorum it authorized are
      // one storage mutation. A crash observes both or neither.
      if (policyUpdate === null) await saveVaultApprovedPlan(ctx.local, planUpdate);
      else await saveVaultPolicyAndApprovedPlan(ctx.local, policyUpdate, planUpdate);
      await ctx.touchSessionLocked(session);
      return { psbtHex: combined.psbtHex, roles: combined.roles };
    } catch (error) {
      throw vaultPlanActionError(error);
    }
  });
}

/** Turn a quorum into a raw transaction. Still sends nothing. */
export async function vaultCoordinatorFinalizePlan(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorFinalizePlanRequest,
): Promise<VaultCoordinatorFinalizePlanResult> {
  return ctx.runExclusive(async () => {
    const { session } = await ctx.activeRecord(input);
    const live = await requireLiveVaultPlan(ctx, input);
    try {
      const existing = live.record.broadcastLifecycle;
      if (existing !== null) {
        if (existing.phase !== 'prepared' ||
            live.record.finalizedTransactionHex !== existing.transactionHex ||
            (live.record.combinedPsbtHex !== null && live.record.combinedPsbtHex !== input.psbtHex)) {
          throw new RpcError(
            existing.phase === 'dispatch-consumed' ||
              (existing.phase === 'terminal' && existing.terminal.status === 'indeterminate')
              ? 'ERR_VAULT_BROADCAST_INDETERMINATE'
              : 'ERR_VAULT_PLAN_ALREADY_BROADCAST',
            'the finalized plan already has a different durable lifecycle state',
          );
        }
        await ctx.touchSessionLocked(session);
        return {
          transactionHex: existing.transactionHex,
          txid: existing.txid,
          wtxid: existing.wtxid,
          vsize: existing.vsize,
          roles: existing.roles as VaultCoordinatorFinalizePlanResult['roles'],
        };
      }
      if (live.record.combinedPsbtHex !== null && live.record.combinedPsbtHex !== input.psbtHex) {
        throw new RpcError('ERR_VAULT_PLAN_REJECTED', 'finalization PSBT differs from the durable quorum');
      }
      const finalized = finalizeVaultTransaction({
        capability: live.capability,
        policy: live.policy,
        plan: live.plan,
        evidence: live.record.evidence,
        nowMs: String(live.nowMs),
        ...(live.previousPlan === undefined ? {} : { previousPlan: live.previousPlan }),
        psbtHex: input.psbtHex,
      });
      const lifecycle = prepareVaultBroadcast({
        policy: live.policy,
        plan: live.plan,
        transactionHex: finalized.transactionHex,
        coordinator: 'extension',
        preparedAtMs: String(ctx.vaultDeps.now()),
      });
      await saveVaultApprovedPlan(ctx.local, {
        ...live.record,
        combinedPsbtHex: input.psbtHex,
        finalizedTransactionHex: finalized.transactionHex,
        broadcastLifecycle: lifecycle,
      });
      await ctx.touchSessionLocked(session);
      return {
        transactionHex: finalized.transactionHex,
        txid: finalized.txid,
        wtxid: finalized.wtxid,
        vsize: finalized.vsize,
        roles: finalized.roles as VaultCoordinatorFinalizePlanResult['roles'],
      };
    } catch (error) {
      throw vaultPlanActionError(error);
    }
  });
}

/**
 * Send a finalized Vault transaction (Workstream C6).
 *
 * Three lifecycle rules, and each exists because of a specific way this can
 * go wrong:
 *
 * - **Replay.** A plan that has already been sent refuses. Resending the same
 *   bytes is at best a no-op, and if a caller reached this path twice with
 *   two different finalizations the second would be a second transaction
 *   spending the same inputs.
 * - **Indeterminate outcome.** If the gateway cannot be reached or answers
 *   `indeterminate`, the exact bytes and txid are recorded and nothing is
 *   ever resent automatically — the same posture `retryBroadcasts` takes for
 *   the Spending wallet. A further attempt refuses until a human has
 *   established what is actually on chain.
 * - **Substitution.** The transaction is re-finalized here from the stored
 *   plan and compared byte-for-byte with the one supplied, so what is sent is
 *   provably this plan's transaction and not merely a well-formed one.
 */
export async function vaultCoordinatorBroadcastPlan(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorBroadcastPlanRequest,
): Promise<VaultCoordinatorPlanBroadcast> {
  const prepared = await ctx.runExclusive(async () => {
    const { session } = await ctx.activeRecord(input);
    const live = await requireLiveVaultPlan(ctx, input);
    if (live.record.broadcast !== null && live.record.broadcastLifecycle === null) {
      throw new RpcError(
        live.record.broadcast.status === 'indeterminate'
          ? 'ERR_VAULT_BROADCAST_INDETERMINATE'
          : 'ERR_VAULT_PLAN_ALREADY_BROADCAST',
        'this legacy plan already has durable broadcast state and cannot be dispatched again',
      );
    }
    // Strip the witnesses and compare against the exact bytes the approved
    // plan commits to. Core already re-verified the witness during
    // finalization; what this catches is a *different* transaction arriving
    // at the one step that cannot be undone.
    const parsed = Transaction.fromRaw(hexToBytes(input.transactionHex));
    if (bytesToHex(parsed.unsignedTx) !== live.plan.unsignedTransactionHex) {
      throw new RpcError(
        'ERR_VAULT_PLAN_MISSING',
        'those bytes are not the transaction this plan approved',
      );
    }
    const existing = live.record.broadcastLifecycle;
    if (existing !== null && existing.phase !== 'prepared') {
      const indeterminate = existing.phase === 'dispatch-consumed' ||
        (existing.phase === 'terminal' && existing.terminal.status === 'indeterminate');
      throw new RpcError(
        indeterminate ? 'ERR_VAULT_BROADCAST_INDETERMINATE' : 'ERR_VAULT_PLAN_ALREADY_BROADCAST',
        indeterminate
          ? 'these exact bytes may already have been dispatched; reconcile without retrying'
          : 'this plan already reached a terminal broadcast state',
      );
    }
    if (existing !== null && existing.transactionHex !== input.transactionHex) {
      throw new RpcError(
        'ERR_VAULT_BROADCAST_INDETERMINATE',
        'the prepared lifecycle commits to different final transaction bytes',
      );
    }
    await ctx.touchSessionLocked(session);
    const next = existing === null
      ? {
          ...live.record,
          finalizedTransactionHex: input.transactionHex,
          broadcastLifecycle: prepareVaultBroadcast({
            policy: live.policy,
            plan: live.plan,
            transactionHex: input.transactionHex,
            coordinator: 'extension',
            preparedAtMs: String(ctx.vaultDeps.now()),
          }),
        }
      : live.record;
    // Persist the exact finalized bytes before leaving the lock or performing
    // any operation that could eventually dispatch them. A replacement call
    // resumes the same prepared record rather than creating a second intent.
    if (existing === null) await saveVaultApprovedPlan(ctx.local, next);
    return {
      record: next,
      policy: live.policy,
      plan: live.plan,
      txid: parsed.id,
      wtxid: transactionWtxid(input.transactionHex),
    };
  });

  const gateway = ctx.gateway;
  // Force a fresh status rather than using whatever is cached. The signed
  // status envelope IS the fee binding for a custom-rate broadcast, and the
  // gateway refuses one older than two minutes — a window an unattended send
  // clears easily and a send behind a human confirmation prompt does not.
  // Found the hard way: the first live pilot withdrawal was rejected with
  // INVALID_BINDING because the cached envelope predated the review.
  const statusView = gateway ? await ctx.gatewayStatus({ forceRefresh: true }) : null;
  const cached = gateway
    ? await loadCachedStatus(ctx.session, gateway.endpoint, gateway.protocolVersions)
    : null;
  if (!gateway || statusView?.lastReason !== null || cached?.status.protocolVersion !== 2) {
    throw new RpcError('ERR_DATA_STALE', 'no verified gateway status to broadcast with');
  }
  const consumed = await ctx.runExclusive(async () => {
    const current = await loadCurrentVaultPlan(ctx);
    if (current === null || current.record.planId !== prepared.record.planId ||
        current.record.broadcastLifecycle?.phase !== 'prepared') {
      throw new RpcError(
        'ERR_VAULT_BROADCAST_INDETERMINATE',
        'broadcast state changed before dispatch; reconcile without retrying',
      );
    }
    const lifecycle = consumeVaultBroadcastAttempt({
      policy: prepared.policy,
      plan: prepared.plan,
      record: current.record.broadcastLifecycle,
      attemptIdHex: bytesToHex(ctx.vaultDeps.random(16)),
      consumedAtMs: String(ctx.vaultDeps.now()),
    });
    await saveVaultApprovedPlan(ctx.local, { ...current.record, broadcastLifecycle: lifecycle });
    return lifecycle;
  });
  const response = await gateway.broadcastTransaction({
    network: ctx.network,
    transactionHex: input.transactionHex,
    txid: prepared.txid,
    wtxid: prepared.wtxid,
    customFeeRateSatPerKvB: Number(prepared.plan.feeRateSatPerKvB),
    status: cached.status,
  });
  // Written whatever happened, including the unknown case. A send whose
  // outcome was never established is the one thing that must not look like a
  // plan that was never sent.
  const outcome: VaultCoordinatorPlanBroadcast = response.ok
    ? {
        txid: prepared.txid,
        status: response.value.status,
        detail: response.value.detail,
        at: ctx.vaultDeps.now(),
      }
    : {
        txid: prepared.txid,
        status: 'indeterminate' as const,
        detail: 'the gateway did not return a verified outcome; reconcile before retrying',
        at: ctx.vaultDeps.now(),
      };
  await ctx.runExclusive(async () => {
    const current = await loadCurrentVaultPlan(ctx);
    if (current === null || current.record.planId !== prepared.record.planId ||
        current.record.broadcastLifecycle?.phase !== 'dispatch-consumed') {
      throw new RpcError(
        'ERR_VAULT_BROADCAST_INDETERMINATE',
        'broadcast was dispatched but terminal state could not be safely attached',
      );
    }
    const lifecycle = completeVaultBroadcast({
      policy: prepared.policy,
      plan: prepared.plan,
      record: consumed,
      status: outcome.status,
      detail: outcome.detail,
      observedAtMs: String(outcome.at),
    });
    await saveVaultApprovedPlan(ctx.local, {
      ...current.record,
      broadcast: outcome,
      broadcastLifecycle: lifecycle,
    });
  });
  return outcome;
}

/**
 * Reconcile an indeterminate exact txid from signed Vault history. This path
 * has no broadcast call: absence remains indeterminate, while a matching
 * mempool/confirmed/conflicted history entry durably resolves the gate.
 */
export async function vaultCoordinatorReconcilePlan(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorReconcilePlanRequest,
): Promise<VaultCoordinatorPlanBroadcast> {
  const target = await ctx.runExclusive(async () => {
    requireVaultCoordinatorCapability(ctx);
    const { session } = await ctx.activeRecord(input);
    const resolved = await resolveVaultPolicy(ctx);
    const held = await loadCurrentVaultPlan(ctx);
    if (resolved === null || held === null || held.record.planId !== input.planId) {
      throw new RpcError('ERR_VAULT_PLAN_MISSING', 'no matching Vault plan is stored');
    }
    if (held.record.broadcast !== null && held.record.broadcast.status !== 'indeterminate') {
      await ctx.touchSessionLocked(session);
      return { resolved: held.record.broadcast, policy: resolved.identity, record: held.record };
    }
    const lifecycle = held.record.broadcastLifecycle;
    if (lifecycle === null || lifecycle.phase === 'prepared' ||
        (lifecycle.phase === 'terminal' && lifecycle.terminal.status !== 'indeterminate')) {
      throw new RpcError('ERR_VAULT_PLAN_REJECTED', 'this plan has no indeterminate dispatch to reconcile');
    }
    await ctx.touchSessionLocked(session);
    return { resolved: null, policy: resolved.identity, record: held.record };
  });
  if (target.resolved !== null) return target.resolved;
  const gateway = ctx.gateway;
  if (gateway === undefined) throw new RpcError('ERR_DATA_STALE', 'gateway unavailable for reconciliation');
  const scan = await scanVaultPolicy({ policy: target.policy, network: ctx.network, gateway });
  if (!scan.result.ok) throw new RpcError('ERR_DATA_STALE', 'signed Vault history is unavailable');
  const lifecycle = target.record.broadcastLifecycle!;
  const found = scan.result.history.find((entry) => entry.txid === lifecycle.txid);
  if (found === undefined) {
    return {
      txid: lifecycle.txid,
      status: 'indeterminate',
      detail: 'the exact txid is not yet present in signed Vault history; do not retry',
      at: ctx.vaultDeps.now(),
    };
  }
  const outcome: VaultCoordinatorPlanBroadcast = {
    txid: lifecycle.txid,
    status: found.confirmationState === 'confirmed' ? 'confirmed'
      : found.confirmationState === 'mempool' ? 'accepted' : 'conflicted',
    detail: `reconciled from signed Vault history (${found.confirmationState})`,
    at: ctx.vaultDeps.now(),
  };
  await ctx.runExclusive(async () => {
    const current = await loadCurrentVaultPlan(ctx);
    if (current === null || current.record.planId !== input.planId ||
        current.record.broadcastLifecycle?.txid !== lifecycle.txid) {
      throw new RpcError('ERR_VAULT_BROADCAST_INDETERMINATE', 'broadcast state changed during reconciliation');
    }
    await saveVaultApprovedPlan(ctx.local, { ...current.record, broadcast: outcome });
  });
  return outcome;
}

/** Forget a plan without acting on it. */
export async function vaultCoordinatorDiscardPlan(
  ctx: VaultCoordinatorContext,
  input: VaultCoordinatorDiscardPlanRequest,
): Promise<{ removed: boolean }> {
  return ctx.runExclusive(async () => {
    requireVaultCoordinatorCapability(ctx);
    const { session } = await ctx.activeRecord(input);
    const stored = (await loadVaultApprovedPlans(ctx.local))
      .find((record) => record.planId === input.planId);
    if (stored === undefined) {
      throw new RpcError('ERR_VAULT_PLAN_MISSING', 'no plan is stored under that id');
    }
    const lifecycle = stored.broadcastLifecycle;
    const reconciled = stored.broadcast !== null && stored.broadcast.status !== 'indeterminate';
    const possiblyDispatched = !reconciled && (stored.broadcast?.status === 'indeterminate' ||
      lifecycle?.phase === 'dispatch-consumed' ||
      (lifecycle?.phase === 'terminal' && lifecycle.terminal.status === 'indeterminate'));
    if (possiblyDispatched) {
      throw new RpcError(
        'ERR_VAULT_BROADCAST_INDETERMINATE',
        'a possibly dispatched transaction must remain durable until its exact txid is reconciled',
      );
    }
    const removed = await removeVaultApprovedPlan(ctx.local, input.planId);
    if (!removed) throw new RpcError('ERR_VAULT_PLAN_MISSING', 'the plan disappeared before removal');
    await ctx.touchSessionLocked(session);
    return { removed };
  });
}

/**
 * Map a plan-action failure onto a code the caller can act on.
 *
 * Everything else stays an internal error deliberately: core's asset-policy
 * and PSBT refusals are about the transaction's own safety, and flattening
 * them into a friendly code would invite a caller to retry past a refusal
 * that was correct.
 */
function vaultPlanActionError(error: unknown): unknown {
  if (error instanceof VaultSigningNotPermittedError) {
    return new RpcError('ERR_VAULT_COORDINATOR_UNAVAILABLE', error.message);
  }
  return error;
}
