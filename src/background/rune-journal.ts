import { z } from 'zod';
import { runeDraftSchema } from '../messaging/rune-ops';
import { runeBalanceSchema, runeAtomicSchema } from '@drey/core/domain/runes/evidence';
export const runeJournalSchema = z.object({
  version: z.literal(1), accountId: z.string(), txid: z.string().regex(/^[0-9a-f]{64}$/u),
  rune: runeBalanceSchema, amount: runeAtomicSchema.refine((value) => value !== '0'), recipient: z.string().min(1).max(200), createdAt: z.number().int().nonnegative().safe(),
  dispatchState: z.enum(['prepared', 'dispatched']).default('dispatched'),
  resolution: z.object({ instanceId: z.string().min(1), classificationRevision: z.string().min(1),
    tip: z.object({ height: z.number().int().nonnegative(), hash: z.string().regex(/^[0-9a-f]{64}$/u) }).strict(),
    status: z.enum(['confirmed', 'conflicted']),
  }).strict().nullable().default(null),
  status: z.enum(['pending', 'confirmed', 'indeterminate', 'conflicted']),
  transactionHex: z.string().regex(/^(?:[0-9a-f]{2})+$/u).max(800000),
  inputKeys: z.array(z.string().regex(/^[0-9a-f]{64}:\d+$/u)).min(1).max(128),
  scriptHashes: z.array(z.string().regex(/^[0-9a-f]{64}$/u)).min(1).max(200),
}).strict();
export type RuneJournal = z.infer<typeof runeJournalSchema>;
export const runePreferencesSchema = z.object({ hidden: z.array(z.string()).max(10000), draft: runeDraftSchema.nullable().optional() }).strict();

/** A different tip/revision reacquires reservations until a fresh signed read
 * proves the transaction or its conflict on that chain. Absence never releases. */
export function runeJournalHoldsInputs(entry: RuneJournal, source: {
  instanceId: string; activeRevision: string; coreTip: { height: number; hash: string };
} | null): boolean {
  if (entry.dispatchState === 'prepared') return false;
  const proof = entry.resolution;
  return !source || !proof || proof.instanceId !== source.instanceId ||
    proof.classificationRevision !== source.activeRevision || proof.tip.hash !== source.coreTip.hash ||
    proof.tip.height !== source.coreTip.height || proof.status !== entry.status;
}
