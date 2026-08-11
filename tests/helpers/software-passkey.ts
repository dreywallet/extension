/**
 * A software WebAuthn authenticator for unit tests (A2.1): a real ES256
 * keypair via WebCrypto that produces create/get ceremony evidence
 * (clientDataJSON, authenticatorData, DER signature) the worker's verifier
 * accepts, with knobs to tamper with each piece so the fail-closed paths can
 * be proven. No platform WebAuthn credential exists in unit tests.
 */
import { base64ToBytes, bytesToBase64 } from '@drey/core/domain/vault/encoding';

function toBase64Url(b64: string): string {
  return b64.replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.length);
  new Uint8Array(out).set(bytes);
  return out;
}

/** IEEE P1363 (r ‖ s) → DER ECDSA-Sig-Value, the WebAuthn wire encoding. */
export function p1363ToDer(p1363: Uint8Array): Uint8Array {
  const encodeInt = (bytes: Uint8Array): number[] => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const trimmed = Array.from(bytes.subarray(start));
    if ((trimmed[0] ?? 0) & 0x80) trimmed.unshift(0);
    return [0x02, trimmed.length, ...trimmed];
  };
  const body = [...encodeInt(p1363.subarray(0, 32)), ...encodeInt(p1363.subarray(32, 64))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

export interface SoftwareAssertion {
  assertionClientDataJSONB64: string;
  assertionAuthenticatorDataB64: string;
  assertionSignatureB64: string;
}

export class SoftwarePasskey {
  readonly publicKeyAlg = -7 as const;

  private constructor(
    readonly credentialIdB64: string,
    readonly publicKeySpkiB64: string,
    private readonly privateKey: CryptoKey,
  ) {}

  static async create(credentialIdB64: string): Promise<SoftwarePasskey> {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
    return new SoftwarePasskey(credentialIdB64, bytesToBase64(spki), pair.privateKey);
  }

  /** clientDataJSON for either ceremony half, base64-encoded. */
  clientData(
    type: 'webauthn.create' | 'webauthn.get',
    challengeB64: string,
    origin: string,
  ): string {
    return bytesToBase64(
      new TextEncoder().encode(
        JSON.stringify({ type, challenge: toBase64Url(challengeB64), origin, crossOrigin: false }),
      ),
    );
  }

  /**
   * A signed webauthn.get assertion. `flags` defaults to UP|UV (0x05);
   * `authDataRpOrigin` / `clientDataOrigin` default to `rpOrigin` and can be
   * skewed independently to prove each verifier check.
   */
  async assert(input: {
    challengeB64: string;
    rpOrigin: string;
    flags?: number;
    authDataRpOrigin?: string;
    clientDataOrigin?: string;
  }): Promise<SoftwareAssertion> {
    const clientDataJSONB64 = this.clientData(
      'webauthn.get',
      input.challengeB64,
      input.clientDataOrigin ?? input.rpOrigin,
    );
    const rpIdHash = new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        toArrayBuffer(new TextEncoder().encode(input.authDataRpOrigin ?? input.rpOrigin)),
      ),
    );
    const authenticatorData = new Uint8Array(37);
    authenticatorData.set(rpIdHash, 0);
    authenticatorData[32] = input.flags ?? 0x05; // UP | UV; counter stays zero
    const clientDataHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', toArrayBuffer(base64ToBytes(clientDataJSONB64))),
    );
    const signedBytes = new Uint8Array([...authenticatorData, ...clientDataHash]);
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        this.privateKey,
        toArrayBuffer(signedBytes),
      ),
    );
    return {
      assertionClientDataJSONB64: clientDataJSONB64,
      assertionAuthenticatorDataB64: bytesToBase64(authenticatorData),
      assertionSignatureB64: bytesToBase64(p1363ToDer(signature)),
    };
  }
}
