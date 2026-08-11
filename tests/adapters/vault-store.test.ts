import { beforeAll, describe, expect, it } from 'vitest';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import {
  DEFAULT_CONFIG,
  IDLE_TIMEOUT_MS,
  countQuarantinedVaults,
  loadActiveVaultId,
  loadConfig,
  loadVaultMeta,
  loadVaults,
  saveActiveVaultId,
  saveConfig,
  saveVaultMeta,
  saveVaults,
  type VaultRecordMap,
} from '../../src/adapters/storage/vault-store';
import {
  ACTIVE_VAULT_KEY,
  CONFIG_KEY,
  VAULTS_KEY,
  VAULTS_QUARANTINE_KEY,
  VAULTS_STAGING_KEY,
} from '../../src/adapters/storage/keys';
import { makeRecord } from '@drey/core/testing/vault-helpers';
import v0Fixture from '@drey/core/fixtures/vault-record-v0.json';
import { makeFakeArea } from './fake-area';

beforeAll(async () => {
  await installTestCryptoProvider();
});

describe('vault-store', () => {
  it('round-trips a vault set and leaves no staging behind', async () => {
    const area = makeFakeArea();
    const record = await makeRecord('v-1');
    const map: VaultRecordMap = { [record.vaultId]: record };
    await saveVaults(area, map);

    expect(await loadVaults(area)).toEqual(map);
    expect(area.store.has(VAULTS_STAGING_KEY)).toBe(false);
  });

  it('migrates a v0 record and commits the swap (§25.2)', async () => {
    const area = makeFakeArea();
    area.store.set(VAULTS_KEY, { 'vault-legacy': v0Fixture });

    const loaded = await loadVaults(area);
    expect(loaded['vault-legacy']?.schemaVersion).toBe(1);
    expect((area.store.get(VAULTS_KEY) as Record<string, { schemaVersion: number }>)['vault-legacy']?.schemaVersion).toBe(1);
    expect(area.store.has(VAULTS_STAGING_KEY)).toBe(false);
  });

  it('keeps the old record intact when the canonical commit crashes', async () => {
    const area = makeFakeArea();
    const seeded = { 'vault-legacy': v0Fixture };
    area.store.set(VAULTS_KEY, seeded);
    area.failOnSetKey = VAULTS_KEY;

    await expect(loadVaults(area)).rejects.toThrow();
    // Old committed record is untouched; a stale staging slot is left behind.
    expect(area.store.get(VAULTS_KEY)).toEqual(seeded);
    expect(area.store.has(VAULTS_STAGING_KEY)).toBe(true);

    // Recovery: the next load discards staging and completes the migration.
    area.failOnSetKey = null;
    const loaded = await loadVaults(area);
    expect(loaded['vault-legacy']?.schemaVersion).toBe(1);
    expect(area.store.has(VAULTS_STAGING_KEY)).toBe(false);
  });

  it('discards a leftover staging slot on load', async () => {
    const area = makeFakeArea();
    const record = await makeRecord('v-1');
    area.store.set(VAULTS_KEY, { [record.vaultId]: record });
    area.store.set(VAULTS_STAGING_KEY, { junk: true });

    const loaded = await loadVaults(area);
    expect(loaded).toEqual({ [record.vaultId]: record });
    expect(area.store.has(VAULTS_STAGING_KEY)).toBe(false);
  });

  it('returns an empty set when nothing is stored', async () => {
    expect(await loadVaults(makeFakeArea())).toEqual({});
  });

  it('quarantines a malformed record without hiding or deleting healthy vaults', async () => {
    const area = makeFakeArea();
    const healthy = await makeRecord('healthy');
    const malformed = { schemaVersion: 99, ciphertext: 'must be preserved exactly' };
    area.store.set(VAULTS_KEY, { healthy, broken: malformed });

    expect(await loadVaults(area)).toEqual({ healthy });
    expect(await countQuarantinedVaults(area)).toBe(1);
    expect(area.store.get(VAULTS_QUARANTINE_KEY)).toMatchObject({
      version: 1,
      records: { broken: malformed },
    });
    expect(area.store.get(VAULTS_KEY)).toEqual({ healthy });
  });

  it('preserves quarantined raw records across later healthy vault-set writes', async () => {
    const area = makeFakeArea();
    const healthy = await makeRecord('healthy');
    const malformed = { schemaVersion: 99, ciphertext: 'must be preserved exactly' };
    area.store.set(VAULTS_KEY, { healthy, broken: malformed });

    const loaded = await loadVaults(area);
    await saveVaults(area, loaded);

    expect(area.store.get(VAULTS_QUARANTINE_KEY)).toMatchObject({
      version: 1,
      records: { broken: malformed },
    });
  });

  it('persists the active vault id and clears it', async () => {
    const area = makeFakeArea();
    await saveActiveVaultId(area, 'v-1');
    expect(await loadActiveVaultId(area)).toBe('v-1');

    await saveActiveVaultId(area, null);
    expect(await loadActiveVaultId(area)).toBeNull();
    expect(area.store.has(ACTIVE_VAULT_KEY)).toBe(false);
  });

  it('ignores a malformed active vault id', async () => {
    const area = makeFakeArea();
    area.store.set(ACTIVE_VAULT_KEY, { vaultId: 'v-1' });
    expect(await loadActiveVaultId(area)).toBeNull();
  });

  it('falls back to default config and round-trips a custom one', async () => {
    const area = makeFakeArea();
    expect(await loadConfig(area)).toEqual(DEFAULT_CONFIG);

    const custom = {
      version: 2 as const,
      idleTimeoutMs: IDLE_TIMEOUT_MS.oneWeek,
      highSecurityMode: true,
      advancedPsbtSigning: true,
      activeAccounts: { 'vault-1:signet': 25 },
    };
    await saveConfig(area, custom);
    expect(await loadConfig(area)).toEqual(custom);
  });

  it('ignores a malformed stored config', async () => {
    const area = makeFakeArea();
    area.store.set(CONFIG_KEY, {
      version: 2,
      idleTimeoutMs: 5,
      highSecurityMode: false,
      advancedPsbtSigning: false,
      activeAccounts: {},
    });
    expect(await loadConfig(area)).toEqual(DEFAULT_CONFIG);
    expect(area.store.get(CONFIG_KEY)).toEqual(DEFAULT_CONFIG);

    area.store.set(CONFIG_KEY, { version: 1, idleTimeoutMs: 5, highSecurityMode: false });
    expect(await loadConfig(area)).toEqual(DEFAULT_CONFIG);
    expect(area.store.get(CONFIG_KEY)).toEqual(DEFAULT_CONFIG);
  });

  it('migrates v1 config without losing security or timeout choices', async () => {
    const area = makeFakeArea();
    area.store.set(CONFIG_KEY, {
      version: 1,
      idleTimeoutMs: 12 * 60 * 60 * 1000,
      highSecurityMode: true,
    });
    expect(await loadConfig(area)).toEqual({
      version: 2,
      idleTimeoutMs: 12 * 60 * 60 * 1000,
      highSecurityMode: true,
      advancedPsbtSigning: false,
      activeAccounts: {},
    });
  });
});

describe('vault meta (§7.1 backup gate)', () => {
  it('defaults to empty and round-trips a saved map', async () => {
    const area = makeFakeArea();
    expect(await loadVaultMeta(area)).toEqual({});
    await saveVaultMeta(area, { 'vault-1': { backupVerified: true } });
    expect(await loadVaultMeta(area)).toEqual({ 'vault-1': { backupVerified: true } });
  });

  it('degrades a malformed map to empty (safe direction: re-verify)', async () => {
    const area = makeFakeArea();
    area.store.set('squirrel:vaultMeta', { 'vault-1': { backupVerified: 'yes' } });
    expect(await loadVaultMeta(area)).toEqual({});
    area.store.set('squirrel:vaultMeta', 'garbage');
    expect(await loadVaultMeta(area)).toEqual({});
  });
});
