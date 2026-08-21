import { describe, expect, it } from 'vitest';
import { transactionExplorerUrl } from '../../src/ui/activity/explorer';

describe('transaction explorer links', () => {
  const txid = 'ab'.repeat(32);

  it('uses the public explorer for mainnet and signet', () => {
    expect(transactionExplorerUrl('mainnet', txid))
      .toBe(`https://mempool.space/tx/${txid}`);
    expect(transactionExplorerUrl('signet', txid))
      .toBe(`https://mempool.space/signet/tx/${txid}`);
  });

  it('uses the build-injected local explorer only for regtest', () => {
    expect(transactionExplorerUrl('regtest', txid))
      .toBe(`http://127.0.0.1:18481/tx/${txid}`);
  });
});
