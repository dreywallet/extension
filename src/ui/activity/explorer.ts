import type { Network } from '@drey/core/domain/keys/derivation';

export function transactionExplorerUrl(network: Network, txid: string): string {
  if (network === 'regtest') {
    if (__REGTEST_EXPLORER_ORIGIN__ === '') {
      throw new Error('regtest explorer is unavailable in this build');
    }
    return `${__REGTEST_EXPLORER_ORIGIN__}/tx/${txid}`;
  }
  return `https://mempool.space${network === 'signet' ? '/signet' : ''}/tx/${txid}`;
}
