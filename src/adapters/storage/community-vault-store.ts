/** Password-encrypted Community Vault owner roots and their accepted policies. */
import { z } from 'zod';
import { vaultRecordV1Schema, type VaultRecordV1 } from '@drey/core/domain/vault/record';
import {
  communityVaultPolicySchema,
  type CommunityVaultCampaignRootV1,
  type CommunityVaultPolicyV1,
} from '@drey/core/domain/community-vault/contracts';
import { getJson, setJson, type StorageArea } from './area';
import type { VaultRecordMap } from './vault-store';
import {
  COMMUNITY_VAULT_OWNERS_KEY,
  VAULTS_KEY,
} from './keys';

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const campaignRootSchema: z.ZodType<CommunityVaultCampaignRootV1> = z.object({
  version: z.literal(1),
  masterFingerprintHex: z.string().regex(/^[0-9a-f]{8}$/u),
  originPath: z.literal('m'),
  campaignXpub: z.string().regex(/^xpub[1-9A-HJ-NP-Za-km-z]{107}$/u),
}).strict();

export interface CommunityVaultOwnerRecordV1 {
  schemaVersion: 1;
  campaignId: string;
  ownerId: string;
  label: string;
  createdAt: number;
  campaignRoot: CommunityVaultCampaignRootV1;
  secret: VaultRecordV1;
  recoveryConfirmedAt: number | null;
  policy: CommunityVaultPolicyV1 | null;
}

export const communityVaultOwnerRecordSchema: z.ZodType<CommunityVaultOwnerRecordV1> = z.object({
  schemaVersion: z.literal(1),
  campaignId: identifier,
  ownerId: identifier,
  label: z.string().max(80),
  createdAt: z.number().int().nonnegative(),
  campaignRoot: campaignRootSchema,
  secret: vaultRecordV1Schema,
  recoveryConfirmedAt: z.number().int().nonnegative().nullable(),
  policy: communityVaultPolicySchema.nullable(),
}).strict().superRefine((record, ctx) => {
  if (record.secret.vaultId !== `community:${record.campaignId}:${record.ownerId}`) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['secret'],
      message: 'encrypted owner root is not bound to this campaign and owner',
    });
  }
  if (record.policy !== null && record.policy.campaignId !== record.campaignId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['policy'],
      message: 'accepted policy belongs to another campaign',
    });
  }
});

export interface CommunityVaultOwnerStoreView {
  records: CommunityVaultOwnerRecordV1[];
  unusableCampaignIds: string[];
}

async function rawMap(area: StorageArea): Promise<Record<string, unknown>> {
  const raw = await getJson<unknown>(area, COMMUNITY_VAULT_OWNERS_KEY);
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) return { __store__: raw };
  return raw as Record<string, unknown>;
}

export async function loadCommunityVaultOwners(
  area: StorageArea,
): Promise<CommunityVaultOwnerStoreView> {
  const raw = await rawMap(area);
  const records: CommunityVaultOwnerRecordV1[] = [];
  const unusableCampaignIds: string[] = [];
  for (const [campaignId, value] of Object.entries(raw)) {
    const parsed = communityVaultOwnerRecordSchema.safeParse(value);
    if (!parsed.success || parsed.data.campaignId !== campaignId) {
      unusableCampaignIds.push(campaignId);
    } else {
      records.push(parsed.data);
    }
  }
  records.sort((left, right) => right.createdAt - left.createdAt || left.campaignId.localeCompare(right.campaignId));
  unusableCampaignIds.sort();
  return { records, unusableCampaignIds };
}

export async function saveCommunityVaultOwner(
  area: StorageArea,
  record: CommunityVaultOwnerRecordV1,
): Promise<void> {
  const parsed = communityVaultOwnerRecordSchema.parse(record);
  const raw = await rawMap(area);
  raw[parsed.campaignId] = parsed;
  await setJson(area, COMMUNITY_VAULT_OWNERS_KEY, raw);
}

const vaultRecordMapSchema = z.record(vaultRecordV1Schema).superRefine((records, ctx) => {
  for (const [vaultId, record] of Object.entries(records)) {
    if (record.vaultId !== vaultId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [vaultId],
        message: 'encrypted vault record is stored under a different vault id',
      });
    }
  }
});

const communityVaultOwnerMapSchema = z.record(communityVaultOwnerRecordSchema).superRefine(
  (records, ctx) => {
    for (const [campaignId, record] of Object.entries(records)) {
      if (record.campaignId !== campaignId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [campaignId],
          message: 'Community Vault owner is stored under a different campaign id',
        });
      }
    }
  },
);

const passwordChangedRecordsSchema = z.object({
  version: z.literal(1),
  vaults: vaultRecordMapSchema,
  communityVaultOwners: communityVaultOwnerMapSchema,
}).strict();

/**
 * Commit every password-wrapped record as one storage transaction.
 *
 * The complete candidate is validated before both canonical keys are written
 * in one `StorageArea.set` call. Chromium commits that multi-key call as one
 * database batch, so a failed write leaves both record families on the old
 * password and a successful write moves both to the new password.
 */
export async function savePasswordChangedRecords(
  area: StorageArea,
  vaults: VaultRecordMap,
  owners: readonly CommunityVaultOwnerRecordV1[],
): Promise<void> {
  const communityVaultOwners: Record<string, CommunityVaultOwnerRecordV1> = {};
  for (const owner of owners) {
    const parsed = communityVaultOwnerRecordSchema.parse(owner);
    if (communityVaultOwners[parsed.campaignId] !== undefined) {
      throw new Error('duplicate Community Vault campaign');
    }
    communityVaultOwners[parsed.campaignId] = parsed;
  }

  const candidate = passwordChangedRecordsSchema.parse({
    version: 1,
    vaults,
    communityVaultOwners,
  });
  await area.set({
    [VAULTS_KEY]: candidate.vaults,
    [COMMUNITY_VAULT_OWNERS_KEY]: candidate.communityVaultOwners,
  });
}
