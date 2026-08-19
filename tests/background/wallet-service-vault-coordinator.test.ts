/**
 * Workstream C0 exit gate: the signet Vault coordinator's create / inspect /
 * prove / reveal / remove state machine.
 *
 * The load-bearing claims under test, in the order ADR 0007 states them:
 *
 * - §8 the whole surface is refused unless the build channel injected a
 *   coordinator network, and nothing in a request can supply one;
 * - §1 role A is a separate CSPRNG generation event, is rejected if it
 *   collides with Spending seed S, and is not stored with or unwrappable by S;
 * - §2 possession is proven over the complete origin, not a fingerprint, and
 *   deleting a local copy is not revocation;
 * - §5 every use of role A's seed costs a fresh password reauthentication.
 *
 * Every wallet here is disposable in-memory test material with the shared test
 * password. Nothing is funded, mainnet, or reused.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { PASSWORD } from '@drey/core/testing/vault-helpers';
import { mnemonicToSeed, validateMnemonic } from '@drey/core/domain/keys/mnemonic';
import { base64ToBytes, bytesToHex, hexToBytes } from '@drey/core/domain/vault/encoding';
import { openVaultPayload } from '@drey/core/domain/vault/vault';
import {
  parseRecoveryCBackupCheckChallenge,
  parseRecoveryCSetupChallenge,
  recoveryCBackupCheckChallengeDigest,
  recoveryCSetupChallengeDigest,
  serializeRecoveryCBackupCheckChallenge,
  serializeRecoveryCBackupCheckResponse,
  serializeRecoveryCSetupResponse,
  verifyVaultProofOfPossession,
} from '@drey/core/domain/vault/multisig-encoding';
import { getSession } from '../../src/adapters/session/session-store';
import { loadVaults } from '../../src/adapters/storage/vault-store';
import {
  VAULT_COORDINATOR_IMPORT_KEY,
  VAULT_COORDINATOR_ROLE_KEY,
} from '../../src/adapters/storage/keys';
import {
  loadVaultRecoveryCCeremony,
  loadVaultRole,
  saveVaultRecoveryCCeremony,
} from '../../src/adapters/storage/vault-coordinator-store';
import {
  deriveVaultRoleOrigin,
  signVaultProofOfPossession,
} from '@drey/core/domain/vault/multisig-role';
import {
  recoveryCSetupProofInput,
  signRecoveryCBackupCheck,
} from '@drey/core/domain/vault/recovery-c-ceremony';
import {
  PEER_MNEMONICS,
  peerOriginHex,
  peerProofHex,
} from '../fixtures/vault-peer-signers';
import { makeHarness, type Harness } from './service-helpers';

beforeAll(installTestCryptoProvider);

const CHALLENGE = {
  sessionIdHex: createHash('sha256').update('c0-session').digest('hex').slice(0, 32),
  challengeNonceHex: createHash('sha256').update('c0-nonce').digest('hex'),
  transcriptHashHex: createHash('sha256').update('c0-transcript').digest('hex'),
  expiresAtMs: '4102444800000',
};

interface Setup {
  h: Harness;
  vaultId: string;
  expectation: { expectedVaultId: string; expectedSessionId: string };
}

/**
 * `coordinator: false` models a build with no coordinator. It omits the key
 * rather than setting it to undefined, because `exactOptionalPropertyTypes`
 * distinguishes the two and only omission matches what the composition root
 * does on a mainnet channel.
 */
async function setup(coordinator = true): Promise<Setup> {
  const h = makeHarness(undefined, {
    network: 'signet',
    ...(coordinator ? { vaultCoordinatorCapability: { network: 'signet', movement: 'full' } as const } : {}),
  });
  const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
  const unlocked = await h.service.unlock({ vaultId, password: PASSWORD });
  return {
    h,
    vaultId,
    expectation: { expectedVaultId: vaultId, expectedSessionId: unlocked.sessionId },
  };
}

async function createRole(s: Setup, label = 'Desktop A') {
  return s.h.service.vaultCoordinatorCreateRole({ password: PASSWORD, label, ...s.expectation });
}

describe('coordinator channel gate (ADR 0007 §8)', () => {
  it('refuses every op when the build injected no coordinator network', async () => {
    // The production/preview posture: `vaultCoordinatorCapability` is simply
    // absent, so there is nothing for a request to negotiate with.
    const s = await setup(false);
    const expectRefused = async (call: Promise<unknown>) =>
      expect(call).rejects.toMatchObject({ code: 'ERR_VAULT_COORDINATOR_UNAVAILABLE' });

    await expectRefused(createRole(s));
    await expectRefused(s.h.service.vaultCoordinatorRoleOrigin({ ...s.expectation }));
    await expectRefused(
      s.h.service.vaultCoordinatorProveRole({ password: PASSWORD, ...CHALLENGE, ...s.expectation }),
    );
    await expectRefused(
      s.h.service.vaultCoordinatorRevealRole({ password: PASSWORD, ...s.expectation }),
    );
    await expectRefused(s.h.service.vaultCoordinatorBeginRecoveryCSetup({ ...s.expectation }));
    await expectRefused(
      s.h.service.vaultCoordinatorImportRecoveryCSetupResponse({
        responseHex: '00',
        ...s.expectation,
      }),
    );
    await expectRefused(s.h.service.vaultCoordinatorCancelRecoveryCSetup({ ...s.expectation }));
    await expectRefused(
      s.h.service.vaultCoordinatorRemoveRole({
        password: PASSWORD,
        roleId: 'anything',
        ...s.expectation,
      }),
    );
    // C1's policy surface is behind the same single gate, not a second one.
    await expectRefused(s.h.service.vaultCoordinatorBeginImport({ ...s.expectation }));
    await expectRefused(
      s.h.service.vaultCoordinatorImportSigner({
        role: 'mobile-b',
        originHex: 'ab',
        proofResultHex: 'cd',
        ...s.expectation,
      }),
    );
    await expectRefused(
      s.h.service.vaultCoordinatorCreatePolicy({
        password: PASSWORD,
        vaultLabel: 'Vault',
        signerLabels: ['A', 'B', 'C'],
        birthdayHeight: null,
        ...s.expectation,
      }),
    );
    await expectRefused(s.h.service.vaultCoordinatorPolicy({ ...s.expectation }));
    await expectRefused(s.h.service.vaultCoordinatorRecoveryKit({ ...s.expectation }));
    await expectRefused(
      s.h.service.vaultCoordinatorAcknowledgeRecoveryKitExport({
        policyId: '11'.repeat(32),
        ...s.expectation,
      }),
    );
    await expectRefused(s.h.service.vaultCoordinatorBeginRecoveryCBackupCheck({ ...s.expectation }));
    await expectRefused(
      s.h.service.vaultCoordinatorImportRecoveryCBackupCheckResponse({
        responseHex: '00',
        ...s.expectation,
      }),
    );
    await expectRefused(s.h.service.vaultCoordinatorRecoveryCReadiness({ ...s.expectation }));
    await expectRefused(
      s.h.service.vaultCoordinatorRemovePolicy({
        password: PASSWORD,
        policyId: '11'.repeat(32),
        ...s.expectation,
      }),
    );
  });

  it('reports unavailable rather than throwing for the status probe', async () => {
    // status is what the UI polls; it must be answerable on a build with no
    // coordinator without looking like a transport failure.
    const s = await setup(false);
    await expect(s.h.service.vaultCoordinatorStatus({ ...s.expectation })).resolves.toEqual({
      available: false,
      network: null,
      movement: null,
      bound: null,
      role: 'absent',
      policy: 'absent',
      importPending: [],
    });
  });

  it('reports a mainnet coordinator as unsigned-only (ADR 0007 §8, amended)', async () => {
    // The pilot posture. A coordinator exists and can observe a real chain and
    // prepare unsigned plans, but the capability it was handed has no
    // `movement: 'full'` inhabitant on mainnet, so it can never sign and the UI
    // is told plainly not to fund it yet.
    const h = makeHarness(undefined, {
      network: 'mainnet',
      vaultCoordinatorCapability: { network: 'mainnet', movement: 'unsigned-only' } as const,
    });
    const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
    const unlocked = await h.service.unlock({ vaultId, password: PASSWORD });
    await expect(
      h.service.vaultCoordinatorStatus({
        expectedVaultId: vaultId,
        expectedSessionId: unlocked.sessionId,
      }),
    ).resolves.toMatchObject({
      available: true,
      network: 'mainnet',
      movement: 'unsigned-only',
    });
  });

  it('never writes coordinator storage on a build without a coordinator', async () => {
    const s = await setup(false);
    await expect(createRole(s)).rejects.toMatchObject({
      code: 'ERR_VAULT_COORDINATOR_UNAVAILABLE',
    });
    expect(await s.h.local.get(VAULT_COORDINATOR_ROLE_KEY)).toEqual({});
  });
});

describe('role A generation (ADR 0007 §1)', () => {
  it('creates a canonical signet Desktop-A origin and reports it', async () => {
    const s = await setup();
    const { role } = await createRole(s, 'Desktop A (signet test)');
    expect(role.label).toBe('Desktop A (signet test)');
    expect(role.origin.role).toBe('desktop-a');
    expect(role.origin.network).toBe('signet');
    expect(role.origin.originPath).toBe("m/48'/1'/0'/2'");
    expect(role.origin.accountXpub.startsWith('tpub')).toBe(true);
    await expect(s.h.service.vaultCoordinatorStatus({ ...s.expectation })).resolves.toMatchObject({
      available: true,
      network: 'signet',
      role: 'present',
    });
  });

  it('projects only cheap, locally verified Recovery Center Vault evidence', async () => {
    const s = await setup();
    await expect(
      s.h.service.vaultCoordinatorRecoveryCReadiness({ ...s.expectation }),
    ).resolves.toEqual({
      state: 'not_started',
      localRole: 'absent',
      policyState: 'absent',
      phoneSignerPaired: false,
      standaloneRecoveryPackageAvailable: true,
      policyId: null,
      setupComplete: false,
      kitExported: false,
      backupCheckComplete: false,
      ready: false,
    });

    await createRole(s);
    await expect(
      s.h.service.vaultCoordinatorRecoveryCReadiness({ ...s.expectation }),
    ).resolves.toMatchObject({
      state: 'not_started',
      localRole: 'usable',
      policyState: 'absent',
      phoneSignerPaired: false,
      standaloneRecoveryPackageAvailable: true,
      policyId: null,
      ready: false,
    });

    await s.h.local.set({ [VAULT_COORDINATOR_ROLE_KEY]: { schemaVersion: 999 } });
    await expect(
      s.h.service.vaultCoordinatorRecoveryCReadiness({ ...s.expectation }),
    ).resolves.toMatchObject({
      state: 'unusable',
      localRole: 'unusable',
      policyState: 'absent',
      phoneSignerPaired: false,
      policyId: null,
      ready: false,
    });
  });

  it('keeps role A out of the Spending wallet list entirely', async () => {
    const s = await setup();
    const { role } = await createRole(s);
    const vaults = await loadVaults(s.h.local);
    expect(Object.keys(vaults)).toEqual([s.vaultId]);
    expect(vaults[role.roleId]).toBeUndefined();
    // And it is not reachable through the ordinary vault surface either.
    const listed = await s.h.service.list();
    expect(listed.vaults.map((v) => v.vaultId)).toEqual([s.vaultId]);
  });

  it('does not store role A under the Spending wallet DEK', async () => {
    // The structural independence claim: the live session DEK unlocks S's
    // payload and must be useless against role A's record.
    const s = await setup();
    await createRole(s);
    const stored = await loadVaultRole(s.h.local);
    expect(stored.state).toBe('valid');
    if (stored.state !== 'valid') return;

    const session = await getSession(s.h.session);
    expect(session).not.toBeNull();
    const spendingDek = base64ToBytes(session!.dekB64);
    const vaults = await loadVaults(s.h.local);
    // Sanity: this DEK really is the one that opens the Spending payload.
    expect(() => openVaultPayload(vaults[s.vaultId]!, spendingDek)).not.toThrow();
    // ...and it cannot open role A.
    expect(() => openVaultPayload(stored.record.secret, spendingDek)).toThrow();
  });

  it('gives role A its own salt, DEK wrapping, and AEAD binding', async () => {
    const s = await setup();
    const { role } = await createRole(s);
    const stored = await loadVaultRole(s.h.local);
    if (stored.state !== 'valid') throw new Error('expected a stored role');
    const spending = (await loadVaults(s.h.local))[s.vaultId]!;
    expect(stored.record.secret.kdf.saltB64).not.toBe(spending.kdf.saltB64);
    expect(stored.record.secret.wrappedDek.ciphertextB64).not.toBe(
      spending.wrappedDek.ciphertextB64,
    );
    // The AEAD associated data names the role, not the wallet.
    expect(stored.record.secret.vaultId).toBe(role.roleId);
    expect(stored.record.secret.vaultId).not.toBe(s.vaultId);
  });

  it('produces a role phrase that is not the Spending recovery phrase', async () => {
    const s = await setup();
    await createRole(s);
    const spendingWords = await s.h.service.revealMnemonic({
      password: PASSWORD,
      ...s.expectation,
    });
    const roleWords = await s.h.service.vaultCoordinatorRevealRole({
      password: PASSWORD,
      ...s.expectation,
    });
    expect(validateMnemonic(roleWords.mnemonic)).toBe(true);
    expect(roleWords.mnemonic.split(' ')).toHaveLength(12);
    expect(roleWords.mnemonic).not.toBe(spendingWords.mnemonic);
  });

  it('rejects a candidate root that is the Spending seed (independence check)', async () => {
    // Force exactly the accident ADR §1 names: an RNG that hands the
    // coordinator the same 128 bits the Spending wallet was created from. In
    // WalletService.create the first 16-byte draw IS S's BIP39 entropy (it is
    // taken before createVaultRecord asks for a salt, which is also 16 bytes).
    // Core's generateMnemonic self-test makes every mnemonic creation a PAIR
    // of 16-byte draws (entropy + probe) and fails closed when they repeat,
    // so replaying S on every draw would trip that check before the ADR §1
    // independence check ever runs. The mock therefore records S, returns
    // fresh bytes everywhere else, and replays S exactly once — for the
    // role's entropy draw — after the test flips replayRoleEntropy.
    let draws = 0;
    let spendingEntropy: Uint8Array | undefined;
    let replayRoleEntropy = false;
    const h = makeHarness(undefined, {
      network: 'signet',
      vaultCoordinatorCapability: { network: 'signet', movement: 'full' },
      vaultDeps: {
        now: () => 1_752_969_600_000,
        random: (n: number) => {
          draws += 1;
          const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + draws * 97) % 256);
          if (n !== 16) return bytes;
          if (spendingEntropy === undefined) {
            // Copy: create() zeroizes its entropy array, and it is this very
            // buffer — replaying the alias would replay zeros.
            spendingEntropy = Uint8Array.from(bytes);
            return bytes;
          }
          if (replayRoleEntropy) {
            replayRoleEntropy = false;
            return Uint8Array.from(spendingEntropy);
          }
          return bytes;
        },
      },
    });
    const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
    const unlocked = await h.service.unlock({ vaultId, password: PASSWORD });
    replayRoleEntropy = true;
    await expect(
      h.service.vaultCoordinatorCreateRole({
        password: PASSWORD,
        label: 'A',
        expectedVaultId: vaultId,
        expectedSessionId: unlocked.sessionId,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_ROLE_NOT_INDEPENDENT' });
    // The rejected attempt persisted nothing.
    expect(await loadVaultRole(h.local)).toEqual({ state: 'absent' });
  });

  it('requires the password and rejects a second role', async () => {
    const s = await setup();
    await expect(
      s.h.service.vaultCoordinatorCreateRole({
        password: 'wrong-password-entirely',
        label: 'A',
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'wrong-password' });
    expect(await loadVaultRole(s.h.local)).toEqual({ state: 'absent' });

    await createRole(s);
    await expect(createRole(s)).rejects.toMatchObject({ code: 'ERR_VAULT_ROLE_EXISTS' });
  });

  it('survives a worker restart', async () => {
    const s = await setup();
    const { role } = await createRole(s);
    const restarted = s.h.rebuild();
    await expect(restarted.vaultCoordinatorRoleOrigin({ ...s.expectation })).resolves.toEqual({
      role,
    });
  });
});

describe('proof of possession (ADR 0007 §2)', () => {
  it('answers a peer challenge with a result core verifies', async () => {
    const s = await setup();
    const { role } = await createRole(s);
    const proof = await s.h.service.vaultCoordinatorProveRole({
      password: PASSWORD,
      ...CHALLENGE,
      ...s.expectation,
    });
    expect(proof.role).toBe('desktop-a');
    expect(proof.scheme).toBe('secp256k1-ecdsa-compact-low-s-v1');
    expect(
      verifyVaultProofOfPossession(
        { version: 1, origin: role.origin, ...CHALLENGE },
        {
          version: 1,
          role: 'desktop-a',
          inputDigestHex: proof.inputDigestHex,
          proofPublicKeyHex: proof.proofPublicKeyHex,
          signatureHex: proof.signatureHex,
          scheme: proof.scheme,
        },
      ),
    ).toBe(true);
  });

  it('does not verify against a different challenge', async () => {
    const s = await setup();
    const { role } = await createRole(s);
    const proof = await s.h.service.vaultCoordinatorProveRole({
      password: PASSWORD,
      ...CHALLENGE,
      ...s.expectation,
    });
    expect(
      verifyVaultProofOfPossession(
        {
          version: 1,
          origin: role.origin,
          ...CHALLENGE,
          challengeNonceHex: createHash('sha256').update('replayed').digest('hex'),
        },
        {
          version: 1,
          role: 'desktop-a',
          inputDigestHex: proof.inputDigestHex,
          proofPublicKeyHex: proof.proofPublicKeyHex,
          signatureHex: proof.signatureHex,
          scheme: proof.scheme,
        },
      ),
    ).toBe(false);
  });

  it('needs a fresh password even while the wallet is unlocked (§5)', async () => {
    const s = await setup();
    await createRole(s);
    await expect(
      s.h.service.vaultCoordinatorProveRole({
        password: 'not-the-password',
        ...CHALLENGE,
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'wrong-password' });
  });

  it('reports a missing role rather than inventing one', async () => {
    const s = await setup();
    await expect(
      s.h.service.vaultCoordinatorProveRole({ password: PASSWORD, ...CHALLENGE, ...s.expectation }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_ROLE_MISSING' });
    await expect(
      s.h.service.vaultCoordinatorRevealRole({ password: PASSWORD, ...s.expectation }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_ROLE_MISSING' });
    await expect(
      s.h.service.vaultCoordinatorRoleOrigin({ ...s.expectation }),
    ).resolves.toEqual({ role: null });
  });
});

describe('reveal and removal (ADR 0007 §§2, 5)', () => {
  it('requires the password to reveal the role words', async () => {
    const s = await setup();
    await createRole(s);
    await expect(
      s.h.service.vaultCoordinatorRevealRole({ password: 'nope', ...s.expectation }),
    ).rejects.toMatchObject({ code: 'wrong-password' });
  });

  it('requires the exact roleId to remove, and the password', async () => {
    const s = await setup();
    const { role } = await createRole(s);
    await expect(
      s.h.service.vaultCoordinatorRemoveRole({
        password: PASSWORD,
        roleId: 'some-other-role',
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_ROLE_MISSING' });
    await expect(
      s.h.service.vaultCoordinatorRemoveRole({
        password: 'nope',
        roleId: role.roleId,
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'wrong-password' });
    expect((await loadVaultRole(s.h.local)).state).toBe('valid');

    await expect(
      s.h.service.vaultCoordinatorRemoveRole({
        password: PASSWORD,
        roleId: role.roleId,
        ...s.expectation,
      }),
    ).resolves.toEqual({ removed: true });
    expect(await loadVaultRole(s.h.local)).toEqual({ state: 'absent' });
  });

  it('never silently discards a stored role it cannot parse', async () => {
    const s = await setup();
    await s.h.local.set({ [VAULT_COORDINATOR_ROLE_KEY]: { schemaVersion: 9, junk: true } });
    await expect(s.h.service.vaultCoordinatorStatus({ ...s.expectation })).resolves.toMatchObject({
      role: 'unusable',
    });
    // Creating over it would destroy it, so creation is blocked too.
    await expect(createRole(s)).rejects.toMatchObject({ code: 'ERR_VAULT_ROLE_EXISTS' });
    // A plain remove must not guess at it either.
    await expect(
      s.h.service.vaultCoordinatorRemoveRole({
        password: PASSWORD,
        roleId: 'guess',
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_ROLE_MISSING' });
    expect(await s.h.local.get(VAULT_COORDINATOR_ROLE_KEY)).not.toEqual({});

    // Only an explicit purge discards it.
    await expect(
      s.h.service.vaultCoordinatorRemoveRole({
        password: PASSWORD,
        purgeUnusable: true,
        ...s.expectation,
      }),
    ).resolves.toEqual({ removed: true });
    expect(await loadVaultRole(s.h.local)).toEqual({ state: 'absent' });
  });
});

function recoveryCSetupResponseHex(challengeHex: string): string {
  const challenge = parseRecoveryCSetupChallenge(hexToBytes(challengeHex));
  const seed = mnemonicToSeed(PEER_MNEMONICS['recovery-c']);
  try {
    const origin = deriveVaultRoleOrigin(seed, 'recovery-c', challenge.network);
    return bytesToHex(
      serializeRecoveryCSetupResponse({
        version: 1,
        challengeDigestHex: recoveryCSetupChallengeDigest(challenge),
        origin,
        proof: {
          ...signVaultProofOfPossession(
            seed,
            recoveryCSetupProofInput(challenge, origin),
            (BigInt(challenge.createdAtMs) + 1n).toString(),
          ),
          role: 'recovery-c',
        },
      }),
    );
  } finally {
    seed.fill(0);
  }
}

function recoveryCBackupResponseHex(challengeHex: string): string {
  const challenge = parseRecoveryCBackupCheckChallenge(hexToBytes(challengeHex));
  const seed = mnemonicToSeed(PEER_MNEMONICS['recovery-c']);
  try {
    return bytesToHex(
      serializeRecoveryCBackupCheckResponse(
        signRecoveryCBackupCheck(
          seed,
          challenge,
          (BigInt(challenge.createdAtMs) + 1n).toString(),
        ),
      ),
    );
  } finally {
    seed.fill(0);
  }
}

async function setupOfflineRecoveryC(s: Setup) {
  await createRole(s);
  const opened = await s.h.service.vaultCoordinatorBeginImport({ ...s.expectation });
  const peerChallenge = {
    sessionIdHex: opened.sessionIdHex,
    challengeNonceHex: opened.challengeNonceHex,
    transcriptHashHex: opened.transcriptHashHex,
    expiresAtMs: opened.expiresAtMs,
  };
  await s.h.service.vaultCoordinatorImportSigner({
    role: 'mobile-b',
    originHex: peerOriginHex('mobile-b'),
    proofResultHex: peerProofHex('mobile-b', peerChallenge),
    ...s.expectation,
  });
  const setupChallenge = await s.h.service.vaultCoordinatorBeginRecoveryCSetup({
    ...s.expectation,
  });
  const imported = await s.h.service.vaultCoordinatorImportRecoveryCSetupResponse({
    responseHex: recoveryCSetupResponseHex(setupChallenge.challengeHex),
    ...s.expectation,
  });
  return { opened, setupChallenge, imported };
}

describe('offline Recovery C ceremony (ADR 0007 §6)', () => {
  it('exchanges only bounded public records and survives a worker restart', async () => {
    const s = await setup();
    const { setupChallenge, imported } = await setupOfflineRecoveryC(s);
    expect(setupChallenge.challengeHex.length / 2).toBeLessThanOrEqual(65_536);
    expect(setupChallenge.fingerprint).toMatch(/^[0-9a-f]{4}(?:-[0-9a-f]{4}){3}$/u);
    expect(imported).toMatchObject({ role: 'recovery-c', pending: [], complete: true });
    await expect(
      s.h.service.vaultCoordinatorRecoveryCReadiness({ ...s.expectation }),
    ).resolves.toMatchObject({
      state: 'setup_complete',
      localRole: 'usable',
      policyState: 'absent',
      phoneSignerPaired: false,
      standaloneRecoveryPackageAvailable: true,
      setupComplete: true,
      ready: false,
    });

    const stored = JSON.stringify([
      ...s.h.local.store.entries(),
      ...s.h.session.store.entries(),
    ]);
    const seed = mnemonicToSeed(PEER_MNEMONICS['recovery-c']);
    expect(stored).not.toContain(PEER_MNEMONICS['recovery-c']);
    expect(stored).not.toContain(bytesToHex(seed));
    seed.fill(0);

    const restarted = s.h.rebuild();
    await expect(
      restarted.vaultCoordinatorRecoveryCReadiness({ ...s.expectation }),
    ).resolves.toMatchObject({ state: 'setup_complete', setupComplete: true });
    await expect(
      restarted.vaultCoordinatorImportRecoveryCSetupResponse({
        responseHex: recoveryCSetupResponseHex(setupChallenge.challengeHex),
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_RECOVERY_C_SESSION_MISSING' });
  });

  it('invalidates replaced and cancelled challenges and rejects the generic C importer', async () => {
    const s = await setup();
    await createRole(s);
    const opened = await s.h.service.vaultCoordinatorBeginImport({ ...s.expectation });
    const first = await s.h.service.vaultCoordinatorBeginRecoveryCSetup({ ...s.expectation });
    const replacement = await s.h.service.vaultCoordinatorBeginRecoveryCSetup({
      ...s.expectation,
    });
    expect(replacement.challengeDigestHex).not.toBe(first.challengeDigestHex);
    await expect(
      s.h.service.vaultCoordinatorImportRecoveryCSetupResponse({
        responseHex: recoveryCSetupResponseHex(first.challengeHex),
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_RECOVERY_C_RESPONSE_REJECTED' });
    await expect(
      s.h.service.vaultCoordinatorImportRecoveryCSetupResponse({
        responseHex: '00',
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_RECOVERY_C_RESPONSE_REJECTED' });
    await expect(
      s.h.service.vaultCoordinatorImportSigner({
        role: 'recovery-c',
        originHex: peerOriginHex('recovery-c'),
        proofResultHex: peerProofHex('recovery-c', opened),
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_SIGNER_REJECTED' });
    await expect(
      s.h.service.vaultCoordinatorCancelRecoveryCSetup({ ...s.expectation }),
    ).resolves.toEqual({ cancelled: true });
    await expect(
      s.h.service.vaultCoordinatorImportRecoveryCSetupResponse({
        responseHex: recoveryCSetupResponseHex(replacement.challengeHex),
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_RECOVERY_C_SESSION_MISSING' });
  });

  it('refuses to mint C challenges from a storage-altered enrollment transcript', async () => {
    const s = await setup();
    await createRole(s);
    await s.h.service.vaultCoordinatorBeginImport({ ...s.expectation });
    const stored = s.h.local.store.get(VAULT_COORDINATOR_IMPORT_KEY);
    if (typeof stored !== 'object' || stored === null) throw new Error('expected import state');
    await s.h.local.set({
      [VAULT_COORDINATOR_IMPORT_KEY]: { ...stored, transcriptHashHex: '00'.repeat(32) },
    });
    await expect(
      s.h.service.vaultCoordinatorBeginRecoveryCSetup({ ...s.expectation }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_RECOVERY_C_SESSION_MISSING' });
  });

  it('lets the bounded offline ceremony finish after the shorter peer-import clock closes', async () => {
    const s = await setup();
    const { opened } = await setupOfflineRecoveryC(s);
    s.h.clock.now = Number(opened.expiresAtMs) + 1;
    await expect(
      s.h.service.vaultCoordinatorCreatePolicy({
        password: PASSWORD,
        vaultLabel: 'Vault',
        signerLabels: ['A', 'B', 'C'],
        birthdayHeight: null,
        ...s.expectation,
      }),
    ).resolves.toMatchObject({ policy: { policyId: expect.stringMatching(/^[0-9a-f]{64}$/u) } });
  });

  it('accepts the exact setup expiry boundary and rejects the next millisecond', async () => {
    const atBoundary = await setup();
    await createRole(atBoundary);
    await atBoundary.h.service.vaultCoordinatorBeginImport({ ...atBoundary.expectation });
    const live = await atBoundary.h.service.vaultCoordinatorBeginRecoveryCSetup({
      ...atBoundary.expectation,
    });
    atBoundary.h.clock.now = Number(live.expiresAtMs);
    atBoundary.expectation.expectedSessionId = (
      await atBoundary.h.service.unlock({ vaultId: atBoundary.vaultId, password: PASSWORD })
    ).sessionId;
    await expect(
      atBoundary.h.service.vaultCoordinatorImportRecoveryCSetupResponse({
        responseHex: recoveryCSetupResponseHex(live.challengeHex),
        ...atBoundary.expectation,
      }),
    ).resolves.toMatchObject({ role: 'recovery-c' });

    const expired = await setup();
    await createRole(expired);
    await expired.h.service.vaultCoordinatorBeginImport({ ...expired.expectation });
    const stale = await expired.h.service.vaultCoordinatorBeginRecoveryCSetup({
      ...expired.expectation,
    });
    expired.h.clock.now = Number(stale.expiresAtMs) + 1;
    expired.expectation.expectedSessionId = (
      await expired.h.service.unlock({ vaultId: expired.vaultId, password: PASSWORD })
    ).sessionId;
    await expect(
      expired.h.service.vaultCoordinatorImportRecoveryCSetupResponse({
        responseHex: recoveryCSetupResponseHex(stale.challengeHex),
        ...expired.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_RECOVERY_C_RESPONSE_REJECTED' });
  });

  it('rejects a storage-tampered backup challenge even when Recovery C signs it', async () => {
    const s = await setup();
    await setupOfflineRecoveryC(s);
    const { policy } = await s.h.service.vaultCoordinatorCreatePolicy({
      password: PASSWORD,
      vaultLabel: 'Vault',
      signerLabels: ['A', 'B', 'C'],
      birthdayHeight: null,
      ...s.expectation,
    });
    await s.h.service.vaultCoordinatorAcknowledgeRecoveryKitExport({
      policyId: policy.policyId,
      ...s.expectation,
    });
    const backup = await s.h.service.vaultCoordinatorBeginRecoveryCBackupCheck({
      ...s.expectation,
    });
    const challenge = parseRecoveryCBackupCheckChallenge(hexToBytes(backup.challengeHex));
    const tampered = {
      ...challenge,
      standaloneToolArtifactDigest: '00'.repeat(32),
    };
    const stored = await loadVaultRecoveryCCeremony(s.h.local);
    if (stored.state !== 'valid' || stored.record.policy === null) {
      throw new Error('expected an open Recovery C backup challenge');
    }
    const policyCeremony = stored.record.policy;
    const open = policyCeremony.backupCheck.open;
    if (open === null) throw new Error('expected an open Recovery C backup challenge');
    await saveVaultRecoveryCCeremony(s.h.local, {
      ...stored.record,
      policy: {
        ...policyCeremony,
        backupCheck: {
          ...policyCeremony.backupCheck,
          open: {
            ...open,
            challengeHex: bytesToHex(serializeRecoveryCBackupCheckChallenge(tampered)),
            challengeDigestHex: recoveryCBackupCheckChallengeDigest(tampered),
          },
        },
      },
    });
    await expect(
      s.h.service.vaultCoordinatorImportRecoveryCBackupCheckResponse({
        responseHex: recoveryCBackupResponseHex(
          bytesToHex(serializeRecoveryCBackupCheckChallenge(tampered)),
        ),
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_RECOVERY_C_RESPONSE_REJECTED' });
  });

  it('blocks funding and value movement until the kit and paper restore are proved', async () => {
    const s = await setup();
    await setupOfflineRecoveryC(s);
    const { policy } = await s.h.service.vaultCoordinatorCreatePolicy({
      password: PASSWORD,
      vaultLabel: 'Vault',
      signerLabels: ['A', 'B', 'C'],
      birthdayHeight: null,
      ...s.expectation,
    });
    await expect(
      s.h.service.vaultCoordinatorRecoveryCReadiness({ ...s.expectation }),
    ).resolves.toMatchObject({
      state: 'kit_required',
      localRole: 'usable',
      policyState: 'usable',
      phoneSignerPaired: true,
      standaloneRecoveryPackageAvailable: true,
      ready: false,
    });
    await expect(
      s.h.service.vaultCoordinatorDepositAddress({ index: 0, ...s.expectation }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_RECOVERY_C_BACKUP_REQUIRED' });
    await expect(
      s.h.service.vaultCoordinatorBeginRecoveryCBackupCheck({ ...s.expectation }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_RECOVERY_C_KIT_REQUIRED' });

    await s.h.service.vaultCoordinatorAcknowledgeRecoveryKitExport({
      policyId: policy.policyId,
      ...s.expectation,
    });
    const backup = await s.h.service.vaultCoordinatorBeginRecoveryCBackupCheck({
      ...s.expectation,
    });
    await expect(
      s.h.service.vaultCoordinatorImportRecoveryCBackupCheckResponse({
        responseHex: recoveryCBackupResponseHex(backup.challengeHex),
        ...s.expectation,
      }),
    ).resolves.toEqual({ policyId: policy.policyId, completed: true });
    await expect(
      s.h.service.vaultCoordinatorImportRecoveryCBackupCheckResponse({
        responseHex: recoveryCBackupResponseHex(backup.challengeHex),
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_RECOVERY_C_SESSION_MISSING' });
    await expect(
      s.h.service.vaultCoordinatorRecoveryCReadiness({ ...s.expectation }),
    ).resolves.toMatchObject({
      state: 'ready',
      localRole: 'usable',
      policyState: 'usable',
      phoneSignerPaired: true,
      standaloneRecoveryPackageAvailable: true,
      ready: true,
      backupCheckComplete: true,
    });
    await expect(
      s.h.service.vaultCoordinatorDepositAddress({ index: 0, ...s.expectation }),
    ).resolves.toMatchObject({ index: 0, address: expect.stringMatching(/^tb1/u) });
    await expect(
      s.h.service.vaultCoordinatorPolicy({ ...s.expectation }),
    ).resolves.toMatchObject({
      state: 'present',
      policy: { firstReceiveAddress: expect.stringMatching(/^tb1/u) },
    });
  });
});
