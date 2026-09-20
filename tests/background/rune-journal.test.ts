import { describe, expect, it } from 'vitest';
import { runeJournalHoldsInputs, runeJournalSchema } from '../../src/background/rune-journal';

const tip = { height: 100, hash: 'a'.repeat(64) };
const source = { instanceId: 'fixture', activeRevision: 'revision', coreTip: tip };
function journal() {
  return runeJournalSchema.parse({ version: 1, accountId: 'fixture', txid: 'b'.repeat(64),
    rune: { id: '100:1', name: 'EXAMPLE', amount: '10', divisibility: 0, symbol: null },
    amount: '10', recipient: 'fixture recipient', createdAt: 1, status: 'indeterminate', transactionHex: '00',
    inputKeys: ['c'.repeat(64) + ':0'], scriptHashes: ['d'.repeat(64)] });
}
describe('Rune durable reservations', () => {
  it('treats old journals and unknown outcomes as dispatched and held', () => {
    const entry = journal();
    expect(entry.dispatchState).toBe('dispatched');
    expect(runeJournalHoldsInputs(entry, source)).toBe(true);
    expect(runeJournalHoldsInputs({ ...entry, status: 'confirmed' }, source)).toBe(true);
    expect(runeJournalHoldsInputs({ ...entry, status: 'conflicted' }, source)).toBe(true);
  });
  it('releases only with matching current-chain confirmed or conflict proof', () => {
    for (const status of ['confirmed', 'conflicted'] as const) {
      const entry = { ...journal(), status, resolution: { instanceId: 'fixture', classificationRevision: 'revision', tip, status } };
      expect(runeJournalHoldsInputs(entry, source)).toBe(false);
      expect(runeJournalHoldsInputs(entry, null)).toBe(true);
      expect(runeJournalHoldsInputs(entry, { ...source, coreTip: { ...tip, hash: 'f'.repeat(64) } })).toBe(true);
      expect(runeJournalHoldsInputs(entry, { ...source, activeRevision: 'new revision' })).toBe(true);
      expect(runeJournalHoldsInputs({ ...entry, status: 'indeterminate' }, source)).toBe(true);
    }
  });
  it('does not reserve a crash-restored prepared record that could never dispatch', () => {
    expect(runeJournalHoldsInputs({ ...journal(), dispatchState: 'prepared' }, null)).toBe(false);
  });
  it('does not accept malformed quantities or unsafe timestamps as journal state', () => {
    expect(runeJournalSchema.safeParse({ ...journal(), amount: 'NaN' }).success).toBe(false);
    expect(runeJournalSchema.safeParse({ ...journal(), createdAt: Infinity }).success).toBe(false);
  });
});
