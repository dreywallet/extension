/** Password-encrypted Community Vault owner roots and their accepted policies. */
import { z } from 'zod';
import { vaultRecordV1Schema, type VaultRecordV1 } from '@drey/core/domain/vault/record';
import {
  communityVaultPolicySchema,
  type CommunityVaultCampaignRootV1,
  type CommunityVaultPolicyV1,
} from '@drey/core/domain/community-vault/contracts';
import { getJson, setJson, type StorageArea } from './area';
import { COMMUNITY_VAULT_OWNERS_KEY } from './keys';

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

export async function saveCommunityVaultOwners(
  area: StorageArea,
  records: readonly CommunityVaultOwnerRecordV1[],
): Promise<void> {
  const map: Record<string, CommunityVaultOwnerRecordV1> = {};
  for (const record of records) {
    const parsed = communityVaultOwnerRecordSchema.parse(record);
    if (map[parsed.campaignId] !== undefined) throw new Error('duplicate Community Vault campaign');
    map[parsed.campaignId] = parsed;
  }
  await setJson(area, COMMUNITY_VAULT_OWNERS_KEY, map);
}
