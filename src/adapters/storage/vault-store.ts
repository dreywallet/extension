/**
 * Vault-record + config persistence over chrome.storage.local (spec §7, §25.2).
 *
 * The domain vault functions are pure over serializable records; this adapter
 * owns persistence. Every write of the vault set goes through the §25.2 atomic
 * keep-old-until-validated swap: the migrated/new set is staged, re-validated,
 * then committed to the canonical key, and only then is staging removed. A
 * crash before the canonical commit leaves the prior committed set intact and a
 * stale staging slot that the next load discards.
 */
import { z } from 'zod';
import { MAX_ACCOUNT_INDEX } from '@drey/core/domain/accounts/limits';
import { migrateVaultRecord } from '@drey/core/domain/vault/migrate';
import { vaultRecordV1Schema, type VaultRecordV1 } from '@drey/core/domain/vault/record';
import { getJson, setJson, type StorageArea } from './area';
import {
  ACTIVE_VAULT_KEY,
  CONFIG_KEY,
  VAULT_META_KEY,
  VAULTS_KEY,
  VAULTS_QUARANTINE_KEY,
  VAULTS_STAGING_KEY,
} from './keys';

export type VaultRecordMap = Record<string, VaultRecordV1>;

// ---- config ----------------------------------------------------------------

export interface WalletConfig {
  version: 2;
  idleTimeoutMs: number;
  highSecurityMode: boolean;
  advancedPsbtSigning: boolean;
  activeAccounts: Record<string, number>;
}

export const IDLE_TIMEOUT_MS = {
  default: 60 * 60 * 1000, // 1h (spec §7.4)
  twelveHours: 12 * 60 * 60 * 1000,
  twentyFourHours: 24 * 60 * 60 * 1000,
  oneWeek: 7 * 24 * 60 * 60 * 1000,
} as const;

export const DEFAULT_CONFIG: WalletConfig = {
  version: 2,
  idleTimeoutMs: IDLE_TIMEOUT_MS.default,
  highSecurityMode: false,
  advancedPsbtSigning: false,
  activeAccounts: {},
};

const configV1Schema = z
  .object({
    version: z.literal(1),
    idleTimeoutMs: z.union([
      z.literal(IDLE_TIMEOUT_MS.default),
      z.literal(IDLE_TIMEOUT_MS.twelveHours),
      z.literal(IDLE_TIMEOUT_MS.twentyFourHours),
      z.literal(IDLE_TIMEOUT_MS.oneWeek),
    ]),
    highSecurityMode: z.boolean(),
  })
  .strict();

const configSchema = z
  .object({
    version: z.literal(2),
    idleTimeoutMs: z.union([
      z.literal(IDLE_TIMEOUT_MS.default),
      z.literal(IDLE_TIMEOUT_MS.twelveHours),
      z.literal(IDLE_TIMEOUT_MS.twentyFourHours),
      z.literal(IDLE_TIMEOUT_MS.oneWeek),
    ]),
    highSecurityMode: z.boolean(),
    advancedPsbtSigning: z.boolean(),
    activeAccounts: z.record(z.number().int().min(0).max(MAX_ACCOUNT_INDEX)),
  })
  .strict();

export async function loadConfig(area: StorageArea): Promise<WalletConfig> {
  const raw = await getJson<unknown>(area, CONFIG_KEY);
  if (raw === undefined) return DEFAULT_CONFIG;
  const parsed = configSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const legacy = configV1Schema.safeParse(raw);
  if (legacy.success) {
    const migrated: WalletConfig = {
      version: 2,
      idleTimeoutMs: legacy.data.idleTimeoutMs,
      highSecurityMode: legacy.data.highSecurityMode,
      advancedPsbtSigning: false,
      activeAccounts: {},
    };
    await setJson(area, CONFIG_KEY, migrated);
    return migrated;
  }
  // Repair malformed/unsupported persisted values so every later reader sees
  // the same bounded configuration rather than repeatedly interpreting junk.
  await setJson(area, CONFIG_KEY, DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}

export function activeAccountKey(vaultId: string, network: string): string {
  return `${vaultId}:${network}`;
}

export async function saveConfig(area: StorageArea, config: WalletConfig): Promise<void> {
  const parsed = configSchema.safeParse(config);
  if (!parsed.success) throw new Error('invalid wallet config');
  await setJson(area, CONFIG_KEY, parsed.data);
}

// ---- vault set -------------------------------------------------------------

/**
 * §25.2 atomic swap: stage the new set, re-validate what was staged, commit to
 * the canonical key, then drop staging. Kept private so every mutation of the
 * vault set is crash-safe by construction.
 */
async function commitVaultSwap(area: StorageArea, map: VaultRecordMap): Promise<void> {
  await setJson(area, VAULTS_STAGING_KEY, map);
  const staged = await getJson<Record<string, unknown>>(area, VAULTS_STAGING_KEY);
  if (!staged) throw new Error('vault swap: staging write did not persist');
  for (const record of Object.values(staged)) {
    if (!vaultRecordV1Schema.safeParse(record).success) {
      throw new Error('vault swap: staged record failed v1 validation');
    }
  }
  await setJson(area, VAULTS_KEY, map);
  await area.remove(VAULTS_STAGING_KEY);
}

/**
 * Load the committed vault set, running the migration runner on each record.
 * Any leftover staging slot from an interrupted swap is discarded first (the
 * canonical set is authoritative). If any record migrated, the migrated set is
 * committed back through the atomic swap before returning. An independently
 * malformed record is copied to quarantine before canonical storage is cleaned,
 * so it cannot hide healthy vaults or be lost by a later full-map write.
 */
interface VaultQuarantineV1 {
  version: 1;
  records: Record<string, unknown>;
  malformedRoot?: unknown;
}

const quarantineSchema = z
  .object({
    version: z.literal(1),
    records: z.record(z.unknown()),
    malformedRoot: z.unknown().optional(),
  })
  .strict();

async function loadQuarantine(area: StorageArea): Promise<VaultQuarantineV1> {
  const parsed = quarantineSchema.safeParse(await getJson<unknown>(area, VAULTS_QUARANTINE_KEY));
  return parsed.success ? parsed.data : { version: 1, records: {} };
}

async function preserveInQuarantine(
  area: StorageArea,
  records: Record<string, unknown>,
  malformedRoot?: unknown,
): Promise<void> {
  const previous = await loadQuarantine(area);
  const next: VaultQuarantineV1 = {
    version: 1,
    records: { ...previous.records, ...records },
    ...(malformedRoot !== undefined
      ? { malformedRoot }
      : previous.malformedRoot !== undefined
        ? { malformedRoot: previous.malformedRoot }
        : {}),
  };
  // The raw copy is committed before invalid entries are removed from the
  // canonical set. A crash can duplicate data, but can never lose its only copy.
  await setJson(area, VAULTS_QUARANTINE_KEY, next);
}

export async function countQuarantinedVaults(area: StorageArea): Promise<number> {
  const quarantine = await loadQuarantine(area);
  return Object.keys(quarantine.records).length + (quarantine.malformedRoot === undefined ? 0 : 1);
}

export async function loadVaults(area: StorageArea): Promise<VaultRecordMap> {
  await area.remove(VAULTS_STAGING_KEY);
  const rawValue = await getJson<unknown>(area, VAULTS_KEY);
  const map: VaultRecordMap = {};
  let anyMigrated = false;
  const invalid: Record<string, unknown> = {};

  if (
    rawValue !== undefined &&
    (typeof rawValue !== 'object' || rawValue === null || Array.isArray(rawValue))
  ) {
    await preserveInQuarantine(area, {}, rawValue);
    await commitVaultSwap(area, map);
    return map;
  }

  const raw = (rawValue ?? {}) as Record<string, unknown>;
  for (const [storageId, rawRecord] of Object.entries(raw)) {
    try {
      const { record, migrated } = migrateVaultRecord(rawRecord);
      // The map key is part of record identity. A mismatch or duplicate ID is
      // ambiguous and must not silently overwrite a healthy record.
      if (record.vaultId !== storageId || map[record.vaultId] !== undefined) {
        invalid[storageId] = rawRecord;
        continue;
      }
      map[record.vaultId] = record;
      if (migrated) anyMigrated = true;
    } catch {
      invalid[storageId] = rawRecord;
    }
  }
  if (Object.keys(invalid).length > 0) await preserveInQuarantine(area, invalid);
  if (anyMigrated || Object.keys(invalid).length > 0) await commitVaultSwap(area, map);
  return map;
}

/** Persist the full vault set atomically (create, restore, change-password, removal). */
export async function saveVaults(area: StorageArea, map: VaultRecordMap): Promise<void> {
  await commitVaultSwap(area, map);
}

// ---- per-vault metadata ----------------------------------------------------

/**
 * Plaintext, loss-tolerant per-vault flags. Deliberately outside the encrypted
 * payload so the §7.1 backup gate can be enforced without a password, and
 * deliberately simple (no staging swap): a lost/corrupt map degrades to
 * backupVerified=false, which is the safe direction (the user re-verifies).
 */
export interface VaultMeta {
  backupVerified: boolean;
}

export type VaultMetaMap = Record<string, VaultMeta>;

const vaultMetaSchema = z.record(z.object({ backupVerified: z.boolean() }).strict());

export async function loadVaultMeta(area: StorageArea): Promise<VaultMetaMap> {
  const parsed = vaultMetaSchema.safeParse(await getJson<unknown>(area, VAULT_META_KEY));
  return parsed.success ? parsed.data : {};
}

export async function saveVaultMeta(area: StorageArea, map: VaultMetaMap): Promise<void> {
  await setJson(area, VAULT_META_KEY, map);
}

// ---- active vault ----------------------------------------------------------

export async function loadActiveVaultId(area: StorageArea): Promise<string | null> {
  const value = await getJson<unknown>(area, ACTIVE_VAULT_KEY);
  return typeof value === 'string' ? value : null;
}

export async function saveActiveVaultId(area: StorageArea, vaultId: string | null): Promise<void> {
  if (vaultId === null) await area.remove(ACTIVE_VAULT_KEY);
  else await setJson(area, ACTIVE_VAULT_KEY, vaultId);
}
