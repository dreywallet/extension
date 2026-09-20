import { describe, expect, it } from 'vitest';
import { clearRuneSnapshot, loadRuneSnapshot, saveRuneSnapshot } from '../../src/adapters/session/rune-snapshot';
import { makeFakeArea } from './fake-area';
const binding = { vaultId: 'vault-a', sessionId: '11111111-1111-4111-8111-111111111111', accountId: 'account-a' };
const data = { status: 'ready' as const, holdings: [], transfers: [], canSign: false, feeFundingSats: '0' };
describe('Rune session display snapshot', () => {
  it('isolates vault, session, and account and removes retained data on clear', async () => {
    const area = makeFakeArea();
    await saveRuneSnapshot(area, binding, data);
    await expect(loadRuneSnapshot(area, binding)).resolves.toEqual(data);
    for (const key of ['vaultId', 'sessionId', 'accountId'] as const) {
      await expect(loadRuneSnapshot(area, { ...binding, [key]: 'different' })).resolves.toBeNull();
    }
    await clearRuneSnapshot(area);
    await expect(loadRuneSnapshot(area, binding)).resolves.toBeNull();
  });
});
