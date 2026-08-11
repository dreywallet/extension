import type { ReactNode } from 'react';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import type { GatewayStatusView } from '@drey/core/domain/gateway/status-view';
import { useWalletHome } from '../../ui/hooks/use-wallet-home';
import { useAccountActivity } from '../../ui/hooks/use-account-activity';
import { useI18n } from '../../ui/i18n';
import { Button } from '../../ui/components/Button';
import { ActivityList } from './ActivityList';
import { AmountUnitToggle } from '../../ui/components/AmountUnitToggle';
import styles from './popup.module.css';

export function Activity(props: {
  expectation: ActiveSessionExpectation;
  activeAccountId: string;
  network: GatewayStatusView['network'] | null;
  continuous?: boolean;
}): ReactNode {
  const { t } = useI18n();
  const { refresh: refreshHome } = useWalletHome(
    props.expectation,
    props.activeAccountId,
    { continuous: props.continuous ?? true },
  );
  const activity = useAccountActivity(props.expectation, props.activeAccountId);
  const refresh = (): void => {
    refreshHome();
    activity.refresh();
  };

  if (activity.items === null) {
    if (activity.loadState === 'error') {
      return (
        <div>
          <p className={styles['empty']}>{t('common.error.internal')}</p>
          <Button variant="secondary" onClick={refresh}>
            {t('common.retry')}
          </Button>
        </div>
      );
    }
    return <p className={styles['empty']}>{t('common.loading')}</p>;
  }

  return (
    <>
      <div className={styles['unitToolbar']}>
        <AmountUnitToggle />
        <Button variant="secondary" onClick={refresh} disabled={activity.refreshing}>
          {t('activity.refresh')}
        </Button>
      </div>
      {activity.updated ? (
        <p className={styles['activityNotice']} role="status">
          {t('activity.pagination.updated')}
        </p>
      ) : null}
      <ActivityList
        activity={activity.items}
        emptyClassName={styles['empty']}
        expectation={props.expectation}
        accountId={props.activeAccountId}
        network={props.network}
      />
      {activity.hasMore || activity.pageError ? (
        <div className={styles['activityFooter']}>
          <Button
            variant="secondary"
            disabled={activity.loadingOlder}
            onClick={activity.loadOlder}
          >
            {activity.loadingOlder
              ? t('activity.pagination.loading')
              : activity.pageError
                ? t('activity.pagination.retry')
                : t('activity.pagination.loadOlder')}
          </Button>
        </div>
      ) : null}
    </>
  );
}
