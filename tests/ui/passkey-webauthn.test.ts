/**
 * WebAuthn page adapter (A2.1): the ceremony options must bind the
 * worker-issued challenge, must NOT disclose the wallet name to the
 * authenticator or its cloud sync (review Finding 6), and the adapter must
 * hand back the ceremony evidence the worker verifies. jsdom has no WebAuthn
 * surface, so the globals are stubbed per test.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { base64ToBytes, bytesToBase64 } from '@drey/core/domain/vault/encoding';
import { createPasskeyCredential, getPrfAssertion } from '../../src/ui/passkey/webauthn';

const CHALLENGE = bytesToBase64(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const CREDENTIAL_ID = Uint8Array.from({ length: 16 }, (_, i) => i + 40);

class FakePublicKeyCredential {
  constructor(
    readonly rawId: ArrayBuffer,
    readonly response: unknown,
    private readonly extensionResults: unknown,
  ) {}
  getClientExtensionResults(): unknown {
    return this.extensionResults;
  }
}
class FakeAttestationResponse {
  clientDataJSON = new TextEncoder().encode('{"type":"webauthn.create"}').buffer;
  getPublicKey(): ArrayBuffer {
    return new Uint8Array(91).buffer;
  }
  getPublicKeyAlgorithm(): number {
    return -7;
  }
}
class FakeAssertionResponse {
  clientDataJSON = new TextEncoder().encode('{"type":"webauthn.get"}').buffer;
  authenticatorData = new Uint8Array(37).buffer;
  signature = new Uint8Array(70).buffer;
}

function installWebAuthn(handlers: { create?: (options: never) => unknown; get?: (options: never) => unknown }) {
  vi.stubGlobal('PublicKeyCredential', FakePublicKeyCredential);
  vi.stubGlobal('AuthenticatorAttestationResponse', FakeAttestationResponse);
  vi.stubGlobal('AuthenticatorAssertionResponse', FakeAssertionResponse);
  Object.defineProperty(navigator, 'credentials', {
    configurable: true,
    value: {
      create: (options: never) => Promise.resolve(handlers.create?.(options)),
      get: (options: never) => Promise.resolve(handlers.get?.(options)),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createPasskeyCredential', () => {
  it('binds the worker challenge and never sends a wallet name to the authenticator', async () => {
    let seen: PublicKeyCredentialCreationOptions | undefined;
    installWebAuthn({
      create: (options) => {
        seen = (options as { publicKey: PublicKeyCredentialCreationOptions }).publicKey;
        return new FakePublicKeyCredential(
          CREDENTIAL_ID.slice().buffer,
          new FakeAttestationResponse(),
          { prf: { enabled: true } },
        );
      },
    });
    const created = await createPasskeyCredential({
      challengeB64: CHALLENGE,
      excludeCredentialIdsB64: [],
    });
    expect(created.credentialIdB64).toBe(bytesToBase64(CREDENTIAL_ID));
    expect(created.publicKeyAlg).toBe(-7);
    expect(created.publicKeySpkiB64).toBe(bytesToBase64(new Uint8Array(91)));
    expect(new Uint8Array(seen!.challenge as ArrayBuffer)).toEqual(base64ToBytes(CHALLENGE));
    // Review Finding 6: generic constant only — no wallet name, no user label.
    expect(seen!.user.name).toBe('Drey wallet');
    expect(seen!.user.displayName).toBe('Drey wallet');
    // UV is required and the create-time PRF *result* is never requested.
    expect(seen!.authenticatorSelection?.userVerification).toBe('required');
    expect((seen!.extensions as { prf?: object }).prf).toEqual({});
  });

  it('fails closed when the platform reports no PRF or withholds the public key', async () => {
    installWebAuthn({
      create: () =>
        new FakePublicKeyCredential(CREDENTIAL_ID.slice().buffer, new FakeAttestationResponse(), {
          prf: { enabled: false },
        }),
    });
    await expect(
      createPasskeyCredential({ challengeB64: CHALLENGE, excludeCredentialIdsB64: [] }),
    ).rejects.toMatchObject({ reason: 'prf-unavailable' });

    const noKey = new FakeAttestationResponse();
    noKey.getPublicKey = () => null as unknown as ArrayBuffer;
    installWebAuthn({
      create: () =>
        new FakePublicKeyCredential(CREDENTIAL_ID.slice().buffer, noKey, {
          prf: { enabled: true },
        }),
    });
    await expect(
      createPasskeyCredential({ challengeB64: CHALLENGE, excludeCredentialIdsB64: [] }),
    ).rejects.toMatchObject({ reason: 'unsupported' });
  });
});

describe('getPrfAssertion', () => {
  it('uses the worker challenge and returns the ceremony evidence for verification', async () => {
    let seen: PublicKeyCredentialRequestOptions | undefined;
    const response = new FakeAssertionResponse();
    installWebAuthn({
      get: (options) => {
        seen = (options as { publicKey: PublicKeyCredentialRequestOptions }).publicKey;
        return new FakePublicKeyCredential(CREDENTIAL_ID.slice().buffer, response, {
          prf: { results: { first: new Uint8Array(32).fill(7) } },
        });
      },
    });
    const assertion = await getPrfAssertion({
      challengeB64: CHALLENGE,
      entries: [
        {
          credentialIdB64: bytesToBase64(CREDENTIAL_ID),
          prfEvalInputB64: bytesToBase64(new Uint8Array(52)),
        },
      ],
    });
    expect(new Uint8Array(seen!.challenge as ArrayBuffer)).toEqual(base64ToBytes(CHALLENGE));
    expect(seen!.userVerification).toBe('required');
    expect(assertion.prfOutput).toEqual(new Uint8Array(32).fill(7));
    expect(assertion.clientDataJSONB64).toBe(
      bytesToBase64(new Uint8Array(response.clientDataJSON)),
    );
    expect(assertion.authenticatorDataB64).toBe(bytesToBase64(new Uint8Array(37)));
    expect(assertion.signatureB64).toBe(bytesToBase64(new Uint8Array(70)));
  });
});
