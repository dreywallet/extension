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
import { decimalU64Schema } from '@drey/core/domain/vault/u64';
import {
  PROVIDER_MAX_LINKED_PSBT_GROUP_INPUTS,
  PROVIDER_MAX_PSBT_BATCH_ITEMS,
} from '@drey/core/domain/transactions/provider-psbt-limits';

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

const BITCOIN_MAX_SATS = '2100000000000000';
const U64_MAX = '18446744073709551615';
const CANONICAL_UNSIGNED = /^(?:0|[1-9][0-9]*)$/u;

function canonicalUnsignedAtMost(value: string, maximum: string): boolean {
  return CANONICAL_UNSIGNED.test(value) &&
    (value.length < maximum.length || (value.length === maximum.length && value <= maximum));
}

function canonicalSignedAtMost(value: string, maximum: string): boolean {
  const magnitude = value.startsWith('-') ? value.slice(1) : value;
  return value !== '-0' && canonicalUnsignedAtMost(magnitude, maximum);
}

const bitcoinSatsSchema = z.string().refine(
  (value) => canonicalUnsignedAtMost(value, BITCOIN_MAX_SATS),
  'Bitcoin amount exceeds total supply',
);
const signedBitcoinSatsSchema = z.string().refine(
  (value) => canonicalSignedAtMost(value, BITCOIN_MAX_SATS),
  'signed Bitcoin amount is invalid',
);
const signedU64SatsSchema = z.string().refine(
  (value) => canonicalSignedAtMost(value, U64_MAX),
  'signed 64-bit amount is invalid',
);

const approvalReviewOutputSchema = z.object({
  index: z.number().int().nonnegative(),
  address: z.string().nullable(),
  valueSats: bitcoinSatsSchema,
  ownership: z.enum(['wallet', 'external', 'unproven']),
  role: z.enum(['recipient', 'payment_change', 'ordinal_change', 'postage', 'data', 'unknown']),
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
  valueSats: bitcoinSatsSchema,
}).strict();

const approvalTransactionFields = {
  authorization: z.enum(['complete', 'partial']),
  feeSats: bitcoinSatsSchema,
  walletInputSats: bitcoinSatsSchema,
  walletOutputSats: bitcoinSatsSchema,
  externalOutputSats: bitcoinSatsSchema,
  netWalletDebitSats: signedBitcoinSatsSchema,
  economicClaims: z.array(approvalEconomicClaimSchema).max(5).refine(
    (claims) => new Set(claims.map((claim) => claim.kind)).size === claims.length,
    'economic claims must be unique',
  ),
  outputs: z.array(approvalReviewOutputSchema).min(1),
};

const approvalBatchItemReviewSchema = z.object({
  index: z.number().int().nonnegative().max(PROVIDER_MAX_PSBT_BATCH_ITEMS - 1),
  ...approvalTransactionFields,
}).strict();

const approvalTransactionGroupBranchSchema = z.object({
  nodeId: z.string().min(1).max(128),
  guaranteedWalletReturnSats: bitcoinSatsSchema,
  maximumWalletDebitSats: bitcoinSatsSchema,
}).strict();

const approvalTransactionGroupOutcomeSchema = z.object({
  settlements: z.array(approvalTransactionGroupBranchSchema)
    .min(1).max(PROVIDER_MAX_PSBT_BATCH_ITEMS - 1),
  recovery: approvalTransactionGroupBranchSchema,
}).strict().superRefine((outcome, context) => {
  const nodeIds = [
    ...outcome.settlements.map((settlement) => settlement.nodeId),
    outcome.recovery.nodeId,
  ];
  if (new Set(nodeIds).size !== nodeIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'transaction group outcome nodes must be unique',
    });
  }
});

const approvalMessageBatchItemSchema = z.object({
  index: z.number().int().nonnegative().max(PROVIDER_MAX_SIGN_MESSAGES - 1),
  address: z.string().min(1),
  addressKind: z.enum(['payment', 'ordinals']),
  message: z.string(),
  messageBytes: z.number().int().nonnegative().max(4_096),
  messageHash: z.string().regex(/^[0-9a-f]{64}$/u),
  protocol: z.literal('BIP322'),
}).strict();

const TRANSACTION_APPROVAL_METHODS = new Set([
  'signPsbt',
  'bitcoin_signPsbtV2',
  'signTransaction',
  'sendTransfer',
  'ord_sendInscriptions',
]);

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
    transactionCount: z.number().int().min(1).max(PROVIDER_MAX_PSBT_BATCH_ITEMS),
    walletInputSats: decimalU64Schema,
    walletOutputSats: decimalU64Schema,
    netWalletDebitSats: signedU64SatsSchema,
    feeExposureSats: decimalU64Schema,
    linked: z.boolean().optional(),
    maximumWalletDebitSats: decimalU64Schema.optional(),
    maximumFeeExposureSats: decimalU64Schema.optional(),
    branchEconomicsExact: z.boolean().optional(),
    sharedFundingConflictCount: z.number().int().nonnegative()
      .max(PROVIDER_MAX_LINKED_PSBT_GROUP_INPUTS).optional(),
    alternativeOutcomeGroups: z.array(approvalTransactionGroupOutcomeSchema)
      .max(PROVIDER_MAX_LINKED_PSBT_GROUP_INPUTS).optional(),
    transactions: z.array(approvalBatchItemReviewSchema).min(1).max(PROVIDER_MAX_PSBT_BATCH_ITEMS),
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
  if (review.kind === 'batch' && review.linked === true &&
      (review.maximumWalletDebitSats === undefined ||
        review.maximumFeeExposureSats === undefined ||
        review.branchEconomicsExact === undefined ||
        review.sharedFundingConflictCount === undefined ||
        review.alternativeOutcomeGroups === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'linked transaction review must include Core-derived branch economics',
    });
  }
  if (review.kind === 'batch' && review.alternativeOutcomeGroups !== undefined) {
    const groupKeys = review.alternativeOutcomeGroups.map((group) => JSON.stringify({
      settlements: group.settlements.map((settlement) => settlement.nodeId).sort(),
      recovery: group.recovery.nodeId,
    }));
    if (new Set(groupKeys).size !== groupKeys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'transaction group outcomes must be unique',
      });
    }
    const nodeIds = new Set(review.alternativeOutcomeGroups.flatMap((group) => [
      ...group.settlements.map((settlement) => settlement.nodeId),
      group.recovery.nodeId,
    ]));
    if (nodeIds.size > review.transactionCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'transaction group outcomes exceed the reviewed transaction set',
      });
    }
    if (review.linked !== true && review.alternativeOutcomeGroups.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'independent transaction review may not include alternative outcomes',
      });
    }
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
  if (request === null) return;
  if ((request.method === 'signMultipleMessages') !== (request.review.kind === 'message_batch')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'message batch approval method and review must match',
      path: ['request', 'review'],
    });
  }
  if ((request.method === 'signMultipleTransactions') !== (request.review.kind === 'batch')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'transaction batch approval method and review must match',
      path: ['request', 'review'],
    });
  }
  if (TRANSACTION_APPROVAL_METHODS.has(request.method) !== (request.review.kind === 'transaction')) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'transaction approval method and review must match',
      path: ['request', 'review'],
    });
  }
});

export type ApprovalCommand = z.infer<typeof approvalCommandSchema>;
export type ApprovalSnapshot = z.infer<typeof approvalSnapshotSchema>;
