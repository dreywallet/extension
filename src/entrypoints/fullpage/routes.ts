export const FULLPAGE_HASH = {
  settings: '#/settings',
  walletAccounts: '#/settings/wallets-accounts',
  accounts: '#/settings/accounts',
  recovery: '#/settings/recovery',
  reveal: '#/settings/reveal',
  passkeys: '#/settings/passkeys',
  vault: '#/settings/vault',
  messageSigning: '#/settings/sign-message',
  addressBook: '#/settings/contacts',
  siteBlocked: '#/settings/site-blocked',
  send: '#/send',
  utxos: '#/send/utxos',
  activity: '#/send/activity',
} as const;

export type FullpageView = keyof typeof FULLPAGE_HASH;
export type TransactionSection = 'send' | 'utxos' | 'activity';
export type PrimaryFullpageView = TransactionSection | 'settings';

export function fullpageViewFromHash(hash: string): FullpageView {
  switch (hash) {
    case FULLPAGE_HASH.walletAccounts:
      return 'walletAccounts';
    case FULLPAGE_HASH.recovery:
      return 'recovery';
    case FULLPAGE_HASH.accounts:
      return 'accounts';
    case FULLPAGE_HASH.reveal:
      return 'reveal';
    case FULLPAGE_HASH.passkeys:
      return 'passkeys';
    case FULLPAGE_HASH.vault:
      return 'vault';
    case FULLPAGE_HASH.messageSigning:
      return 'messageSigning';
    case FULLPAGE_HASH.addressBook:
      return 'addressBook';
    case FULLPAGE_HASH.siteBlocked:
      return 'siteBlocked';
    case FULLPAGE_HASH.send:
      return 'send';
    case FULLPAGE_HASH.utxos:
      return 'utxos';
    case FULLPAGE_HASH.activity:
      return 'activity';
    default:
      return 'settings';
  }
}

export function transactionFullpageHash(
  section: TransactionSection,
): (typeof FULLPAGE_HASH)[TransactionSection] {
  return FULLPAGE_HASH[section];
}
