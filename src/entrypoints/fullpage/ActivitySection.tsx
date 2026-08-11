import { useMemo, type ReactNode } from 'react';
import type { WalletHomeResult } from '@drey/core/messaging/ops';
import { mempoolTransactionUrl } from '@drey/core/domain/explorer';
import { satsToBtcDecimal } from '@drey/core/domain/sats';
import type { OpResult } from '../../adapters/rpc-client';
import { Button } from '../../ui/components/Button';
import { AmountUnitToggle } from '../../ui/components/AmountUnitToggle';
import {
  ActivityList,
  type ActivityDecoration,
} from '../../ui/activity/ActivityList';
import type {
  ActivityItem,
  ActivityPresentation,
} from '../../ui/activity/activity-presentation';
import { useI18n } from '../../ui/i18n';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import { useActivityUnit, usePortfolioPrivacy } from '../../ui/UiRoot';
import { BlockTrail } from '../../ui/transaction/BlockTrail';
import type { BlockTrailStatus } from '../../ui/transaction/block-trail-presentation';
import sectionStyles from './ActivitySection.module.css';
import styles from './fullpage.module.css';

type Transaction = OpResult<'transaction.status'>['transactions'][number];
type LoadState = 'loading' | 'ready' | 'error';
type DetectedActivityItem = ActivityItem & {
  detectedAssets?: unknown[];
  detectedAssetCount?: number;
};

function statusText(status: string, t: ReturnType<typeof useI18n>['t']): string {
  if (status === 'pending') return t('activity.status.pending');
  if (status === 'accepted') return t('activity.status.accepted');
  if (status === 'already_known') return t('activity.status.already_known');
  if (status === 'confirmed') return t('activity.status.confirmed');
  if (status === 'replaced') return t('activity.status.replaced');
  if (status === 'conflicted') return t('activity.status.conflicted');
  return t('activity.status.rejected');
}

function blockTrailStatus(status: string): BlockTrailStatus | null {
  switch (status) {
    case 'pending':
    case 'accepted':
    case 'already_known':
    case 'mempool':
    case 'confirmed':
    case 'replaced':
    case 'conflicted':
    case 'rejected':
    case 'indeterminate':
      return status;
    default:
      return null;
  }
}

function exactContext(
  item: ActivityItem,
  presentation: ActivityPresentation,
  t: ReturnType<typeof useI18n>['t'],
): string | null {
  if (BigInt(item.deltaSats) < 0n && item.addressDisplay?.kind === 'sent_to') {
    return t('activity.address.sentTo', { address: item.addressDisplay.address });
  }
  const source = item.transactionSource ?? null;
  if (BigInt(item.deltaSats) >= 0n && source?.singleInputAddress != null) {
    return t('activity.source.single', { address: source.singleInputAddress });
  }
  return presentation.identity;
}

function hasUnidentifiedOrdinalsContext(item: ActivityItem): boolean {
  const detected = item as DetectedActivityItem;
  const detectedCount = detected.detectedAssetCount ?? detected.detectedAssets?.length ?? 0;
  return item.actionKind == null && item.bitcoinActionKind !== 'self_transfer' &&
    item.addressContext != null && detectedCount === 0;
}

function Detail(props: { label: string; children: ReactNode; wide?: boolean }): ReactNode {
  return (
    <div className={props.wide ? sectionStyles['detailWide'] : undefined}>
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

export function ActivitySection(props: {
  expectation: ActiveSessionExpectation;
  accountId: string;
  activity: WalletHomeResult['activity'] | null;
  transactions: Transaction[];
  network: 'mainnet' | 'signet' | null;
  loadState: LoadState;
  hasMore: boolean;
  loadingOlder: boolean;
  pageError: boolean;
  updated: boolean;
  onLoadOlder: () => void;
  onRefresh: () => void;
  onAccelerate: (strategy: 'rbf' | 'cpfp', txid: string) => void;
}): ReactNode {
  const { t, lang } = useI18n();
  const { activityUnit } = useActivityUnit();
  const { amountsHidden } = usePortfolioPrivacy();
  const expectation = useMemo<ActiveSessionExpectation>(() => ({
    expectedVaultId: props.expectation.expectedVaultId,
    expectedSessionId: props.expectation.expectedSessionId,
  }), [props.expectation.expectedSessionId, props.expectation.expectedVaultId]);
  const tracked = useMemo(
    () => new Map(props.transactions.map((transaction) => [transaction.txid, transaction])),
    [props.transactions],
  );
  const activityTxids = useMemo(
    () => new Set(props.activity?.map((item) => item.txid) ?? []),
    [props.activity],
  );
  const unmatchedRecoveries = props.activity === null
    ? props.transactions
    : props.transactions.filter(
        (transaction) => transaction.recovering && !activityTxids.has(transaction.txid),
      );
  const formatAmount = (value: bigint): string => amountsHidden
    ? t('privacy.amountHidden')
    : activityUnit === 'btc'
      ? `${satsToBtcDecimal(value)} BTC`
      : `${value.toLocaleString(lang)} sats`;

  const decorate = (item: ActivityItem): ActivityDecoration => {
    const transaction = tracked.get(item.txid);
    if (transaction === undefined) return {};
    const danger = transaction.status === 'rejected' || transaction.status === 'conflicted';
    return {
      state: statusText(transaction.status, t),
      tone: danger ? 'danger' : transaction.recovering ? 'warning' : 'muted',
      attention: transaction.recovering ? t('activity.recovering') : null,
    };
  };

  const renderDetails = (item: ActivityItem, presentation: ActivityPresentation): ReactNode => {
    const transaction = tracked.get(item.txid);
    const state = transaction === undefined ? presentation.state : statusText(transaction.status, t);
    const context = exactContext(item, presentation, t);
    const unidentifiedOrdinalsContext = hasUnidentifiedOrdinalsContext(item);
    const accelerate = transaction?.status === 'accepted' || transaction?.status === 'already_known';
    const trailStatus = transaction === undefined
      ? item.confirmationState
      : blockTrailStatus(transaction.status) ?? item.confirmationState;
    return (
      <div className={sectionStyles['detailBody']}>
        <BlockTrail
          status={trailStatus}
          recordKind={transaction === undefined ? 'observed' : 'durable'}
          statusLabel={state}
          height={item.height}
        />
        <dl className={sectionStyles['detailGrid']}>
          <Detail label={t('activity.detail.status')}>{state}</Detail>
          <Detail label={t('activity.detail.date')}>{presentation.dateTimeLabel}</Detail>
          {presentation.amount === null ? null : (
            <Detail label={t('activity.detail.amount')}>{presentation.amount}</Detail>
          )}
          {presentation.fee === null ? null : (
            <Detail label={t('activity.detail.fee')}>{presentation.fee}</Detail>
          )}
          {context === null && !unidentifiedOrdinalsContext ? null : (
            <Detail label={t('activity.detail.context')} wide>
              {context === null ? null : (
                <span className={sectionStyles['breakable']}>{context}</span>
              )}
              {context !== null && unidentifiedOrdinalsContext ? <br /> : null}
              {unidentifiedOrdinalsContext
                ? t('activity.address.assetUnidentified')
                : null}
            </Detail>
          )}
          {item.height === null ? null : (
            <Detail label={t('activity.detail.blockHeight')}>
              {item.height.toLocaleString(lang)}
            </Detail>
          )}
          {item.inscriptionId == null ? null : (
            <Detail label={t('activity.detail.inscriptionId')} wide>
              <code className={sectionStyles['code']}>{item.inscriptionId}</code>
            </Detail>
          )}
          <Detail label={t('activity.detail.transactionId')} wide>
            <code className={sectionStyles['code']}>{item.txid}</code>
          </Detail>
        </dl>
        {transaction?.recovering ? (
          <p className={sectionStyles['attention']} role="status">{t('activity.recovering')}</p>
        ) : null}
        {accelerate ? (
          <div className={sectionStyles['actions']}>
            <Button variant="secondary" onClick={() => props.onAccelerate('rbf', item.txid)}>
              {t('activity.speedUp.rbf')}
            </Button>
            <Button variant="secondary" onClick={() => props.onAccelerate('cpfp', item.txid)}>
              {t('activity.speedUp.cpfp')}
            </Button>
            <p className={styles['advisory']}>{t('activity.pendingSafety')}</p>
          </div>
        ) : null}
        {props.network === null ? null : (
          <a
            className={sectionStyles['explorer']}
            href={mempoolTransactionUrl(props.network, item.txid)}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('activity.viewExplorer')}
          >
            {t('activity.viewExplorer')} ↗
          </a>
        )}
      </div>
    );
  };

  const fallback = unmatchedRecoveries.map((transaction) => {
    const accelerate = transaction.status === 'accepted' || transaction.status === 'already_known';
    const trailStatus = blockTrailStatus(transaction.status);
    return (
    <article
      className={transaction.recovering ? sectionStyles['recovery'] : sectionStyles['fallback']}
      key={`${transaction.planId}:${transaction.status}`}
    >
      <div>
        <strong>{transaction.recovering
          ? t('activity.detail.needsAttention')
          : formatAmount(BigInt(transaction.amountSats))}</strong>
        <span>{statusText(transaction.status, t)}</span>
      </div>
      {transaction.recovering ? <p role="status">{t('activity.recovering')}</p> : null}
      {trailStatus === null ? null : (
        <BlockTrail
          status={trailStatus}
          recordKind="durable"
          statusLabel={statusText(transaction.status, t)}
        />
      )}
      <dl className={sectionStyles['detailGrid']}>
        {transaction.recovering ? (
          <Detail label={t('activity.detail.amount')}>
            {formatAmount(BigInt(transaction.amountSats))}
          </Detail>
        ) : null}
        {BigInt(transaction.feeSats) > 0n ? (
          <Detail label={t('activity.detail.fee')}>
            {t('activity.feeDisplay', { fee: formatAmount(BigInt(transaction.feeSats)) })}
          </Detail>
        ) : null}
        <Detail label={t('activity.detail.transactionId')} wide>
          <code className={sectionStyles['code']}>{transaction.txid}</code>
        </Detail>
      </dl>
      {accelerate ? (
        <div className={sectionStyles['actions']}>
          <Button variant="secondary" onClick={() => props.onAccelerate('rbf', transaction.txid)}>
            {t('activity.speedUp.rbf')}
          </Button>
          <Button variant="secondary" onClick={() => props.onAccelerate('cpfp', transaction.txid)}>
            {t('activity.speedUp.cpfp')}
          </Button>
          <p className={styles['advisory']}>{t('activity.pendingSafety')}</p>
        </div>
      ) : null}
      {props.network === null ? null : (
        <a
          className={sectionStyles['explorer']}
          href={mempoolTransactionUrl(props.network, transaction.txid)}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('activity.viewExplorer')}
        >
          {t('activity.viewExplorer')} ↗
        </a>
      )}
    </article>
    );
  });

  const hasActivity = props.activity !== null && props.activity.length > 0;
  const hasFallback = fallback.length > 0;
  return (
    <section className={`${styles['section']} ${sectionStyles['section']}`}>
      <header className={sectionStyles['header']}>
        <h1 className={sectionStyles['headerTitle']}>{t('activity.title')}</h1>
        <div className={sectionStyles['toolbar']}>
          <AmountUnitToggle />
          <Button variant="secondary" onClick={props.onRefresh}>{t('activity.refresh')}</Button>
        </div>
      </header>
      {props.updated ? (
        <p className={sectionStyles['activityNotice']} role="status">
          {t('activity.pagination.updated')}
        </p>
      ) : null}
      {props.loadState === 'loading' ? (
        <p className={styles['loadingState']}>{t('common.loading')}</p>
      ) : props.loadState === 'error' && !hasActivity && !hasFallback ? (
        <div className={sectionStyles['loadError']}>
          <p role="alert">{t('activity.loadError')}</p>
          <Button variant="secondary" onClick={props.onRefresh}>{t('common.retry')}</Button>
        </div>
      ) : (
        <>
          {hasFallback ? <div className={sectionStyles['recoveryList']}>{fallback}</div> : null}
          {hasActivity ? (
            <ActivityList
              activity={props.activity ?? []}
              variant="comfortable"
              expectation={expectation}
              accountId={props.accountId}
              network={props.network}
              interaction={{ kind: 'disclosure', decorate, renderDetails }}
            />
          ) : hasFallback ? null : <p>{t('activity.empty')}</p>}
          {props.hasMore || props.pageError ? (
            <div className={sectionStyles['paginationFooter']}>
              <Button
                variant="secondary"
                disabled={props.loadingOlder}
                onClick={props.onLoadOlder}
              >
                {props.loadingOlder
                  ? t('activity.pagination.loading')
                  : props.pageError
                    ? t('activity.pagination.retry')
                    : t('activity.pagination.loadOlder')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
