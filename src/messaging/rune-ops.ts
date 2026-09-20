import { z } from 'zod';
import type { OpSpec } from '@drey/core/messaging/ops';
import { runeBalanceSchema, runeIdSchema, runeAtomicSchema } from '@drey/core/domain/runes/evidence';
const session = {
  expectedVaultId: z.string().min(1), expectedSessionId: z.string().uuid(),
  accountId: z.string().regex(/^acct_(?:mainnet|signet|regtest)_[0-9a-f]{64}$/u),
};
const binding = z.object(session).strict();
export const runeDraftSchema = z.object({ runeId: runeIdSchema, recipient: z.string().max(200), quantity: z.string().max(79), feeRate: z.string().max(32), sending: z.boolean(), feeTier: z.enum(['priority', 'standard', 'economy', 'custom']).optional() }).strict();
export type RuneDraft = z.infer<typeof runeDraftSchema>;
const holding = runeBalanceSchema.extend({
  total: runeAtomicSchema, available: runeAtomicSchema, reserved: runeAtomicSchema,
  constrained: z.array(z.object({ reason: z.enum(['wrong_role', 'pending', 'reserved', 'frozen', 'mixed_assets', 'incomplete']), amount: runeAtomicSchema }).strict()),
  hidden: z.boolean(),
}).strict();
export const runeReviewSchema = z.object({
  planId: z.string().uuid(), planHash: z.string().regex(/^[0-9a-f]{64}$/u),
  rune: runeBalanceSchema, recipient: z.string().min(1), amount: runeAtomicSchema,
  retained: runeAtomicSchema, feeSats: z.string(), postageSats: z.string(),
  changeSats: z.string(), feeRate: z.string(), expiresAt: z.number(), requiresReauth: z.boolean(),
}).strict();
const transfer = z.object({
  direction: z.enum(['sent', 'received']).default('sent'),
  txid: z.string().regex(/^[0-9a-f]{64}$/u), rune: runeBalanceSchema,
  amount: runeAtomicSchema, recipient: z.string(),
  status: z.enum(['pending', 'confirmed', 'indeterminate', 'conflicted']),
  createdAt: z.number(),
}).strict();
const policy = { allowedSenders: ['popup', 'sidepanel', 'fullpage'], requiresUnlock: true, handlerEnforcesUnlock: true } as const;
export const runeListSchema = z.object({
    status: z.enum(['ready', 'checking', 'unavailable']), holdings: z.array(holding).max(10000),
    historyComplete: z.boolean().optional(), transfers: z.array(transfer).max(1000), canSign: z.boolean(), feeFundingSats: z.string(),
  }).strict();
export const RUNE_SNAPSHOT_KEY = 'drey:runeSnapshot';
export const RUNE_OP_SCHEMAS = {
  'runes.snapshot': { ...policy, request: binding, response: z.object({ data: runeListSchema.nullable() }).strict() },
  'runes.draft': { ...policy, request: z.object({ ...session, draft: runeDraftSchema.nullable().optional() }).strict(), response: z.object({ draft: runeDraftSchema.nullable() }).strict() },
  'runes.list': { ...policy, request: binding, response: runeListSchema },
  'runes.visibility': { ...policy, request: z.object({ ...session, runeId: runeIdSchema, hidden: z.boolean() }).strict(), response: z.object({ updated: z.literal(true) }).strict() },
  'runes.prepare': { ...policy, request: z.object({ ...session, runeId: runeIdSchema, amount: z.union([runeAtomicSchema, z.literal('max')]),
    recipient: z.string().min(1).max(200), feeRate: z.string().min(1).max(32) }).strict(), response: runeReviewSchema },
  'runes.cancel': { ...policy, request: z.object({ ...session, planId: z.string().uuid() }).strict(), response: z.object({ cancelled: z.literal(true) }).strict() },
  'runes.approve': { ...policy, request: z.object({ ...session, planId: z.string().uuid(), planHash: z.string().regex(/^[0-9a-f]{64}$/u), password: z.string().optional() }).strict(), response: transfer },
} satisfies Record<string, OpSpec>;
export type RuneOp = keyof typeof RUNE_OP_SCHEMAS;
export type RuneListRequest = z.infer<typeof binding>;
export type RuneListResult = z.infer<typeof RUNE_OP_SCHEMAS['runes.list']['response']>;
export type RunePrepareRequest = z.infer<typeof RUNE_OP_SCHEMAS['runes.prepare']['request']>;
export type RuneApproveRequest = z.infer<typeof RUNE_OP_SCHEMAS['runes.approve']['request']>;
export type RuneVisibilityRequest = z.infer<typeof RUNE_OP_SCHEMAS['runes.visibility']['request']>;
export type RuneCancelRequest = z.infer<typeof RUNE_OP_SCHEMAS['runes.cancel']['request']>;
export type RuneReview = z.infer<typeof runeReviewSchema>;
export type RuneTransferView = z.infer<typeof transfer>;
