/**
 * Extension-local Vault coordinator op registry (ADR 0007 §8, Workstreams
 * C0-C1).
 *
 * These ops are deliberately NOT part of @drey/core's OP_SCHEMAS. Core owns the
 * platform-free Vault *contracts* (Workstream B) precisely so that a future
 * mobile signer consumes the same records; it does not own a coordinator, and
 * this coordinator is an extension-owned, compile-time-authorized surface that
 * does not widen the shared wallet RPC protocol. Core's envelope leaves `op` an open
 * string and the dispatcher accepts any OpRegistry, so the extension owns this
 * surface end to end.
 *
 * Availability is not negotiated over the wire. Every op below is refused by
 * the worker unless the build channel injected a coordinator capability, and
 * production mainnet authority is a distinct reviewed union arm. No
 * request field, stored value, environment variable, or gateway response can
 * change either fact.
 *
 * Secrecy: as in core's registry, no response carries a secret except
 * `vaultCoordinator.revealRole`, which returns Desktop A's
 * mnemonic to a trusted extension surface after password reauthentication.
 * Recovery C is generated and entered only by the standalone offline package;
 * this registry carries its bounded public challenge and response bytes only.
 */
import { z } from 'zod';
import { validateMnemonic } from '@drey/core/domain/keys/mnemonic';
import { base64ToBytes, bytesToBase64 } from '@drey/core/domain/vault/encoding';
import {
  PASSKEY_PRF_OUTPUT_BYTES,
  PASSKEY_PRF_SALT_BYTES,
} from '@drey/core/domain/vault/passkey-envelope';
import type { SenderContext } from '@drey/core/messaging/envelope';
import type { OpSpec } from '@drey/core/messaging/ops';
import {
  vaultPairingEnvelopeSchema,
  vaultPsbtApprovalEnvelopeSchema,
} from '@drey/core/domain/vault/multisig-contracts';

// Core does not export its ordinary wallet-surface sender list; keep the
// dedicated approval window on its exact bound Port rather than this RPC set.
const TRUSTED_SENDERS: readonly SenderContext[] = [
  'popup', 'sidepanel', 'fullpage', 'onboarding',
];

// ---- extension-local wire error codes --------------------------------------

/**
 * Coordinator-only caller-facing codes. They live outside core's ErrorCode enum
 * because only these extension-local ops can raise them; the extension-owned
 * dispatcher, rpc client, and UI error mapping all speak the widened union.
 */
export const VAULT_COORDINATOR_ERROR_CODES = [
  /** This build channel has no Vault coordinator authority. */
  'ERR_VAULT_COORDINATOR_UNAVAILABLE',
  /** A role already exists; replacement is an explicit, separate ceremony. */
  'ERR_VAULT_ROLE_EXISTS',
  /** No usable role is stored (absent, or present but unparseable). */
  'ERR_VAULT_ROLE_MISSING',
  /** ADR 0007 §1: the candidate root is not independent of Spending seed S. */
  'ERR_VAULT_ROLE_NOT_INDEPENDENT',
  /** No import ceremony is open, or the stored challenge has expired. */
  'ERR_VAULT_IMPORT_SESSION_MISSING',
  /**
   * ADR 0007 §2: the peer record is malformed, is for the wrong role or
   * network, collides with a role already held, or its proof of possession does
   * not verify against this coordinator's own challenge. Deliberately one code:
   * telling a caller *which* of those failed is a free oracle over the policy.
   */
  'ERR_VAULT_SIGNER_REJECTED',
  /** No live offline Recovery C setup/backup challenge is stored. */
  'ERR_VAULT_RECOVERY_C_SESSION_MISSING',
  /** A Recovery C response is malformed, stale, replayed, or does not verify. */
  'ERR_VAULT_RECOVERY_C_RESPONSE_REJECTED',
  /** The public recovery kit must be saved and acknowledged before the paper check. */
  'ERR_VAULT_RECOVERY_C_KIT_REQUIRED',
  /** Policy funding and value-moving operations remain closed until the paper check passes. */
  'ERR_VAULT_RECOVERY_C_BACKUP_REQUIRED',
  /** A policy is already committed; replacing one is a separate ceremony. */
  'ERR_VAULT_POLICY_EXISTS',
  /** No usable policy is stored (absent, or present but unparseable). */
  'ERR_VAULT_POLICY_MISSING',
  /** The import is not yet complete, so no policy can be composed. */
  'ERR_VAULT_POLICY_INCOMPLETE',
  // ---- C4/C5/C6: the plan lifecycle ---------------------------------------
  /** No approved plan is stored, or the one named is not the stored one. */
  'ERR_VAULT_PLAN_MISSING',
  /**
   * The plan cannot be built or is outside what this build may move: the
   * ADR 0007 §8.1 pilot bound, an unspendable UTXO set, dust change. One code,
   * because the message carries the detail and the caller's action is the same
   * — build a different plan.
   */
  'ERR_VAULT_PLAN_REJECTED',
  /**
   * The plan's evidence window has closed. Its classification snapshot no
   * longer describes a chain state anyone has checked, so nothing may be signed
   * or sent against it and it must be rebuilt from a fresh scan.
   */
  'ERR_VAULT_PLAN_STALE',
  /**
   * This plan has already been sent. Re-broadcasting the same bytes is at best
   * a no-op and at worst hides a second, different transaction, so it refuses.
   */
  'ERR_VAULT_PLAN_ALREADY_BROADCAST',
  /**
   * A previous broadcast of this plan ended without a known outcome. The exact
   * bytes are kept for reconciliation and are never resent automatically; a
   * caller must establish what happened on chain first.
   */
  'ERR_VAULT_BROADCAST_INDETERMINATE',
] as const;
export type VaultCoordinatorErrorCode = (typeof VAULT_COORDINATOR_ERROR_CODES)[number];

// ---- schema helpers --------------------------------------------------------

/**
 * The networks a coordinator may report. The worker's compile-time capability,
 * not this schema or request data, decides which one this build has.
 */
const coordinatorNetwork = z.enum(['signet', 'mainnet']);

const hex = (bytes: number): z.ZodType<string> =>
  z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`, 'u'));

const canonicalBase64 = (minimumBytes: number, maximumBytes = minimumBytes): z.ZodType<string> =>
  z.string().refine((value) => {
    try {
      const bytes = base64ToBytes(value);
      return bytes.length >= minimumBytes && bytes.length <= maximumBytes &&
        bytesToBase64(bytes) === value;
    } catch {
      return false;
    }
  });

/** Canonical unsigned 64-bit decimal, matching core's SQVB object encoding. */
const decimalU64 = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/u)
  .refine((value) => BigInt(value) <= 0xffff_ffff_ffff_ffffn, 'unsigned 64-bit decimal required');

const sessionExpectation = {
  expectedVaultId: z.string().min(1),
  expectedSessionId: z.string().uuid(),
} as const;

/**
 * The public half of a signer origin. Structurally identical to core's
 * VaultSignerOriginV1 and re-validated against core's own schema in the worker;
 * restated here because a wire response schema must be self-contained and
 * `.strict()` at this boundary.
 */
const signerOrigin = z
  .object({
    version: z.literal(1),
    role: z.literal('desktop-a'),
    network: coordinatorNetwork,
    masterFingerprintHex: hex(4),
    originPath: z.string().min(1).max(64),
    accountXpub: z.string().min(1).max(128),
  })
  .strict();

const roleSummary = z
  .object({
    roleId: z.string().min(1).max(64),
    label: z.string().max(64),
    createdAt: z.number().int().nonnegative(),
    origin: signerOrigin,
  })
  .strict();

/**
 * Any of the three policy roles, for the records this coordinator imports and
 * displays rather than mints. Kept separate from `signerOrigin` above so the
 * role-A surface keeps its narrower literal: an op that answers about the
 * locally generated root should not accept a `mobile-b` shape at all.
 */
const policySignerOrigin = z
  .object({
    version: z.literal(1),
    role: z.enum(['desktop-a', 'mobile-b', 'recovery-c']),
    network: coordinatorNetwork,
    masterFingerprintHex: hex(4),
    originPath: z.string().min(1).max(64),
    accountXpub: z.string().min(1).max(128),
  })
  .strict();

/** The two roles this extension never stores (ADR 0007 §8, C scope). */
const importableRole = z.enum(['mobile-b', 'recovery-c']);

const policySummary = z
  .object({
    policyId: hex(32),
    network: coordinatorNetwork,
    policyVersion: z.literal(1),
    threshold: z.literal(2),
    createdAt: z.number().int().nonnegative(),
    vaultLabel: z.string().max(256),
    birthdayHeight: z.number().int().nonnegative().nullable(),
    signers: z.tuple([
      policySignerOrigin.extend({ label: z.string().max(256) }).strict(),
      policySignerOrigin.extend({ label: z.string().max(256) }).strict(),
      policySignerOrigin.extend({ label: z.string().max(256) }).strict(),
    ]),
    receiveDescriptor: z.string().min(1).max(2048),
    changeDescriptor: z.string().min(1).max(2048),
    /** The BIP380 checksums, restated so a human can compare them at a glance. */
    receiveChecksum: z.string().length(8),
    changeChecksum: z.string().length(8),
    /** Hidden until the Recovery C paper-restore gate makes funding safe. */
    firstReceiveAddress: z.string().min(1).max(128).nullable(),
  })
  .strict();

// ---- request schemas -------------------------------------------------------

const statusRequest = z.object(sessionExpectation).strict();

const createRoleRequest = z
  .object({ password: z.string().min(1), label: z.string().max(64), ...sessionExpectation })
  .strict();

/**
 * Put a previously revealed role A back (ADR 0007 §1, Workstream R1).
 *
 * Deliberately the same shape as `createRoleRequest` plus the words, because
 * the two ceremonies must have the same posture: reauthentication, the same
 * §1 independence checks against Spending seed S, the same refusal when a role
 * already exists. The only difference is where the entropy came from.
 *
 * Checksum-validated here so a mistyped phrase is a typed `ERR_INVALID_PAYLOAD`
 * at the boundary rather than an opaque internal error, exactly as core's
 * `vault.restore` does it.
 *
 * There is no passphrase field, and that is a decision rather than an omission.
 * `createRole` generates words with no passphrase and `revealRole` returns only
 * words, so a passphrase-bearing restore would mint a role whose sanctioned
 * backup path could not reproduce it — a role that looks recoverable and is not.
 */
const restoreRoleRequest = z
  .object({
    password: z.string().min(1),
    label: z.string().max(64),
    mnemonic: z.string().refine(validateMnemonic, { message: 'invalid BIP39 mnemonic' }),
    ...sessionExpectation,
  })
  .strict();

const roleOriginRequest = z.object(sessionExpectation).strict();

/**
 * A proof-of-possession challenge supplied by the verifying peer. The
 * coordinator never invents its own challenge for an outbound proof: a
 * self-chosen nonce proves nothing to anyone else.
 */
const proveRoleRequest = z
  .object({
    password: z.string().min(1),
    sessionIdHex: hex(16),
    challengeNonceHex: hex(32),
    transcriptHashHex: hex(32),
    expiresAtMs: decimalU64,
    ...sessionExpectation,
  })
  .strict();

const revealRoleRequest = z
  .object({ password: z.string().min(1), ...sessionExpectation })
  .strict();

/**
 * Mints the single-use worker challenge for a Role A recovery export.
 */
const beginRoleRecoveryExportRequest = z.object(sessionExpectation).strict();

/** One fresh, password-authorized WebAuthn ceremony creates the package. */
const exportRoleRecoveryRequest = z.object({
  password: z.string().min(1),
  credentialIdB64: canonicalBase64(16, 1023),
  prfSaltB64: canonicalBase64(PASSKEY_PRF_SALT_BYTES),
  prfOutputB64: canonicalBase64(PASSKEY_PRF_OUTPUT_BYTES),
  assertionClientDataJSONB64: canonicalBase64(1, 4096),
  assertionAuthenticatorDataB64: canonicalBase64(37, 2048),
  assertionSignatureB64: canonicalBase64(8, 2048),
  ...sessionExpectation,
}).strict();

const removeRoleRequest = z
  .object({
    password: z.string().min(1),
    /** Must equal the stored roleId: removing a signing root is not a misclick. */
    roleId: z.string().min(1).max(64).optional(),
    /**
     * Discard a stored value that does not parse. It has no readable roleId to
     * restate, so it gets its own explicit intent instead of a weaker check on
     * the normal path.
     */
    purgeUnusable: z.boolean().optional(),
    ...sessionExpectation,
  })
  .strict()
  .refine((req) => (req.roleId !== undefined) !== (req.purgeUnusable === true), {
    message: 'exactly one of roleId or purgeUnusable must be given',
  });

const beginImportRequest = z.object({
  /** Optional canonical Mobile B origin: when present, return the real QR
   * proof-input challenge for that exact signer. */
  mobileOriginHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u).max(4096).optional(),
  /** Required only when Desktop A signs the Mobile B challenge envelope. */
  password: z.string().min(1).optional(),
  ...sessionExpectation,
}).strict().refine((request) => request.mobileOriginHex === undefined || request.password !== undefined, {
  message: 'password is required to authenticate a Mobile B pairing challenge',
});

const beginRecoveryCSetupRequest = z.object(sessionExpectation).strict();
const importRecoveryCSetupResponseRequest = z.object({
  responseHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u).max(131_072),
  ...sessionExpectation,
}).strict();
const cancelRecoveryCSetupRequest = z.object(sessionExpectation).strict();

/**
 * One peer signer, as the two complete SQVB records core defines: the type-1
 * signer origin and the type-3 proof result. Binary rather than a field-by-field
 * object on purpose — the bytes the peer signed are the bytes we verify, so
 * there is no room for a re-serialization to change what was proven.
 */
const importSignerRequest = z
  .object({
    role: importableRole,
    originHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u).max(4096),
    proofResultHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u).max(4096),
    originEnvelope: vaultPairingEnvelopeSchema.optional(),
    proofEnvelope: vaultPairingEnvelopeSchema.optional(),
    ...sessionExpectation,
  })
  .strict();

const createPolicyRequest = z
  .object({
    // ADR 0007 §2: committing the policy re-proves that the stored role A
    // record actually holds the key its public origin advertises, which needs
    // the seed and therefore a fresh reauthentication.
    password: z.string().min(1),
    vaultLabel: z.string().max(256),
    signerLabels: z.tuple([
      z.string().max(256),
      z.string().max(256),
      z.string().max(256),
    ]),
    birthdayHeight: z.number().int().nonnegative().max(0xffff_ffff).nullable(),
    ...sessionExpectation,
  })
  .strict();

const policyRequest = z.object(sessionExpectation).strict();

const recoveryKitRequest = z.object(sessionExpectation).strict();
const acknowledgeRecoveryKitExportRequest = z.object({
  policyId: hex(32),
  ...sessionExpectation,
}).strict();
const beginRecoveryCBackupCheckRequest = z.object(sessionExpectation).strict();
const importRecoveryCBackupCheckResponseRequest = z.object({
  responseHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u).max(131_072),
  ...sessionExpectation,
}).strict();
const recoveryCReadinessRequest = z.object(sessionExpectation).strict();

/**
 * ADR 0007 §2: this erases a local watch-only record. It is not cryptographic
 * revocation and it does not rotate anything on chain — the descriptors it
 * forgets still describe whatever those addresses hold. The policyId must be
 * restated for exactly the reason the roleId must be on `removeRole`.
 */
/**
 * Refresh the Vault's classified UTXO state from the gateway.
 *
 * There is no cached-read variant: a Vault balance is only meaningful next to
 * the evidence that justified it, and serving a stale set without re-verifying
 * its source is exactly the guess ADR 0007 §7 forbids. The response therefore
 * always carries the refusal, if any, alongside whatever it could show.
 */
const scanRequest = z.object(sessionExpectation).strict();

const utxoRefusal = z.enum([
  'degraded',
  'classification_incomplete',
  'rare_sat',
  'unsupported_asset',
  'mixed_or_unknown',
  'user_frozen',
  'dust_quarantined',
  'unconfirmed',
]);

const scanResult = z
  .object({
    /**
     * Non-null means the Vault is read-only: the balance below, if any, is the
     * last thing that could be verified and nothing may be built from it.
     */
    refusal: z
      .enum([
        'gateway_unavailable',
        'capabilities_insufficient',
        'conflicting_source',
        'stale_evidence',
        'scan_incomplete',
      ])
      .nullable(),
    scannedAt: z.number().int().nonnegative().nullable(),
    balance: z
      .object({
        totalSats: decimalU64,
        movableSats: decimalU64,
        immovableSats: decimalU64,
        inscriptionCount: z.number().int().nonnegative(),
      })
      .nullable(),
    tip: z.object({ height: z.number().int().nonnegative(), hash: hex(32) }).nullable(),
    utxos: z
      .array(
        z
          .object({
            txid: hex(32),
            vout: z.number().int().nonnegative(),
            valueSats: decimalU64,
            branch: z.enum(['receive', 'change']),
            derivationIndex: z.number().int().nonnegative(),
            confirmations: z.number().int().nonnegative(),
            primaryClass: z.enum([
              'cardinal_clean',
              'inscribed',
              'rare_sat',
              'runic_or_unsupported',
              'mixed',
              'unknown',
            ]),
            inscriptionCount: z.number().int().nonnegative(),
            /** Null means this output may take part in a movement. */
            refusal: utxoRefusal.nullable(),
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict();

// ---- C4/C5/C6: deposit, plan, transport, signing, broadcast ---------------

/**
 * Prove a deposit destination is Vault-owned (ADR 0007 §7, C3).
 *
 * A deposit is not a Vault plan and never can be: every `VaultPlanInputV1`
 * needs a witness script and is proved Vault-owned, and the inputs of a deposit
 * belong to the Spending wallet. All the Vault contributes is an address it can
 * prove is its own by regenerating it from the committed policy.
 */
const depositAddressRequest = z
  .object({ index: z.number().int().nonnegative().max(0xffff), ...sessionExpectation })
  .strict();

const depositAddressResult = z
  .object({
    address: z.string().min(1).max(128),
    scriptPubKeyHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u),
    branch: z.literal('receive'),
    index: z.number().int().nonnegative(),
  })
  .strict();

/**
 * Build a withdrawal to the paired Spending wallet.
 *
 * There is deliberately no destination field. ADR 0007 §8.1 restricts the pilot
 * to the paired Spending wallet and requires that to be proved by regeneration
 * rather than by comparing strings, so the worker derives the destination from
 * the active Spending seed and the caller cannot name one at all. A field a
 * caller cannot set is a field a caller cannot get wrong.
 */
const buildPlanRequest = z
  .object({
    movement: z.enum(['cardinal', 'inscription']).optional(),
    amountSats: decimalU64.optional(),
    inscriptionId: z.string().regex(/^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/u).optional(),
    feeRateSatPerKvB: decimalU64,
    ...sessionExpectation,
  })
  .strict()
  .superRefine((value, ctx) => {
    const movement = value.movement ?? 'cardinal';
    if (movement === 'cardinal' && value.amountSats === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amountSats'], message: 'cardinal amount required' });
    }
    if (movement === 'inscription' && value.inscriptionId === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['inscriptionId'], message: 'inscription ID required' });
    }
    if (movement === 'cardinal' && value.inscriptionId !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['inscriptionId'], message: 'cardinal plan cannot name an inscription' });
    }
    if (movement === 'inscription' && value.amountSats !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['amountSats'], message: 'inscription postage is fixed by its UTXO' });
    }
  });

const buildCpfpRequest = z.object({
  feeRateSatPerKvB: decimalU64,
  ...sessionExpectation,
}).strict();

const planSummary = z
  .object({
    planId: hex(16),
    planDigest: hex(32),
    policyId: hex(32),
    network: coordinatorNetwork,
    kind: z.literal('withdrawal'),
    replacement: z.enum(['none', 'rbf', 'cpfp']),
    /** The regenerated paired-Spending address, for review before signing. */
    destinationAddress: z.string().min(1).max(128),
    amountSats: decimalU64,
    changeSats: decimalU64,
    feeSats: decimalU64,
    feeRateSatPerKvB: decimalU64,
    vsize: z.number().int().positive(),
    inputCount: z.number().int().positive(),
    outputs: z.array(z.object({
      outputIndex: z.number().int().nonnegative(),
      purpose: z.enum(['paired-spending', 'vault-change', 'vault-rotation', 'recovery-exit']),
      valueSats: decimalU64,
      address: z.string().min(1).max(128),
    }).strict()).min(1),
    assetEffects: z.array(z.object({
      kind: z.enum(['cardinal', 'inscription', 'rare-sat', 'rune', 'unsupported']),
      assetId: z.string(),
      protected: z.boolean(),
    }).strict()),
    createdAtMs: decimalU64,
    /** When the evidence behind this plan stops describing a checked chain. */
    expiresAtMs: decimalU64,
  })
  .strict();

/** What happened to a plan after it left the coordinator (C6). */
const planBroadcast = z
  .object({
    txid: hex(32),
    status: z.enum([
      'accepted',
      'already_known',
      'confirmed',
      'conflicted',
      'rejected',
      /** The gateway answered without a usable outcome, or did not answer. */
      'indeterminate',
    ]),
    detail: z.string().max(512).nullable(),
    at: z.number().int().nonnegative(),
  })
  .strict();

const buildPlanResult = z
  .object({
    plan: planSummary,
    /** The unsigned PSBT to review before Desktop A authorizes transport. */
    psbtHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u),
  })
  .strict();

const planRequest = z.object(sessionExpectation).strict();

const mobileResponseResult = z.object({
  approvalContextQrFrames: z.array(z.string().startsWith('ur:x-drey-vault/')).min(1).max(256),
  psbtQrFrames: z.array(z.string().startsWith('ur:psbt/')).min(1).max(4096),
}).strict();

const planResult = z
  .object({
    plan: planSummary.nullable(),
    psbtHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u).nullable(),
    combinedPsbtHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u).nullable(),
    /** True once the evidence window has closed; nothing may act on it. */
    stale: z.boolean(),
    broadcast: planBroadcast.nullable(),
    /** Durable exact bytes and one-way posture survive worker/UI restarts. */
    transactionHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u).nullable(),
    txid: hex(32).nullable(),
    broadcastPosture: z.enum(['none', 'safe-to-dispatch-once', 'reconcile-only', 'terminal']),
    /** Last exact Desktop response to a Mobile-owned plan, if any. */
    mobileResponse: mobileResponseResult.nullable(),
  })
  .strict();

/** Role A's own record is separately encrypted, so signing reauthenticates. */
const signPlanRequest = z
  .object({ password: z.string().min(1), ...sessionExpectation })
  .strict();

const signPlanResult = z
  .object({
    roleAdded: z.literal('desktop-a'),
    /** The PSBT carrying this coordinator's signature, for the peer. */
    signedPsbtHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u),
    /** The complete SQVB type-6 record, for a transport that carries envelopes. */
    resultHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u),
    approvalContextQrFrames: z.array(z.string().startsWith('ur:x-drey-vault/')).min(1).max(256),
    psbtQrFrames: z.array(z.string().startsWith('ur:psbt/')).min(1).max(4096),
  })
  .strict();

const signMobileRequestRequest = z.object({
  password: z.string().min(1),
  approvalEnvelope: vaultPsbtApprovalEnvelopeSchema,
  psbtHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u).max(200_000),
  ...sessionExpectation,
}).strict();

const signMobileRequestResult = mobileResponseResult;

/**
 * Combine signed PSBTs into a quorum.
 *
 * Plain PSBT hex, not the SQVB envelope, because the PSBT is the signing truth
 * and the envelope is transport: a third-party signer returns a PSBT and
 * nothing else. Asset safety does not come from the envelope — the worker runs
 * the full B3 validator over every incoming PSBT before the combiner sees it.
 */
const combinePlanRequest = z
  .object({
    psbtHexes: z
      .array(z.string().regex(/^(?:[0-9a-f]{2})+$/u).max(200_000))
      .min(2)
      .max(3),
    /** Required for the production Mobile B QR return. The worker binds the
     * signed PSBT to the durable channel, monotonic counter and exact plan. */
    mobileApprovalEnvelope: vaultPsbtApprovalEnvelopeSchema.optional(),
    ...sessionExpectation,
  })
  .strict();

const combinePlanResult = z
  .object({
    psbtHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u),
    roles: z.array(z.enum(['desktop-a', 'mobile-b', 'recovery-c'])).min(2).max(3),
  })
  .strict();

const finalizePlanRequest = z
  .object({
    psbtHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u).max(200_000),
    ...sessionExpectation,
  })
  .strict();

const finalizePlanResult = z
  .object({
    transactionHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u),
    txid: hex(32),
    wtxid: hex(32),
    vsize: z.number().int().positive(),
    roles: z.array(z.enum(['desktop-a', 'mobile-b', 'recovery-c'])).length(2),
  })
  .strict();

/**
 * Send a finalized transaction (C6).
 *
 * The bytes are supplied so the caller broadcasts exactly what it reviewed, and
 * the worker re-derives the txid from them and re-finalizes from the stored
 * plan before sending — a transaction that is not this plan's is not sent.
 */
const broadcastPlanRequest = z
  .object({
    transactionHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u).max(200_000),
    ...sessionExpectation,
  })
  .strict();

const discardPlanRequest = z
  .object({ planId: hex(16), ...sessionExpectation })
  .strict();

const reconcilePlanRequest = discardPlanRequest;

const removePolicyRequest = z
  .object({ password: z.string().min(1), policyId: hex(32).optional(), purgeUnusable: z.boolean().optional(), ...sessionExpectation })
  .strict()
  .refine((req) => (req.policyId !== undefined) !== (req.purgeUnusable === true), {
    message: 'exactly one of policyId or purgeUnusable must be given',
  });

// ---- response schemas ------------------------------------------------------

const statusResult = z
  .object({
    /** Whether this build has a coordinator at all. */
    available: z.boolean(),
    network: coordinatorNetwork.nullable(),
    /**
     * What this build may move. `full` is signet test authority,
     * `production-mainnet` is reviewed mainnet authority, and `unsigned-only`
     * can inspect and plan but never sign.
     */
    movement: z.enum(['full', 'unsigned-only', 'production-mainnet']).nullable(),
    /**
     * Retained as a nullable compatibility field for older UIs. Production has
     * no temporary coded monetary ceiling, so this is always null.
     */
    bound: z
      .object({ maxTransferSats: decimalU64, maxFeeRateSatPerKvB: decimalU64 })
      .strict()
      .nullable(),
    /** `unusable` means a stored value exists but does not parse; it is never auto-deleted. */
    role: z.enum(['absent', 'present', 'unusable']),
    /** Same three states for the committed watch-only policy (C1). */
    policy: z.enum(['absent', 'present', 'unusable']),
    /** Whether an import ceremony is open, and which peer roles it still wants. */
    importPending: z.array(importableRole).max(2),
  })
  .strict();

const roleOriginResult = z.object({ role: roleSummary.nullable() }).strict();

const createRoleResult = z.object({ role: roleSummary }).strict();

/**
 * Identical to `createRoleResult`, and restated rather than aliased so the two
 * cannot drift: a restore that reported a different shape from a creation would
 * be the first hint that it had produced a different role.
 */
const restoreRoleResult = z.object({ role: roleSummary }).strict();

const proveRoleResult = z
  .object({
    role: z.literal('desktop-a'),
    inputDigestHex: hex(32),
    proofPublicKeyHex: z.string().regex(/^(?:02|03)[0-9a-f]{64}$/u),
    signatureHex: hex(64),
    scheme: z.literal('secp256k1-ecdsa-compact-low-s-v1'),
    /** The complete SQVB type-3 record, ready for any transport adapter. */
    resultHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u),
  })
  .strict();

/** The first of the two sanctioned secret-bearing responses (module header). */
const revealRoleResult = z.object({ mnemonic: z.string().min(1) }).strict();

const beginRoleRecoveryExportResult = z.object({
  challengeB64: canonicalBase64(32),
}).strict();

const exportRoleRecoveryResult = z.object({
  packageJson: z.string().min(1).max(262_144),
  fileName: z.literal('drey-vault-role-a-recovery.json'),
  credentialIdB64: canonicalBase64(16, 1023),
  rpOrigin: z.string().regex(/^chrome-extension:\/\/[a-p]{32}$/u),
}).strict();

const removeRoleResult = z.object({ removed: z.boolean() }).strict();

/**
 * The challenge a peer must sign. Every field is minted here: a self-chosen
 * nonce proves nothing to anyone else, and a peer-chosen one proves nothing to
 * us.
 */
const beginImportResult = z
  .object({
    sessionIdHex: hex(16),
    challengeNonceHex: hex(32),
    transcriptHashHex: hex(32),
    expiresAtMs: decimalU64,
    imported: z.array(importableRole).max(2),
    pending: z.array(importableRole).max(2),
    challengeQrFrames: z.array(z.string().startsWith('ur:x-drey-vault/')).max(256).nullable(),
  })
  .strict();

const recoveryCChallengeResult = z.object({
  challengeHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u).max(131_072),
  challengeDigestHex: hex(32),
  fingerprint: z.string().regex(/^[0-9a-f]{4}(?:-[0-9a-f]{4}){3}$/u),
  network: coordinatorNetwork,
  expiresAtMs: decimalU64,
  fileName: z.string().min(1).max(128),
}).strict();

const importSignerResult = z
  .object({
    role: importableRole,
    origin: policySignerOrigin,
    imported: z.array(importableRole).max(2),
    pending: z.array(importableRole).max(2),
    /** True once both peer roles are held and a policy can be composed. */
    complete: z.boolean(),
  })
  .strict();

const recoveryCReadinessResult = z.object({
  state: z.enum([
    'not_started', 'setup_open', 'setup_complete', 'kit_required', 'backup_required',
    'backup_open', 'ready', 'unusable',
  ]),
  policyId: hex(32).nullable(),
  setupComplete: z.boolean(),
  kitExported: z.boolean(),
  backupCheckComplete: z.boolean(),
  ready: z.boolean(),
}).strict();

const acknowledgeRecoveryKitExportResult = z.object({
  policyId: hex(32),
  kitExported: z.literal(true),
}).strict();

const recoveryCBackupCheckResult = z.object({
  policyId: hex(32),
  completed: z.literal(true),
}).strict();

const createPolicyResult = z.object({
  policy: policySummary,
  /** Authenticated response carrying the exact committed policy to Mobile B. */
  policyQrFrames: z.array(z.string().startsWith('ur:x-drey-vault/')).min(1).max(256),
}).strict();

const policyResult = z
  .object({
    /** `unusable` means a stored policy exists but does not parse. */
    state: z.enum(['absent', 'present', 'unusable']),
    policy: policySummary.nullable(),
  })
  .strict();

/**
 * ADR 0007 §6. Non-spending but highly privacy-sensitive: it names every xpub
 * and both descriptors. It must never contain S, A, B, C, an xprv, passkey
 * material, or C's words — the worker builds it from public records only.
 */
const recoveryKitResult = z
  .object({
    kit: z
      .object({
        version: z.literal(1),
        network: coordinatorNetwork,
        policyVersion: z.literal(1),
        policyId: hex(32),
        signers: z.tuple([policySignerOrigin, policySignerOrigin, policySignerOrigin]),
        receiveDescriptor: z.string().min(1).max(2048),
        changeDescriptor: z.string().min(1).max(2048),
        createdAtMs: decimalU64,
        birthdayHeight: z.number().int().nonnegative().nullable(),
        vaultLabel: z.string().max(256),
        signerLabels: z.tuple([
          z.string().max(256),
          z.string().max(256),
          z.string().max(256),
        ]),
        firstReceiveAddress: z.string().min(1).max(128),
        compatibilityRequirements: z.array(z.string().min(1).max(256)).min(1).max(32),
        minimumReaderVersion: z.literal(1),
        standaloneToolSourceDigest: hex(32),
        standaloneToolArtifactDigest: hex(32),
        recoveryInstructions: z.string().min(1).max(4096),
        rotationInstructions: z.string().min(1).max(4096),
        recoveryInstructionsVersion: z.literal(1),
      })
      .strict(),
    /** The complete SQVB type-10 record, ready for any transport adapter. */
    kitHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u),
    /**
     * Whether the standalone recovery tool digests are real. False for a build
     * that carries the all-zero sentinel, so the UI says the
     * provider-independent exit is not yet publishable rather than implying a
     * verified digest.
     */
    standaloneToolPublished: z.boolean(),
    /**
     * The core release the digests above were produced from. Carried on the
     * response rather than imported by the UI, so an approval surface never
     * reaches into background modules for a value a user is asked to act on —
     * and so a digest is never displayed without the revision that reproduces
     * it, which alone would be unverifiable.
     */
    standaloneToolCoreTag: z.string().regex(/^v\d+\.\d+\.\d+$/u),
  })
  .strict();

// ---- registry --------------------------------------------------------------

export const VAULT_COORDINATOR_OP_SCHEMAS = {
  // Every op requires an unlocked session: the §7.5 locked-privacy gate applies
  // to the Vault surface exactly as it does to the Spending wallet. Unlike
  // passkey.challenge there is no locked-screen consumer, so nothing here needs
  // to answer before unlock — the UI decides whether to offer the surface from
  // the compile-time channel flag alone.
  'vaultCoordinator.status': {
    request: statusRequest,
    response: statusResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  // ADR 0007 §1: generating a Vault root is a signing-material ceremony, so it
  // takes password reauthentication — which the worker also needs in order to
  // open the Spending payload and run the independence checks against S.
  'vaultCoordinator.createRole': {
    request: createRoleRequest,
    response: createRoleResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  // ADR 0007 §1 (Workstream R1): the counterpart of `revealRole`. Role A is
  // otherwise generation-only, so a browser-profile wipe would destroy one of
  // three roles with no single seed phrase to fall back on. Same posture as
  // creation: password reauthentication, the same independence checks, and a
  // refusal when any role is already stored.
  'vaultCoordinator.restoreRole': {
    request: restoreRoleRequest,
    response: restoreRoleResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.roleOrigin': {
    request: roleOriginRequest,
    response: roleOriginResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  // Needs the private key, therefore needs the password.
  'vaultCoordinator.proveRole': {
    request: proveRoleRequest,
    response: proveRoleResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  // ADR 0007 §5: password reauthentication is required for any root reveal.
  'vaultCoordinator.revealRole': {
    request: revealRoleRequest,
    response: revealRoleResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.beginRoleRecoveryExport': {
    request: beginRoleRecoveryExportRequest,
    response: beginRoleRecoveryExportResult,
    allowedSenders: ['fullpage'],
    requiresUnlock: true,
  },
  'vaultCoordinator.exportRoleRecovery': {
    request: exportRoleRecoveryRequest,
    response: exportRoleRecoveryResult,
    allowedSenders: ['fullpage'],
    requiresUnlock: true,
  },
  // ADR 0007 §2: deleting a local copy is not cryptographic revocation. This
  // erases a disposable signet role; it never rotates a policy.
  'vaultCoordinator.removeRole': {
    request: removeRoleRequest,
    response: removeRoleResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  // ---- C1: importing peer roles and committing a watch-only policy ---------
  //
  // No password: nothing below `createPolicy` touches a secret. Importing a
  // peer origin and verifying its proof of possession are pure public-key
  // operations over records the peer chose to hand over.
  'vaultCoordinator.beginImport': {
    request: beginImportRequest,
    response: beginImportResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.beginRecoveryCSetup': {
    request: beginRecoveryCSetupRequest,
    response: recoveryCChallengeResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.importRecoveryCSetupResponse': {
    request: importRecoveryCSetupResponseRequest,
    response: importSignerResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.cancelRecoveryCSetup': {
    request: cancelRecoveryCSetupRequest,
    response: z.object({ cancelled: z.literal(true) }).strict(),
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.importSigner': {
    request: importSignerRequest,
    response: importSignerResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.createPolicy': {
    request: createPolicyRequest,
    response: createPolicyResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.policy': {
    request: policyRequest,
    response: policyResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.recoveryKit': {
    request: recoveryKitRequest,
    response: recoveryKitResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.acknowledgeRecoveryKitExport': {
    request: acknowledgeRecoveryKitExportRequest,
    response: acknowledgeRecoveryKitExportResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.beginRecoveryCBackupCheck': {
    request: beginRecoveryCBackupCheckRequest,
    response: recoveryCChallengeResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.importRecoveryCBackupCheckResponse': {
    request: importRecoveryCBackupCheckResponseRequest,
    response: recoveryCBackupCheckResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.recoveryCReadiness': {
    request: recoveryCReadinessRequest,
    response: recoveryCReadinessResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.removePolicy': {
    request: removePolicyRequest,
    response: removeRoleResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  // ---- C2: classified UTXO state from independently verified evidence -----
  'vaultCoordinator.scan': {
    request: scanRequest,
    response: scanResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  // ---- C3/C4/C5/C6: the plan lifecycle ------------------------------------
  //
  // No password below except on `signPlan`. Building, combining, finalizing,
  // and broadcasting touch no secret: they operate on a plan, on PSBTs, and on
  // public policy material. Only adding role A's own signature opens role A's
  // separately encrypted record, so only that one reauthenticates.
  'vaultCoordinator.depositAddress': {
    request: depositAddressRequest,
    response: depositAddressResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.buildPlan': {
    request: buildPlanRequest,
    response: buildPlanResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.buildCpfp': {
    request: buildCpfpRequest,
    response: buildPlanResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.plan': {
    request: planRequest,
    response: planResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.signPlan': {
    request: signPlanRequest,
    response: signPlanResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.signMobileRequest': {
    request: signMobileRequestRequest,
    response: signMobileRequestResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.combinePlan': {
    request: combinePlanRequest,
    response: combinePlanResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.finalizePlan': {
    request: finalizePlanRequest,
    response: finalizePlanResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.broadcastPlan': {
    request: broadcastPlanRequest,
    response: planBroadcast,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.reconcilePlan': {
    request: reconcilePlanRequest,
    response: planBroadcast,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'vaultCoordinator.discardPlan': {
    request: discardPlanRequest,
    response: removeRoleResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
} satisfies Record<string, OpSpec>;

export type VaultCoordinatorOp = keyof typeof VAULT_COORDINATOR_OP_SCHEMAS;

export type VaultCoordinatorStatusRequest = z.infer<typeof statusRequest>;
export type VaultCoordinatorStatusResult = z.infer<typeof statusResult>;
export type VaultCoordinatorCreateRoleRequest = z.infer<typeof createRoleRequest>;
export type VaultCoordinatorCreateRoleResult = z.infer<typeof createRoleResult>;
export type VaultCoordinatorRestoreRoleRequest = z.infer<typeof restoreRoleRequest>;
export type VaultCoordinatorRestoreRoleResult = z.infer<typeof restoreRoleResult>;
export type VaultCoordinatorRoleOriginRequest = z.infer<typeof roleOriginRequest>;
export type VaultCoordinatorRoleOriginResult = z.infer<typeof roleOriginResult>;
export type VaultCoordinatorProveRoleRequest = z.infer<typeof proveRoleRequest>;
export type VaultCoordinatorProveRoleResult = z.infer<typeof proveRoleResult>;
export type VaultCoordinatorRevealRoleRequest = z.infer<typeof revealRoleRequest>;
export type VaultCoordinatorBeginRoleRecoveryExportRequest = z.infer<typeof beginRoleRecoveryExportRequest>;
export type VaultCoordinatorBeginRoleRecoveryExportResult = z.infer<typeof beginRoleRecoveryExportResult>;
export type VaultCoordinatorExportRoleRecoveryRequest = z.infer<typeof exportRoleRecoveryRequest>;
export type VaultCoordinatorExportRoleRecoveryResult = z.infer<typeof exportRoleRecoveryResult>;
export type VaultCoordinatorRemoveRoleRequest = z.infer<typeof removeRoleRequest>;
export type VaultCoordinatorBeginImportRequest = z.infer<typeof beginImportRequest>;
export type VaultCoordinatorBeginImportResult = z.infer<typeof beginImportResult>;
export type VaultCoordinatorBeginRecoveryCSetupRequest = z.infer<typeof beginRecoveryCSetupRequest>;
export type VaultCoordinatorRecoveryCChallengeResult = z.infer<typeof recoveryCChallengeResult>;
export type VaultCoordinatorImportRecoveryCSetupResponseRequest = z.infer<typeof importRecoveryCSetupResponseRequest>;
export type VaultCoordinatorCancelRecoveryCSetupRequest = z.infer<typeof cancelRecoveryCSetupRequest>;
export type VaultCoordinatorImportSignerRequest = z.infer<typeof importSignerRequest>;
export type VaultCoordinatorImportSignerResult = z.infer<typeof importSignerResult>;
export type VaultCoordinatorCreatePolicyRequest = z.infer<typeof createPolicyRequest>;
export type VaultCoordinatorCreatePolicyResult = z.infer<typeof createPolicyResult>;
export type VaultCoordinatorPolicyRequest = z.infer<typeof policyRequest>;
export type VaultCoordinatorPolicyResult = z.infer<typeof policyResult>;
export type VaultCoordinatorPolicySummary = z.infer<typeof policySummary>;
export type VaultCoordinatorRecoveryKitRequest = z.infer<typeof recoveryKitRequest>;
export type VaultCoordinatorRecoveryKitResult = z.infer<typeof recoveryKitResult>;
export type VaultCoordinatorAcknowledgeRecoveryKitExportRequest = z.infer<typeof acknowledgeRecoveryKitExportRequest>;
export type VaultCoordinatorBeginRecoveryCBackupCheckRequest = z.infer<typeof beginRecoveryCBackupCheckRequest>;
export type VaultCoordinatorImportRecoveryCBackupCheckResponseRequest = z.infer<typeof importRecoveryCBackupCheckResponseRequest>;
export type VaultCoordinatorRecoveryCReadinessRequest = z.infer<typeof recoveryCReadinessRequest>;
export type VaultCoordinatorRecoveryCReadinessResult = z.infer<typeof recoveryCReadinessResult>;
export type VaultCoordinatorRemovePolicyRequest = z.infer<typeof removePolicyRequest>;
export type VaultCoordinatorScanRequest = z.infer<typeof scanRequest>;
export type VaultCoordinatorScanResult = z.infer<typeof scanResult>;
export type VaultCoordinatorDepositAddressRequest = z.infer<typeof depositAddressRequest>;
export type VaultCoordinatorDepositAddressResult = z.infer<typeof depositAddressResult>;
export type VaultCoordinatorBuildPlanRequest = z.infer<typeof buildPlanRequest>;
export type VaultCoordinatorBuildPlanResult = z.infer<typeof buildPlanResult>;
export type VaultCoordinatorBuildCpfpRequest = z.infer<typeof buildCpfpRequest>;
export type VaultCoordinatorPlanRequest = z.infer<typeof planRequest>;
export type VaultCoordinatorPlanResult = z.infer<typeof planResult>;
export type VaultCoordinatorPlanSummary = z.infer<typeof planSummary>;
export type VaultCoordinatorPlanBroadcast = z.infer<typeof planBroadcast>;
export type VaultCoordinatorSignPlanRequest = z.infer<typeof signPlanRequest>;
export type VaultCoordinatorSignPlanResult = z.infer<typeof signPlanResult>;
export type VaultCoordinatorSignMobileRequestRequest = z.infer<typeof signMobileRequestRequest>;
export type VaultCoordinatorSignMobileRequestResult = z.infer<typeof signMobileRequestResult>;
export type VaultCoordinatorCombinePlanRequest = z.infer<typeof combinePlanRequest>;
export type VaultCoordinatorCombinePlanResult = z.infer<typeof combinePlanResult>;
export type VaultCoordinatorFinalizePlanRequest = z.infer<typeof finalizePlanRequest>;
export type VaultCoordinatorFinalizePlanResult = z.infer<typeof finalizePlanResult>;
export type VaultCoordinatorBroadcastPlanRequest = z.infer<typeof broadcastPlanRequest>;
export type VaultCoordinatorReconcilePlanRequest = z.infer<typeof reconcilePlanRequest>;
export type VaultCoordinatorDiscardPlanRequest = z.infer<typeof discardPlanRequest>;
