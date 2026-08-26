import { z } from 'zod';
import { MAX_ACCOUNT_INDEX } from '@drey/core/domain/accounts/limits';
import { permissionDataCategorySchema } from '@drey/core/domain/provider/permission-journal';
import { PROVIDER_BRIDGE_VERSION } from './bridge';
import {
  PROVIDER_MAX_SIGN_MESSAGES,
  PROVIDER_MAX_SIGN_MESSAGE_BATCH_BYTES,
} from '@drey/core/domain/transactions/provider-message-batch-limits';
import {
  bip322MessageHash,
  validateBip322Message,
} from '@drey/core/domain/transactions/bip322';
import { bytesToHex } from '@drey/core/domain/vault/encoding';

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
  network: z.enum(['mainnet', 'signet', 'regtest']),
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

const approvalTransactionFields = {
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
};

const approvalBatchItemReviewSchema = z.object({
  index: z.number().int().nonnegative().max(40),
  ...approvalTransactionFields,
}).strict();

const approvalMessageBatchItemSchema = z.object({
  index: z.number().int().nonnegative().max(PROVIDER_MAX_SIGN_MESSAGES - 1),
  address: z.string().min(1),
  addressKind: z.enum(['payment', 'ordinals']),
  message: z.string(),
  messageBytes: z.number().int().nonnegative().max(4_096),
  messageHash: z.string().regex(/^[0-9a-f]{64}$/u),
  protocol: z.literal('BIP322'),
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
    kind: z.literal('message_batch'),
    messageCount: z.number().int().min(1).max(PROVIDER_MAX_SIGN_MESSAGES),
    totalMessageBytes: z.number().int().nonnegative().max(PROVIDER_MAX_SIGN_MESSAGE_BATCH_BYTES),
    messages: z.array(approvalMessageBatchItemSchema).min(1).max(PROVIDER_MAX_SIGN_MESSAGES),
  }).strict(),
  approvalIdentitySchema.extend({
    kind: z.literal('transaction'),
    ...approvalTransactionFields,
  }).strict(),
  approvalIdentitySchema.extend({
    kind: z.literal('batch'),
    transactionCount: z.number().int().min(1).max(41),
    walletInputSats: z.string().regex(/^(0|[1-9][0-9]*)$/u),
    walletOutputSats: z.string().regex(/^(0|[1-9][0-9]*)$/u),
    netWalletDebitSats: z.string().regex(/^-?(0|[1-9][0-9]*)$/u),
    feeExposureSats: z.string().regex(/^(0|[1-9][0-9]*)$/u),
    transactions: z.array(approvalBatchItemReviewSchema).min(1).max(41),
  }).strict(),
]).superRefine((review, context) => {
  if (review.kind === 'batch' &&
      (review.transactions.length !== review.transactionCount ||
        review.transactions.some((transaction, index) => transaction.index !== index))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'batch transaction review must be complete and ordered',
    });
  }
  if (review.kind === 'message_batch' &&
      (review.messages.length !== review.messageCount ||
        review.messages.some((message, index) => message.index !== index) ||
        review.messages.reduce((total, message) => total + message.messageBytes, 0) !==
          review.totalMessageBytes)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'message batch review must be complete and ordered',
    });
  }
  if (review.kind === 'message_batch') {
    for (const item of review.messages) {
      try {
        const messageBytes = validateBip322Message(item.message);
        if (item.messageBytes !== messageBytes.length ||
            item.messageHash !== bytesToHex(bip322MessageHash(messageBytes))) {
          throw new Error('message metadata changed');
        }
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `message batch item ${item.index} does not match its signed bytes`,
        });
      }
    }
  }
});

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
}).strict().superRefine((snapshot, context) => {
  const request = snapshot.request;
  if (request !== null &&
      ((request.method === 'signMultipleMessages') !== (request.review.kind === 'message_batch'))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'message batch approval method and review must match',
      path: ['request', 'review'],
    });
  }
});

export type ApprovalCommand = z.infer<typeof approvalCommandSchema>;
export type ApprovalSnapshot = z.infer<typeof approvalSnapshotSchema>;
