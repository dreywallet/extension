import { z } from 'zod';
import { MAX_ACCOUNT_INDEX } from '@drey/core/domain/accounts/limits';
import { permissionDataCategorySchema } from '@drey/core/domain/provider/permission-journal';
import { PROVIDER_BRIDGE_VERSION } from './bridge';

export const APPROVAL_PORT_NAME = 'drey-provider-approval-v1';

export const approvalCommandSchema = z.discriminatedUnion('command', [
  z.object({
    type: z.literal('drey:approval'),
    protocolVersion: z.literal(PROVIDER_BRIDGE_VERSION),
    command: z.literal('snapshot'),
  }).strict(),
  z.object({
    type: z.literal('drey:approval'),
    protocolVersion: z.literal(PROVIDER_BRIDGE_VERSION),
    command: z.literal('resolve'),
    requestNonce: z.string().uuid(),
    approved: z.boolean(),
    password: z.string().min(1).optional(),
    confirmation: z.string().max(64).optional(),
    previewUnavailableAcknowledged: z.boolean().optional(),
  }).strict(),
  z.object({
    type: z.literal('drey:approval'),
    protocolVersion: z.literal(PROVIDER_BRIDGE_VERSION),
    command: z.literal('setFee'),
    requestNonce: z.string().uuid(),
    feeRateSatPerVb: z.number().int().min(1).max(5_000),
  }).strict(),
]);

const approvalIdentitySchema = z.object({
  walletName: z.string().min(1).max(128),
  account: z.number().int().min(0).max(MAX_ACCOUNT_INDEX),
  network: z.enum(['mainnet', 'signet']),
}).strict();

const approvalReviewOutputSchema = z.object({
  index: z.number().int().nonnegative(),
  address: z.string().nullable(),
  valueSats: z.string().regex(/^(0|[1-9][0-9]*)$/u),
  ownership: z.enum(['wallet', 'external', 'unproven']),
  role: z.enum(['recipient', 'payment_change', 'ordinal_change', 'postage', 'unknown']),
  committed: z.boolean(),
}).strict();

const approvalEconomicClaimSchema = z.object({
  kind: z.enum([
    'buyer_total',
    'guaranteed_proceeds',
    'marketplace_fee',
    'creator_royalty',
    'miner_fee',
  ]),
  valueSats: z.string().regex(/^(0|[1-9][0-9]*)$/u),
}).strict();

export const approvalReviewSchema = z.discriminatedUnion('kind', [
  approvalIdentitySchema.extend({
    kind: z.literal('connection'),
    categories: z.array(permissionDataCategorySchema)
      .max(permissionDataCategorySchema.options.length),
    purposes: z.array(z.enum(['payment', 'ordinals'])).max(2),
  }).strict(),
  approvalIdentitySchema.extend({
    kind: z.literal('message'),
    address: z.string().min(1),
    message: z.string(),
  }).strict(),
  approvalIdentitySchema.extend({
    kind: z.literal('transaction'),
    authorization: z.enum(['complete', 'partial']),
    feeSats: z.string().regex(/^(0|[1-9][0-9]*)$/u),
    walletInputSats: z.string().regex(/^(0|[1-9][0-9]*)$/u),
    walletOutputSats: z.string().regex(/^(0|[1-9][0-9]*)$/u),
    externalOutputSats: z.string().regex(/^(0|[1-9][0-9]*)$/u),
    netWalletDebitSats: z.string().regex(/^-?(0|[1-9][0-9]*)$/u),
    economicClaims: z.array(approvalEconomicClaimSchema).max(5).refine(
      (claims) => new Set(claims.map((claim) => claim.kind)).size === claims.length,
      'economic claims must be unique',
    ),
    outputs: z.array(approvalReviewOutputSchema).min(1),
  }).strict(),
]);

export const approvalSnapshotSchema = z.object({
  type: z.literal('drey:approval:snapshot'),
  protocolVersion: z.literal(PROVIDER_BRIDGE_VERSION),
  request: z.object({
    requestNonce: z.string().uuid(),
    method: z.string(),
    origin: z.string().url(),
    unicodeOrigin: z.string(),
    warnings: z.array(z.string()),
    createdAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    approveAfter: z.number().int().nonnegative(),
    review: approvalReviewSchema,
    details: z.unknown(),
    requiresPassword: z.boolean(),
    confirmationPhrase: z.string().nullable(),
    approvalError: z.string().nullable(),
  }).strict().nullable(),
}).strict();

export type ApprovalCommand = z.infer<typeof approvalCommandSchema>;
export type ApprovalSnapshot = z.infer<typeof approvalSnapshotSchema>;
