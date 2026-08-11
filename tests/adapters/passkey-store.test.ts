import { describe, expect, it } from 'vitest';
import {
  loadPasskeyEnvelopes,
  passkeyEnvelopesForVault,
  savePasskeyEnvelopes,
} from '../../src/adapters/storage/passkey-store';
import { PASSKEY_ENVELOPES_KEY } from '../../src/adapters/storage/keys';
import { makeFakeArea } from './fake-area';

describe('passkey envelope store', () => {
  it('round-trips raw envelope objects without validating them', async () => {
    const area = makeFakeArea();
    const records = [{ vaultId: 'v1', anything: 1 }, { vaultId: 'v2' }];
    await savePasskeyEnvelopes(area, records);
    expect(await loadPasskeyEnvelopes(area)).toEqual(records);
  });

  it('degrades a malformed root to an empty list (fail-closed to password)', async () => {
    const area = makeFakeArea();
    await area.set({ [PASSKEY_ENVELOPES_KEY]: { not: 'an array' } });
    expect(await loadPasskeyEnvelopes(area)).toEqual([]);
  });

  it('drops entries that can never be attributed (non-objects)', async () => {
    const area = makeFakeArea();
    await area.set({
      [PASSKEY_ENVELOPES_KEY]: ['junk', 7, null, [1], { vaultId: 'v1' }],
    });
    expect(await loadPasskeyEnvelopes(area)).toEqual([{ vaultId: 'v1' }]);
  });

  it('attributes entries to a vault only by exact raw vaultId equality', () => {
    const entries = [{ vaultId: 'v1' }, { vaultId: 'v2' }, { other: true }];
    expect(passkeyEnvelopesForVault(entries, 'v1')).toEqual([{ vaultId: 'v1' }]);
    expect(passkeyEnvelopesForVault(entries, 'v3')).toEqual([]);
  });
});
