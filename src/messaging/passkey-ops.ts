/**
 * Extension-local passkey op registry (ADR 0007 §5, Workstream A2).
 *
 * These ops are deliberately NOT part of @drey/core's OP_SCHEMAS: WebAuthn PRF
 * unlock is a Chromium-extension capability bound to the extension's RP origin
 * (A0 identity decision), with no mobile equivalent — mobile biometric unlock
 * will be its own platform surface. Core's envelope leaves `op` an open string
 * and the dispatcher accepts any OpRegistry, so the extension owns this
 * surface end to end without widening the shared protocol.
 *
 * Secrecy rules match core's registry: no response schema carries a secret.
 * Requests may carry reauthentication material exactly like vault.unlock
 * carries the password — passkey.enroll and passkey.unlock carry the raw PRF
 * output (KEK input keying material, base64) from the extension page that ran
 * the WebAuthn ceremony to the worker, which is the only place the DEK is
 * wrapped or unwrapped. PRF output never derives signing material and is
 * zeroized by both ends after use (spec §7.7).
 */
import { z } from 'zod';
import { base64ToBytes, bytesToBase64 } from '@drey/core/domain/vault/encoding';
import {
  PASSKEY_PRF_OUTPUT_BYTES,
  PASSKEY_PRF_SALT_BYTES,
} from '@drey/core/domain/vault/passkey-envelope';
import type { SenderContext } from '@drey/core/messaging/envelope';
import type { OpSpec } from '@drey/core/messaging/ops';

// Core does not export its ordinary wallet-surface sender list; keep the
// dedicated approval window on its exact bound Port rather than this RPC set.
const TRUSTED_SENDERS: readonly SenderContext[] = [
  'popup', 'sidepanel', 'fullpage', 'onboarding',
];

// ---- extension-local wire error codes --------------------------------------

/**
 * A2 caller-facing codes for the three A1 passkey VaultError codes plus the
 * channel/enrollment availability gate. They live outside core's ErrorCode
 * enum because they can only be raised by these extension-local ops; the
 * extension-owned dispatcher, rpc client, and UI mapping all speak the widened
 * union. If a passkey VaultError ever leaked through a core op, the client's
 * core-enum validation would degrade it to ERR_INTERNAL — fail closed.
 */
export const PASSKEY_ERROR_CODES = [
  'ERR_PASSKEY_IDENTITY_MISMATCH',
  'ERR_PASSKEY_INVALID_PRF',
  'ERR_PASSKEY_DUPLICATE',
  'ERR_PASSKEY_UNAVAILABLE',
] as const;
export type PasskeyErrorCode = (typeof PASSKEY_ERROR_CODES)[number];

// ---- schema helpers --------------------------------------------------------

/**
 * Canonical padded Base64 of an exact byte length. atob() is forgiving, so
 * without the round-trip check one byte string would have many accepted
 * spellings — the same aliasing the core envelope schema rejects.
 */
const canonicalBase64 = (byteLength: number): z.ZodType<string> =>
  z.string().refine((value) => {
    try {
      const bytes = base64ToBytes(value);
      return bytes.length === byteLength && bytesToBase64(bytes) === value;
    } catch {
      return false;
    }
  });

/** Canonical padded Base64 whose decoded length falls in [min, max] bytes. */
const canonicalBase64Bounded = (minBytes: number, maxBytes: number): z.ZodType<string> =>
  z.string().refine((value) => {
    try {
      const bytes = base64ToBytes(value);
      return (
        bytes.length >= minBytes && bytes.length <= maxBytes && bytesToBase64(bytes) === value
      );
    } catch {
      return false;
    }
  });

/** WebAuthn credential IDs are 16..1023 bytes (mirrors the core envelope). */
const credentialIdB64 = z.string().refine((value) => {
  try {
    const bytes = base64ToBytes(value);
    return bytes.length >= 16 && bytes.length <= 1023 && bytesToBase64(bytes) === value;
  } catch {
    return false;
  }
});

const sessionExpectation = {
  expectedVaultId: z.string().min(1),
  expectedSessionId: z.string().uuid(),
} as const;

/** Display metadata only — never part of the envelope's authenticated data. */
const passkeyLabel = z.string().max(64);

// PRF eval input = utf8("drey-passkey-prf/v1") ‖ 0x00 ‖ prfSalt(32).
const PRF_EVAL_INPUT_BYTES = 'drey-passkey-prf/v1'.length + 1 + PASSKEY_PRF_SALT_BYTES;

/** Worker-issued WebAuthn challenge length (bytes). */
export const PASSKEY_CHALLENGE_BYTES = 32;

// ---- request schemas -------------------------------------------------------

const passkeyChallengeRequest = z.object({ vaultId: z.string().min(1) }).strict();

/**
 * Public WebAuthn ceremony evidence (A2.1, review Finding 1): the worker
 * verifies clientData (type/challenge/origin), authenticatorData (rpIdHash,
 * UP+UV flags), and the signature under the credential public key bound at
 * enrollment, so a captured PRF output cannot be replayed without a fresh
 * user-verification ceremony.
 */
const assertionEvidence = {
  assertionClientDataJSONB64: canonicalBase64Bounded(1, 4096),
  assertionAuthenticatorDataB64: canonicalBase64Bounded(37, 2048),
  assertionSignatureB64: canonicalBase64Bounded(8, 2048),
} as const;

/** COSE algorithms enrollment requests: ES256 (-7) and RS256 (-257). */
const publicKeyAlg = z.union([z.literal(-7), z.literal(-257)]);

const passkeyBeginEnrollmentRequest = z
  .object({ password: z.string().min(1), ...sessionExpectation })
  .strict();

const passkeyEnrollRequest = z
  .object({
    /** Single-use authorization minted by passkey.beginEnrollment. */
    authorizationId: z.string().uuid(),
    credentialIdB64,
    prfSaltB64: canonicalBase64(PASSKEY_PRF_SALT_BYTES),
    prfOutputB64: canonicalBase64(PASSKEY_PRF_OUTPUT_BYTES),
    label: passkeyLabel,
    /** SPKI public key from AuthenticatorAttestationResponse.getPublicKey(). */
    publicKeySpkiB64: canonicalBase64Bounded(40, 2048),
    publicKeyAlg,
    /** create()-ceremony clientDataJSON, bound to the create challenge. */
    createClientDataJSONB64: canonicalBase64Bounded(1, 4096),
    ...assertionEvidence,
    ...sessionExpectation,
  })
  .strict();

const passkeyUnlockRequest = z
  .object({
    vaultId: z.string().min(1),
    credentialIdB64,
    prfOutputB64: canonicalBase64(PASSKEY_PRF_OUTPUT_BYTES),
    ...assertionEvidence,
  })
  .strict();

const passkeyListRequest = z.object(sessionExpectation).strict();

const passkeyRenameRequest = z
  .object({ credentialIdB64, label: passkeyLabel, ...sessionExpectation })
  .strict();

const passkeyRemoveRequest = z
  .object({
    password: z.string().min(1),
    credentialIdB64: credentialIdB64.optional(),
    /** Remove this vault's unusable records (malformed or wrong identity). */
    purgeInvalid: z.boolean().optional(),
    ...sessionExpectation,
  })
  .strict()
  .refine((req) => (req.credentialIdB64 !== undefined) !== (req.purgeInvalid === true), {
    message: 'exactly one of credentialIdB64 or purgeInvalid must be given',
  });

// ---- response schemas (no secrets) -----------------------------------------

const passkeyChallengeResult = z
  .object({
    /** False when this build channel has no stable RP identity (A0 §1). */
    available: z.boolean(),
    entries: z.array(
      z
        .object({
          credentialIdB64,
          /** Fail-closed-parsed PRF eval input (domain ‖ 0x00 ‖ salt); public. */
          prfEvalInputB64: canonicalBase64(PRF_EVAL_INPUT_BYTES),
          label: passkeyLabel,
        })
        .strict(),
    ),
    /**
     * Worker-issued, single-use, expiring assertion challenge; present only
     * when at least one credential is offered. passkey.unlock verifies the
     * assertion's clientData against it, so an unlock cannot happen without
     * a fresh ceremony over a challenge this worker minted.
     */
    challengeB64: canonicalBase64(PASSKEY_CHALLENGE_BYTES).optional(),
    /** Stored records for this vault that must never provoke a ceremony. */
    invalidCount: z.number().int().nonnegative(),
  })
  .strict();

const passkeyBeginEnrollmentResult = z
  .object({
    /** Single-use enrollment authorization: password already reverified. */
    authorizationId: z.string().uuid(),
    createChallengeB64: canonicalBase64(PASSKEY_CHALLENGE_BYTES),
    getChallengeB64: canonicalBase64(PASSKEY_CHALLENGE_BYTES),
  })
  .strict();

const passkeyEnrollResult = z
  .object({ credentialIdB64, label: passkeyLabel, createdAtMs: z.number().int().nonnegative() })
  .strict();

const passkeyUnlockResult = z
  .object({
    vaultId: z.string().min(1),
    sessionId: z.string().uuid(),
    deadline: z.number().int().positive(),
  })
  .strict();

const passkeyListResult = z
  .object({
    entries: z.array(
      z
        .object({ credentialIdB64, label: passkeyLabel, createdAtMs: z.number().int().nonnegative() })
        .strict(),
    ),
    invalidCount: z.number().int().nonnegative(),
  })
  .strict();

const passkeyRenameResult = z.object({ renamed: z.boolean() }).strict();

const passkeyRemoveResult = z.object({ removed: z.number().int().nonnegative() }).strict();

// ---- registry --------------------------------------------------------------

export const PASSKEY_OP_SCHEMAS = {
  // Locked-surface op: the unlock screen must learn whether passkey unlock can
  // be offered for a vault before any session exists (like vault.list).
  'passkey.challenge': {
    request: passkeyChallengeRequest,
    response: passkeyChallengeResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: false,
  },
  // ADR 0007 §5: password reauthentication is required to enroll, and it now
  // happens BEFORE any platform credential is created (review Finding 5):
  // beginEnrollment reverifies the password and mints the single-use
  // authorization + ceremony challenges that passkey.enroll later consumes.
  'passkey.beginEnrollment': {
    request: passkeyBeginEnrollmentRequest,
    response: passkeyBeginEnrollmentResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  // Enrollment is a settings action on the unlocked wallet: it consumes a
  // beginEnrollment authorization, verifies the create + get ceremony
  // evidence, and round-trips wrap/unwrap before persisting anything.
  'passkey.enroll': {
    request: passkeyEnrollRequest,
    response: passkeyEnrollResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'passkey.unlock': {
    request: passkeyUnlockRequest,
    response: passkeyUnlockResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: false,
  },
  'passkey.list': {
    request: passkeyListRequest,
    response: passkeyListResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  // Label is display metadata outside the envelope AAD; session gating is
  // sufficient (no password reauth, mirroring other non-sensitive settings).
  'passkey.rename': {
    request: passkeyRenameRequest,
    response: passkeyRenameResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  // ADR 0007 §5: password reauthentication is required to remove.
  'passkey.remove': {
    request: passkeyRemoveRequest,
    response: passkeyRemoveResult,
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
} satisfies Record<string, OpSpec>;

export type PasskeyOp = keyof typeof PASSKEY_OP_SCHEMAS;

export type PasskeyChallengeRequest = z.infer<typeof passkeyChallengeRequest>;
export type PasskeyBeginEnrollmentRequest = z.infer<typeof passkeyBeginEnrollmentRequest>;
export type PasskeyBeginEnrollmentResult = z.infer<typeof passkeyBeginEnrollmentResult>;
export type PasskeyEnrollRequest = z.infer<typeof passkeyEnrollRequest>;
export type PasskeyUnlockRequest = z.infer<typeof passkeyUnlockRequest>;
export type PasskeyListRequest = z.infer<typeof passkeyListRequest>;
export type PasskeyRenameRequest = z.infer<typeof passkeyRenameRequest>;
export type PasskeyRemoveRequest = z.infer<typeof passkeyRemoveRequest>;
export type PasskeyChallengeResult = z.infer<typeof passkeyChallengeResult>;
export type PasskeyEnrollResult = z.infer<typeof passkeyEnrollResult>;
export type PasskeyListResult = z.infer<typeof passkeyListResult>;
