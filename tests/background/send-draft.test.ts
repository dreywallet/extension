/**
 * The Bitcoin Send draft survives popup close and worker restart, stays sealed
 * under the wallet key, and is bound to the active account and session.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { PASSWORD } from '@drey/core/testing/vault-helpers';
import type { SendDraft } from '../../src/messaging/send-draft';
import { MemoryWalletCache } from '../../src/adapters/storage/wallet-cache-idb';
import type { WalletCacheRecord } from '../../src/adapters/storage/wallet-cache';
import { makeHarness } from './service-helpers';

beforeAll(async () => {
  await installTestCryptoProvider();
});

const DRAFT: SendDraft = {
  recipient: 'bc1qrecipientunique7x9',
  amount: '0.0001',
  unit: 'btc',
  sendMax: false,
  feeTier: 'custom',
  customFee: '3',
  additionalRecipients: [{ address: 'bc1qsecond', amount: '0.0002' }],
};

async function unlocked(walletCache = new MemoryWalletCache()) {
  const h = makeHarness(undefined, { walletCache });
  const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
  const { sessionId } = await h.service.unlock({ vaultId, password: PASSWORD });
  const accountId = (await h.service.sessionSnapshot()).activeAccountId;
  if (accountId === null) throw new Error('missing active account');
  return { h, vaultId, active: { expectedVaultId: vaultId, expectedSessionId: sessionId, accountId } };
}

describe('send draft', () => {
  it('starts empty, round-trips a draft across a worker restart, and clears', async () => {
    const { h, active } = await unlocked();
    await expect(h.service.sendDraft(active)).resolves.toEqual({ draft: null });
    await h.service.sendDraft({ ...active, draft: DRAFT });
    await expect(h.rebuild().sendDraft(active)).resolves.toEqual({ draft: DRAFT });
    await h.service.sendDraft({ ...active, draft: null });
    await expect(h.service.sendDraft(active)).resolves.toEqual({ draft: null });
  });

  it('seals the draft instead of storing the address in plaintext', async () => {
    const cache = new MemoryWalletCache();
    const puts: WalletCacheRecord[] = [];
    const put = cache.put.bind(cache);
    cache.put = (record) => { puts.push(record); return put(record); };
    const { h, active } = await unlocked(cache);
    await h.service.sendDraft({ ...active, draft: DRAFT });
    const stored = puts.filter((record) => record.type === 'sendDraft');
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored[0], (_key, value: unknown) =>
      value instanceof Uint8Array ? new TextDecoder().decode(value) : value))
      .not.toContain('bc1qrecipientunique7x9');
  });

  it('refuses a draft for an account that is not active', async () => {
    const { h, active } = await unlocked();
    await expect(h.service.sendDraft({ ...active, accountId: `acct_mainnet_${'f'.repeat(64)}` }))
      .rejects.toMatchObject({ code: 'ERR_PLAN_CHANGED' });
  });

  it('requires the unlocked session', async () => {
    const { h, active } = await unlocked();
    await h.service.lock();
    await expect(h.service.sendDraft(active)).rejects.toMatchObject({ code: 'ERR_LOCKED' });
  });
});
