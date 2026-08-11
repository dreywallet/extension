import { lazy, Suspense, useState, type ReactNode } from 'react';
import { useI18n } from '../../ui/i18n';
import { useGatewayStatus } from '../../ui/hooks/use-gateway-status';
import { useRpc } from '../../ui/hooks/use-rpc';
import type { SessionView } from '../../ui/hooks/use-session';
import { GatewayBadge } from '../../ui/components/GatewayBadge';
import { AccountSelector } from '../../ui/components/AccountSelector';
import { Activity } from './Activity';
import { Home } from './Home';
import { Gallery } from './Gallery';
import { PopupIcon, type PopupIconName } from './PopupIcon';
import { Receive } from './Receive';
import {
  FULLPAGE_HASH,
  transactionFullpageHash,
} from '../fullpage/routes';
import styles from './popup.module.css';
import type { OrdinalActionDraft } from '../../ui/ordinal-action';
import { OpenSidePanelButton } from './OpenSidePanelButton';
import { isPersistentSurface, type WalletSurface } from './surface';

const SendTransactions = lazy(async () => {
  const module = await import('../fullpage/Transactions');
  return { default: module.Transactions };
});

type Destination = 'bitcoin' | 'ordinals' | 'activity';
type Overlay = 'none' | 'receive' | 'send';

function openFullpage(hash: string): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`/fullpage.html${hash}`) });
}

export function Shell(props: {
  session: SessionView;
  surface?: WalletSurface;
  sidePanelError?: string | null;
  onSidePanelErrorChange?: ((message: string | null) => void) | undefined;
}): ReactNode {
  const { t } = useI18n();
  const rpc = useRpc();
  const [destination, setDestination] = useState<Destination>('bitcoin');
  const [overlay, setOverlay] = useState<Overlay>('none');
  const [receiveKind, setReceiveKind] = useState<'payment' | 'ordinals'>('payment');
  const [ordinalAction, setOrdinalAction] = useState<OrdinalActionDraft | null>(null);
  const [targetInscriptionId, setTargetInscriptionId] = useState<string | null>(null);
  const surface = props.surface ?? 'popup';
  const persistent = isPersistentSurface(surface);
  const gateway = useGatewayStatus({ persistent });

  const destinations: { id: Destination; icon: PopupIconName; label: string }[] = [
    { id: 'bitcoin', icon: 'bitcoin', label: t('nav.bitcoin') },
    { id: 'ordinals', icon: 'ordinals', label: t('nav.ordinals') },
    { id: 'activity', icon: 'activity', label: t('nav.activity') },
  ];

  return (
    <div className={[
      styles['popup'],
      persistent ? styles['sidePanel'] : null,
    ].filter(Boolean).join(' ')}>
      <header className={styles['header']}>
        <AccountSelector session={props.session} compact />
        <div className={styles['headerControls']}>
          {!persistent && overlay === 'none' ? (
            <OpenSidePanelButton onErrorChange={props.onSidePanelErrorChange} />
          ) : null}
          <button
            type="button"
            className={styles['iconButton']}
            aria-label={t('nav.settings')}
            title={t('nav.settings')}
            onClick={() => openFullpage(FULLPAGE_HASH.settings)}
          >
            <PopupIcon name="settings" />
          </button>
          <button
            type="button"
            className={styles['iconButton']}
            aria-label={t('nav.lock')}
            title={t('nav.lock')}
            onClick={() => {
              void rpc('vault.lock', {}).then(() => props.session.refresh());
            }}
          >
            <PopupIcon name="lock" />
          </button>
          <span className={styles['statusSlot']} data-header-control="gateway-status">
            <GatewayBadge view={gateway} />
          </span>
        </div>
      </header>

      <main className={styles['main']}>
        {props.sidePanelError ? (
          <p className={styles['surfaceError']} role="alert">{props.sidePanelError}</p>
        ) : null}
        {props.session.quarantinedVaultCount > 0 ? (
          <p role="alert" className={styles['error']}>
            {t('common.error.quarantined')}
          </p>
        ) : null}
        {overlay === 'send' && props.session.expectation !== null && props.session.activeAccountId !== null ? (
          <>
            <div className={styles['overlayToolbar']}>
              <button
                type="button"
                className={styles['overlayBack']}
                onClick={() => {
                  setOverlay('none');
                  setOrdinalAction(null);
                }}
              >
                {t('common.back')}
              </button>
              <button
                type="button"
                className={styles['iconButton']}
                aria-label={t('send.expand')}
                title={t('send.expand')}
                onClick={() => openFullpage(FULLPAGE_HASH.send)}
              >
                <PopupIcon name="expand" />
              </button>
            </div>
            <Suspense fallback={<p role="status">{t('common.loading')}</p>}>
              <SendTransactions
                expectedVaultId={props.session.expectation.expectedVaultId}
                expectedSessionId={props.session.expectation.expectedSessionId}
                capabilities={props.session.capabilities}
                accountId={props.session.activeAccountId}
                initialAccount={props.session.activeAccount}
                accountSummaries={props.session.accountSummaries}
                initialSection="send"
                initialOrdinalAction={ordinalAction}
                compact
                onOpenAddressBook={() => openFullpage(FULLPAGE_HASH.addressBook)}
                onNavigate={(section) => {
                  if (section !== 'send') openFullpage(transactionFullpageHash(section));
                }}
              />
            </Suspense>
          </>
        ) : overlay === 'receive' ? (
          props.session.expectation !== null && props.session.activeAccountId !== null ? (
            <Receive
              initialKind={receiveKind}
              expectation={props.session.expectation}
              activeAccountId={props.session.activeAccountId}
              onClose={() => setOverlay('none')}
            />
          ) : null
        ) : (
          <>
            {destination === 'bitcoin' && props.session.expectation !== null && props.session.activeAccountId !== null ? (
              <Home
                gateway={gateway}
                expectation={props.session.expectation}
                activeAccountId={props.session.activeAccountId}
                continuous={!persistent}
                onReceive={() => {
                  setReceiveKind('payment');
                  setOverlay('receive');
                }}
                onSend={() => {
                  setOrdinalAction(null);
                  setOverlay('send');
                }}
                onManageUtxos={() => openFullpage(FULLPAGE_HASH.utxos)}
                onViewOrdinals={() => {
                  setTargetInscriptionId(null);
                  setDestination('ordinals');
                }}
                onOpenCollectible={(inscriptionId) => {
                  setTargetInscriptionId(inscriptionId);
                  setDestination('ordinals');
                }}
              />
            ) : null}
            {destination === 'ordinals' && props.session.expectation !== null && props.session.activeAccountId !== null ? (
              <Gallery
                expectation={props.session.expectation}
                account={props.session.activeAccount}
                accountId={props.session.activeAccountId}
                continuous={!persistent}
                onReceive={() => {
                  setReceiveKind('ordinals');
                  setOverlay('receive');
                }}
                onOrdinalAction={(draft) => {
                  setOrdinalAction(draft);
                  setOverlay('send');
                }}
                initialInscriptionId={targetInscriptionId}
                onInitialInscriptionHandled={() => setTargetInscriptionId(null)}
              />
            ) : null}
            {destination === 'activity' && props.session.expectation !== null && props.session.activeAccountId !== null ? (
              <Activity
                expectation={props.session.expectation}
                activeAccountId={props.session.activeAccountId}
                continuous={!persistent}
                network={gateway?.network ?? null}
              />
            ) : null}
          </>
        )}
      </main>

      <nav className={styles['bottomNav']} aria-label={t('app.name')}>
        {destinations.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={[
              styles['navItem'],
              destination === entry.id ? styles['navItemActive'] : null,
            ]
              .filter(Boolean)
              .join(' ')}
            aria-current={destination === entry.id ? 'page' : undefined}
            onClick={() => {
              setOverlay('none');
              if (entry.id === 'ordinals') setTargetInscriptionId(null);
              setDestination(entry.id);
            }}
          >
            <PopupIcon name={entry.icon} />
            <span>{entry.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
