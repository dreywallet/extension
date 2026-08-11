/**
 * Workstream R1 exit gate: putting Vault role A back.
 *
 * Until this existed, role A was generation-only. `revealRole` could write the
 * words down and nothing could read them back, so a funded Vault was one
 * browser-profile wipe from unrecoverable — and unlike the Spending wallet
 * there is no single phrase to fall back on, only two of three roots plus the
 * policy.
 *
 * The claims under test:
 *
 * - a restore of the words `revealRole` produced reproduces the *same* role:
 *   identical origin, master fingerprint, and account xpub;
 * - a policy recomposed over a restored role reproduces the identical
 *   `policyId`, both descriptors, and the first receive address — which is what
 *   makes this a recovery path rather than a second creation;
 * - restore has `createRole`'s posture exactly: password reauthentication, the
 *   ADR §1 independence checks against Spending seed S, its own salt/DEK/
 *   roleId-bound AEAD, and refusal when a role or a policy already exists;
 * - the restored role survives a worker restart; and
 * - the restore response carries no secret. The request carries the phrase in,
 *   because that is the only way words get back in; nothing comes out.
 *
 * Every wallet here is disposable in-memory test material with the shared test
 * password. Nothing is funded, mainnet, or reused.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { PASSWORD } from '@drey/core/testing/vault-helpers';
import { base64ToBytes } from '@drey/core/domain/vault/encoding';
import { openVaultPayload } from '@drey/core/domain/vault/vault';
import { getSession } from '../../src/adapters/session/session-store';
import { loadVaults } from '../../src/adapters/storage/vault-store';
import { VAULT_COORDINATOR_ROLE_KEY } from '../../src/adapters/storage/keys';
import { loadVaultRole } from '../../src/adapters/storage/vault-coordinator-store';
import { VAULT_COORDINATOR_OP_SCHEMAS } from '../../src/messaging/vault-coordinator-ops';
import {
  peerOriginHex,
  peerProofHex,
  recoveryCBackupResponseHex,
  recoveryCSetupResponseHex,
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

async function createRole(s: Setup, label = 'Desktop A') {
  return s.h.service.vaultCoordinatorCreateRole({ password: PASSWORD, label, ...s.expectation });
}

async function restoreRole(s: Setup, mnemonic: string, label = 'Desktop A (restored)') {
  return s.h.service.vaultCoordinatorRestoreRole({
    password: PASSWORD,
    label,
    mnemonic,
    ...s.expectation,
  });
}

async function reveal(s: Setup): Promise<string> {
  const { mnemonic } = await s.h.service.vaultCoordinatorRevealRole({
    password: PASSWORD,
    ...s.expectation,
  });
  return mnemonic;
}

/** Mobile B and offline Recovery C enrolled, then the paper gate completed. */
async function committedPolicy(s: Setup) {
  const challenge = await s.h.service.vaultCoordinatorBeginImport({ ...s.expectation });
  await s.h.service.vaultCoordinatorImportSigner({
    role: 'mobile-b',
    originHex: peerOriginHex('mobile-b'),
    proofResultHex: peerProofHex('mobile-b', challenge),
    ...s.expectation,
  });
  const setupChallenge = await s.h.service.vaultCoordinatorBeginRecoveryCSetup({
    ...s.expectation,
  });
  await s.h.service.vaultCoordinatorImportRecoveryCSetupResponse({
    responseHex: recoveryCSetupResponseHex(setupChallenge.challengeHex),
    ...s.expectation,
  });
  const { policy } = await s.h.service.vaultCoordinatorCreatePolicy({
    password: PASSWORD,
    vaultLabel: 'Test Vault',
    signerLabels: ['Desktop', 'Mobile', 'Recovery'],
    birthdayHeight: 250_000,
    ...s.expectation,
  });
  await s.h.service.vaultCoordinatorAcknowledgeRecoveryKitExport({
    policyId: policy.policyId,
    ...s.expectation,
  });
  const backupChallenge = await s.h.service.vaultCoordinatorBeginRecoveryCBackupCheck({
    ...s.expectation,
  });
  await s.h.service.vaultCoordinatorImportRecoveryCBackupCheckResponse({
    responseHex: recoveryCBackupResponseHex(backupChallenge.challengeHex),
    ...s.expectation,
  });
  const ready = await s.h.service.vaultCoordinatorPolicy({ ...s.expectation });
  if (ready.policy === null) throw new Error('expected a ready Vault policy');
  return ready.policy;
}

describe('R1 role restore reproduces the same role (ADR 0007 §1)', () => {
  it('rebuilds the identical origin, fingerprint, and account xpub', async () => {
    const s = await setup();
    const { role: original } = await createRole(s);
    const words = await reveal(s);

    // Wipe the profile's coordinator state the way losing a browser profile
    // would, then put the role back from the words alone.
    await s.h.service.vaultCoordinatorRemoveRole({
      password: PASSWORD,
      roleId: original.roleId,
      ...s.expectation,
    });
    expect(await loadVaultRole(s.h.local)).toEqual({ state: 'absent' });

    const { role: restored } = await restoreRole(s, words);
    expect(restored.origin).toEqual(original.origin);
    expect(restored.origin.masterFingerprintHex).toBe(original.origin.masterFingerprintHex);
    expect(restored.origin.accountXpub).toBe(original.origin.accountXpub);
    // ...and revealing again returns the same words, so the round trip closes.
    expect(await reveal(s)).toBe(words);
  });

  it('gives the restored record a new roleId and a new AEAD binding', async () => {
    // The roleId identifies this local encrypted record, not the Bitcoin root.
    // Reusing the old one would imply the ciphertext was recovered too; it was
    // not, it was rebuilt from the words under a fresh salt and DEK.
    const s = await setup();
    const { role: original } = await createRole(s);
    const words = await reveal(s);
    const before = await loadVaultRole(s.h.local);
    await s.h.service.vaultCoordinatorRemoveRole({
      password: PASSWORD,
      roleId: original.roleId,
      ...s.expectation,
    });
    const { role: restored } = await restoreRole(s, words);
    const after = await loadVaultRole(s.h.local);
    if (before.state !== 'valid' || after.state !== 'valid') throw new Error('expected two roles');

    expect(restored.roleId).not.toBe(original.roleId);
    expect(after.record.secret.vaultId).toBe(restored.roleId);
    expect(after.record.secret.kdf.saltB64).not.toBe(before.record.secret.kdf.saltB64);
    expect(after.record.secret.wrappedDek.ciphertextB64).not.toBe(
      before.record.secret.wrappedDek.ciphertextB64,
    );
  });

  it('keeps a restored role outside the Spending wallet and its DEK', async () => {
    // The same structural independence C0 proved for a generated role. A
    // restore that quietly filed the role next to S would undo it.
    const s = await setup();
    const { role: original } = await createRole(s);
    const words = await reveal(s);
    await s.h.service.vaultCoordinatorRemoveRole({
      password: PASSWORD,
      roleId: original.roleId,
      ...s.expectation,
    });
    const { role: restored } = await restoreRole(s, words);

    const vaults = await loadVaults(s.h.local);
    expect(Object.keys(vaults)).toEqual([s.vaultId]);
    expect(vaults[restored.roleId]).toBeUndefined();

    const stored = await loadVaultRole(s.h.local);
    if (stored.state !== 'valid') throw new Error('expected a stored role');
    const session = await getSession(s.h.session);
    const spendingDek = base64ToBytes(session!.dekB64);
    expect(() => openVaultPayload(vaults[s.vaultId]!, spendingDek)).not.toThrow();
    expect(() => openVaultPayload(stored.record.secret, spendingDek)).toThrow();
  });

  it('survives a worker restart', async () => {
    const s = await setup();
    const { role: original } = await createRole(s);
    const words = await reveal(s);
    await s.h.service.vaultCoordinatorRemoveRole({
      password: PASSWORD,
      roleId: original.roleId,
      ...s.expectation,
    });
    const { role: restored } = await restoreRole(s, words);
    const rebuilt = s.h.rebuild();
    await expect(rebuilt.vaultCoordinatorRoleOrigin({ ...s.expectation })).resolves.toEqual({
      role: restored,
    });
  });
});

describe('R1 a restored role rebuilds the same Vault (ADR 0007 §§3-4)', () => {
  it('recomposes the identical policyId, descriptors, and first address', async () => {
    // The claim that makes this a recovery path: the words plus the two public
    // peer records are enough to arrive back at the same Vault. If the policyId
    // moved, the "restored" role would be watching a different Vault from the
    // one that holds the coins.
    const s = await setup();
    const { role: original } = await createRole(s);
    const before = await committedPolicy(s);
    const words = await reveal(s);

    await s.h.service.vaultCoordinatorRemovePolicy({
      password: PASSWORD,
      policyId: before.policyId,
      ...s.expectation,
    });
    await s.h.service.vaultCoordinatorRemoveRole({
      password: PASSWORD,
      roleId: original.roleId,
      ...s.expectation,
    });

    await restoreRole(s, words);
    const after = await committedPolicy(s);

    expect(after.policyId).toBe(before.policyId);
    expect(after.receiveDescriptor).toBe(before.receiveDescriptor);
    expect(after.changeDescriptor).toBe(before.changeDescriptor);
    expect(after.receiveChecksum).toBe(before.receiveChecksum);
    expect(after.changeChecksum).toBe(before.changeChecksum);
    expect(after.firstReceiveAddress).toBe(before.firstReceiveAddress);
    expect(after.signers.map((signer) => signer.masterFingerprintHex)).toEqual(
      before.signers.map((signer) => signer.masterFingerprintHex),
    );
  });

  it('clears a pending import minted against the role that was lost', async () => {
    // The stale-transcript case. `beginImport` binds the challenge to role A's
    // own origin, so peers half-imported under the previous record were never
    // proven to this one. Restarting the ceremony is the cheap correct outcome;
    // silently keeping the earlier halves is the dangerous one.
    const s = await setup();
    const { role: original } = await createRole(s);
    const challenge = await s.h.service.vaultCoordinatorBeginImport({ ...s.expectation });
    await s.h.service.vaultCoordinatorImportSigner({
      role: 'mobile-b',
      originHex: peerOriginHex('mobile-b'),
      proofResultHex: peerProofHex('mobile-b', challenge),
      ...s.expectation,
    });
    const words = await reveal(s);
    await s.h.service.vaultCoordinatorRemoveRole({
      password: PASSWORD,
      roleId: original.roleId,
      ...s.expectation,
    });
    await restoreRole(s, words);

    await expect(s.h.service.vaultCoordinatorStatus({ ...s.expectation })).resolves.toMatchObject({
      role: 'present',
      importPending: [],
    });
  });
});

describe('R1 restore refuses what creation refuses (ADR 0007 §§1-2)', () => {
  it('refuses while any role is stored, valid or not', async () => {
    const s = await setup();
    await createRole(s);
    const words = await reveal(s);
    await expect(restoreRole(s, words)).rejects.toMatchObject({
      code: 'ERR_VAULT_ROLE_EXISTS',
    });
  });

  it('refuses while a policy still names a signer A', async () => {
    // Writing a new role under a committed policy would swap the local signing
    // root without the policy noticing. ADR §2 makes replacement its own
    // ceremony, and this is not it.
    const s = await setup();
    const { role: original } = await createRole(s);
    await committedPolicy(s);
    const words = await reveal(s);
    // Remove only the role — which the policy itself refuses, so force the
    // state the way a partial storage loss would.
    await expect(
      s.h.service.vaultCoordinatorRemoveRole({
        password: PASSWORD,
        roleId: original.roleId,
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_POLICY_EXISTS' });
    await s.h.local.remove(VAULT_COORDINATOR_ROLE_KEY);

    await expect(restoreRole(s, words)).rejects.toMatchObject({
      code: 'ERR_VAULT_POLICY_EXISTS',
    });
  });

  it('refuses the Spending recovery phrase with the independence code', async () => {
    // The mistake ADR §1 exists to catch, and the one a restore box invites in
    // a way a generate button never could: a user who reaches for "the phrase"
    // reaches for the wrong one.
    const s = await setup();
    const spending = await s.h.service.revealMnemonic({ password: PASSWORD, ...s.expectation });
    await expect(restoreRole(s, spending.mnemonic)).rejects.toMatchObject({
      code: 'ERR_VAULT_ROLE_NOT_INDEPENDENT',
    });
    expect(await loadVaultRole(s.h.local)).toEqual({ state: 'absent' });
  });

  it('requires the password even while the wallet is unlocked (§5)', async () => {
    const s = await setup();
    const { role: original } = await createRole(s);
    const words = await reveal(s);
    await s.h.service.vaultCoordinatorRemoveRole({
      password: PASSWORD,
      roleId: original.roleId,
      ...s.expectation,
    });
    await expect(
      s.h.service.vaultCoordinatorRestoreRole({
        password: 'not-the-password',
        label: 'A',
        mnemonic: words,
        ...s.expectation,
      }),
    ).rejects.toMatchObject({ code: 'wrong-password' });
    expect(await loadVaultRole(s.h.local)).toEqual({ state: 'absent' });
  });

  it('is refused outright on a build with no coordinator (§8)', async () => {
    const h = makeHarness(undefined, { network: 'signet' });
    const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
    const unlocked = await h.service.unlock({ vaultId, password: PASSWORD });
    await expect(
      h.service.vaultCoordinatorRestoreRole({
        password: PASSWORD,
        label: 'A',
        mnemonic:
          'grace frog zone boss dawn market donate wagon amateur stadium puppy kind',
        expectedVaultId: vaultId,
        expectedSessionId: unlocked.sessionId,
      }),
    ).rejects.toMatchObject({ code: 'ERR_VAULT_COORDINATOR_UNAVAILABLE' });
  });
});

describe('R1 wire contract', () => {
  const spec = VAULT_COORDINATOR_OP_SCHEMAS['vaultCoordinator.restoreRole'];

  it('rejects a phrase with a bad checksum at the boundary', () => {
    // Typed ERR_INVALID_PAYLOAD rather than an opaque internal error, the same
    // contract core's `vault.restore` uses.
    const base = {
      password: PASSWORD,
      label: 'A',
      expectedVaultId: 'v',
      expectedSessionId: '00000000-0000-4000-8000-000000000001',
    };
    expect(
      spec.request.safeParse({
        ...base,
        mnemonic: 'grace frog zone boss dawn market donate wagon amateur stadium puppy kind',
      }).success,
    ).toBe(true);
    for (const mnemonic of [
      // one word changed: valid words, invalid checksum
      'grace frog zone boss dawn market donate wagon amateur stadium puppy king',
      // not in the wordlist
      'grace frog zone boss dawn market donate wagon amateur stadium puppy zzzz',
      // wrong length
      'grace frog zone boss dawn market donate wagon amateur stadium puppy',
      '',
    ]) {
      expect(spec.request.safeParse({ ...base, mnemonic }).success, mnemonic).toBe(false);
    }
  });

  it('takes the phrase in and returns no secret', () => {
    // The asymmetry is the point: `revealRole` is the one sanctioned
    // secret-bearing *response*, and restore does not become a second one.
    expect(spec.response.safeParse({ mnemonic: 'a b c' }).success).toBe(false);
    expect(spec.response.safeParse({ seedHex: 'ff', entropyHex: 'ff' }).success).toBe(false);
    // ...and there is no passphrase field, so no role can be minted that
    // `revealRole` could not reproduce.
    expect(
      spec.request.safeParse({
        password: PASSWORD,
        label: 'A',
        mnemonic: 'grace frog zone boss dawn market donate wagon amateur stadium puppy kind',
        passphrase: 'extra',
        expectedVaultId: 'v',
        expectedSessionId: '00000000-0000-4000-8000-000000000001',
      }).success,
    ).toBe(false);
  });
});
