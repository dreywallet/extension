/**
 * Passkey convenience-unlock surface (ADR 0007 §5, Workstream A2), extracted
 * from WalletService.
 *
 * Lock contract, in two tiers exactly as in vault-coordinator-service.ts: the
 * *helper* functions (top half) assume the caller already holds the
 * WalletService serialization queue, while the exported *op* functions
 * (bottom half, `PasskeyOpsContext`) take that queue themselves — but only
 * ever the service's own queue, borrowed through `ctx.runExclusive`. There is
 * exactly ONE queue instance and it lives on WalletService; nothing here may
 * call back into the service or create a second queue. The context is a slice
 * of the service's injected deps plus the two worker-memory grant maps, which
 * remain WalletService instance fields (deliberately NOT cleared on lock; an
 * MV3 restart drops them and every in-flight ceremony fails closed).
 */
import type { Network } from '@drey/core/domain/keys/derivation';
import { base64ToBytes, bytesToBase64 } from '@drey/core/domain/vault/encoding';
import {
  assertUniquePasskeyCredentials,
  createPasskeyEnvelope,
  parsePasskeyEnvelope,
  passkeyPrfEvalInputForEnvelope,
  PASSKEY_HKDF_SALT_BYTES,
  unwrapPasskeyDek,
  type PasskeyEnvelopeV1,
} from '@drey/core/domain/vault/passkey-envelope';
import { NONCE_BYTES } from '@drey/core/domain/vault/crypto';
import { openVaultPayload, unlockVault, zeroize } from '@drey/core/domain/vault/vault';
import type { VaultRecordV1 } from '@drey/core/domain/vault/record';
import type { ActiveSessionRequest } from '@drey/core/messaging/ops';
import type { StorageArea } from '../adapters/storage/area';
import type { UnlockSession } from '../adapters/session/session-store';
import { loadVaults } from '../adapters/storage/vault-store';
import {
  loadPasskeyEnvelopes,
  passkeyEnvelopesForVault,
  savePasskeyEnvelopes,
  type RawPasskeyEnvelope,
} from '../adapters/storage/passkey-store';
import {
  loadPasskeyCredentials,
  passkeyCredentialFor,
  savePasskeyCredentials,
  type PasskeyCredentialRecord,
} from '../adapters/storage/passkey-credentials';
import {
  challengeBase64Url,
  verifyAssertion,
  verifyClientData,
  WebAuthnVerifyError,
} from './webauthn-verify';
import {
  PASSKEY_CHALLENGE_BYTES,
  type PasskeyBeginEnrollmentRequest,
  type PasskeyBeginEnrollmentResult,
  type PasskeyChallengeRequest,
  type PasskeyChallengeResult,
  type PasskeyEnrollRequest,
  type PasskeyEnrollResult,
  type PasskeyListRequest,
  type PasskeyListResult,
  type PasskeyRemoveRequest,
  type PasskeyRenameRequest,
  type PasskeyUnlockRequest,
} from '../messaging/passkey-ops';
import { RpcError } from './errors';

/**
 * Fail-closed bounds on stored passkey records (A2.1, review Finding 2): a
 * storage-writing attacker must not be able to occupy the worker's serialized
 * queue with unbounded per-record parsing ahead of a password unlock. An
 * over-limit root is treated as corrupt passkey state — nothing is offered,
 * and password unlock proceeds untouched.
 */
export const MAX_PASSKEY_RECORDS_TOTAL = 32;
export const MAX_PASSKEY_RECORDS_PER_VAULT = 5;
/** Worker-issued WebAuthn challenge / enrollment-authorization lifetime. */
export const PASSKEY_GRANT_TTL_MS = 2 * 60 * 1000;
const MAX_PASSKEY_UNLOCK_CHALLENGES = 8;
export const MAX_PASSKEY_ENROLL_AUTHORIZATIONS = 4;

/** Value type of WalletService's worker-memory unlock-challenge map. */
export interface PasskeyUnlockChallenge {
  vaultId: string;
  challengeB64: string;
  expiresAt: number;
}

/** Value type of WalletService's worker-memory enrollment-authorization map. */
export interface PasskeyEnrollAuthorization {
  sessionId: string;
  vaultId: string;
  createChallengeB64: string;
  getChallengeB64: string;
  expiresAt: number;
}

/**
 * The slice of WalletService state these helpers operate on. `unlockChallenges`
 * and `enrollAuthorizations` are the service's own map instances, passed by
 * reference — the context never copies or replaces them.
 */
export interface PasskeyContext {
  local: StorageArea;
  network: Network;
  now(): number;
  random(bytes: number): Uint8Array;
  unlockChallenges: Map<string, PasskeyUnlockChallenge>;
  enrollAuthorizations: Map<string, PasskeyEnrollAuthorization>;
}

/** The offering decision over one vault's stored records (see offeringFrom). */
export interface PasskeyOffering {
  valid: {
    raw: RawPasskeyEnvelope;
    envelope: PasskeyEnvelopeV1;
    prfEvalInput: Uint8Array;
    credential: PasskeyCredentialRecord;
  }[];
  invalidCount: number;
}

/**
 * Canonical key of a credential-ID field by its decoded bytes, accepting
 * noncanonical (unpadded/whitespace) spellings so an aliased stored record
 * still collides with its canonical twin (A2.1, review Finding 3). Null when
 * the value is not decodable base64 at all.
 */
export function forgivingCredentialIdKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const bytes = Uint8Array.from(atob(value.replace(/\s+/gu, '')), (c) => c.charCodeAt(0));
    return bytesToBase64(bytes);
  } catch {
    return null;
  }
}

/**
 * Classifies one stored record for a vault against this build's exact
 * identity. Fail-closed parse runs first (unknown version / malformed →
 * invalid), then the identity triple; only a record unwrapPasskeyDek could
 * accept is ever 'valid'.
 */
export function classifyPasskeyEnvelope(
  ctx: PasskeyContext,
  raw: RawPasskeyEnvelope,
  vaultId: string,
  rpOrigin: string,
):
  | { kind: 'valid'; envelope: PasskeyEnvelopeV1; prfEvalInput: Uint8Array }
  | { kind: 'invalid' } {
  try {
    const prfEvalInput = passkeyPrfEvalInputForEnvelope(raw);
    const envelope = parsePasskeyEnvelope(raw);
    if (
      envelope.vaultId !== vaultId ||
      envelope.rpOrigin !== rpOrigin ||
      envelope.network !== ctx.network
    ) {
      return { kind: 'invalid' };
    }
    return { kind: 'valid', envelope, prfEvalInput };
  } catch {
    return { kind: 'invalid' };
  }
}

/**
 * The full offering decision for one vault over preloaded stores (A2.1):
 * a record is offered only when it classifies as valid, its decoded
 * credential ID is unique among this vault's attributable records (review
 * Finding 3), a credential public key is bound for it (Finding 1), and the
 * root is under the storage caps (Finding 2). Everything else counts as
 * invalid and is surfaced for password-authenticated purge.
 */
export function offeringFrom(
  ctx: PasskeyContext,
  stored: readonly RawPasskeyEnvelope[],
  credentials: readonly PasskeyCredentialRecord[],
  vaultId: string,
  rpOrigin: string,
): PasskeyOffering {
  const forVault = passkeyEnvelopesForVault(stored, vaultId);
  if (
    stored.length > MAX_PASSKEY_RECORDS_TOTAL ||
    forVault.length > MAX_PASSKEY_RECORDS_PER_VAULT
  ) {
    // Over-cap roots are corrupt state: no per-record parsing, no offering.
    return { valid: [], invalidCount: forVault.length };
  }
  const idCounts = new Map<string, number>();
  for (const raw of forVault) {
    const key = forgivingCredentialIdKey(raw['credentialIdB64']);
    if (key !== null) idCounts.set(key, (idCounts.get(key) ?? 0) + 1);
  }
  const valid: PasskeyOffering['valid'] = [];
  let invalidCount = 0;
  for (const raw of forVault) {
    const classified = classifyPasskeyEnvelope(ctx, raw, vaultId, rpOrigin);
    const idKey = forgivingCredentialIdKey(raw['credentialIdB64']);
    const credential =
      classified.kind === 'valid'
        ? passkeyCredentialFor(credentials, vaultId, classified.envelope.credentialIdB64)
        : null;
    if (
      classified.kind === 'valid' &&
      credential !== null &&
      idKey !== null &&
      idCounts.get(idKey) === 1
    ) {
      valid.push({
        raw,
        envelope: classified.envelope,
        prfEvalInput: classified.prfEvalInput,
        credential,
      });
    } else {
      invalidCount += 1;
    }
  }
  return { valid, invalidCount };
}

export async function collectPasskeyOffering(
  ctx: PasskeyContext,
  vaultId: string,
  rpOrigin: string,
): Promise<PasskeyOffering> {
  return offeringFrom(
    ctx,
    await loadPasskeyEnvelopes(ctx.local),
    await loadPasskeyCredentials(ctx.local),
    vaultId,
    rpOrigin,
  );
}

/** Drop expired worker-issued challenges/authorizations (cheap, on mint). */
export function prunePasskeyGrants(ctx: PasskeyContext): void {
  const now = ctx.now();
  for (const [key, value] of ctx.unlockChallenges) {
    if (value.expiresAt <= now) ctx.unlockChallenges.delete(key);
  }
  for (const [key, value] of ctx.enrollAuthorizations) {
    if (value.expiresAt <= now) ctx.enrollAuthorizations.delete(key);
  }
}

/** Mints a single-use unlock challenge, keyed by its clientData spelling. */
export function mintPasskeyUnlockChallenge(ctx: PasskeyContext, vaultId: string): string {
  prunePasskeyGrants(ctx);
  while (ctx.unlockChallenges.size >= MAX_PASSKEY_UNLOCK_CHALLENGES) {
    const oldest = ctx.unlockChallenges.keys().next().value;
    if (oldest === undefined) break;
    ctx.unlockChallenges.delete(oldest);
  }
  const challengeB64 = bytesToBase64(ctx.random(PASSKEY_CHALLENGE_BYTES));
  ctx.unlockChallenges.set(challengeBase64Url(challengeB64), {
    vaultId,
    challengeB64,
    expiresAt: ctx.now() + PASSKEY_GRANT_TTL_MS,
  });
  return challengeB64;
}

/**
 * Resolves (and ALWAYS consumes) the outstanding challenge named by an
 * assertion's clientData. Null — never a ceremony, never an unwrap — when
 * the clientData is unreadable, the challenge is unknown, already used,
 * expired, or was minted for a different vault.
 */
export function consumePasskeyUnlockChallenge(
  ctx: PasskeyContext,
  clientDataJSONB64: string,
  vaultId: string,
): string | null {
  let challenge: unknown;
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(base64ToBytes(clientDataJSONB64)),
    ) as { challenge?: unknown };
    challenge = parsed.challenge;
  } catch {
    return null;
  }
  if (typeof challenge !== 'string') return null;
  const entry = ctx.unlockChallenges.get(challenge);
  if (entry === undefined) return null;
  ctx.unlockChallenges.delete(challenge);
  if (entry.expiresAt <= ctx.now() || entry.vaultId !== vaultId) return null;
  return entry.challengeB64;
}

/** Removes a vault's envelopes AND bound credential keys (Finding 4). */
export async function purgePasskeyStateForVault(
  ctx: PasskeyContext,
  vaultId: string,
): Promise<void> {
  const envelopes = await loadPasskeyEnvelopes(ctx.local);
  const remaining = envelopes.filter((raw) => raw['vaultId'] !== vaultId);
  if (remaining.length !== envelopes.length) {
    await savePasskeyEnvelopes(ctx.local, remaining);
  }
  const credentials = await loadPasskeyCredentials(ctx.local);
  const remainingCredentials = credentials.filter((candidate) => candidate.vaultId !== vaultId);
  if (remainingCredentials.length !== credentials.length) {
    await savePasskeyCredentials(ctx.local, remainingCredentials);
  }
}

// ---- passkey ops (ADR 0007 §5, Workstream A2) ------------------------------
//
// PRF output arrives base64 from the extension page that ran the WebAuthn
// ceremony (the MV3 worker has no WebAuthn surface — A0 §3). It is HKDF input
// keying material for the envelope KEK only: it never derives seed S, any
// Vault root, a BIP32 child, or other signing material (spec §7.7), is never
// persisted or logged, and every buffer is zeroized before return.
//
// Unlike the helpers above, these functions take the service queue themselves
// through `ctx.runExclusive` (see the module header). WalletService keeps
// one-line delegating methods, so the op registry and dispatch table are
// unchanged.

/**
 * The helper context plus the service hooks the ops borrow. The four function
 * members are the service's own methods, passed as closures — the ops borrow
 * the single serialization queue and session machinery, never re-implementing
 * either.
 */
export interface PasskeyOpsContext extends PasskeyContext {
  /** `WalletServiceDeps.passkeyRpOrigin`, verbatim: absent means no surface. */
  passkeyRpOrigin: string | undefined;
  newSessionId(): string;
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
  activeRecord(
    expectation: ActiveSessionRequest,
  ): Promise<{ record: VaultRecordV1; session: UnlockSession }>;
  requireSession(expectation: ActiveSessionRequest): Promise<UnlockSession>;
  touchSessionLocked(session: UnlockSession): Promise<void>;
  installSessionLocked(
    vaultId: string,
    dek: Uint8Array,
  ): Promise<{ vaultId: string; sessionId: string; deadline: number }>;
}

/**
 * Non-secret unlock offering for a vault while locked: which enrolled
 * credentials may be asserted, with their fail-closed-parsed PRF eval
 * inputs and a worker-issued single-use assertion challenge. A record that
 * is malformed, of an unknown version, bound to a different RP origin /
 * vault / network, missing its bound credential public key, part of an
 * ambiguous same-credential duplicate set, over the storage caps, or
 * attributed to a vault that no longer exists is never offered, so it can
 * never provoke a user-verification ceremony (A1 fail-closed rule; A2.1
 * review Findings 2, 3, 4).
 */
export async function passkeyChallenge(
  ctx: PasskeyOpsContext,
  input: PasskeyChallengeRequest,
): Promise<PasskeyChallengeResult> {
  return ctx.runExclusive(async () => {
    const rpOrigin = ctx.passkeyRpOrigin;
    if (rpOrigin === undefined) return { available: false, entries: [], invalidCount: 0 };
    const map = await loadVaults(ctx.local);
    if (!map[input.vaultId]) return { available: true, entries: [], invalidCount: 0 };
    const offering = await collectPasskeyOffering(ctx, input.vaultId, rpOrigin);
    const entries = offering.valid.map((candidate) => ({
      credentialIdB64: candidate.envelope.credentialIdB64,
      prfEvalInputB64: bytesToBase64(candidate.prfEvalInput),
      label: candidate.envelope.label,
    }));
    if (entries.length === 0) {
      return { available: true, entries, invalidCount: offering.invalidCount };
    }
    return {
      available: true,
      entries,
      challengeB64: mintPasskeyUnlockChallenge(ctx, input.vaultId),
      invalidCount: offering.invalidCount,
    };
  });
}

/**
 * Password reauthentication BEFORE any platform credential exists (ADR 0007
 * §5; A2.1 review Finding 5): verifies the password against the active
 * vault record and mints a single-use, expiring enrollment authorization
 * with the two ceremony challenges (create + get) that passkey.enroll will
 * verify. Nothing is persisted; a wrong password stops the flow before the
 * platform credential manager is ever involved.
 */
export async function passkeyBeginEnrollment(
  ctx: PasskeyOpsContext,
  input: PasskeyBeginEnrollmentRequest,
): Promise<PasskeyBeginEnrollmentResult> {
  return ctx.runExclusive(async () => {
    const rpOrigin = ctx.passkeyRpOrigin;
    if (rpOrigin === undefined) {
      throw new RpcError('ERR_PASSKEY_UNAVAILABLE', 'this build has no stable RP identity');
    }
    const { record, session } = await ctx.activeRecord(input);
    const unlocked = await unlockVault(record, input.password); // throws on wrong-password
    zeroize(unlocked.dek); // reauthentication only — enroll wraps the session DEK
    const stored = await loadPasskeyEnvelopes(ctx.local);
    const forVault = passkeyEnvelopesForVault(stored, record.vaultId);
    if (
      stored.length >= MAX_PASSKEY_RECORDS_TOTAL ||
      forVault.length >= MAX_PASSKEY_RECORDS_PER_VAULT
    ) {
      throw new RpcError('ERR_PASSKEY_UNAVAILABLE', 'passkey storage limit reached');
    }
    prunePasskeyGrants(ctx);
    while (ctx.enrollAuthorizations.size >= MAX_PASSKEY_ENROLL_AUTHORIZATIONS) {
      const oldest = ctx.enrollAuthorizations.keys().next().value;
      if (oldest === undefined) break;
      ctx.enrollAuthorizations.delete(oldest);
    }
    const authorizationId = ctx.newSessionId();
    const grant = {
      sessionId: session.sessionId,
      vaultId: record.vaultId,
      createChallengeB64: bytesToBase64(ctx.random(PASSKEY_CHALLENGE_BYTES)),
      getChallengeB64: bytesToBase64(ctx.random(PASSKEY_CHALLENGE_BYTES)),
      expiresAt: ctx.now() + PASSKEY_GRANT_TTL_MS,
    };
    ctx.enrollAuthorizations.set(authorizationId, grant);
    await ctx.touchSessionLocked(session);
    return {
      authorizationId,
      createChallengeB64: grant.createChallengeB64,
      getChallengeB64: grant.getChallengeB64,
    };
  });
}

/**
 * Persists a new envelope for the active vault. Requires the live session
 * AND a single-use beginEnrollment authorization (which reverified the
 * password), AND worker-verified ceremony evidence: the create clientData
 * and the PRF-bearing get() assertion must both bind this worker's
 * challenges, and the assertion must verify under the supplied credential
 * public key with the UV flag set (A2.1 review Findings 1/5). Nothing
 * persists unless the get()-time PRF output round-trips through wrap →
 * unwrap → byte-compare (A0 §4 step 5); create-time PRF results are never
 * accepted as evidence.
 */
export async function passkeyEnroll(
  ctx: PasskeyOpsContext,
  input: PasskeyEnrollRequest,
): Promise<PasskeyEnrollResult> {
  return ctx.runExclusive(async () => {
    const rpOrigin = ctx.passkeyRpOrigin;
    if (rpOrigin === undefined) {
      throw new RpcError('ERR_PASSKEY_UNAVAILABLE', 'this build has no stable RP identity');
    }
    const { record, session } = await ctx.activeRecord(input);
    // Single-use: the authorization is consumed now, success or failure.
    const grant = ctx.enrollAuthorizations.get(input.authorizationId);
    ctx.enrollAuthorizations.delete(input.authorizationId);
    if (
      grant === undefined ||
      grant.expiresAt <= ctx.now() ||
      grant.sessionId !== session.sessionId ||
      grant.vaultId !== record.vaultId
    ) {
      throw new RpcError('ERR_PASSKEY_UNAVAILABLE', 'enrollment authorization missing or expired');
    }
    try {
      verifyClientData({
        clientDataJSONB64: input.createClientDataJSONB64,
        expectedType: 'webauthn.create',
        challengeB64: grant.createChallengeB64,
        rpOrigin,
      });
      await verifyAssertion({
        publicKeySpkiB64: input.publicKeySpkiB64,
        publicKeyAlg: input.publicKeyAlg,
        clientDataJSONB64: input.assertionClientDataJSONB64,
        authenticatorDataB64: input.assertionAuthenticatorDataB64,
        signatureB64: input.assertionSignatureB64,
        challengeB64: grant.getChallengeB64,
        rpOrigin,
      });
    } catch (err) {
      if (err instanceof WebAuthnVerifyError) {
        throw new RpcError('ERR_PASSKEY_INVALID_PRF', 'webauthn ceremony evidence rejected');
      }
      throw err;
    }
    const dek = base64ToBytes(session.dekB64);
    const prfOutput = base64ToBytes(input.prfOutputB64);
    const prfSalt = base64ToBytes(input.prfSaltB64);
    try {
      // The session DEK must still open the live record before it is wrapped.
      openVaultPayload(record, dek);
      const stored = await loadPasskeyEnvelopes(ctx.local);
      const forVault = passkeyEnvelopesForVault(stored, record.vaultId);
      if (
        stored.length >= MAX_PASSKEY_RECORDS_TOTAL ||
        forVault.length >= MAX_PASSKEY_RECORDS_PER_VAULT
      ) {
        throw new RpcError('ERR_PASSKEY_UNAVAILABLE', 'passkey storage limit reached');
      }
      // One envelope per credential per wallet, enforced against every
      // attributable stored record by DECODED credential-ID bytes, so an
      // aliased (noncanonical base64) spelling in a record this build
      // cannot parse still collides (review Finding 3).
      const inputIdKey = forgivingCredentialIdKey(input.credentialIdB64);
      if (
        inputIdKey === null ||
        forVault.some((raw) => forgivingCredentialIdKey(raw['credentialIdB64']) === inputIdKey)
      ) {
        throw new RpcError('ERR_PASSKEY_DUPLICATE', 'credential already enrolled for this wallet');
      }
      const envelope = createPasskeyEnvelope({
        dek,
        prfOutput,
        rpOrigin,
        vaultId: record.vaultId,
        network: ctx.network,
        credentialIdB64: input.credentialIdB64,
        label: input.label.trim(),
        createdAtMs: ctx.now(),
        prfSalt,
        hkdfSalt: ctx.random(PASSKEY_HKDF_SALT_BYTES),
        nonce: ctx.random(NONCE_BYTES),
      });
      const roundTrip = unwrapPasskeyDek({
        envelope,
        prfOutput,
        expected: { rpOrigin, vaultId: record.vaultId, network: ctx.network },
      });
      const matches =
        roundTrip.length === dek.length && roundTrip.every((byte, i) => byte === dek[i]);
      zeroize(roundTrip);
      if (!matches) throw new RpcError('ERR_INTERNAL', 'passkey wrap round-trip mismatch');
      const parsedForVault: PasskeyEnvelopeV1[] = [];
      for (const raw of forVault) {
        try {
          parsedForVault.push(parsePasskeyEnvelope(raw));
        } catch {
          // Unparseable records were already covered by the decoded-ID guard.
        }
      }
      assertUniquePasskeyCredentials([...parsedForVault, envelope]);
      // Bind the credential public key FIRST: an envelope with no bound
      // credential record is never offered, so a failure between the two
      // writes fails closed to password unlock rather than leaving an
      // unlockable-but-unverifiable envelope behind.
      const credentials = (await loadPasskeyCredentials(ctx.local)).filter(
        (candidate) =>
          !(candidate.vaultId === record.vaultId &&
            candidate.credentialIdB64 === input.credentialIdB64),
      );
      credentials.push({
        vaultId: record.vaultId,
        credentialIdB64: input.credentialIdB64,
        publicKeyAlg: input.publicKeyAlg,
        publicKeySpkiB64: input.publicKeySpkiB64,
        createdAtMs: envelope.createdAtMs,
      });
      await savePasskeyCredentials(ctx.local, credentials);
      await savePasskeyEnvelopes(ctx.local, [
        ...stored,
        envelope as unknown as RawPasskeyEnvelope,
      ]);
      await ctx.touchSessionLocked(session);
      return {
        credentialIdB64: envelope.credentialIdB64,
        label: envelope.label,
        createdAtMs: envelope.createdAtMs,
      };
    } finally {
      zeroize(dek);
      zeroize(prfOutput);
      zeroize(prfSalt);
    }
  });
}

/**
 * Unlocks a vault with a fresh get()-time PRF output AND worker-verified
 * assertion evidence (A2.1 review Finding 1): the assertion's clientData
 * must name a worker-issued single-use challenge for this vault, its
 * authenticatorData must carry this build's rpIdHash with the UV flag set,
 * and its signature must verify under the credential public key bound at
 * enrollment — so a captured PRF output cannot be replayed after a lock or
 * restart without a fresh user-verification ceremony. The envelope must
 * then authenticate under this build's exact identity AND the unwrapped
 * DEK must still open the vault payload before a session is installed. Any
 * failure leaves the wallet exactly as locked as before — the password
 * path is a peer, not a fallback of last resort.
 *
 * The caller (WalletService) kicks its broadcast retry AFTER this returns,
 * outside the queue, exactly as the password unlock does.
 */
export async function passkeyUnlock(
  ctx: PasskeyOpsContext,
  input: PasskeyUnlockRequest,
): Promise<{ vaultId: string; sessionId: string; deadline: number }> {
  return ctx.runExclusive(async () => {
    const rpOrigin = ctx.passkeyRpOrigin;
    if (rpOrigin === undefined) {
      throw new RpcError('ERR_PASSKEY_UNAVAILABLE', 'this build has no stable RP identity');
    }
    // Single-use: the named challenge is consumed now, success or failure.
    const challengeB64 = consumePasskeyUnlockChallenge(
      ctx,
      input.assertionClientDataJSONB64,
      input.vaultId,
    );
    if (challengeB64 === null) {
      throw new RpcError('ERR_PASSKEY_UNAVAILABLE', 'unknown or expired unlock challenge');
    }
    const map = await loadVaults(ctx.local);
    const record = map[input.vaultId];
    if (!record) throw new RpcError('ERR_VAULT_NOT_FOUND', 'vault not found');
    const stored = passkeyEnvelopesForVault(
      await loadPasskeyEnvelopes(ctx.local),
      input.vaultId,
    );
    const raw = stored.find((entry) => entry['credentialIdB64'] === input.credentialIdB64);
    if (raw === undefined) {
      throw new RpcError('ERR_PASSKEY_UNAVAILABLE', 'no envelope for this credential');
    }
    const credential = passkeyCredentialFor(
      await loadPasskeyCredentials(ctx.local),
      input.vaultId,
      input.credentialIdB64,
    );
    if (credential === null) {
      throw new RpcError('ERR_PASSKEY_UNAVAILABLE', 'credential has no bound public key');
    }
    // Fresh-ceremony proof BEFORE any unwrap is attempted.
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
    } catch (err) {
      if (err instanceof WebAuthnVerifyError) {
        throw new RpcError('ERR_PASSKEY_INVALID_PRF', 'webauthn assertion rejected');
      }
      throw err;
    }
    const prfOutput = base64ToBytes(input.prfOutputB64);
    let dek: Uint8Array | null = null;
    try {
      dek = unwrapPasskeyDek({
        envelope: raw,
        prfOutput,
        expected: { rpOrigin, vaultId: input.vaultId, network: ctx.network },
      });
      // The envelope authenticated, but the DEK must additionally still open
      // this vault's payload before any prior session is dropped.
      openVaultPayload(record, dek);
      return await ctx.installSessionLocked(input.vaultId, dek);
    } finally {
      if (dek !== null) zeroize(dek);
      zeroize(prfOutput);
    }
  });
}

/** Enrollment list for the active vault (labels and dates only; no secrets). */
export async function passkeyList(
  ctx: PasskeyOpsContext,
  input: PasskeyListRequest,
): Promise<PasskeyListResult> {
  return ctx.runExclusive(async () => {
    const session = await ctx.requireSession(input);
    const rpOrigin = ctx.passkeyRpOrigin;
    if (rpOrigin === undefined) {
      const forVault = passkeyEnvelopesForVault(
        await loadPasskeyEnvelopes(ctx.local),
        session.vaultId,
      );
      return { entries: [], invalidCount: forVault.length };
    }
    const offering = await collectPasskeyOffering(ctx, session.vaultId, rpOrigin);
    return {
      entries: offering.valid.map((candidate) => ({
        credentialIdB64: candidate.envelope.credentialIdB64,
        label: candidate.envelope.label,
        createdAtMs: candidate.envelope.createdAtMs,
      })),
      invalidCount: offering.invalidCount,
    };
  });
}

/**
 * Relabels one enrollment. The label is display metadata outside the
 * envelope's authenticated data (A1), so a session gate suffices; the
 * renamed record is reparsed to prove it is still storable.
 */
export async function passkeyRename(
  ctx: PasskeyOpsContext,
  input: PasskeyRenameRequest,
): Promise<{ renamed: boolean }> {
  return ctx.runExclusive(async () => {
    const session = await ctx.requireSession(input);
    const rpOrigin = ctx.passkeyRpOrigin;
    if (rpOrigin === undefined) {
      throw new RpcError('ERR_PASSKEY_UNAVAILABLE', 'this build has no stable RP identity');
    }
    const stored = await loadPasskeyEnvelopes(ctx.local);
    let renamed = false;
    const next = stored.map((raw) => {
      if (raw['vaultId'] !== session.vaultId || raw['credentialIdB64'] !== input.credentialIdB64) {
        return raw;
      }
      const classified = classifyPasskeyEnvelope(ctx, raw, session.vaultId, rpOrigin);
      if (classified.kind !== 'valid') return raw;
      renamed = true;
      return parsePasskeyEnvelope({
        ...classified.envelope,
        label: input.label.trim(),
      }) as unknown as RawPasskeyEnvelope;
    });
    if (renamed) await savePasskeyEnvelopes(ctx.local, next);
    return { renamed };
  });
}

/**
 * Removes one enrollment (or purges this vault's unusable records). ADR
 * 0007 §5: password reauthentication required; removal only deletes the
 * local envelope — the platform-side passkey is managed by the platform
 * credential manager, and the UI must say so.
 */
export async function passkeyRemove(
  ctx: PasskeyOpsContext,
  input: PasskeyRemoveRequest,
): Promise<{ removed: number }> {
  return ctx.runExclusive(async () => {
    const { record, session } = await ctx.activeRecord(input);
    const unlocked = await unlockVault(record, input.password); // throws on wrong-password
    zeroize(unlocked.dek);
    const rpOrigin = ctx.passkeyRpOrigin;
    const stored = await loadPasskeyEnvelopes(ctx.local);
    // purgeInvalid keeps exactly what would be OFFERED (bound public key,
    // unique decoded ID, under caps) — anything unusable goes, and an
    // over-cap root is corrupt state that clears this vault's records.
    const offerable =
      input.purgeInvalid === true && rpOrigin !== undefined
        ? new Set(
            offeringFrom(
              ctx,
              stored,
              await loadPasskeyCredentials(ctx.local),
              record.vaultId,
              rpOrigin,
            ).valid.map((candidate) => candidate.raw),
          )
        : new Set<RawPasskeyEnvelope>();
    const next = stored.filter((raw) => {
      if (raw['vaultId'] !== record.vaultId) return true;
      if (input.credentialIdB64 !== undefined) {
        return raw['credentialIdB64'] !== input.credentialIdB64;
      }
      return offerable.has(raw);
    });
    const removed = stored.length - next.length;
    if (removed > 0) await savePasskeyEnvelopes(ctx.local, next);
    // The credential-key sidecar tracks the envelopes: drop any bound key
    // whose envelope no longer exists for this vault.
    const remainingIds = new Set(
      next
        .filter((raw) => raw['vaultId'] === record.vaultId)
        .map((raw) => raw['credentialIdB64']),
    );
    const credentials = await loadPasskeyCredentials(ctx.local);
    const nextCredentials = credentials.filter(
      (candidate) =>
        candidate.vaultId !== record.vaultId || remainingIds.has(candidate.credentialIdB64),
    );
    if (nextCredentials.length !== credentials.length) {
      await savePasskeyCredentials(ctx.local, nextCredentials);
    }
    await ctx.touchSessionLocked(session);
    return { removed };
  });
}
