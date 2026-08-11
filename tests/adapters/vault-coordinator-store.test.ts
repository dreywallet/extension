/**
 * Vault role persistence (Workstream C0).
 *
 * The behaviour that matters here is the *failure* posture. Role A is a
 * Bitcoin root, so unlike the passkey envelope store this one must never
 * repair, drop, or overwrite a value it cannot read: a bad parse reports
 * `unusable` and leaves the bytes alone.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { PASSWORD, TEST_PARAMS } from '@drey/core/testing/vault-helpers';
import { createVaultRecord, webCryptoDeps } from '@drey/core/domain/vault/vault';
import { entropyToMnemonic, mnemonicToSeed } from '@drey/core/domain/keys/mnemonic';
import { bytesToHex } from '@drey/core/domain/vault/encoding';
import {
  VAULT_COORDINATOR_IMPORT_KEY,
  VAULT_COORDINATOR_RECOVERY_C_KEY,
  VAULT_COORDINATOR_ROLE_KEY,
} from '../../src/adapters/storage/keys';
import {
  clearVaultRole,
  loadVaultRecoveryCCeremony,
  loadVaultRole,
  saveVaultImportWithRecoveryCCeremony,
  saveVaultRecoveryCCeremony,
  saveVaultRole,
  vaultRecoveryCCeremonyStateSchema,
  vaultRoleSummary,
  type VaultCoordinatorRoleRecordV1,
  type VaultImportSessionV1,
  type VaultRecoveryCCeremonyStateV1,
} from '../../src/adapters/storage/vault-coordinator-store';
import { deriveVaultRoleOrigin } from '@drey/core/domain/vault/multisig-role';
import { makeFakeArea } from './fake-area';
import { peerOrigin } from '../fixtures/vault-peer-signers';

beforeAll(installTestCryptoProvider);

const ROLE_ID = 'role-a-0001';

// One consistent disposable BIP39 identity: core's payload check requires that
// entropy and seed describe the same mnemonic, so both are derived here rather
// than pasted.
const ENTROPY = Uint8Array.from({ length: 16 }, (_, i) => (i * 7 + 11) % 256);
const MNEMONIC = entropyToMnemonic(ENTROPY);
const SEED = mnemonicToSeed(MNEMONIC);

let record: VaultCoordinatorRoleRecordV1;

beforeAll(async () => {
  const secret = await createVaultRecord(
    {
      vaultId: ROLE_ID,
      name: 'vault-role-desktop-a',
      password: PASSWORD,
      payload: { version: 1, entropyHex: bytesToHex(ENTROPY), seedHex: bytesToHex(SEED) },
      kdfParams: TEST_PARAMS,
    },
    webCryptoDeps(),
  );
  record = {
    schemaVersion: 1,
    roleId: ROLE_ID,
    role: 'desktop-a',
    network: 'signet',
    createdAt: 1_752_969_600_000,
    label: 'Desktop A',
    origin: deriveVaultRoleOrigin(SEED, 'desktop-a'),
    secret,
  };
});

describe('vault coordinator store', () => {
  it('reports absent for an empty area', async () => {
    expect(await loadVaultRole(makeFakeArea())).toEqual({ state: 'absent' });
  });

  it('round-trips a valid record', async () => {
    const area = makeFakeArea();
    await saveVaultRole(area, record);
    const loaded = await loadVaultRole(area);
    expect(loaded).toEqual({ state: 'valid', record });
    expect(vaultRoleSummary(record)).toEqual({
      roleId: record.roleId,
      label: record.label,
      createdAt: record.createdAt,
      origin: record.origin,
    });
    // The summary is the public projection: it must not carry the secret half.
    expect(Object.keys(vaultRoleSummary(record))).not.toContain('secret');
  });

  it('reports unusable — and preserves the bytes — for anything it cannot parse', async () => {
    for (const junk of [
      { schemaVersion: 2, roleId: ROLE_ID },
      { ...record, network: 'mainnet' },
      { ...record, role: 'mobile-b' },
      { ...record, origin: { ...record.origin, network: 'mainnet' } },
      // A secret half grafted from some other record: its AEAD binding names a
      // different id, so the ciphertext is not this role's.
      { ...record, secret: { ...record.secret, vaultId: 'someone-else' } },
      { ...record, extraField: true },
      'not-an-object',
      42,
    ]) {
      const area = makeFakeArea();
      await area.set({ [VAULT_COORDINATOR_ROLE_KEY]: junk });
      expect(await loadVaultRole(area), JSON.stringify(junk).slice(0, 60)).toEqual({
        state: 'unusable',
      });
      // Nothing was deleted or rewritten.
      expect(area.store.get(VAULT_COORDINATOR_ROLE_KEY)).toEqual(junk);
    }
  });

  it('refuses to write a record that would not load back', async () => {
    const area = makeFakeArea();
    await expect(
      saveVaultRole(area, { ...record, network: 'mainnet' } as unknown as VaultCoordinatorRoleRecordV1),
    ).rejects.toThrow();
    expect(area.store.has(VAULT_COORDINATOR_ROLE_KEY)).toBe(false);
  });

  it('clears only on an explicit removal', async () => {
    const area = makeFakeArea();
    await saveVaultRole(area, record);
    await clearVaultRole(area);
    expect(await loadVaultRole(area)).toEqual({ state: 'absent' });
  });
});

const OPEN_CHALLENGE = {
  challengeHex: '0102',
  challengeDigestHex: '11'.repeat(32),
  createdAt: 1,
  expiresAtMs: '2',
};

const COMPLETED_CEREMONY: VaultRecoveryCCeremonyStateV1 = {
  schemaVersion: 1,
  setup: {
    open: null,
    completed: {
      challengeDigestHex: '11'.repeat(32),
      origin: { ...peerOrigin('recovery-c'), role: 'recovery-c' },
      completedAt: 2,
    },
  },
  policy: null,
};

describe('Recovery C ceremony persistence', () => {
  it('preserves unusable public ceremony state for explicit recovery', async () => {
    const area = makeFakeArea();
    const malformed = { schemaVersion: 1, setup: { open: OPEN_CHALLENGE, completed: {} } };
    await area.set({ [VAULT_COORDINATOR_RECOVERY_C_KEY]: malformed });
    expect(await loadVaultRecoveryCCeremony(area)).toEqual({ state: 'unusable' });
    expect(area.store.get(VAULT_COORDINATOR_RECOVERY_C_KEY)).toEqual(malformed);
  });

  it('rejects contradictory open/completed states and backup without kit export', () => {
    expect(() => vaultRecoveryCCeremonyStateSchema.parse({
      ...COMPLETED_CEREMONY,
      setup: { ...COMPLETED_CEREMONY.setup, open: OPEN_CHALLENGE },
    })).toThrow();
    expect(() => vaultRecoveryCCeremonyStateSchema.parse({
      ...COMPLETED_CEREMONY,
      policy: {
        policyId: '22'.repeat(32),
        ceremony: 'paper-mnemonic-offline-v1',
        kitExportedAt: null,
        backupCheck: { open: OPEN_CHALLENGE, completedAt: null },
      },
    })).toThrow();
  });

  it('atomically stores an accepted public origin with its completion marker', async () => {
    const area = makeFakeArea();
    const session: VaultImportSessionV1 = {
      schemaVersion: 1,
      network: 'signet',
      createdAt: 1,
      sessionIdHex: '33'.repeat(16),
      challengeNonceHex: '44'.repeat(32),
      transcriptHashHex: '55'.repeat(32),
      expiresAtMs: '9',
      signers: { 'recovery-c': peerOrigin('recovery-c') },
    };
    await saveVaultImportWithRecoveryCCeremony(area, session, COMPLETED_CEREMONY);
    expect(area.store.get(VAULT_COORDINATOR_IMPORT_KEY)).toEqual(session);
    expect(await loadVaultRecoveryCCeremony(area)).toEqual({
      state: 'valid',
      record: COMPLETED_CEREMONY,
    });
  });

  it('round-trips valid public-only state', async () => {
    const area = makeFakeArea();
    await saveVaultRecoveryCCeremony(area, COMPLETED_CEREMONY);
    expect(await loadVaultRecoveryCCeremony(area)).toEqual({
      state: 'valid',
      record: COMPLETED_CEREMONY,
    });
    expect(JSON.stringify([...area.store.entries()])).not.toContain('mnemonic');
  });
});
