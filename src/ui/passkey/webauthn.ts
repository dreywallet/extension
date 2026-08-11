/**
 * Browser WebAuthn PRF adapter (ADR 0007 §5, Workstream A2; identity and
 * detection per the A0 spike). Runs ONLY in extension pages — the MV3 service
 * worker has no WebAuthn surface (A0 §3) — and hands nothing but derived,
 * short-lived byte buffers to callers, which forward them to the worker and
 * zeroize them.
 *
 * Identity: rp.id is deliberately omitted on every ceremony. Chromium resolves
 * it to this extension's ID and internally rewrites the effective RP ID to the
 * full serialized origin `chrome-extension://<id>`, which is exactly what the
 * envelope binds as rpOrigin. Claiming any other identity is rejected by
 * Chromium before UI (A0 §1).
 *
 * Detection ladder (A0 §4) as split between this module and the worker:
 *   1. PublicKeyCredential present, else no passkey UI at all   (here)
 *   2. channel gate — pinned manifest key only                  (worker + build define)
 *   3. getClientCapabilities()['extension:prf'] where available (here)
 *   4. create() must report prf.enabled === true                (here)
 *   5. authoritative get()-based wrap/unwrap round-trip         (here + worker)
 * Failures leave the wallet password-only; nothing persists before step 5.
 */
import { base64ToBytes, bytesToBase64 } from '@drey/core/domain/vault/encoding';

/** Typed failure the enrollment/unlock UI can map to specific copy. */
export type PasskeyCeremonyFailure =
  | 'unsupported' // no WebAuthn surface or PRF capability on this client
  | 'prf-unavailable' // credential created but authenticator cannot do PRF
  | 'cancelled' // user dismissed / timed out / no matching credential
  | 'failed'; // any other WebAuthn error

export class PasskeyCeremonyError extends Error {
  readonly reason: PasskeyCeremonyFailure;
  constructor(reason: PasskeyCeremonyFailure, message?: string) {
    super(message ?? reason);
    this.name = 'PasskeyCeremonyError';
    this.reason = reason;
  }
}

interface PrfExtensionResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer | Uint8Array } };
}

/** Copies bytes into a fresh ArrayBuffer (DOM BufferSource wants ArrayBuffer). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}

/** Base64url per WebAuthn L3 `evalByCredential` keys (unpadded). */
function toBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function ceremonyErrorFrom(err: unknown): PasskeyCeremonyError {
  if (err instanceof PasskeyCeremonyError) return err;
  const name = (err as { name?: unknown } | null)?.name;
  // NotAllowedError covers dismissal, timeout, and no-usable-credential; it
  // deliberately does not distinguish them (WebAuthn privacy rule).
  if (name === 'NotAllowedError') return new PasskeyCeremonyError('cancelled');
  return new PasskeyCeremonyError('failed', name === undefined ? undefined : String(name));
}

/**
 * Ladder steps 1 and 3. Step 3 is advisory where getClientCapabilities is
 * absent (Chrome 116–132): a capable client must not be blocked by a missing
 * probe, so absence falls through to the authoritative create/get gates.
 */
export async function detectPasskeySupport(): Promise<{ supported: boolean }> {
  if (typeof PublicKeyCredential === 'undefined') return { supported: false };
  const withCaps = PublicKeyCredential as unknown as {
    getClientCapabilities?: () => Promise<Record<string, boolean | undefined>>;
  };
  if (typeof withCaps.getClientCapabilities === 'function') {
    try {
      const caps = await withCaps.getClientCapabilities();
      if (caps['extension:prf'] !== true) return { supported: false };
    } catch {
      // Probe failure is not evidence of absence; the create gate decides.
    }
  }
  return { supported: true };
}

export interface CreatedPasskey {
  credentialIdB64: string;
  /** create() clientDataJSON — worker-verified against its create challenge. */
  clientDataJSONB64: string;
  /** SPKI public key + COSE alg: the worker's assertion-verification anchor. */
  publicKeySpkiB64: string;
  publicKeyAlg: -7 | -257;
}

/**
 * Ladder step 4: creates a discoverable, UV-required credential and requires
 * the client to report PRF support for it. A create-time PRF *result* is
 * never read — only get() output is ever used (step 5), so the one PRF value
 * that exists is the one the round-trip verified.
 *
 * The challenge comes from the worker (passkey.beginEnrollment), which also
 * reverified the password BEFORE this runs — no platform credential is ever
 * created ahead of reauthentication (A2.1). The WebAuthn user entry is a
 * generic constant: wallet names must not reach the authenticator or its
 * cloud sync (A2.1 review Finding 6).
 *
 * Throws 'prf-unavailable' when the credential was created without PRF: the
 * caller must tell the user a dangling platform-side passkey may exist and
 * that Drey stored nothing.
 */
export async function createPasskeyCredential(input: {
  challengeB64: string;
  excludeCredentialIdsB64: readonly string[];
}): Promise<CreatedPasskey> {
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        // rp.id omitted: Chromium binds the extension's own stable identity.
        rp: { name: 'Drey' },
        user: {
          // Random opaque handle and a generic constant name: no wallet
          // identifier or user-chosen label leaves the wallet.
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: 'Drey wallet',
          displayName: 'Drey wallet',
        },
        challenge: toArrayBuffer(base64ToBytes(input.challengeB64)),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 }, // ES256
          { type: 'public-key', alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          residentKey: 'required',
          requireResidentKey: true,
          userVerification: 'required',
        },
        excludeCredentials: input.excludeCredentialIdsB64.map((id) => ({
          type: 'public-key' as const,
          id: toArrayBuffer(base64ToBytes(id)),
        })),
        attestation: 'none',
        extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
      },
    });
  } catch (err) {
    throw ceremonyErrorFrom(err);
  }
  if (!(credential instanceof PublicKeyCredential)) {
    throw new PasskeyCeremonyError('failed', 'no credential returned');
  }
  const results = credential.getClientExtensionResults() as PrfExtensionResults;
  if (results.prf?.enabled !== true) {
    throw new PasskeyCeremonyError('prf-unavailable');
  }
  const response = credential.response;
  if (!(response instanceof AuthenticatorAttestationResponse)) {
    throw new PasskeyCeremonyError('failed', 'no attestation response');
  }
  const publicKey = response.getPublicKey();
  const publicKeyAlg = response.getPublicKeyAlgorithm();
  if (publicKey === null || (publicKeyAlg !== -7 && publicKeyAlg !== -257)) {
    // Without an extractable public key the worker cannot verify future
    // assertions, so the enrollment cannot proceed (fail closed).
    throw new PasskeyCeremonyError('unsupported', 'credential public key unavailable');
  }
  return {
    credentialIdB64: bytesToBase64(new Uint8Array(credential.rawId)),
    clientDataJSONB64: bytesToBase64(new Uint8Array(response.clientDataJSON)),
    publicKeySpkiB64: bytesToBase64(new Uint8Array(publicKey)),
    publicKeyAlg,
  };
}

export interface PrfAssertion {
  credentialIdB64: string;
  /** 32-byte PRF output. Caller MUST zeroize after base64-encoding. */
  prfOutput: Uint8Array;
  /** Public ceremony evidence the worker verifies (A2.1 review Finding 1). */
  clientDataJSONB64: string;
  authenticatorDataB64: string;
  signatureB64: string;
}

/**
 * Ladder step 5's ceremony half: a fresh UV-required assertion evaluating the
 * PRF for exactly the offered credentials, each under its own fail-closed-
 * parsed eval input, over a worker-issued single-use challenge. Every unwrap
 * requires a new call — no PRF output is ever cached or reused (ADR 0007 §5)
 * — and the worker independently verifies the returned clientData /
 * authenticatorData / signature before accepting the PRF output.
 */
export async function getPrfAssertion(input: {
  challengeB64: string;
  entries: readonly { credentialIdB64: string; prfEvalInputB64: string }[];
}): Promise<PrfAssertion> {
  if (input.entries.length === 0) throw new PasskeyCeremonyError('failed', 'no credentials offered');
  const evalByCredential: Record<string, { first: Uint8Array }> = {};
  for (const entry of input.entries) {
    evalByCredential[toBase64Url(base64ToBytes(entry.credentialIdB64))] = {
      first: base64ToBytes(entry.prfEvalInputB64),
    };
  }
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({
      publicKey: {
        challenge: toArrayBuffer(base64ToBytes(input.challengeB64)),
        allowCredentials: input.entries.map((entry) => ({
          type: 'public-key' as const,
          id: toArrayBuffer(base64ToBytes(entry.credentialIdB64)),
        })),
        userVerification: 'required',
        extensions: { prf: { evalByCredential } } as AuthenticationExtensionsClientInputs,
      },
    });
  } catch (err) {
    throw ceremonyErrorFrom(err);
  }
  if (!(credential instanceof PublicKeyCredential)) {
    throw new PasskeyCeremonyError('failed', 'no assertion returned');
  }
  const response = credential.response;
  if (!(response instanceof AuthenticatorAssertionResponse)) {
    throw new PasskeyCeremonyError('failed', 'no assertion response');
  }
  const results = credential.getClientExtensionResults() as PrfExtensionResults;
  const first = results.prf?.results?.first;
  if (first === undefined) throw new PasskeyCeremonyError('prf-unavailable');
  const prfOutput = first instanceof Uint8Array ? new Uint8Array(first) : new Uint8Array(first);
  if (prfOutput.length !== 32) {
    prfOutput.fill(0);
    throw new PasskeyCeremonyError('failed', 'prf output is not 32 bytes');
  }
  return {
    credentialIdB64: bytesToBase64(new Uint8Array(credential.rawId)),
    prfOutput,
    clientDataJSONB64: bytesToBase64(new Uint8Array(response.clientDataJSON)),
    authenticatorDataB64: bytesToBase64(new Uint8Array(response.authenticatorData)),
    signatureB64: bytesToBase64(new Uint8Array(response.signature)),
  };
}
