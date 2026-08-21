/**
 * Compact header status. Mainnet is assumed, signet remains explicit, and
 * every connection state uses the same titled, accessible status dot. The
 * content surface carries the explanatory warning when action is required.
 */
import type { ReactNode } from 'react';
import { isGatewaySyncing, type GatewayStatusView } from '@drey/core/domain/gateway/status-view';
import { useI18n, type MessageKey } from '../i18n';
import styles from './GatewayBadge.module.css';

function statusIndicator(view: GatewayStatusView): { key: MessageKey; className: string } {
  if (isGatewaySyncing(view)) {
    return { key: 'gateway.state.syncing', className: 'stateWarning' };
  }
  switch (view.state) {
    case 'degraded':
      return { key: 'gateway.mode.standard', className: 'stateWarning' };
    case 'connected':
      return { key: 'gateway.state.connected', className: 'stateConnected' };
    case 'stale':
      return { key: 'gateway.state.stale', className: 'stateWarning' };
    case 'unreachable':
      return { key: 'gateway.state.unreachable', className: 'stateBlocked' };
    case 'read_only':
      return { key: 'gateway.state.readOnly', className: 'stateBlocked' };
  }
}

export function GatewayBadge(props: { view: GatewayStatusView | null }): ReactNode {
  const { t } = useI18n();
  const view = props.view;

  if (view === null) {
    return (
      <span
        className={[styles['dot'], styles['stateChecking']].join(' ')}
        aria-label={t('gateway.state.checking')}
        title={t('gateway.state.checking')}
      />
    );
  }

  const indicator = statusIndicator(view);

  return (
    <span className={styles['group']} aria-label={t('gateway.status')}>
      {view.network !== 'mainnet' ? (
        <span
          className={styles['networkMarker']}
          aria-label={t(view.network === 'regtest' ? 'home.network.regtest' : 'home.network.signet')}
          title={t(view.network === 'regtest' ? 'home.network.regtest' : 'home.network.signet')}
        >{t(view.network === 'regtest' ? 'home.network.regtest' : 'home.network.signet')}</span>
      ) : null}
      <span
        className={[styles['dot'], styles[indicator.className]].join(' ')}
        aria-label={t(indicator.key)}
        title={t(indicator.key)}
      />
    </span>
  );
}
