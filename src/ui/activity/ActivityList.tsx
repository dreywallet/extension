import {
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import type { ActivityInscriptionPreviewResult, WalletHomeResult } from '@drey/core/messaging/ops';
import { mempoolTransactionUrl } from '@drey/core/domain/explorer';
import { isSessionStateChangedEvent } from '@drey/core/messaging/events';
import { satsToBtcDecimal } from '@drey/core/domain/sats';
import type { ActiveSessionExpectation } from '../hooks/use-session';
import { useRpc } from '../hooks/use-rpc';
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

type ActivityRpc = ReturnType<typeof useRpc>;
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

interface PreviewQueueEntry {
  key: string;
  scope: string;
  txid: string;
  inscriptionId: string;
  accountId: string;
  expectation: ActiveSessionExpectation;
  rpc: ActivityRpc;
}

const ACTIVITY_PREVIEW_CACHE_MAX = 64;
const previewStore = new Map<string, ActivityInscriptionPreviewResult>();
const previewQueue = new Map<string, PreviewQueueEntry>();
const previewRetryCounts = new Map<string, number>();
const previewRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const previewInFlightKeys = new Set<string>();
const previewSubscribers = new Set<() => void>();
let previewBatchInFlight: Promise<void> | null = null;
let previewEpoch = 0;
let previewScope = '';

function previewKey(scope: string, txid: string, inscriptionId: string): string {
  return `${scope}:${txid}:${inscriptionId}`;
}

function notifyPreviewSubscribers(): void {
  for (const subscriber of previewSubscribers) subscriber();
}

function cacheActivityPreview(
  entry: PreviewQueueEntry,
  result: ActivityInscriptionPreviewResult,
): void {
  if (result.preview.kind !== 'raster') return;
  previewStore.delete(entry.key);
  previewStore.set(entry.key, result);
  while (previewStore.size > ACTIVITY_PREVIEW_CACHE_MAX) {
    const oldest = previewStore.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    previewStore.delete(oldest);
  }
}

function scheduleActivityPreviewRetry(entry: PreviewQueueEntry): void {
  if (previewStore.has(entry.key) || previewRetryTimers.has(entry.key)) return;
  const retries = previewRetryCounts.get(entry.key) ?? 0;
  if (retries >= 2) return;
  previewRetryCounts.set(entry.key, retries + 1);
  previewRetryTimers.set(entry.key, setTimeout(() => {
    previewRetryTimers.delete(entry.key);
    if (!previewStore.has(entry.key) && !previewInFlightKeys.has(entry.key)) {
      previewQueue.set(entry.key, entry);
      drainPreviewQueue();
    }
  }, 1_500));
}

function drainPreviewQueue(): void {
  if (previewBatchInFlight !== null || previewQueue.size === 0) return;
  const first = previewQueue.values().next().value as PreviewQueueEntry | undefined;
  if (first === undefined) return;
  const entries: PreviewQueueEntry[] = [];
  const inscriptionIds = new Set<string>();
  for (const entry of previewQueue.values()) {
    if (entry.scope !== first.scope || inscriptionIds.has(entry.inscriptionId)) continue;
    entries.push(entry);
    inscriptionIds.add(entry.inscriptionId);
    if (entries.length === 8) break;
  }
  for (const entry of entries) {
    previewQueue.delete(entry.key);
    previewInFlightKeys.add(entry.key);
  }
  const requestEpoch = previewEpoch;
  previewBatchInFlight = first.rpc('activity.inscriptionPreviewBatch', {
    items: entries.map(({ txid, inscriptionId }) => ({ txid, inscriptionId })),
    accountId: first.accountId,
    ...first.expectation,
  })
    .then((response) => {
      if (requestEpoch !== previewEpoch) return;
      if (!response.ok) {
        if (response.code !== 'ERR_UNAUTHORIZED_CONTEXT') {
          for (const entry of entries) scheduleActivityPreviewRetry(entry);
        }
        return;
      }
      const resolvedKeys = new Set<string>();
      for (const result of response.result.items) {
        const entry = entries.find((candidate) => candidate.inscriptionId === result.inscriptionId);
        if (entry === undefined) continue;
        resolvedKeys.add(entry.key);
        if (result.preview.kind === 'raster') {
          cacheActivityPreview(entry, result);
          previewRetryCounts.delete(entry.key);
          continue;
        }
        scheduleActivityPreviewRetry(entry);
      }
      for (const entry of entries) {
        if (!resolvedKeys.has(entry.key)) scheduleActivityPreviewRetry(entry);
      }
    })
    .catch(() => {
      if (requestEpoch !== previewEpoch) return;
      for (const entry of entries) scheduleActivityPreviewRetry(entry);
    })
    .finally(() => {
      for (const entry of entries) previewInFlightKeys.delete(entry.key);
      previewBatchInFlight = null;
      notifyPreviewSubscribers();
      drainPreviewQueue();
    });
}

function enqueueActivityPreview(entry: PreviewQueueEntry): void {
  if (previewStore.has(entry.key) || previewQueue.has(entry.key) ||
      previewInFlightKeys.has(entry.key)) return;
  previewQueue.set(entry.key, entry);
  queueMicrotask(drainPreviewQueue);
}

function resetActivityPreviewStore(notify: boolean): void {
  previewEpoch += 1;
  previewStore.clear();
  previewQueue.clear();
  previewInFlightKeys.clear();
  previewRetryCounts.clear();
  for (const timer of previewRetryTimers.values()) clearTimeout(timer);
  previewRetryTimers.clear();
  previewScope = '';
  if (notify) notifyPreviewSubscribers();
}

/** Drop every cached thumbnail and queued retry on lock. */
export function clearActivityPreviewStore(): void {
  resetActivityPreviewStore(true);
}

function alignActivityPreviewScope(scope: string): void {
  if (scope === previewScope) return;
  // The synchronous reset makes stale paint unreadable in the first render of
  // a new account. The store is document-local and the new scope is part of
  // every cache key as a second boundary.
  resetActivityPreviewStore(false);
  previewScope = scope;
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
  const rpc = useRpc();
  const { t } = useI18n();
  const inscriptionId = props.item.inscriptionId;
  const txid = props.item.txid;
  const key = inscriptionId == null ? null : previewKey(props.scope, txid, inscriptionId);
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [, setGeneration] = useState(0);
  useEffect(() => {
    const subscriber = (): void => setGeneration((current) => current + 1);
    previewSubscribers.add(subscriber);
    return () => {
      previewSubscribers.delete(subscriber);
    };
  }, []);
  useEffect(() => {
    if (node === null || inscriptionId == null || key === null) return;
    const enqueue = (): void => enqueueActivityPreview({
      key,
      scope: props.scope,
      txid,
      inscriptionId,
      accountId: props.accountId,
      expectation: props.expectation,
      rpc,
    });
    if (typeof IntersectionObserver === 'undefined') {
      enqueue();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) enqueue();
    }, { rootMargin: '160px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [inscriptionId, key, node, props.accountId, props.expectation, props.scope, rpc, txid]);
  const result = key === null ? null : previewStore.get(key) ?? null;
  const preview = result?.preview;
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
      title={t('inscription.preview.iframe', { inscriptionId: inscriptionId ?? '' })}
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
  alignActivityPreviewScope(scope);
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
