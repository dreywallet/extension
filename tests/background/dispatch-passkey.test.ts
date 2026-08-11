/**
 * Wire-level checks for the extension-local passkey ops: registry presence,
 * sender gating, payload validation, the locked-privacy gate, and the A2
 * caller-facing error-code assignments for the three A1 VaultError codes.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { dispatch } from '../../src/background/dispatch';
import { vaultErrorToCode } from '../../src/background/errors';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import type { MessageEnvelope, SenderContext } from '@drey/core/messaging/envelope';
import { OP_SCHEMAS } from '@drey/core/messaging/ops';
import { bytesToBase64 } from '@drey/core/domain/vault/encoding';
import { PASSWORD } from '@drey/core/testing/vault-helpers';
import { EXTENSION_OP_SCHEMAS } from '../../src/messaging/extension-ops';
import { PASSKEY_OP_SCHEMAS } from '../../src/messaging/passkey-ops';
import { SoftwarePasskey } from '../helpers/software-passkey';
import { makeHarness } from './service-helpers';

beforeAll(async () => {
  await installTestCryptoProvider();
});

const RP_ORIGIN = `chrome-extension://${'c'.repeat(32)}`;
const CREDENTIAL_ID = bytesToBase64(Uint8Array.from({ length: 16 }, (_, i) => i + 1));
const PRF_SALT = bytesToBase64(Uint8Array.from({ length: 32 }, (_, i) => i + 2));
const PRF_OUTPUT = bytesToBase64(Uint8Array.from({ length: 32 }, (_, i) => i + 3));
/** Shape-valid (canonical, right-sized) assertion evidence for payload tests. */
const DUMMY_EVIDENCE = {
  assertionClientDataJSONB64: bytesToBase64(new TextEncoder().encode('{}')),
  assertionAuthenticatorDataB64: bytesToBase64(new Uint8Array(37)),
  assertionSignatureB64: bytesToBase64(new Uint8Array(8)),
};

function env(sender: SenderContext, op: string, payload: unknown): MessageEnvelope {
  return { protocolVersion: 1, requestId: 'req-0', sender, op, payload };
}

async function readySetup() {
  const h = makeHarness(undefined, { passkeyRpOrigin: RP_ORIGIN });
  const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
  const { sessionId } = await h.service.unlock({ vaultId, password: PASSWORD });
  return { h, vaultId, expectation: { expectedVaultId: vaultId, expectedSessionId: sessionId } };
}

describe('passkey op registry', () => {
  it('extends the core registry without shadowing any core op', () => {
    for (const op of Object.keys(PASSKEY_OP_SCHEMAS)) {
      expect(op in OP_SCHEMAS, op).toBe(false);
      expect(op in EXTENSION_OP_SCHEMAS, op).toBe(true);
    }
  });

  it('no passkey response schema accepts secret-bearing fields', () => {
    // Spot the invariant, not each schema: strict response objects reject any
    // extra field, so a handler bug cannot smuggle PRF output or a DEK out.
    for (const [op, spec] of Object.entries(PASSKEY_OP_SCHEMAS)) {
      expect(
        spec.response.safeParse({ prfOutputB64: PRF_OUTPUT, dekB64: PRF_OUTPUT }).success,
        op,
      ).toBe(false);
    }
  });

  it('gates every passkey op to trusted senders', async () => {
    const { service } = makeHarness();
    for (const op of Object.keys(PASSKEY_OP_SCHEMAS)) {
      expect(PASSKEY_OP_SCHEMAS[op as keyof typeof PASSKEY_OP_SCHEMAS].allowedSenders, op)
        .not.toContain('approval');
      expect(await dispatch(env('content-bridge', op, {}), service)).toEqual({
        ok: false,
        code: 'ERR_UNAUTHORIZED_CONTEXT',
      });
    }
  });

  it('rejects malformed payloads (non-canonical base64 PRF output)', async () => {
    const { h, vaultId } = await readySetup();
    expect(
      await dispatch(
        env('popup', 'passkey.unlock', {
          vaultId,
          credentialIdB64: CREDENTIAL_ID,
          prfOutputB64: PRF_OUTPUT.slice(0, -1), // padding stripped: aliasing spelling
          ...DUMMY_EVIDENCE,
        }),
        h.service,
      ),
    ).toEqual({ ok: false, code: 'ERR_INVALID_PAYLOAD' });
    // Assertion evidence is mandatory: a bare PRF output is not a valid request.
    expect(
      await dispatch(
        env('popup', 'passkey.unlock', {
          vaultId,
          credentialIdB64: CREDENTIAL_ID,
          prfOutputB64: PRF_OUTPUT,
        }),
        h.service,
      ),
    ).toEqual({ ok: false, code: 'ERR_INVALID_PAYLOAD' });
  });

  it('applies the locked-privacy gate to session-bound passkey ops', async () => {
    const { h, expectation } = await readySetup();
    await h.service.lock();
    expect(await dispatch(env('popup', 'passkey.list', { ...expectation }), h.service)).toEqual({
      ok: false,
      code: 'ERR_LOCKED',
    });
  });

  it('answers passkey.challenge while locked (like vault.list)', async () => {
    const { h, vaultId } = await readySetup();
    await h.service.lock();
    expect(await dispatch(env('popup', 'passkey.challenge', { vaultId }), h.service)).toEqual({
      ok: true,
      result: { available: true, entries: [], invalidCount: 0 },
    });
  });
});

describe('A2 caller-facing wire codes', () => {
  it('maps the three A1 passkey VaultError codes onto passkey wire codes', () => {
    expect(vaultErrorToCode('identity-mismatch')).toBe('ERR_PASSKEY_IDENTITY_MISMATCH');
    expect(vaultErrorToCode('invalid-prf-output')).toBe('ERR_PASSKEY_INVALID_PRF');
    expect(vaultErrorToCode('duplicate-credential')).toBe('ERR_PASSKEY_DUPLICATE');
  });

  it('surfaces ERR_PASSKEY_DUPLICATE and ERR_PASSKEY_INVALID_PRF over the wire', async () => {
    const { h, vaultId, expectation } = await readySetup();
    const passkey = await SoftwarePasskey.create(CREDENTIAL_ID);
    const enrollOnce = async () => {
      const begin = await dispatch(
        env('fullpage', 'passkey.beginEnrollment', { password: PASSWORD, ...expectation }),
        h.service,
      );
      if (!begin.ok) return begin;
      const grant = begin.result as {
        authorizationId: string;
        createChallengeB64: string;
        getChallengeB64: string;
      };
      return dispatch(
        env('fullpage', 'passkey.enroll', {
          authorizationId: grant.authorizationId,
          credentialIdB64: passkey.credentialIdB64,
          prfSaltB64: PRF_SALT,
          prfOutputB64: PRF_OUTPUT,
          label: 'key',
          publicKeySpkiB64: passkey.publicKeySpkiB64,
          publicKeyAlg: passkey.publicKeyAlg,
          createClientDataJSONB64: passkey.clientData(
            'webauthn.create',
            grant.createChallengeB64,
            RP_ORIGIN,
          ),
          ...(await passkey.assert({ challengeB64: grant.getChallengeB64, rpOrigin: RP_ORIGIN })),
          ...expectation,
        }),
        h.service,
      );
    };
    expect((await enrollOnce()).ok).toBe(true);
    expect(await enrollOnce()).toEqual({ ok: false, code: 'ERR_PASSKEY_DUPLICATE' });
    await h.service.lock();
    const challenge = await h.service.passkeyChallenge({ vaultId });
    expect(
      await dispatch(
        env('popup', 'passkey.unlock', {
          vaultId,
          credentialIdB64: CREDENTIAL_ID,
          prfOutputB64: bytesToBase64(new Uint8Array(32)), // all-zero
          ...(await passkey.assert({
            challengeB64: challenge.challengeB64!,
            rpOrigin: RP_ORIGIN,
          })),
        }),
        h.service,
      ),
    ).toEqual({ ok: false, code: 'ERR_PASSKEY_INVALID_PRF' });
  });

  it('surfaces ERR_PASSKEY_UNAVAILABLE on a channel without a stable identity', async () => {
    const h = makeHarness();
    const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
    expect(
      await dispatch(
        env('popup', 'passkey.unlock', {
          vaultId,
          credentialIdB64: CREDENTIAL_ID,
          prfOutputB64: PRF_OUTPUT,
          ...DUMMY_EVIDENCE,
        }),
        h.service,
      ),
    ).toEqual({ ok: false, code: 'ERR_PASSKEY_UNAVAILABLE' });
  });
});
