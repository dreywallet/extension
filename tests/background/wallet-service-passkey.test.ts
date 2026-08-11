/**
 * Workstream A2/A2.1: passkey enroll / unlock / list / rename / remove state
 * machine over synthetic PRF outputs and a software authenticator (real ES256
 * signatures — no platform WebAuthn credential exists in unit tests). Covers
 * the exit-gate fail-closed paths plus the A2.1 review's negative list:
 * challenge replay after lock/restart, arbitrary non-WebAuthn enrollment
 * material, password rejection before any ceremony, aliased and duplicate
 * credential IDs, orphaned-vault envelopes, partial vault removal, storage
 * caps, and password-path independence.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { bytesToBase64 } from '@drey/core/domain/vault/encoding';
import { PASSWORD } from '@drey/core/testing/vault-helpers';
import { getSession } from '../../src/adapters/session/session-store';
import { loadVaults, saveVaults } from '../../src/adapters/storage/vault-store';
import {
  loadPasskeyEnvelopes,
  savePasskeyEnvelopes,
  type RawPasskeyEnvelope,
} from '../../src/adapters/storage/passkey-store';
import {
  loadPasskeyCredentials,
  savePasskeyCredentials,
} from '../../src/adapters/storage/passkey-credentials';
import type { WalletCachePort } from '../../src/adapters/storage/wallet-cache';
import type { WalletService } from '../../src/background/wallet-service';
import {
  MAX_PASSKEY_RECORDS_PER_VAULT,
  MAX_PASSKEY_RECORDS_TOTAL,
  PASSKEY_GRANT_TTL_MS,
} from '../../src/background/wallet-service';
import { SoftwarePasskey } from '../helpers/software-passkey';
import { DEFAULT_IDLE_MS, makeHarness, type Harness } from './service-helpers';

beforeAll(async () => {
  await installTestCryptoProvider();
});

const RP_ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const OTHER_RP_ORIGIN = `chrome-extension://${'b'.repeat(32)}`;

const CREDENTIAL_ID = bytesToBase64(Uint8Array.from({ length: 16 }, (_, i) => 0x40 + i));
const OTHER_CREDENTIAL_ID = bytesToBase64(Uint8Array.from({ length: 16 }, (_, i) => 0x80 + i));
const PRF_SALT = bytesToBase64(Uint8Array.from({ length: 32 }, (_, i) => 255 - i));

function prfOutput(seed = 1): Uint8Array {
  return Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + seed * 13) % 255 | 1);
}

interface Setup {
  h: Harness;
  vaultId: string;
  expectation: { expectedVaultId: string; expectedSessionId: string };
}

async function setup(overrides: Parameters<typeof makeHarness>[1] = {}): Promise<Setup> {
  const h = makeHarness(undefined, { passkeyRpOrigin: RP_ORIGIN, ...overrides });
  const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
  const unlocked = await h.service.unlock({ vaultId, password: PASSWORD });
  return {
    h,
    vaultId,
    expectation: { expectedVaultId: vaultId, expectedSessionId: unlocked.sessionId },
  };
}

/** Full A2.1 enrollment: begin (password) → evidence → enroll. */
async function enroll(
  s: Setup,
  opts: { seed?: number; credentialIdB64?: string; passkey?: SoftwarePasskey; label?: string } = {},
) {
  const passkey =
    opts.passkey ?? (await SoftwarePasskey.create(opts.credentialIdB64 ?? CREDENTIAL_ID));
  const begin = await s.h.service.passkeyBeginEnrollment({
    password: PASSWORD,
    ...s.expectation,
  });
  const assertion = await passkey.assert({
    challengeB64: begin.getChallengeB64,
    rpOrigin: RP_ORIGIN,
  });
  const result = await s.h.service.passkeyEnroll({
    authorizationId: begin.authorizationId,
    credentialIdB64: passkey.credentialIdB64,
    prfSaltB64: PRF_SALT,
    prfOutputB64: bytesToBase64(prfOutput(opts.seed ?? 1)),
    label: opts.label ?? 'MacBook Touch ID',
    publicKeySpkiB64: passkey.publicKeySpkiB64,
    publicKeyAlg: passkey.publicKeyAlg,
    createClientDataJSONB64: passkey.clientData(
      'webauthn.create',
      begin.createChallengeB64,
      RP_ORIGIN,
    ),
    ...assertion,
    ...s.expectation,
  });
  return { passkey, result };
}

/** Full A2.1 unlock: challenge → fresh signed assertion → unlock. */
async function passkeyUnlock(
  s: Setup,
  passkey: SoftwarePasskey,
  opts: {
    seed?: number;
    vaultId?: string;
    credentialIdB64?: string;
    service?: WalletService;
    tamperBeforeUnlock?: () => Promise<void>;
  } = {},
) {
  const service = opts.service ?? s.h.service;
  const vaultId = opts.vaultId ?? s.vaultId;
  const challenge = await service.passkeyChallenge({ vaultId });
  if (challenge.challengeB64 === undefined) throw new Error('no challenge offered');
  const assertion = await passkey.assert({
    challengeB64: challenge.challengeB64,
    rpOrigin: RP_ORIGIN,
  });
  await opts.tamperBeforeUnlock?.();
  return service.passkeyUnlock({
    vaultId,
    credentialIdB64: opts.credentialIdB64 ?? passkey.credentialIdB64,
    prfOutputB64: bytesToBase64(prfOutput(opts.seed ?? 1)),
    ...assertion,
  });
}

describe('passkey enrollment', () => {
  it('persists one envelope + bound public key after a verified round-trip and offers it while locked', async () => {
    const s = await setup();
    const { result } = await enroll(s);
    expect(result).toEqual({
      credentialIdB64: CREDENTIAL_ID,
      label: 'MacBook Touch ID',
      createdAtMs: expect.any(Number),
    });
    const credentials = await loadPasskeyCredentials(s.h.local);
    expect(credentials).toEqual([
      {
        vaultId: s.vaultId,
        credentialIdB64: CREDENTIAL_ID,
        publicKeyAlg: -7,
        publicKeySpkiB64: expect.any(String),
        createdAtMs: result.createdAtMs,
      },
    ]);

    await s.h.service.lock();
    const challenge = await s.h.service.passkeyChallenge({ vaultId: s.vaultId });
    expect(challenge.available).toBe(true);
    expect(challenge.invalidCount).toBe(0);
    expect(challenge.entries).toHaveLength(1);
    expect(challenge.challengeB64).toEqual(expect.any(String));
    expect(challenge.entries[0]).toMatchObject({
      credentialIdB64: CREDENTIAL_ID,
      label: 'MacBook Touch ID',
    });
    // Eval input = utf8("drey-passkey-prf/v1") ‖ 0x00 ‖ salt(32).
    expect(challenge.entries[0]!.prfEvalInputB64).toBe(
      bytesToBase64(
        Uint8Array.from([
          ...new TextEncoder().encode('drey-passkey-prf/v1'),
          0,
          ...Uint8Array.from({ length: 32 }, (_, i) => 255 - i),
        ]),
      ),
    );
  });

  it('refuses enrollment on a channel without a stable RP identity', async () => {
    const h = makeHarness(); // no passkeyRpOrigin
    const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
    const { sessionId } = await h.service.unlock({ vaultId, password: PASSWORD });
    await expect(
      h.service.passkeyBeginEnrollment({
        password: PASSWORD,
        expectedVaultId: vaultId,
        expectedSessionId: sessionId,
      }),
    ).rejects.toMatchObject({ code: 'ERR_PASSKEY_UNAVAILABLE' });
    expect(await loadPasskeyEnvelopes(h.local)).toEqual([]);
    // The challenge op likewise reports unavailability instead of offering.
    expect(await h.service.passkeyChallenge({ vaultId })).toEqual({
      available: false,
      entries: [],
      invalidCount: 0,
    });
  });

  it('rejects a wrong password at beginEnrollment — before any ceremony exists', async () => {
    const s = await setup();
    await expect(
      s.h.service.passkeyBeginEnrollment({
        password: 'not-the-password',
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'wrong-password' });
    expect(await loadPasskeyEnvelopes(s.h.local)).toEqual([]);
  });

  it('requires a live matching session (stale expectation is a lock)', async () => {
    const s = await setup();
    await expect(
      s.h.service.passkeyBeginEnrollment({
        password: PASSWORD,
        expectedVaultId: s.vaultId,
        expectedSessionId: '00000000-0000-4000-8000-999999999999',
      }),
    ).rejects.toMatchObject({ code: 'ERR_LOCKED' });
  });

  it('rejects enrollment without a beginEnrollment authorization', async () => {
    const s = await setup();
    const passkey = await SoftwarePasskey.create(CREDENTIAL_ID);
    const assertion = await passkey.assert({
      challengeB64: bytesToBase64(new Uint8Array(32).fill(9)),
      rpOrigin: RP_ORIGIN,
    });
    await expect(
      s.h.service.passkeyEnroll({
        authorizationId: '00000000-0000-4000-8000-424242424242',
        credentialIdB64: passkey.credentialIdB64,
        prfSaltB64: PRF_SALT,
        prfOutputB64: bytesToBase64(prfOutput()),
        label: 'x',
        publicKeySpkiB64: passkey.publicKeySpkiB64,
        publicKeyAlg: passkey.publicKeyAlg,
        createClientDataJSONB64: passkey.clientData(
          'webauthn.create',
          bytesToBase64(new Uint8Array(32).fill(8)),
          RP_ORIGIN,
        ),
        ...assertion,
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_PASSKEY_UNAVAILABLE' });
    expect(await loadPasskeyEnvelopes(s.h.local)).toEqual([]);
  });

  it('an authorization is single-use and expires', async () => {
    const s = await setup();
    const passkey = await SoftwarePasskey.create(CREDENTIAL_ID);
    const begin = await s.h.service.passkeyBeginEnrollment({
      password: PASSWORD,
      ...s.expectation,
    });
    const request = async () =>
      s.h.service.passkeyEnroll({
        authorizationId: begin.authorizationId,
        credentialIdB64: passkey.credentialIdB64,
        prfSaltB64: PRF_SALT,
        prfOutputB64: bytesToBase64(prfOutput()),
        label: 'x',
        publicKeySpkiB64: passkey.publicKeySpkiB64,
        publicKeyAlg: passkey.publicKeyAlg,
        createClientDataJSONB64: passkey.clientData(
          'webauthn.create',
          begin.createChallengeB64,
          RP_ORIGIN,
        ),
        ...(await passkey.assert({ challengeB64: begin.getChallengeB64, rpOrigin: RP_ORIGIN })),
        ...s.expectation,
      });
    await expect(request()).resolves.toMatchObject({ credentialIdB64: CREDENTIAL_ID });
    // Second use of the same authorization is refused (already consumed).
    await expect(request()).rejects.toMatchObject({ code: 'ERR_PASSKEY_UNAVAILABLE' });

    // A fresh authorization expires after its TTL.
    const begin2 = await s.h.service.passkeyBeginEnrollment({
      password: PASSWORD,
      ...s.expectation,
    });
    s.h.clock.now += PASSKEY_GRANT_TTL_MS + 1;
    const other = await SoftwarePasskey.create(OTHER_CREDENTIAL_ID);
    await expect(
      s.h.service.passkeyEnroll({
        authorizationId: begin2.authorizationId,
        credentialIdB64: other.credentialIdB64,
        prfSaltB64: PRF_SALT,
        prfOutputB64: bytesToBase64(prfOutput(2)),
        label: 'x',
        publicKeySpkiB64: other.publicKeySpkiB64,
        publicKeyAlg: other.publicKeyAlg,
        createClientDataJSONB64: other.clientData(
          'webauthn.create',
          begin2.createChallengeB64,
          RP_ORIGIN,
        ),
        ...(await other.assert({ challengeB64: begin2.getChallengeB64, rpOrigin: RP_ORIGIN })),
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_PASSKEY_UNAVAILABLE' });
  });

  it('rejects arbitrary non-WebAuthn enrollment material (bad signature / wrong challenge / no UV)', async () => {
    const s = await setup();
    const passkey = await SoftwarePasskey.create(CREDENTIAL_ID);
    const impostor = await SoftwarePasskey.create(CREDENTIAL_ID); // different keypair
    const attempt = async (evidence: {
      assertionClientDataJSONB64: string;
      assertionAuthenticatorDataB64: string;
      assertionSignatureB64: string;
    }, createChallengeB64?: string) => {
      const begin = await s.h.service.passkeyBeginEnrollment({
        password: PASSWORD,
        ...s.expectation,
      });
      return s.h.service.passkeyEnroll({
        authorizationId: begin.authorizationId,
        credentialIdB64: passkey.credentialIdB64,
        prfSaltB64: PRF_SALT,
        prfOutputB64: bytesToBase64(prfOutput()),
        label: 'x',
        publicKeySpkiB64: passkey.publicKeySpkiB64,
        publicKeyAlg: passkey.publicKeyAlg,
        createClientDataJSONB64: passkey.clientData(
          'webauthn.create',
          createChallengeB64 ?? begin.createChallengeB64,
          RP_ORIGIN,
        ),
        ...evidence,
        ...s.expectation,
      });
    };
    // Signature from a different private key than the supplied public key.
    await expect(
      attempt(await impostor.assert({
        challengeB64: bytesToBase64(new Uint8Array(32).fill(1)),
        rpOrigin: RP_ORIGIN,
      })),
    ).rejects.toMatchObject({ code: 'ERR_PASSKEY_INVALID_PRF' });
    // Correct key but an attacker-chosen (non-worker) challenge.
    await expect(
      attempt(await passkey.assert({
        challengeB64: bytesToBase64(new Uint8Array(32).fill(2)),
        rpOrigin: RP_ORIGIN,
      })),
    ).rejects.toMatchObject({ code: 'ERR_PASSKEY_INVALID_PRF' });
    // Stale create clientData (bound to a mismatched create challenge).
    await expect(
      attempt(
        await passkey.assert({
          challengeB64: bytesToBase64(new Uint8Array(32).fill(3)),
          rpOrigin: RP_ORIGIN,
        }),
        bytesToBase64(new Uint8Array(32).fill(4)),
      ),
    ).rejects.toMatchObject({ code: 'ERR_PASSKEY_INVALID_PRF' });
    expect(await loadPasskeyEnvelopes(s.h.local)).toEqual([]);
    expect(await loadPasskeyCredentials(s.h.local)).toEqual([]);
  });

  it('rejects an all-zero PRF output before wrapping', async () => {
    const s = await setup();
    const passkey = await SoftwarePasskey.create(CREDENTIAL_ID);
    const begin = await s.h.service.passkeyBeginEnrollment({
      password: PASSWORD,
      ...s.expectation,
    });
    await expect(
      s.h.service.passkeyEnroll({
        authorizationId: begin.authorizationId,
        credentialIdB64: passkey.credentialIdB64,
        prfSaltB64: PRF_SALT,
        prfOutputB64: bytesToBase64(new Uint8Array(32)),
        label: 'x',
        publicKeySpkiB64: passkey.publicKeySpkiB64,
        publicKeyAlg: passkey.publicKeyAlg,
        createClientDataJSONB64: passkey.clientData(
          'webauthn.create',
          begin.createChallengeB64,
          RP_ORIGIN,
        ),
        ...(await passkey.assert({ challengeB64: begin.getChallengeB64, rpOrigin: RP_ORIGIN })),
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'invalid-prf-output' });
    expect(await loadPasskeyEnvelopes(s.h.local)).toEqual([]);
  });

  it('enforces one envelope per credential per wallet', async () => {
    const s = await setup();
    await enroll(s);
    await expect(enroll(s, { seed: 2 })).rejects.toMatchObject({ code: 'ERR_PASSKEY_DUPLICATE' });
    expect(await loadPasskeyEnvelopes(s.h.local)).toHaveLength(1);
    // A second credential for the same wallet is fine.
    const second = await enroll(s, { seed: 3, credentialIdB64: OTHER_CREDENTIAL_ID });
    expect(second.result).toMatchObject({ credentialIdB64: OTHER_CREDENTIAL_ID });
  });

  it('an aliased (noncanonical base64) unparseable record still collides (review Finding 3)', async () => {
    const s = await setup();
    // Same credential-ID BYTES, spelled without padding: unparseable by the
    // envelope schema, but attributable to this vault.
    await savePasskeyEnvelopes(s.h.local, [
      { vaultId: s.vaultId, credentialIdB64: CREDENTIAL_ID.replace(/=+$/u, '') },
    ]);
    await expect(enroll(s)).rejects.toMatchObject({ code: 'ERR_PASSKEY_DUPLICATE' });
    expect(await loadPasskeyEnvelopes(s.h.local)).toHaveLength(1); // only the alias record
  });

  it('enforces the per-vault storage cap', async () => {
    const s = await setup();
    await savePasskeyEnvelopes(
      s.h.local,
      Array.from({ length: MAX_PASSKEY_RECORDS_PER_VAULT }, (_, i) => ({
        vaultId: s.vaultId,
        credentialIdB64: `junk-${i}`,
      })),
    );
    await expect(
      s.h.service.passkeyBeginEnrollment({ password: PASSWORD, ...s.expectation }),
    ).rejects.toMatchObject({ code: 'ERR_PASSKEY_UNAVAILABLE' });
  });
});

describe('passkey unlock', () => {
  it('unlocks with a verified fresh assertion and installs a normal session', async () => {
    const s = await setup();
    const { passkey } = await enroll(s);
    await s.h.service.lock();

    const result = await passkeyUnlock(s, passkey);
    expect(result.vaultId).toBe(s.vaultId);
    expect(result.deadline).toBe(s.h.clock.now + DEFAULT_IDLE_MS);
    expect((await s.h.service.sessionStatus()).locked).toBe(false);
    const session = await getSession(s.h.session);
    expect(session?.vaultId).toBe(s.vaultId);
  });

  it('a captured PRF output + assertion cannot be replayed after a lock (review Finding 1)', async () => {
    const s = await setup();
    const { passkey } = await enroll(s);
    await s.h.service.lock();
    const challenge = await s.h.service.passkeyChallenge({ vaultId: s.vaultId });
    const assertion = await passkey.assert({
      challengeB64: challenge.challengeB64!,
      rpOrigin: RP_ORIGIN,
    });
    const request = {
      vaultId: s.vaultId,
      credentialIdB64: CREDENTIAL_ID,
      prfOutputB64: bytesToBase64(prfOutput()),
      ...assertion,
    };
    await expect(s.h.service.passkeyUnlock(request)).resolves.toMatchObject({
      vaultId: s.vaultId,
    });
    await s.h.service.lock();
    // Same bytes, no fresh ceremony: the challenge was consumed.
    await expect(s.h.service.passkeyUnlock(request)).rejects.toMatchObject({
      code: 'ERR_PASSKEY_UNAVAILABLE',
    });
    expect((await s.h.service.sessionStatus()).locked).toBe(true);
  });

  it('a challenge is consumed even by a FAILED unlock, expires, and dies with the worker', async () => {
    const s = await setup();
    const { passkey } = await enroll(s);
    await s.h.service.lock();

    // Failure consumes: wrong PRF output, then a retry with the same assertion.
    const challenge = await s.h.service.passkeyChallenge({ vaultId: s.vaultId });
    const assertion = await passkey.assert({
      challengeB64: challenge.challengeB64!,
      rpOrigin: RP_ORIGIN,
    });
    const bad = {
      vaultId: s.vaultId,
      credentialIdB64: CREDENTIAL_ID,
      prfOutputB64: bytesToBase64(prfOutput(99)),
      ...assertion,
    };
    await expect(s.h.service.passkeyUnlock(bad)).rejects.toMatchObject({ code: 'decrypt-failed' });
    await expect(
      s.h.service.passkeyUnlock({ ...bad, prfOutputB64: bytesToBase64(prfOutput()) }),
    ).rejects.toMatchObject({ code: 'ERR_PASSKEY_UNAVAILABLE' });

    // Expiry.
    const challenge2 = await s.h.service.passkeyChallenge({ vaultId: s.vaultId });
    const assertion2 = await passkey.assert({
      challengeB64: challenge2.challengeB64!,
      rpOrigin: RP_ORIGIN,
    });
    s.h.clock.now += PASSKEY_GRANT_TTL_MS + 1;
    await expect(
      s.h.service.passkeyUnlock({
        vaultId: s.vaultId,
        credentialIdB64: CREDENTIAL_ID,
        prfOutputB64: bytesToBase64(prfOutput()),
        ...assertion2,
      }),
    ).rejects.toMatchObject({ code: 'ERR_PASSKEY_UNAVAILABLE' });

    // MV3 restart: challenges are worker memory and vanish.
    const challenge3 = await s.h.service.passkeyChallenge({ vaultId: s.vaultId });
    const assertion3 = await passkey.assert({
      challengeB64: challenge3.challengeB64!,
      rpOrigin: RP_ORIGIN,
    });
    const restarted = s.h.rebuild();
    await expect(
      restarted.passkeyUnlock({
        vaultId: s.vaultId,
        credentialIdB64: CREDENTIAL_ID,
        prfOutputB64: bytesToBase64(prfOutput()),
        ...assertion3,
      }),
    ).rejects.toMatchObject({ code: 'ERR_PASSKEY_UNAVAILABLE' });
    expect((await restarted.sessionStatus()).locked).toBe(true);
  });

  it('rejects assertions that fail verification (wrong key, no UV, wrong rpIdHash, wrong origin)', async () => {
    const s = await setup();
    const { passkey } = await enroll(s);
    await s.h.service.lock();
    const impostor = await SoftwarePasskey.create(CREDENTIAL_ID);

    const cases: ((challengeB64: string) => ReturnType<SoftwarePasskey['assert']>)[] = [
      (c) => impostor.assert({ challengeB64: c, rpOrigin: RP_ORIGIN }), // wrong private key
      (c) => passkey.assert({ challengeB64: c, rpOrigin: RP_ORIGIN, flags: 0x01 }), // UP without UV
      (c) => passkey.assert({ challengeB64: c, rpOrigin: RP_ORIGIN, authDataRpOrigin: OTHER_RP_ORIGIN }),
      (c) => passkey.assert({ challengeB64: c, rpOrigin: RP_ORIGIN, clientDataOrigin: OTHER_RP_ORIGIN }),
    ];
    for (const makeEvidence of cases) {
      const challenge = await s.h.service.passkeyChallenge({ vaultId: s.vaultId });
      await expect(
        s.h.service.passkeyUnlock({
          vaultId: s.vaultId,
          credentialIdB64: CREDENTIAL_ID,
          prfOutputB64: bytesToBase64(prfOutput()),
          ...(await makeEvidence(challenge.challengeB64!)),
        }),
      ).rejects.toMatchObject({ code: 'ERR_PASSKEY_INVALID_PRF' });
      expect((await s.h.service.sessionStatus()).locked).toBe(true);
    }
  });

  it('rejects a wrong PRF output and stays locked', async () => {
    const s = await setup();
    const { passkey } = await enroll(s);
    await s.h.service.lock();
    await expect(passkeyUnlock(s, passkey, { seed: 99 })).rejects.toMatchObject({
      code: 'decrypt-failed',
    });
    expect((await s.h.service.sessionStatus()).locked).toBe(true);
  });

  it('rejects an all-zero PRF output without touching the AEAD', async () => {
    const s = await setup();
    const { passkey } = await enroll(s);
    await s.h.service.lock();
    const challenge = await s.h.service.passkeyChallenge({ vaultId: s.vaultId });
    await expect(
      s.h.service.passkeyUnlock({
        vaultId: s.vaultId,
        credentialIdB64: CREDENTIAL_ID,
        prfOutputB64: bytesToBase64(new Uint8Array(32)),
        ...(await passkey.assert({ challengeB64: challenge.challengeB64!, rpOrigin: RP_ORIGIN })),
      }),
    ).rejects.toMatchObject({ code: 'invalid-prf-output' });
  });

  it('fails closed on an unknown credential or vault', async () => {
    const s = await setup();
    const { passkey } = await enroll(s);
    await s.h.service.lock();
    await expect(
      passkeyUnlock(s, passkey, { credentialIdB64: OTHER_CREDENTIAL_ID }),
    ).rejects.toMatchObject({ code: 'ERR_PASSKEY_UNAVAILABLE' });
    // A vault with no record gets no challenge at all — and a forged request
    // against it cannot name an outstanding challenge.
    expect(await s.h.service.passkeyChallenge({ vaultId: 'missing-vault' })).toEqual({
      available: true,
      entries: [],
      invalidCount: 0,
    });
    const challenge = await s.h.service.passkeyChallenge({ vaultId: s.vaultId });
    await expect(
      s.h.service.passkeyUnlock({
        vaultId: 'missing-vault',
        credentialIdB64: CREDENTIAL_ID,
        prfOutputB64: bytesToBase64(prfOutput()),
        ...(await passkey.assert({ challengeB64: challenge.challengeB64!, rpOrigin: RP_ORIGIN })),
      }),
    ).rejects.toMatchObject({ code: 'ERR_PASSKEY_UNAVAILABLE' });
  });

  it('an envelope bound to a different build identity is never offered and cannot unlock', async () => {
    const s = await setup();
    await enroll(s);
    await s.h.service.lock();
    const vaults = await loadVaults(s.h.local);
    const envelopes = await loadPasskeyEnvelopes(s.h.local);
    const credentials = await loadPasskeyCredentials(s.h.local);

    for (const overrides of [
      { passkeyRpOrigin: OTHER_RP_ORIGIN }, // different reviewed build
      { passkeyRpOrigin: RP_ORIGIN, network: 'signet' as const }, // different network
    ]) {
      const foreign = makeHarness(s.h.clock.now, overrides);
      await saveVaults(foreign.local, vaults);
      await savePasskeyEnvelopes(foreign.local, envelopes);
      await savePasskeyCredentials(foreign.local, credentials);
      // Never offered — a mismatched envelope must not provoke a ceremony,
      // so no challenge is minted and no unlock request can even begin.
      const challenge = await foreign.service.passkeyChallenge({ vaultId: s.vaultId });
      expect(challenge).toEqual({ available: true, entries: [], invalidCount: 1 });
      expect((await foreign.service.sessionStatus()).locked).toBe(true);
    }
    // The original identity still accepts the same stored envelope.
    const challenge = await s.h.rebuild().passkeyChallenge({ vaultId: s.vaultId });
    expect(challenge.entries).toHaveLength(1);
  });

  it('identity is re-checked at unwrap even if storage changes after the challenge', async () => {
    const s = await setup();
    const { passkey } = await enroll(s);
    await s.h.service.lock();
    await expect(
      passkeyUnlock(s, passkey, {
        tamperBeforeUnlock: async () => {
          const [stored] = await loadPasskeyEnvelopes(s.h.local);
          await savePasskeyEnvelopes(s.h.local, [
            { ...stored, network: 'signet' } as RawPasskeyEnvelope,
          ]);
        },
      }),
    ).rejects.toMatchObject({ code: 'identity-mismatch' });
    expect((await s.h.service.sessionStatus()).locked).toBe(true);
  });

  it('a schema-tampered stored record is never offered and cannot unlock', async () => {
    const s = await setup();
    const { passkey } = await enroll(s);
    await s.h.service.lock();
    // Tamper AFTER a challenge exists: the unwrap parse still fails closed.
    await expect(
      passkeyUnlock(s, passkey, {
        tamperBeforeUnlock: async () => {
          const [stored] = await loadPasskeyEnvelopes(s.h.local);
          await savePasskeyEnvelopes(s.h.local, [
            { ...stored, version: 2 } as RawPasskeyEnvelope, // unknown version
          ]);
        },
      }),
    ).rejects.toMatchObject({ code: 'unsupported-version' });
    // And with the tamper in place, nothing is offered at all.
    const challenge = await s.h.service.passkeyChallenge({ vaultId: s.vaultId });
    expect(challenge.entries).toHaveLength(0);
    expect(challenge.invalidCount).toBe(1);
    expect(challenge.challengeB64).toBeUndefined();
    expect((await s.h.service.sessionStatus()).locked).toBe(true);
  });

  it('a ciphertext-tampered envelope authenticates nothing and stays locked', async () => {
    const s = await setup();
    const { passkey } = await enroll(s);
    await s.h.service.lock();
    await expect(
      passkeyUnlock(s, passkey, {
        tamperBeforeUnlock: async () => {
          const [stored] = await loadPasskeyEnvelopes(s.h.local);
          const box = stored!['wrappedDek'] as { nonceB64: string; ciphertextB64: string };
          const bytes = Uint8Array.from(atob(box.ciphertextB64), (c) => c.charCodeAt(0));
          bytes[0] = bytes[0]! ^ 0xff;
          await savePasskeyEnvelopes(s.h.local, [
            {
              ...stored,
              wrappedDek: { ...box, ciphertextB64: bytesToBase64(bytes) },
            } as RawPasskeyEnvelope,
          ]);
        },
      }),
    ).rejects.toMatchObject({ code: 'decrypt-failed' });
    expect((await s.h.service.sessionStatus()).locked).toBe(true);
  });

  it('two same-vault records for one credential are ambiguous state: none offered (review Finding 3)', async () => {
    const s = await setup();
    await enroll(s);
    const [stored] = await loadPasskeyEnvelopes(s.h.local);
    await savePasskeyEnvelopes(s.h.local, [stored!, { ...stored } as RawPasskeyEnvelope]);
    await s.h.service.lock();
    const challenge = await s.h.service.passkeyChallenge({ vaultId: s.vaultId });
    expect(challenge.entries).toHaveLength(0);
    expect(challenge.invalidCount).toBe(2);
    expect(challenge.challengeB64).toBeUndefined();
  });

  it('an envelope without a bound credential public key is never offered (pre-A2.1 records)', async () => {
    const s = await setup();
    await enroll(s);
    await savePasskeyCredentials(s.h.local, []); // simulate a legacy A2 enrollment
    await s.h.service.lock();
    const challenge = await s.h.service.passkeyChallenge({ vaultId: s.vaultId });
    expect(challenge.entries).toHaveLength(0);
    expect(challenge.invalidCount).toBe(1);
  });

  it('an over-cap storage root offers nothing and leaves password unlock untouched (review Finding 2)', async () => {
    const s = await setup();
    await enroll(s);
    const stored = await loadPasskeyEnvelopes(s.h.local);
    await savePasskeyEnvelopes(s.h.local, [
      ...stored,
      ...Array.from({ length: MAX_PASSKEY_RECORDS_TOTAL }, (_, i) => ({
        vaultId: 'someone-else',
        credentialIdB64: `junk-${i}`,
      })),
    ]);
    await s.h.service.lock();
    const challenge = await s.h.service.passkeyChallenge({ vaultId: s.vaultId });
    expect(challenge.entries).toHaveLength(0);
    expect(challenge.invalidCount).toBe(1);
    expect(challenge.challengeB64).toBeUndefined();
    // The password path is a peer: it works exactly as before.
    await expect(
      s.h.service.unlock({ vaultId: s.vaultId, password: PASSWORD }),
    ).resolves.toMatchObject({ vaultId: s.vaultId });
  });

  it('survives a password change (same DEK, new wrap) and an MV3 restart', async () => {
    const s = await setup();
    const { passkey } = await enroll(s);
    await s.h.service.changePassword({ oldPassword: PASSWORD, newPassword: 'a-brand-new-password' });
    const restarted = s.h.rebuild();
    const result = await passkeyUnlock(s, passkey, { service: restarted });
    expect(result.vaultId).toBe(s.vaultId);
    expect((await restarted.sessionStatus()).locked).toBe(false);
  });

  it('is refused entirely on a channel without a stable RP identity', async () => {
    const s = await setup();
    const { passkey } = await enroll(s);
    await s.h.service.lock();
    const disabled = makeHarness(s.h.clock.now);
    await savePasskeyEnvelopes(disabled.local, await loadPasskeyEnvelopes(s.h.local));
    await savePasskeyCredentials(disabled.local, await loadPasskeyCredentials(s.h.local));
    const assertion = await passkey.assert({
      challengeB64: bytesToBase64(new Uint8Array(32).fill(5)),
      rpOrigin: RP_ORIGIN,
    });
    await expect(
      disabled.service.passkeyUnlock({
        vaultId: s.vaultId,
        credentialIdB64: CREDENTIAL_ID,
        prfOutputB64: bytesToBase64(prfOutput()),
        ...assertion,
      }),
    ).rejects.toMatchObject({ code: 'ERR_PASSKEY_UNAVAILABLE' });
  });
});

describe('passkey list / rename / remove', () => {
  it('lists enrollments for the active session only', async () => {
    const s = await setup();
    await enroll(s);
    const list = await s.h.service.passkeyList({ ...s.expectation });
    expect(list.entries).toEqual([
      { credentialIdB64: CREDENTIAL_ID, label: 'MacBook Touch ID', createdAtMs: expect.any(Number) },
    ]);
    expect(list.invalidCount).toBe(0);
    await s.h.service.lock();
    await expect(s.h.service.passkeyList({ ...s.expectation })).rejects.toMatchObject({
      code: 'ERR_LOCKED',
    });
  });

  it('renames without touching decryptability (label is outside the AAD)', async () => {
    const s = await setup();
    const { passkey } = await enroll(s);
    const renamed = await s.h.service.passkeyRename({
      credentialIdB64: CREDENTIAL_ID,
      label: 'Office key',
      ...s.expectation,
    });
    expect(renamed).toEqual({ renamed: true });
    const list = await s.h.service.passkeyList({ ...s.expectation });
    expect(list.entries[0]).toMatchObject({ label: 'Office key' });
    await s.h.service.lock();
    await expect(passkeyUnlock(s, passkey)).resolves.toMatchObject({ vaultId: s.vaultId });
  });

  it('rename of an unknown credential reports renamed: false', async () => {
    const s = await setup();
    await enroll(s);
    await expect(
      s.h.service.passkeyRename({
        credentialIdB64: OTHER_CREDENTIAL_ID,
        label: 'x',
        ...s.expectation,
      }),
    ).resolves.toEqual({ renamed: false });
  });

  it('removal requires the password and permanently disables the credential', async () => {
    const s = await setup();
    const { passkey } = await enroll(s);
    await expect(
      s.h.service.passkeyRemove({
        password: 'not-the-password',
        credentialIdB64: CREDENTIAL_ID,
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'wrong-password' });

    const removed = await s.h.service.passkeyRemove({
      password: PASSWORD,
      credentialIdB64: CREDENTIAL_ID,
      ...s.expectation,
    });
    expect(removed).toEqual({ removed: 1 });
    expect(await loadPasskeyEnvelopes(s.h.local)).toEqual([]);
    // The bound public key goes with the envelope.
    expect(await loadPasskeyCredentials(s.h.local)).toEqual([]);
    await s.h.service.lock();
    const assertion = await passkey.assert({
      challengeB64: bytesToBase64(new Uint8Array(32).fill(6)),
      rpOrigin: RP_ORIGIN,
    });
    await expect(
      s.h.service.passkeyUnlock({
        vaultId: s.vaultId,
        credentialIdB64: CREDENTIAL_ID,
        prfOutputB64: bytesToBase64(prfOutput()),
        ...assertion,
      }),
    ).rejects.toMatchObject({ code: 'ERR_PASSKEY_UNAVAILABLE' });
  });

  it('purgeInvalid drops only this vault records that this build cannot use', async () => {
    const s = await setup();
    await enroll(s);
    const stored = await loadPasskeyEnvelopes(s.h.local);
    await savePasskeyEnvelopes(s.h.local, [
      ...stored,
      { ...stored[0], version: 2, credentialIdB64: OTHER_CREDENTIAL_ID } as RawPasskeyEnvelope,
      { vaultId: 'someone-else', junk: true },
    ]);
    const removed = await s.h.service.passkeyRemove({
      password: PASSWORD,
      purgeInvalid: true,
      ...s.expectation,
    });
    expect(removed).toEqual({ removed: 1 });
    const remaining = await loadPasskeyEnvelopes(s.h.local);
    expect(remaining).toHaveLength(2);
    expect(remaining.map((e) => e['vaultId'])).toEqual([s.vaultId, 'someone-else']);
  });

  it('vault removal deletes its envelopes and bound keys with it', async () => {
    const s = await setup();
    await enroll(s);
    await savePasskeyEnvelopes(s.h.local, [
      ...(await loadPasskeyEnvelopes(s.h.local)),
      { vaultId: 'other-vault', keep: true },
    ]);
    await s.h.service.removeVault({ targetVaultId: s.vaultId, password: PASSWORD, ...s.expectation });
    const remaining = await loadPasskeyEnvelopes(s.h.local);
    expect(remaining).toEqual([{ vaultId: 'other-vault', keep: true }]);
    expect(await loadPasskeyCredentials(s.h.local)).toEqual([]);
  });

  it('a failed vault removal cannot leave an offered passkey orphan (review Finding 4)', async () => {
    const failingCache = {
      clearVault: () => Promise.reject(new Error('cache-clear failed')),
    } as unknown as WalletCachePort;
    const s = await setup({ walletCache: failingCache });
    await enroll(s);
    // The removal fails at the cache step — but passkey state is already gone.
    await expect(s.h.service.removeVault({ targetVaultId: s.vaultId, password: PASSWORD,
      ...s.expectation })).rejects.toThrow('cache-clear failed');
    expect((await s.h.service.list()).vaults.map((vault) => vault.vaultId))
      .toContain(s.vaultId);
    expect(await loadPasskeyEnvelopes(s.h.local)).toEqual([]);
    expect(await loadPasskeyCredentials(s.h.local)).toEqual([]);
    // Nothing is offered for the removed vault.
    expect(await s.h.service.passkeyChallenge({ vaultId: s.vaultId })).toEqual({
      available: true,
      entries: [],
      invalidCount: 0,
    });
  });
});
