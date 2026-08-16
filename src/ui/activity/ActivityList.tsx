import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import type { WalletHomeResult } from '@drey/core/messaging/ops';
import { mempoolTransactionUrl } from '@drey/core/domain/explorer';
import { isSessionStateChangedEvent } from '@drey/core/messaging/events';
import { satsToBtcDecimal } from '@drey/core/domain/sats';
import type { ActiveSessionExpectation } from '../hooks/use-session';
import {
  alignInscriptionThumbnailScope,
  clearInscriptionThumbnailStore,
  useInscriptionThumbnail,
} from '../hooks/use-inscription-thumbnail';
import { useI18n } from '../i18n';
import { useActivityUnit, usePortfolioPrivacy } from '../UiRoot';
import { ActivityGlyph } from './ActivityGlyph';
import {
  groupActivity,
  HOME_ACTIVITY_LIMIT,
  presentActivity,
  type ActivityItem,
  type ActivityPresentation,
} from './activity-presentation';
import styles from './ActivityList.module.css';

type ActivityVariant = 'compact' | 'standard' | 'comfortable';
export type ActivityTone = 'muted' | 'warning' | 'danger';

export interface ActivityDecoration {
  state?: string | undefined;
  tone?: ActivityTone | undefined;
  attention?: string | null | undefined;
}

export type ActivityInteraction =
  | { kind: 'explorer' }
  | {
      kind: 'disclosure';
      decorate?: ((item: ActivityItem) => ActivityDecoration) | undefined;
      renderDetails: (item: ActivityItem, presentation: ActivityPresentation) => ReactNode;
    };

/** Drop every cached thumbnail and queued retry on lock. */
export function clearActivityPreviewStore(): void {
  clearInscriptionThumbnailStore();
}

function sandboxUrl(): string {
  const runtime = (globalThis as typeof globalThis & { chrome?: typeof chrome }).chrome?.runtime;
  return runtime?.getURL
    ? runtime.getURL('inscription-preview.html')
    : new URL('/inscription-preview.html', window.location.href).href;
}

function ActivityInscriptionVisual(props: {
  scope: string;
  expectation: ActiveSessionExpectation;
  accountId: string;
  item: ActivityItem;
}): ReactNode {
  const { t } = useI18n();
  // The parent renders this component only for an inscription presentation.
  const inscriptionId = props.item.inscriptionId!;
  const { preview, setNode } = useInscriptionThumbnail({
    scope: props.scope,
    expectation: props.expectation,
    accountId: props.accountId,
    txid: props.item.txid,
    inscriptionId,
  });
  const message = useMemo(() => preview?.kind === 'raster' && inscriptionId != null
    ? {
        type: 'drey:inert-inscription-preview',
        protocolVersion: 1,
        inscriptionId,
        rasterBase64: preview.rasterBase64,
        pngSha256: preview.pngSha256,
        pngWidth: preview.pngWidth,
        pngHeight: preview.pngHeight,
      }
    : null, [inscriptionId, preview]);
  if (message === null) {
    return (
      <span ref={setNode} className={styles['assetIcon']} aria-hidden="true">
        <ActivityGlyph name="ordinals" />
      </span>
    );
  }
  return (
    <iframe
      ref={(element) => setNode(element)}
      aria-hidden="true"
      className={styles['assetPreview']}
      onLoad={(event: SyntheticEvent<HTMLIFrameElement>) =>
        event.currentTarget.contentWindow?.postMessage(message, '*')}
      referrerPolicy="no-referrer"
      sandbox="allow-scripts"
      src={sandboxUrl()}
      tabIndex={-1}
      title={t('inscription.preview.iframe', { inscriptionId })}
    />
  );
}

export function ActivityList(props: {
  activity: WalletHomeResult['activity'];
  compact?: boolean | undefined;
  variant?: ActivityVariant | undefined;
  emptyClassName?: string | undefined;
  expectation: ActiveSessionExpectation;
  accountId: string;
  network: 'mainnet' | 'signet' | null;
  interaction?: ActivityInteraction | undefined;
}): ReactNode {
  const { t, lang } = useI18n();
  const { activityUnit } = useActivityUnit();
  const { amountsHidden } = usePortfolioPrivacy();
  const variant = props.compact === true ? 'compact' : props.variant ?? 'standard';
  const interaction = props.interaction ?? { kind: 'explorer' as const };
  const scope = [
    props.expectation.expectedVaultId,
    props.expectation.expectedSessionId,
    props.accountId,
  ].join(':');
  alignInscriptionThumbnailScope(scope);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const onMessage = (message: unknown): void => {
      if (!isSessionStateChangedEvent(message) || !message.locked) return;
      clearActivityPreviewStore();
      setGeneration((current) => current + 1);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  const formatAmount = (value: bigint): string => amountsHidden
    ? t('privacy.amountHidden')
    : activityUnit === 'btc'
      ? `${satsToBtcDecimal(value)} BTC`
      : `${value.toLocaleString(lang)} sats`;
  const items = variant === 'compact'
    ? props.activity.slice(0, HOME_ACTIVITY_LIMIT)
    : props.activity;
  if (items.length === 0) {
    return <p className={props.emptyClassName ?? styles['muted']}>{t('activity.empty')}</p>;
  }

  const renderItem = (item: ActivityItem): ReactNode => {
    const presentation = presentActivity(item, t, lang, formatAmount, variant === 'compact');
    const decoration = interaction.kind === 'disclosure'
      ? interaction.decorate?.(item) ?? {}
      : {};
    const state = decoration.state ?? presentation.state;
    const stateVisible = variant === 'compact' || item.confirmationState !== 'confirmed' ||
      decoration.state !== undefined;
    const tone = decoration.tone ?? (
      item.confirmationState === 'indeterminate' ? 'warning'
        : item.confirmationState === 'rejected' || item.confirmationState === 'conflicted'
          ? 'danger'
          : 'muted'
    );
    const content = (
      <>
        {presentation.inscription ? (
          <ActivityInscriptionVisual
            key={`${item.txid}:${generation}`}
            scope={scope}
            expectation={props.expectation}
            accountId={props.accountId}
            item={item}
          />
        ) : item.bitcoinActionKind === 'self_transfer' ? (
          <span className={styles['assetIcon']} aria-hidden="true">
            <ActivityGlyph name="bitcoin" />
          </span>
        ) : (
          <span
            className={`${styles['directionIcon']} ${
              presentation.incoming ? styles['directionIncoming'] : ''
            }`}
            aria-hidden="true"
          >
            {presentation.incoming ? '↓' : '↑'}
          </span>
        )}
        <span className={styles['primary']}>
          <strong>{presentation.description}</strong>
          {presentation.identity !== null ? (
            <span className={styles['identity']} title={presentation.identityTitle}>
              {presentation.identity}
            </span>
          ) : null}
          {variant !== 'compact' && variant !== 'comfortable' && presentation.fee !== null ? (
            <small className={styles['fee']}>{presentation.fee}</small>
          ) : null}
          {decoration.attention ? (
            <small className={styles['attention']} role="status">{decoration.attention}</small>
          ) : null}
        </span>
        <span className={styles['state']} data-tone={tone}>
          {presentation.amount === null ? null : (
            <strong className={presentation.incoming ? styles['incomingAmount'] : undefined}>
              {presentation.amount}
            </strong>
          )}
          {variant === 'comfortable' && presentation.fee !== null ? (
            <small className={styles['fee']}>{presentation.fee}</small>
          ) : stateVisible ? (
            <small>{variant === 'compact' ? presentation.dateLabel : state}</small>
          ) : null}
        </span>
      </>
    );
    const key = item.txid;
    if (interaction.kind === 'disclosure') {
      return (
        <details key={key} className={styles['disclosure']} data-tone={tone}>
          <summary className={`${styles['item']} ${styles['comfortableItem']}`}>
            {content}
          </summary>
          <div className={styles['details']}>
            {interaction.renderDetails(item, presentation)}
          </div>
        </details>
      );
    }
    const className = `${styles['item']} ${styles[`${variant}Item`]}`;
    if (props.network === null) return <div key={key} className={className}>{content}</div>;
    return (
      <a
        key={key}
        className={`${className} ${styles['itemLink']}`}
        href={mempoolTransactionUrl(props.network, item.txid)}
        target="_blank"
        rel="noopener noreferrer"
        title={t('activity.viewExplorer')}
      >
        {content}
      </a>
    );
  };

  if (variant === 'compact') return items.map(renderItem);
  return groupActivity(items, t, lang).map((group) => (
    <section key={group.key} className={styles['group']}>
      <h3 className={styles['groupDate']}>{group.label}</h3>
      {group.items.map(renderItem)}
    </section>
  ));
}
