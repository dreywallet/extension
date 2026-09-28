import { z } from 'zod';

/**
 * The Bitcoin Send form's unfinished input. It survives the popup closing,
 * Back, and tab switches so a user who leaves to copy an address comes back
 * to what they typed. Stored sealed under the wallet key, like Rune drafts.
 */
export const sendDraftSchema = z.object({
  recipient: z.string().max(8 * 1024),
  amount: z.string().max(32),
  unit: z.enum(['btc', 'sats']),
  sendMax: z.boolean(),
  feeTier: z.enum(['priority', 'standard', 'economy', 'custom']),
  customFee: z.string().max(32),
  additionalRecipients: z.array(z.object({
    address: z.string().max(200),
    amount: z.string().max(32),
  }).strict()).max(20),
}).strict();
export type SendDraft = z.infer<typeof sendDraftSchema>;

export const sendDraftRequestSchema = z.object({
  expectedVaultId: z.string().min(1),
  expectedSessionId: z.string().uuid(),
  accountId: z.string().regex(/^acct_(?:mainnet|signet|regtest)_[0-9a-f]{64}$/u),
  draft: sendDraftSchema.nullable().optional(),
}).strict();
export type SendDraftRequest = z.infer<typeof sendDraftRequestSchema>;
