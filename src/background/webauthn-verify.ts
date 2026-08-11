/**
 * Worker-side WebAuthn evidence verification (A2.1, review Finding 1/5).
 *
 * The MV3 worker has no WebAuthn surface, so ceremonies run in extension
 * pages — but the worker must not take the page's word for it: a PRF output
 * alone is a static, replayable bearer secret. Every unlock (and the get()
 * half of enrollment) therefore carries the assertion's clientDataJSON,
 * authenticatorData, and signature, and the worker verifies:
 *   - clientData type / challenge (worker-issued, single-use) / origin
 *   - authenticatorData rpIdHash === SHA-256(rpOrigin) and the UP+UV flags
 *   - the signature, under the credential public key bound at enrollment,
 *     over authenticatorData ‖ SHA-256(clientDataJSON)
 * Only ES256 (-7) and RS256 (-257) are accepted — the two algorithms
 * enrollment requests. Verification failures throw; callers map them to
 * fail-closed wire errors. Nothing here touches secrets: every input is
 * public ceremony evidence.
 */
import { base64ToBytes, bytesToBase64 } from '@drey/core/domain/vault/encoding';

/** COSE algorithm identifiers accepted at enrollment (webauthn.ts mirrors). */
export type PasskeyCoseAlg = -7 | -257;

export class WebAuthnVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebAuthnVerifyError';
  }
}

function fail(message: string): never {
  throw new WebAuthnVerifyError(message);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(bytes); // detached copy: digest wants ArrayBuffer
  return new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer));
}

/** Unpadded base64url of raw bytes — the encoding clientData.challenge uses. */
export function challengeBase64Url(challengeB64: string): string {
  return bytesToBase64(base64ToBytes(challengeB64))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}

interface ClientData {
  type?: unknown;
  challenge?: unknown;
  origin?: unknown;
}

/**
 * Parses and checks a ceremony's clientDataJSON against the expected type
 * ('webauthn.create' | 'webauthn.get'), worker-issued challenge, and origin.
 */
export function verifyClientData(input: {
  clientDataJSONB64: string;
  expectedType: 'webauthn.create' | 'webauthn.get';
  challengeB64: string;
  rpOrigin: string;
}): void {
  let parsed: ClientData;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64ToBytes(input.clientDataJSONB64))) as ClientData;
  } catch {
    fail('clientDataJSON is not valid JSON');
  }
  if (parsed.type !== input.expectedType) fail('clientData type mismatch');
  if (parsed.challenge !== challengeBase64Url(input.challengeB64)) fail('clientData challenge mismatch');
  if (parsed.origin !== input.rpOrigin) fail('clientData origin mismatch');
}

/**
 * DER ECDSA-Sig-Value → IEEE P1363 (r ‖ s, 32 bytes each), which is what
 * WebCrypto's ECDSA verify consumes. WebAuthn signatures are DER.
 */
function derToP1363(der: Uint8Array): Uint8Array {
  let offset = 0;
  const expect = (tag: number): number => {
    if (der[offset] !== tag) fail('malformed DER signature');
    offset += 1;
    const length = der[offset];
    if (length === undefined || length > 0x80 + 2) fail('malformed DER signature');
    offset += 1;
    if (length <= 0x7f) return length;
    // Long form: 1 or 2 length bytes (P-256 integers never need more).
    let resolved = 0;
    for (let i = 0; i < length - 0x80; i += 1) {
      resolved = resolved * 256 + (der[offset] ?? fail('malformed DER signature'));
      offset += 1;
    }
    return resolved;
  };
  expect(0x30);
  const out = new Uint8Array(64);
  for (const half of [0, 1]) {
    let length = expect(0x02);
    let start = offset;
    offset += length;
    if (offset > der.length) fail('malformed DER signature');
    // Strip leading zero padding; then the integer must fit in 32 bytes.
    while (length > 0 && der[start] === 0) {
      start += 1;
      length -= 1;
    }
    if (length > 32) fail('malformed DER signature');
    out.set(der.subarray(start, start + length), half * 32 + (32 - length));
  }
  if (offset !== der.length) fail('malformed DER signature');
  return out;
}

function importParams(alg: PasskeyCoseAlg): { import: RsaHashedImportParams | EcKeyImportParams; verify: AlgorithmIdentifier | EcdsaParams } {
  if (alg === -7) {
    return {
      import: { name: 'ECDSA', namedCurve: 'P-256' },
      verify: { name: 'ECDSA', hash: 'SHA-256' },
    };
  }
  return {
    import: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    verify: { name: 'RSASSA-PKCS1-v1_5' },
  };
}

/** Copies bytes into a fresh ArrayBuffer (WebCrypto BufferSource typing). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;

/**
 * Verifies a webauthn.get assertion end to end: clientData (type, challenge,
 * origin), authenticatorData (rpIdHash, user-present AND user-verified), and
 * the signature under the enrolled credential public key. Throws
 * WebAuthnVerifyError on any mismatch.
 */
export async function verifyAssertion(input: {
  publicKeySpkiB64: string;
  publicKeyAlg: PasskeyCoseAlg;
  clientDataJSONB64: string;
  authenticatorDataB64: string;
  signatureB64: string;
  challengeB64: string;
  rpOrigin: string;
}): Promise<void> {
  verifyClientData({
    clientDataJSONB64: input.clientDataJSONB64,
    expectedType: 'webauthn.get',
    challengeB64: input.challengeB64,
    rpOrigin: input.rpOrigin,
  });

  const authenticatorData = base64ToBytes(input.authenticatorDataB64);
  if (authenticatorData.length < 37) fail('authenticatorData too short');
  // Chromium rewrites an extension's effective RP ID to the full serialized
  // origin (A0 §1), so rpIdHash must be SHA-256 of exactly that string.
  const rpIdHash = await sha256(new TextEncoder().encode(input.rpOrigin));
  for (let i = 0; i < 32; i += 1) {
    if (authenticatorData[i] !== rpIdHash[i]) fail('rpIdHash mismatch');
  }
  const flags = authenticatorData[32] ?? 0;
  if ((flags & FLAG_UP) === 0) fail('user-present flag not set');
  if ((flags & FLAG_UV) === 0) fail('user-verified flag not set');

  const params = importParams(input.publicKeyAlg);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'spki',
      toArrayBuffer(base64ToBytes(input.publicKeySpkiB64)),
      params.import,
      false,
      ['verify'],
    );
  } catch {
    fail('credential public key rejected');
  }
  const rawSignature = base64ToBytes(input.signatureB64);
  const signature = input.publicKeyAlg === -7 ? derToP1363(rawSignature) : rawSignature;
  const clientDataHash = await sha256(base64ToBytes(input.clientDataJSONB64));
  const signedBytes = new Uint8Array(authenticatorData.length + clientDataHash.length);
  signedBytes.set(authenticatorData, 0);
  signedBytes.set(clientDataHash, authenticatorData.length);
  const valid = await crypto.subtle.verify(
    params.verify,
    key,
    toArrayBuffer(signature),
    toArrayBuffer(signedBytes),
  );
  if (!valid) fail('assertion signature invalid');
}
