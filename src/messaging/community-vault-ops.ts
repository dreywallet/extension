/** Extension-owned RPC surface for Community Vault owner enrollment and signing. */
import { z } from 'zod';
import { validateMnemonic } from '@drey/core/domain/keys/mnemonic';
import type { SenderContext } from '@drey/core/messaging/envelope';
import type { OpSpec } from '@drey/core/messaging/ops';
import {
  communityVaultPolicySchema,
  communityVaultSpendPlanSchema,
} from '@drey/core/domain/community-vault/contracts';

const TRUSTED_SENDERS: readonly SenderContext[] = ['popup', 'sidepanel', 'fullpage', 'onboarding'];
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const hex32 = z.string().regex(/^[0-9a-f]{64}$/u);
const sessionExpectation = {
  expectedVaultId: z.string().min(1),
  expectedSessionId: z.string().uuid(),
} as const;
const campaignRoot = z.object({
  version: z.literal(1),
  masterFingerprintHex: z.string().regex(/^[0-9a-f]{8}$/u),
  originPath: z.literal('m'),
  campaignXpub: z.string().regex(/^xpub[1-9A-HJ-NP-Za-km-z]{107}$/u),
}).strict();
const enrollment = z.object({
  version: z.literal(1),
  network: z.literal('mainnet'),
  campaignId: identifier,
  ownerId: identifier,
  campaignRoot,
}).strict();
const summary = z.object({
  campaignId: identifier,
  ownerId: identifier,
  label: z.string().max(80),
  createdAt: z.number().int().nonnegative(),
  campaignRoot,
  recoveryConfirmed: z.boolean(),
  policyId: hex32.nullable(),
  capTableHash: hex32.nullable(),
  units: z.array(z.number().int().min(0).max(99)).max(33),
  mode: z.enum(['anchored', 'open']).nullable(),
  readiness: z.enum(['needs-recovery', 'needs-policy', 'ready']),
}).strict();

const statusRequest = z.object(sessionExpectation).strict();
const createRequest = z.object({
  campaignId: identifier,
  ownerId: identifier,
  label: z.string().max(80),
  password: z.string().min(1),
  ...sessionExpectation,
}).strict();
const restoreRequest = createRequest.extend({
  mnemonic: z.string().refine(validateMnemonic, { message: 'invalid BIP39 mnemonic' }),
}).strict();
const campaignRequest = z.object({ campaignId: identifier, ...sessionExpectation }).strict();
const passwordCampaignRequest = campaignRequest.extend({ password: z.string().min(1) }).strict();
const confirmRecoveryRequest = passwordCampaignRequest.extend({
  mnemonic: z.string().refine(validateMnemonic, { message: 'invalid BIP39 mnemonic' }),
}).strict();
const acceptPolicyRequest = campaignRequest.extend({ policy: communityVaultPolicySchema }).strict();
const signRequest = passwordCampaignRequest.extend({
  policy: communityVaultPolicySchema,
  plan: communityVaultSpendPlanSchema,
  psbtHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u).max(2_000_000),
}).strict();

export const COMMUNITY_VAULT_ERROR_CODES = [
  'ERR_COMMUNITY_VAULT_EXISTS',
  'ERR_COMMUNITY_VAULT_MISSING',
  'ERR_COMMUNITY_VAULT_UNUSABLE',
  'ERR_COMMUNITY_VAULT_RECOVERY_REQUIRED',
  'ERR_COMMUNITY_VAULT_POLICY_MISMATCH',
] as const;
export type CommunityVaultErrorCode = (typeof COMMUNITY_VAULT_ERROR_CODES)[number];

export const COMMUNITY_VAULT_OP_SCHEMAS = {
  'communityVault.status': {
    request: statusRequest,
    response: z.object({ owners: z.array(summary).max(100), unusableCampaignIds: z.array(z.string()).max(100) }).strict(),
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'communityVault.create': {
    request: createRequest,
    response: z.object({ owner: summary, enrollment }).strict(),
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'communityVault.restore': {
    request: restoreRequest,
    response: z.object({ owner: summary, enrollment }).strict(),
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'communityVault.revealRecovery': {
    request: passwordCampaignRequest,
    response: z.object({ mnemonic: z.string().min(1) }).strict(),
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'communityVault.confirmRecovery': {
    request: confirmRecoveryRequest,
    response: z.object({ owner: summary }).strict(),
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'communityVault.acceptPolicy': {
    request: acceptPolicyRequest,
    response: z.object({ owner: summary }).strict(),
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
  'communityVault.sign': {
    request: signRequest,
    response: z.object({
      psbtHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u).max(2_000_000),
      psbtHash: hex32,
      approvedOwnerId: identifier,
      addedUnits: z.array(z.number().int().min(0).max(99)).min(1).max(33),
      signedUnits: z.array(z.number().int().min(0).max(99)).min(1).max(100),
      signedOwnerIds: z.array(identifier).min(1).max(100),
    }).strict(),
    allowedSenders: TRUSTED_SENDERS,
    requiresUnlock: true,
  },
} satisfies Record<string, OpSpec>;

export type CommunityVaultOp = keyof typeof COMMUNITY_VAULT_OP_SCHEMAS;
export type CommunityVaultStatusRequest = z.infer<typeof statusRequest>;
export type CommunityVaultCreateRequest = z.infer<typeof createRequest>;
export type CommunityVaultRestoreRequest = z.infer<typeof restoreRequest>;
export type CommunityVaultCampaignRequest = z.infer<typeof campaignRequest>;
export type CommunityVaultPasswordCampaignRequest = z.infer<typeof passwordCampaignRequest>;
export type CommunityVaultConfirmRecoveryRequest = z.infer<typeof confirmRecoveryRequest>;
export type CommunityVaultAcceptPolicyRequest = z.infer<typeof acceptPolicyRequest>;
export type CommunityVaultSignRequest = z.infer<typeof signRequest>;
export type CommunityVaultStatusResult = z.infer<(typeof COMMUNITY_VAULT_OP_SCHEMAS)['communityVault.status']['response']>;
export type CommunityVaultOwnerResult = z.infer<(typeof COMMUNITY_VAULT_OP_SCHEMAS)['communityVault.create']['response']>;
export type CommunityVaultSummary = z.infer<typeof summary>;
