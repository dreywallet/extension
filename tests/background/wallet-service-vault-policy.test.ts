/**
 * Workstream C1 exit gate, part two: the signer-import ceremony and the
 * watch-only Vault it produces.
 *
 * The load-bearing claims, in the order ADR 0007 states them:
 *
 * - §2 the *verifier* mints the challenge, possession is proven over the
 *   complete origin and account xpub rather than a fingerprint, and a proof
 *   from another session, another role, or another key is refused;
 * - §2 two copies of one key are one logical role, so a collision on either
 *   fingerprint or account xpub is refused before it can reach a descriptor;
 * - §3 the committed policy is exactly one canonical 2-of-3 P2WSH identity, and
 *   it survives a worker restart unchanged;
 * - §6 the public recovery kit carries no S, A, B, C, xprv, or passkey
 *   material; and
 * - the coordinator still cannot fund, sign, or broadcast anything.
 *
 * Role A is generated live by the service under test. Roles B and C come from
 * the disposable public fixture in tests/fixtures/vault-peer-signers.ts,
 * standing in for a mobile signer and an offline recovery ceremony — the
 * extension never manufactures a production role B.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { PASSWORD } from '@drey/core/testing/vault-helpers';
import { bytesToHex, hexToBytes } from '@drey/core/domain/vault/encoding';
import { mnemonicToSeed } from '@drey/core/domain/keys/mnemonic';
import {
  parseRecoveryCSetupChallenge,
  recoveryCSetupChallengeDigest,
  serializeRecoveryCSetupResponse,
  serializeVaultSignerOrigin,
  serializeVaultProofResult,
  signVaultPairingEnvelope,
  vaultTransportChannelId,
} from '@drey/core/domain/vault/multisig-encoding';
import {
  loadVaultPolicy,
  vaultCoordinatorPolicyRecordSchema,
} from '../../src/adapters/storage/vault-coordinator-store';
import { VAULT_COORDINATOR_OP_SCHEMAS } from '../../src/messaging/vault-coordinator-ops';
import {
  deriveVaultRoleOrigin,
  signVaultProofOfPossession,
  vaultSignerRoot,
} from '@drey/core/domain/vault/multisig-role';
import { recoveryCSetupProofInput } from '@drey/core/domain/vault/recovery-c-ceremony';
import { composeVaultPolicyRecord, summarizeVaultPolicy } from '../../src/background/vault-policy';
import {
  FOREIGN_DESKTOP_MNEMONIC,
  PEER_FINGERPRINTS,
  PEER_MNEMONICS,
  peerOrigin,
  peerOriginHex,
  peerProofHex,
  peerSeed,
  recoveryCSetupResponseHex,
  type PeerRole,
} from '../fixtures/vault-peer-signers';
import { makeHarness, type Harness } from './service-helpers';

beforeAll(installTestCryptoProvider);

interface Setup {
  h: Harness;
  vaultId: string;
  expectation: { expectedVaultId: string; expectedSessionId: string };
}

async function setup(): Promise<Setup> {
  const h = makeHarness(undefined, {
    network: 'signet',
    vaultCoordinatorCapability: { network: 'signet', movement: 'full' } as const,
  });
  const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
  const unlocked = await h.service.unlock({ vaultId, password: PASSWORD });
  return {
    h,
    vaultId,
    expectation: { expectedVaultId: vaultId, expectedSessionId: unlocked.sessionId },
  };
}

async function withRole(): Promise<Setup> {
  const s = await setup();
  await s.h.service.vaultCoordinatorCreateRole({
    password: PASSWORD,
    label: 'Desktop A',
    ...s.expectation,
  });
  return s;
}

async function beginImport(s: Setup) {
  return s.h.service.vaultCoordinatorBeginImport({ ...s.expectation });
}

async function importPeer(s: Setup, role: PeerRole, challenge: Awaited<ReturnType<typeof beginImport>>) {
  if (role === 'recovery-c') {
    const setupChallenge = await s.h.service.vaultCoordinatorBeginRecoveryCSetup({
      ...s.expectation,
    });
    return s.h.service.vaultCoordinatorImportRecoveryCSetupResponse({
      responseHex: recoveryCSetupResponseHex(setupChallenge.challengeHex),
      ...s.expectation,
    });
  }
  return s.h.service.vaultCoordinatorImportSigner({
    role,
    originHex: peerOriginHex(role),
    proofResultHex: peerProofHex(role, challenge),
    ...s.expectation,
  });
}

/** Role A generated, both peers imported, policy committed. */
async function withPolicy(): Promise<Setup> {
  const s = await withRole();
  const challenge = await beginImport(s);
  await importPeer(s, 'mobile-b', challenge);
  await importPeer(s, 'recovery-c', challenge);
  await s.h.service.vaultCoordinatorCreatePolicy({
    password: PASSWORD,
    vaultLabel: 'Test Vault',
    signerLabels: ['Desktop', 'Mobile', 'Recovery'],
    birthdayHeight: 250_000,
    ...s.expectation,
  });
  return s;
}

describe('C1 import ceremony (ADR 0007 §2)', () => {
  it('requires and verifies both authenticated Mobile B response envelopes on mainnet', async () => {
    const h = makeHarness(undefined, {
      network: 'mainnet',
      vaultCoordinatorCapability: { network: 'mainnet', movement: 'production-mainnet' } as const,
    });
    const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
    const unlocked = await h.service.unlock({ vaultId, password: PASSWORD });
    const expectation = { expectedVaultId: vaultId, expectedSessionId: unlocked.sessionId };
    await h.service.vaultCoordinatorCreateRole({
      password: PASSWORD,
      label: 'Desktop A',
      ...expectation,
    });
    const roleA = (await h.service.vaultCoordinatorRoleOrigin(expectation)).role!.origin;
    const mobileSeed = mnemonicToSeed(PEER_MNEMONICS['mobile-b']);
    const mobileOrigin = deriveVaultRoleOrigin(mobileSeed, 'mobile-b', 'mainnet');
    const originHex = bytesToHex(serializeVaultSignerOrigin(mobileOrigin));
    const challenge = await h.service.vaultCoordinatorBeginImport({
      mobileOriginHex: originHex,
      password: PASSWORD,
      ...expectation,
    });
    const proofInput = {
      version: 1 as const,
      origin: mobileOrigin,
      sessionIdHex: challenge.sessionIdHex,
      challengeNonceHex: challenge.challengeNonceHex,
      transcriptHashHex: challenge.transcriptHashHex,
      expiresAtMs: challenge.expiresAtMs,
    };
    const proof = signVaultProofOfPossession(mobileSeed, proofInput, String(h.clock.now));
    const proofResultHex = bytesToHex(serializeVaultProofResult(proof));
    await expect(h.service.vaultCoordinatorImportSigner({
      role: 'mobile-b',
      originHex,
      proofResultHex,
      ...expectation,
    })).rejects.toMatchObject({
      code: 'ERR_VAULT_SIGNER_REJECTED',
      message: expect.stringMatching(/authenticated QR response envelopes/u),
    });

    const mobileRoot = vaultSignerRoot(mobileSeed, 'mainnet');
    try {
      const common = {
        version: 1 as const,
        network: 'mainnet' as const,
        sessionIdHex: challenge.sessionIdHex,
        senderChannelIdHex: vaultTransportChannelId(mobileOrigin),
        recipientChannelIdHex: vaultTransportChannelId(roleA),
        createdAtMs: String(h.clock.now),
        expiresAtMs: challenge.expiresAtMs,
        transcriptHashHex: challenge.transcriptHashHex,
      };
      const originEnvelope = signVaultPairingEnvelope({
        ...common,
        counter: '2',
        antiReplayNonceHex: '55'.repeat(32),
        messageType: 'signer-origin',
        payloadHex: originHex,
      }, mobileRoot, mobileOrigin);
      const proofEnvelope = signVaultPairingEnvelope({
        ...common,
        counter: '3',
        antiReplayNonceHex: '66'.repeat(32),
        messageType: 'pop-result',
        payloadHex: proofResultHex,
      }, mobileRoot, mobileOrigin);
      await expect(h.service.vaultCoordinatorImportSigner({
        role: 'mobile-b',
        originHex,
        proofResultHex,
        originEnvelope,
        proofEnvelope: { ...proofEnvelope, counter: '4' },
        ...expectation,
      })).rejects.toMatchObject({ code: 'ERR_VAULT_SIGNER_REJECTED' });

      await expect(h.service.vaultCoordinatorImportSigner({
        role: 'mobile-b',
        originHex,
        proofResultHex,
        originEnvelope,
        proofEnvelope,
        ...expectation,
      })).resolves.toMatchObject({
        role: 'mobile-b',
        imported: ['mobile-b'],
        pending: ['recovery-c'],
      });
    } finally {
      mobileRoot.wipePrivateData();
      mobileSeed.fill(0);
    }
  });

  it('mints its own challenge and completes with both peer roles', async () => {
    const s = await withRole();
    const challenge = await beginImport(s);
    // The verifier chose all of it. Nothing in the request supplied a nonce.
    expect(challenge.challengeNonceHex).toMatch(/^[0-9a-f]{64}$/u);
    expect(challenge.sessionIdHex).toMatch(/^[0-9a-f]{32}$/u);
    expect(challenge.pending).toEqual(['mobile-b', 'recovery-c']);

    const first = await importPeer(s, 'mobile-b', challenge);
    expect(first.origin.masterFingerprintHex).toBe(PEER_FINGERPRINTS['mobile-b']);
    expect(first.complete).toBe(false);
    expect(first.pending).toEqual(['recovery-c']);

    const second = await importPeer(s, 'recovery-c', challenge);
    expect(second.complete).toBe(true);
    expect(second.pending).toEqual([]);
  });

  it('binds the challenge to this coordinator\'s own role A', async () => {
    // A transcript that ignored role A would be replayable between two
    // coordinators: a proof captured during somebody else's setup would satisfy
    // ours. Changing only role A must therefore change the transcript.
    const s = await withRole();
    const before = await beginImport(s);
    const role = (await s.h.service.vaultCoordinatorRoleOrigin({ ...s.expectation })).role!;
    await s.h.service.vaultCoordinatorRemoveRole({
      password: PASSWORD,
      roleId: role.roleId,
      ...s.expectation,
    });
    await s.h.service.vaultCoordinatorCreateRole({
      password: PASSWORD,
      label: 'Desktop A again',
      ...s.expectation,
    });
    const replacement = (await s.h.service.vaultCoordinatorRoleOrigin({ ...s.expectation })).role!;
    expect(replacement.origin.accountXpub).not.toBe(role.origin.accountXpub);
    const after = await beginImport(s);
    expect(after.transcriptHashHex).not.toBe(before.transcriptHashHex);
  });

  it('refuses a proof minted for a different challenge', async () => {
    const s = await withRole();
    const stale = await beginImport(s);
    const fresh = await beginImport(s); // replaces the pending ceremony outright
    expect(fresh.challengeNonceHex).not.toBe(stale.challengeNonceHex);
    await expect(
      s.h.service.vaultCoordinatorImportSigner({
        role: 'mobile-b',
        originHex: peerOriginHex('mobile-b'),
        proofResultHex: peerProofHex('mobile-b', stale),
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_SIGNER_REJECTED' });
  });

  it('refuses a proof presented for the wrong role slot', async () => {
    const s = await withRole();
    const challenge = await beginImport(s);
    await expect(
      s.h.service.vaultCoordinatorImportSigner({
        role: 'recovery-c',
        originHex: peerOriginHex('mobile-b'),
        proofResultHex: peerProofHex('mobile-b', challenge),
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_SIGNER_REJECTED' });
  });

  it('refuses a fingerprint-only match — possession of the xpub is the evidence', async () => {
    // ADR 0007 §2's named case: a record wearing role B's real four-byte
    // fingerprint — the thing a human eyeballs across devices — over a foreign
    // account key, offering the fingerprint as its only credential. The proof
    // is taken over the complete origin and the xpub's /0/0 child, so an
    // attacker who does not hold that key cannot produce one.
    const s = await withRole();
    const challenge = await beginImport(s);
    const impostor = {
      ...peerOrigin('recovery-c'),
      role: 'mobile-b' as const,
      masterFingerprintHex: PEER_FINGERPRINTS['mobile-b'],
    };
    const { serializeVaultSignerOrigin } = await import(
      '@drey/core/domain/vault/multisig-encoding'
    );
    await expect(
      s.h.service.vaultCoordinatorImportSigner({
        role: 'mobile-b',
        originHex: bytesToHex(serializeVaultSignerOrigin(impostor)),
        // The genuine role-B proof, which is what an attacker who had merely
        // observed B's setup could replay. It does not verify against the
        // substituted xpub.
        proofResultHex: peerProofHex('mobile-b', challenge),
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_SIGNER_REJECTED' });
  });

  it('never lets two roles share a fingerprint, whichever arrives first', async () => {
    // A master fingerprint cannot be verified from an account xpub — it is the
    // hash of a master key four levels up, and ADR 0007 §2 is explicit that it
    // is a review label rather than proof. What CAN be guaranteed is that one
    // policy never contains the same label twice, so the cross-device check the
    // ADR §6 ceremony asks for is never ambiguous.
    const s = await withRole();
    const challenge = await beginImport(s);
    // A self-consistent record — it really holds the key it names — that merely
    // borrows the other peer's fingerprint.
    const mislabelled = {
      ...peerOrigin('recovery-c'),
      role: 'recovery-c' as const,
      masterFingerprintHex: PEER_FINGERPRINTS['mobile-b'],
    };
    const submit = async (target: Setup) => {
      const setupChallenge = await target.h.service.vaultCoordinatorBeginRecoveryCSetup({
        ...target.expectation,
      });
      const parsed = parseRecoveryCSetupChallenge(hexToBytes(setupChallenge.challengeHex));
      const seed = peerSeed('recovery-c');
      try {
        return await target.h.service.vaultCoordinatorImportRecoveryCSetupResponse({
          responseHex: bytesToHex(serializeRecoveryCSetupResponse({
            version: 1,
            challengeDigestHex: recoveryCSetupChallengeDigest(parsed),
            origin: mislabelled,
            proof: {
              ...signVaultProofOfPossession(
                seed,
                recoveryCSetupProofInput(parsed, mislabelled),
                (BigInt(parsed.createdAtMs) + 1n).toString(),
              ),
              role: 'recovery-c',
            },
          })),
          ...target.expectation,
        });
      } finally {
        seed.fill(0);
      }
    };

    // Real B first: the mislabelled C then collides and is refused.
    await importPeer(s, 'mobile-b', challenge);
    await expect(submit(s)).rejects.toMatchObject({ code: 'ERR_VAULT_RECOVERY_C_RESPONSE_REJECTED' });

    // Mislabelled C first: real B is refused instead. Either order, the two
    // can never end up in one policy together.
    const other = await withRole();
    const otherChallenge = await beginImport(other);
    await submit(other);
    await expect(importPeer(other, 'mobile-b', otherChallenge)).rejects.toMatchObject({
      code: 'ERR_VAULT_SIGNER_REJECTED',
    });
  });

  it('refuses a tampered origin record', async () => {
    const s = await withRole();
    const challenge = await beginImport(s);
    const good = peerOriginHex('mobile-b');
    await expect(
      s.h.service.vaultCoordinatorImportSigner({
        role: 'mobile-b',
        originHex: `${good.slice(0, -2)}ff`,
        proofResultHex: peerProofHex('mobile-b', challenge),
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_SIGNER_REJECTED' });
  });

  it('refuses the coordinator\'s own role A as a peer', async () => {
    // Otherwise "import a peer" becomes "replace the signing root".
    const s = await withRole();
    const challenge = await beginImport(s);
    const origin = await s.h.service.vaultCoordinatorRoleOrigin({ ...s.expectation });
    const { serializeVaultSignerOrigin } = await import(
      '@drey/core/domain/vault/multisig-encoding'
    );
    const asPeer = { ...origin.role!.origin, role: 'mobile-b' as const };
    await expect(
      s.h.service.vaultCoordinatorImportSigner({
        role: 'mobile-b',
        originHex: bytesToHex(serializeVaultSignerOrigin(asPeer)),
        proofResultHex: peerProofHex('mobile-b', challenge),
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_SIGNER_REJECTED' });
  });

  it('refuses the same peer in both slots', async () => {
    const s = await withRole();
    const challenge = await beginImport(s);
    await importPeer(s, 'mobile-b', challenge);
    const { serializeVaultSignerOrigin } = await import(
      '@drey/core/domain/vault/multisig-encoding'
    );
    const cloned = { ...peerOrigin('mobile-b'), role: 'recovery-c' as const };
    await expect(
      s.h.service.vaultCoordinatorImportSigner({
        role: 'recovery-c',
        originHex: bytesToHex(serializeVaultSignerOrigin(cloned)),
        proofResultHex: bytesToHex(
          serializeVaultProofResult(
            signVaultProofOfPossession(peerSeed('mobile-b'), {
              version: 1,
              origin: cloned,
              sessionIdHex: challenge.sessionIdHex,
              challengeNonceHex: challenge.challengeNonceHex,
              transcriptHashHex: challenge.transcriptHashHex,
              expiresAtMs: challenge.expiresAtMs,
            }),
          ),
        ),
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_SIGNER_REJECTED' });
  });

  it('refuses an expired challenge', async () => {
    const s = await withRole();
    const challenge = await beginImport(s);
    s.h.clock.now = Number(challenge.expiresAtMs) + 1;
    await expect(importPeer(s, 'mobile-b', challenge)).rejects.toMatchObject({
      code: 'ERR_VAULT_IMPORT_SESSION_MISSING',
    });
  });

  it('refuses an import with no open ceremony', async () => {
    const s = await withRole();
    await expect(
      s.h.service.vaultCoordinatorImportSigner({
        role: 'mobile-b',
        originHex: peerOriginHex('mobile-b'),
        proofResultHex: peerProofHex('mobile-b', {
          sessionIdHex: 'ab'.repeat(16),
          challengeNonceHex: 'cd'.repeat(32),
          transcriptHashHex: 'ef'.repeat(32),
          expiresAtMs: '4102444800000',
        }),
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_IMPORT_SESSION_MISSING' });
  });

  it('needs role A before any import can start', async () => {
    const s = await setup();
    await expect(beginImport(s)).rejects.toMatchObject({ code: 'ERR_VAULT_ROLE_MISSING' });
  });
});

describe('C1 policy commitment (ADR 0007 §§3-4)', () => {
  it('composes the policy its own three roles actually describe', async () => {
    const s = await withPolicy();
    const stored = await s.h.service.vaultCoordinatorPolicy({ ...s.expectation });
    expect(stored.state).toBe('present');
    const summary = stored.policy!;

    // Independently recompose from the live role A origin and the two fixture
    // peers, and require the identical policy: a coordinator that quietly
    // substituted a key would diverge here.
    const roleOrigin = (await s.h.service.vaultCoordinatorRoleOrigin({ ...s.expectation })).role!;
    const expected = summarizeVaultPolicy(
      composeVaultPolicyRecord(
        'signet',
        [roleOrigin.origin, peerOrigin('mobile-b'), peerOrigin('recovery-c')],
        {
          createdAtMs: String(summary.createdAt),
          birthdayHeight: 250_000,
          vaultLabel: 'Test Vault',
          signerLabels: ['Desktop', 'Mobile', 'Recovery'],
        },
      ),
    );
    expect(summary.policyId).toBe(expected.policyId);
    expect(summary.receiveDescriptor).toBe(expected.receiveDescriptor);
    expect(summary.changeDescriptor).toBe(expected.changeDescriptor);
    // The coordinator knows the deterministic address, but does not expose it
    // as a funding target until the Recovery C paper check passes.
    expect(expected.firstReceiveAddress!.startsWith('tb1q')).toBe(true);
    expect(summary.firstReceiveAddress).toBeNull();
    expect(summary.signers.map((signer) => signer.role)).toEqual([
      'desktop-a',
      'mobile-b',
      'recovery-c',
    ]);
  });

  it('refuses to commit before both peers are imported', async () => {
    const s = await withRole();
    const challenge = await beginImport(s);
    const commit = () =>
      s.h.service.vaultCoordinatorCreatePolicy({
        password: PASSWORD,
        vaultLabel: 'Test Vault',
        signerLabels: ['A', 'B', 'C'],
        birthdayHeight: null,
        ...s.expectation,
      });
    await expect(commit()).rejects.toMatchObject({ code: 'ERR_VAULT_POLICY_INCOMPLETE' });
    await importPeer(s, 'mobile-b', challenge);
    await expect(commit()).rejects.toMatchObject({ code: 'ERR_VAULT_POLICY_INCOMPLETE' });
    expect(await loadVaultPolicy(s.h.local)).toEqual({ state: 'absent' });
  });

  it('requires the password, and persists nothing when it is wrong', async () => {
    const s = await withRole();
    const challenge = await beginImport(s);
    await importPeer(s, 'mobile-b', challenge);
    await importPeer(s, 'recovery-c', challenge);
    await expect(
      s.h.service.vaultCoordinatorCreatePolicy({
        password: 'wrong-password-entirely',
        vaultLabel: 'Test Vault',
        signerLabels: ['A', 'B', 'C'],
        birthdayHeight: null,
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'wrong-password' });
    expect(await loadVaultPolicy(s.h.local)).toEqual({ state: 'absent' });
  });

  it('refuses a second policy and refuses to reopen the import', async () => {
    const s = await withPolicy();
    await expect(beginImport(s)).rejects.toMatchObject({ code: 'ERR_VAULT_POLICY_EXISTS' });
    await expect(
      s.h.service.vaultCoordinatorCreatePolicy({
        password: PASSWORD,
        vaultLabel: 'Another',
        signerLabels: ['A', 'B', 'C'],
        birthdayHeight: null,
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_POLICY_EXISTS' });
  });

  it('will not let role A be deleted out from under a committed policy', async () => {
    const s = await withPolicy();
    const role = (await s.h.service.vaultCoordinatorRoleOrigin({ ...s.expectation })).role!;
    await expect(
      s.h.service.vaultCoordinatorRemoveRole({
        password: PASSWORD,
        roleId: role.roleId,
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_POLICY_EXISTS' });
  });

  it('survives a worker restart unchanged', async () => {
    const s = await withPolicy();
    const before = await s.h.service.vaultCoordinatorPolicy({ ...s.expectation });
    const restarted = s.h.rebuild();
    await expect(restarted.vaultCoordinatorPolicy({ ...s.expectation })).resolves.toEqual(before);
  });

  it('resumes the final Mobile B handoff and records the observed ready state', async () => {
    const s = await withPolicy();
    const initial = await s.h.service.vaultCoordinatorPolicy({ ...s.expectation });
    expect(initial.policyQrFrames?.length).toBeGreaterThan(0);
    expect(initial.mobilePairingComplete).toBe(false);

    s.h.clock.now += 24 * 60 * 60 * 1_000 + 1;
    await s.h.service.lock();
    const unlocked = await s.h.service.unlock({ vaultId: s.vaultId, password: PASSWORD });
    const refreshedExpectation = {
      expectedVaultId: s.vaultId,
      expectedSessionId: unlocked.sessionId,
    };
    await expect(s.h.service.vaultCoordinatorPolicy(refreshedExpectation)).resolves.toMatchObject({
      state: 'present',
      policyQrFrames: null,
      mobilePairingComplete: false,
    });

    const refreshed = await s.h.service.vaultCoordinatorPolicyPairingQr({
      password: PASSWORD,
      ...refreshedExpectation,
    });
    expect(refreshed.policyQrFrames.length).toBeGreaterThan(0);

    const policyId = initial.policy!.policyId;
    await expect(s.h.rebuild().vaultCoordinatorAcknowledgePolicyPairing({
      policyId,
      ...refreshedExpectation,
    })).resolves.toEqual({ policyId, mobilePairingComplete: true });
    await expect(s.h.service.vaultCoordinatorPolicy(refreshedExpectation)).resolves.toMatchObject({
      state: 'present',
      policyQrFrames: null,
      mobilePairingComplete: true,
    });
    const acknowledged = await loadVaultPolicy(s.h.local);
    expect(acknowledged.state === 'valid'
      ? acknowledged.stored.transport?.pendingPairingPolicyEnvelope
      : null).not.toBeNull();
  });

  it('treats a pre-resume policy as already handed off after an upgrade', async () => {
    const s = await withPolicy();
    const stored = await loadVaultPolicy(s.h.local);
    if (stored.state !== 'valid' || stored.stored.transport === null) {
      throw new Error('expected a committed policy with Mobile B transport');
    }
    const legacyTransport = { ...stored.stored.transport };
    delete legacyTransport.pendingPairingPolicyEnvelope;
    delete legacyTransport.mobilePairingConfirmedAt;
    await s.h.local.set({
      'squirrel:vaultCoordinator:policy': { ...stored.stored, transport: legacyTransport },
    });

    await expect(s.h.rebuild().vaultCoordinatorPolicy({ ...s.expectation })).resolves.toMatchObject({
      state: 'present',
      policyQrFrames: null,
      mobilePairingComplete: true,
    });
  });

  it('rejects an odd Desktop A change-reservation counter', async () => {
    const s = await withPolicy();
    const stored = await loadVaultPolicy(s.h.local);
    if (stored.state !== 'valid') throw new Error('expected a committed policy');
    expect(vaultCoordinatorPolicyRecordSchema.safeParse({
      ...stored.stored,
      nextChangeIndex: 1,
    }).success).toBe(false);
  });

  it('reads as unusable when the stored policy no longer matches this device\'s role', async () => {
    // A policy that names some other role A is not a Vault this profile can
    // ever sign for. It must never render as a watchable Vault.
    const s = await withPolicy();
    const foreign = composeVaultPolicyRecord(
      'signet',
      [
        deriveVaultRoleOrigin(mnemonicToSeed(FOREIGN_DESKTOP_MNEMONIC), 'desktop-a', 'signet'),
        peerOrigin('mobile-b'),
        peerOrigin('recovery-c'),
      ],
      {
        createdAtMs: '1735689600000',
        birthdayHeight: null,
        vaultLabel: 'Foreign',
        signerLabels: ['A', 'B', 'C'],
      },
    );
    const stored = await loadVaultPolicy(s.h.local);
    if (stored.state !== 'valid') throw new Error('expected a committed policy');
    await s.h.local.set({
      'squirrel:vaultCoordinator:policy': { ...stored.stored, record: foreign },
    });
    const restarted = s.h.rebuild();
    await expect(restarted.vaultCoordinatorPolicy({ ...s.expectation })).resolves.toEqual({
      state: 'unusable',
      policy: null,
      policyQrFrames: null,
      mobilePairingComplete: false,
    });
    await expect(
      restarted.vaultCoordinatorRecoveryCReadiness({ ...s.expectation }),
    ).resolves.toMatchObject({
      state: 'unusable',
      localRole: 'usable',
      policyState: 'unusable',
      phoneSignerPaired: false,
      policyId: null,
      ready: false,
    });
    await expect(
      restarted.vaultCoordinatorRecoveryKit({ ...s.expectation }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_POLICY_MISSING' });
  });

  it('forgets a policy only when the policyId is restated', async () => {
    const s = await withPolicy();
    const summary = (await s.h.service.vaultCoordinatorPolicy({ ...s.expectation })).policy!;
    await expect(
      s.h.service.vaultCoordinatorRemovePolicy({
        password: PASSWORD,
        policyId: '11'.repeat(32),
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_POLICY_MISSING' });
    await expect(
      s.h.service.vaultCoordinatorRemovePolicy({
        password: PASSWORD,
        policyId: summary.policyId,
        ...s.expectation,
      }),
    ).resolves.toEqual({ removed: true });
    expect(await loadVaultPolicy(s.h.local)).toEqual({ state: 'absent' });
  });
});

describe('C1 recovery kit carries no secrets (ADR 0007 §6)', () => {
  it('contains no S, A, B, C, xprv, or passkey material', async () => {
    const s = await withPolicy();
    const kit = await s.h.service.vaultCoordinatorRecoveryKit({ ...s.expectation });
    const serialized = `${kit.kitHex} ${JSON.stringify(kit.kit)}`.toLowerCase();

    // Every secret this harness holds, in every encoding it could leak in.
    const spending = await s.h.service.revealMnemonic({ password: PASSWORD, ...s.expectation });
    const roleWords = await s.h.service.vaultCoordinatorRevealRole({
      password: PASSWORD,
      ...s.expectation,
    });
    const secrets: string[] = [
      PASSWORD,
      spending.mnemonic,
      roleWords.mnemonic,
      bytesToHex(mnemonicToSeed(spending.mnemonic)),
      bytesToHex(mnemonicToSeed(roleWords.mnemonic)),
      ...(['mobile-b', 'recovery-c'] as PeerRole[]).flatMap((role) => [
        PEER_MNEMONICS[role],
        bytesToHex(peerSeed(role)),
      ]),
    ];
    for (const secret of secrets) {
      expect(serialized.includes(secret.toLowerCase()), secret.slice(0, 24)).toBe(false);
      // Individual BIP39 words are ordinary English and would false-positive,
      // so check the joined phrase and its hex seed only.
    }
    // No extended *private* key form anywhere, on either network prefix.
    expect(serialized).not.toMatch(/xprv|tprv/u);
    expect(serialized).not.toMatch(/entropyhex|seedhex|dekb64|credentialid/u);
    // ...while the public material it is supposed to carry is present.
    expect(kit.kit.receiveDescriptor).toContain('wsh(sortedmulti(2,');
    // C7 published a real package, so this is now true — and the digests
    // beside it are the checkable evidence for the claim.
    expect(kit.standaloneToolPublished).toBe(true);
    expect(kit.kit.standaloneToolArtifactDigest).not.toMatch(/^0+$/u);
  });
});

describe('the coordinator surface is a deliberate list', () => {
  it('exposes exactly the C0-C6 op set and nothing else', async () => {
    // Pinned by name rather than by pattern: `importSigner` contains "sign"
    // while doing the opposite of signing, and a loose regex would either
    // false-positive on it or be weakened until it caught nothing. Adding an
    // op is meant to fail here so the surface stays a deliberate list.
    //
    // C4-C6 added the plan lifecycle, so this is no longer a list with no
    // funding path in it — `signPlan` and `broadcastPlan` are exactly that
    // path. What the list still asserts is that nothing arrived unnoticed:
    // every op that can move value is here because someone wrote it here.
    expect(Object.keys(VAULT_COORDINATOR_OP_SCHEMAS).sort()).toEqual([
      'vaultCoordinator.acknowledgePolicyPairing',
      'vaultCoordinator.acknowledgeRecoveryKitExport',
      'vaultCoordinator.beginImport',
      'vaultCoordinator.beginRecoveryCBackupCheck',
      'vaultCoordinator.beginRecoveryCSetup',
      'vaultCoordinator.beginRoleRecoveryExport',
      'vaultCoordinator.broadcastPlan',
      'vaultCoordinator.buildCpfp',
      'vaultCoordinator.buildPlan',
      'vaultCoordinator.cancelRecoveryCSetup',
      'vaultCoordinator.combinePlan',
      'vaultCoordinator.createPolicy',
      'vaultCoordinator.createRole',
      'vaultCoordinator.depositAddress',
      'vaultCoordinator.discardPlan',
      'vaultCoordinator.exportRoleRecovery',
      'vaultCoordinator.finalizePlan',
      'vaultCoordinator.importRecoveryCBackupCheckResponse',
      'vaultCoordinator.importRecoveryCSetupResponse',
      'vaultCoordinator.importSigner',
      'vaultCoordinator.plan',
      'vaultCoordinator.policy',
      'vaultCoordinator.policyPairingQr',
      'vaultCoordinator.proveRole',
      'vaultCoordinator.reconcilePlan',
      'vaultCoordinator.recoveryCReadiness',
      'vaultCoordinator.recoveryKit',
      'vaultCoordinator.removePolicy',
      'vaultCoordinator.removeRole',
      // R1: the counterpart of revealRole. It takes a phrase in and returns a
      // public role summary; it is not a signing or broadcasting surface.
      'vaultCoordinator.restoreRole',
      'vaultCoordinator.revealRole',
      'vaultCoordinator.roleOrigin',
      'vaultCoordinator.scan',
      'vaultCoordinator.signMobileRequest',
      'vaultCoordinator.signPlan',
      'vaultCoordinator.status',
    ]);
  });

  it('never returns a balance, UTXO set, PSBT, or txid', async () => {
    const s = await withPolicy();
    const answers = [
      await s.h.service.vaultCoordinatorStatus({ ...s.expectation }),
      await s.h.service.vaultCoordinatorPolicy({ ...s.expectation }),
      await s.h.service.vaultCoordinatorRecoveryKit({ ...s.expectation }),
    ];
    // Check response *keys*, not the prose: the recovery kit legitimately says
    // the word "UTXO" while explaining that inscriptions need an Ordinals
    // source, and a substring scan over English would flag it.
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          keys.add(key.toLowerCase());
          walk(child);
        }
      }
    };
    walk(answers);
    for (const forbidden of [
      'balancesats', 'valuesats', 'utxos', 'psbthex', 'psbt', 'txid', 'rawtx', 'inputs', 'outputs',
    ]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
  });
});
