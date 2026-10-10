import { useState, type ReactNode } from 'react';
import { useI18n } from '../../ui/i18n';
import { useRpc } from '../../ui/hooks/use-rpc';
import { useGatewayStatus } from '../../ui/hooks/use-gateway-status';
import type { SessionView } from '../../ui/hooks/use-session';
import { AccountSelector } from '../../ui/components/AccountSelector';
import { BrandMark } from '../../ui/components/BrandMark';
import { GatewayBadge } from '../../ui/components/GatewayBadge';
import { PopupIcon } from '../popup/PopupIcon';
import { openSidePanel, sidePanelOpeningSupported } from '../popup/OpenSidePanelButton';
import styles from './fullpage.module.css';

/**
 * The same header the popup and side panel show — which account, which
 * network, and Lock — so the full page reads as the same wallet. "Wallet"
 * opens the side panel, where the balance and Ordinals live.
 *
 * Pages that handle recovery words or keys pass `ceremony`: they keep the
 * brand, network and Lock, but not the account switcher or the side-panel
 * shortcut, so nothing can change or pull focus mid-ceremony.
 */
export function FullpageHeader(props: {
  session: SessionView;
  ceremony?: boolean;
  /** The page manages accounts itself, so the header doesn't repeat the switcher. */
  hideAccount?: boolean;
}): ReactNode {
  const { t } = useI18n();
  const rpc = useRpc();
  const gateway = useGatewayStatus({ persistent: true });
  const [sidePanelError, setSidePanelError] = useState<string | null>(null);
  const showWallet = props.ceremony !== true && sidePanelOpeningSupported();
  return (
    <>
      <header className={styles['fullpageHeader']}>
        <BrandMark compact />
        {props.ceremony === true || props.hideAccount === true ? <span /> : (
          <div className={styles['fullpageHeaderAccount']}>
            <AccountSelector session={props.session} compact />
          </div>
        )}
        <div className={styles['fullpageHeaderControls']}>
          {showWallet ? (
            <button
              type="button"
              className={styles['headerTextButton']}
              title={t('sidePanel.open')}
              onClick={() => {
                setSidePanelError(null);
                void openSidePanel().catch(() => setSidePanelError(t('sidePanel.openError')));
              }}
            >
              <PopupIcon name="sidePanel" />
              {t('runes.wallet')}
            </button>
          ) : null}
          <button
            type="button"
            className={styles['headerIconButton']}
            aria-label={t('nav.lock')}
            title={t('nav.lock')}
            onClick={() => {
              void rpc('vault.lock', {}).then(() => props.session.refresh());
            }}
          >
            <PopupIcon name="lock" />
          </button>
          <span className={styles['headerStatusSlot']} data-header-control="gateway-status">
            <GatewayBadge view={gateway} />
          </span>
        </div>
      </header>
      {sidePanelError !== null ? <p role="alert" className={styles['error']}>{sidePanelError}</p> : null}
    </>
  );
}
