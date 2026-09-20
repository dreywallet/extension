import type { ReactNode } from 'react';
import type { RuneReview, RuneTransferView } from '../../messaging/rune-ops';
import { useI18n } from '../i18n';
import { usePortfolioPrivacy } from '../UiRoot';
import { formatRuneAmount } from '../format-rune-amount';
import { transactionExplorerUrl } from './explorer';
import styles from './ActivityList.module.css';
import runeStyles from './RuneActivity.module.css';

type Network = 'mainnet' | 'signet' | 'regtest';
export function runeNetwork(accountId: string): Network | null {
  const network = /^acct_(mainnet|signet|regtest)_/u.exec(accountId)?.[1];
  return network === 'mainnet' || network === 'signet' || network === 'regtest' ? network : null;
}

export function RuneTransferDetails(props: { transfer: RuneTransferView; network: Network | null; review?: RuneReview | null }): ReactNode {
  const { t, lang } = useI18n();
  const { amountsHidden } = usePortfolioPrivacy();
  const item = props.transfer;
  const cost = props.review;
  return <div className={runeStyles.details}>
    <dl>
      <dt>{t('runes.amount')}</dt><dd>{amountsHidden ? '••••' : formatRuneAmount(item.amount, item.rune.divisibility, lang, item.rune.symbol)}</dd>
      <dt>{t('runes.recipient')}</dt><dd>{item.recipient}</dd>
      <dt>{t('runes.date')}</dt><dd><time dateTime={new Date(item.createdAt).toISOString()}>{new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(item.createdAt)}</time></dd>
      <dt>{t('runes.status')}</dt><dd>{t(`runes.${item.status}`)}</dd>
      {cost ? <><dt>{t('runes.totalBitcoin')}</dt><dd>{(BigInt(cost.feeSats) + BigInt(cost.postageSats)).toLocaleString(lang)} sats</dd><dt>{t('runes.fee')}</dt><dd>{BigInt(cost.feeSats).toLocaleString(lang)} sats</dd><dt>{t('runes.postage')}</dt><dd>{BigInt(cost.postageSats).toLocaleString(lang)} sats</dd></> : null}
      <dt>{t('runes.transactionId')}</dt><dd className={runeStyles.txid}>{item.txid}</dd>
    </dl>
    {props.network ? <a className={runeStyles.explorer} href={transactionExplorerUrl(props.network, item.txid)} target="_blank" rel="noopener noreferrer">{t('activity.viewExplorer')} ↗</a> : null}
  </div>;
}

export function RuneTransferRow(props: { transfer: RuneTransferView; network: Network | null; compact?: boolean }): ReactNode {
  const { t, lang } = useI18n();
  const { amountsHidden } = usePortfolioPrivacy();
  const item = props.transfer;
  const incoming = item.direction === 'received';
  const tone = item.status === 'indeterminate' ? 'warning' : item.status === 'conflicted' ? 'danger' : 'muted';
  return <details className={`${styles.disclosure} ${runeStyles.row}`} data-tone={tone}>
    <summary className={styles.item}>
      <span className={`${styles.directionIcon} ${incoming ? styles.directionIncoming : ''}`} aria-hidden>{incoming ? '↓' : '↑'}</span>
      <span className={styles.primary}><strong>{t(`runes.${item.direction}`)} · {item.rune.name}</strong><small>{new Intl.DateTimeFormat(lang, { month: 'short', day: 'numeric', ...(props.compact ? {} : { hour: 'numeric', minute: '2-digit' }) }).format(item.createdAt)}</small></span>
      <span className={`${styles.state} ${runeStyles.amount}`} data-tone={tone}><strong>{amountsHidden ? '••••' : formatRuneAmount(item.amount, item.rune.divisibility, lang, item.rune.symbol)}</strong><small>{t(item.status === 'indeterminate' ? 'runes.statusChecking' : `runes.${item.status}`)}</small></span>
    </summary>
    <RuneTransferDetails transfer={item} network={props.network} />
  </details>;
}
