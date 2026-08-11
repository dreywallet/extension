import { useEffect, useMemo, type ReactNode, type SyntheticEvent } from 'react';
import type { WalletHomeResult } from '@drey/core/messaging/ops';
import { useI18n } from '../../ui/i18n';
import {
  NOT_REQUESTED,
  useGalleryData,
} from '../../ui/hooks/use-gallery-data';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import { useHomeCollectiblePaint } from '../../ui/hooks/use-home-collectible-paint';
import {
  HOME_COLLECTIBLE_LIMIT,
  HOME_COLLECTIBLE_RASTER_WINDOW,
  orderHomeCollectibleCandidates,
  retainHomeCollectiblePaint,
  selectHomeCollectibles,
  type HomeCollectible,
} from './home-collectibles';
import { MediaBadgeTile, TextExcerptTile } from '../../ui/components/PreviewTile';
import { PopupIcon } from './PopupIcon';
import styles from './popup.module.css';

function sandboxUrl(): string {
  return chrome.runtime.getURL('inscription-preview.html');
}

function shortInscriptionId(inscriptionId: string): string {
  return `${inscriptionId.slice(0, 8)}…${inscriptionId.slice(-8)}`;
}

function retryableHomePreview(item: HomeCollectible): boolean {
  return item.preview.kind === 'placeholder' &&
    item.preview.reason === NOT_REQUESTED;
}

function PendingCollectibleTile(props: { label: string; status: string }): ReactNode {
  return (
    <span
      aria-label={`${props.label}: ${props.status}`}
      className={styles['collectiblesPending']}
    >
      <span className={styles['collectiblesPendingIcon']}><PopupIcon name="ordinals" /></span>
      <span className={styles['collectiblesPendingLabel']}>{props.label}</span>
      <span className={styles['collectiblesPendingStatus']}>{props.status}</span>
    </span>
  );
}

function UnavailableCollectibleTile(props: { label: string }): ReactNode {
  return (
    <span
      aria-label={props.label}
      className={`${styles['collectiblesTile']} ${styles['collectiblesUnavailable']}`}
    >
      <span className={styles['collectiblesStateIcon']}>
        <PopupIcon name="imageOff" />
      </span>
      <span className={styles['collectiblesStateLabel']}>{props.label}</span>
    </span>
  );
}

export function HomeCollectibles(props: {
  count: number;
  activity: WalletHomeResult['activity'];
  expectation: ActiveSessionExpectation;
  accountId: string;
  onViewAll(): void;
  onOpen(inscriptionId: string): void;
}): ReactNode {
  const { t, lang } = useI18n();
  const gallery = useGalleryData(props.expectation, props.accountId, {
    continuous: false,
  });
  const paintedItems = useHomeCollectiblePaint(props.expectation, props.accountId);
  const { requestRasters } = gallery;
  const hasFreshResult = gallery.authority === 'fresh' && gallery.result !== null;
  // Home's separate paint RPC has already matched every cached preview to the
  // current encrypted UTXO and visibility records. It is still pixels only;
  // the live gallery result atomically supersedes it for every authority use.
  const displayedItems = useMemo(
    () => hasFreshResult
      ? retainHomeCollectiblePaint(gallery.result?.items ?? [], paintedItems)
      : paintedItems,
    [gallery.result, hasFreshResult, paintedItems],
  );
  const candidates = useMemo(() => selectHomeCollectibles(
    displayedItems,
    props.activity,
  ), [displayedItems, props.activity]);

  useEffect(() => {
    if (!hasFreshResult) return;
    // Retained paint stays visible, but the raw live result remains the source
    // of lazy-load cues so a quiet refresh still asks for replacement pixels.
    const wanted = orderHomeCollectibleCandidates(gallery.result?.items ?? [], props.activity)
      .filter((item) => item.preview.kind === 'placeholder' &&
        item.preview.reason === NOT_REQUESTED)
      .slice(0, HOME_COLLECTIBLE_RASTER_WINDOW)
      .map((item) => item.inscriptionId);
    if (wanted.length > 0) requestRasters(wanted);
  }, [gallery.result, hasFreshResult, props.activity, requestRasters]);

  const slotCount = Math.min(HOME_COLLECTIBLE_LIMIT, props.count);
  const missingCount = Math.max(0, slotCount - candidates.length);
  const authorityPending = gallery.status !== 'error' &&
    (!hasFreshResult || gallery.status === 'loading' || gallery.refreshing);
  const loading = candidates.some(retryableHomePreview) ||
    (authorityPending && missingCount > 0);
  return (
    <section className={styles['collectiblesSection']} data-testid="home-collectibles">
      <div className={styles['collectiblesHeading']}>
        <div className={styles['collectiblesTitleGroup']}>
          <h2 className={styles['sectionTitle']}>{t('home.collectibles')}</h2>
          <span className={styles['collectiblesCount']} data-testid="home-collectibles-count">
            {props.count.toLocaleString(lang)}
          </span>
        </div>
        <button className={styles['collectiblesViewAll']} onClick={props.onViewAll} type="button">
          {t('home.collectibles.viewAll')} <span aria-hidden="true">›</span>
        </button>
      </div>
      {slotCount > 0 ? (
        <div
          className={styles['collectiblesCarousel']}
          data-testid="home-collectibles-carousel"
          {...(loading ? { 'aria-label': t('common.loading'), role: 'status' } : {})}
        >
          {candidates.map((item) => {
            const label = item.display.title?.text ?? (item.number === null
              ? shortInscriptionId(item.inscriptionId)
              : t('home.collectibles.inscription', { number: item.number.toLocaleString(lang) }));
            if (retryableHomePreview(item)) {
              return (
                <PendingCollectibleTile
                  key={item.inscriptionId}
                  label={label}
                  status={t('gallery.previewRendering')}
                />
              );
            }
            if (item.preview.kind === 'placeholder') {
              return (
                <UnavailableCollectibleTile
                  key={item.inscriptionId}
                  label={t('gallery.previewUnavailable')}
                />
              );
            }
            if (item.preview.kind === 'text' || item.preview.kind === 'mediaBadge') {
              return (
                <button
                  aria-label={t('home.collectibles.open', { item: label })}
                  className={styles['collectiblesTile']}
                  key={item.inscriptionId}
                  onClick={() => props.onOpen(item.inscriptionId)}
                  type="button"
                >
                  {item.preview.kind === 'text'
                    ? <TextExcerptTile
                        excerpt={item.preview.excerpt}
                        truncated={item.preview.truncated}
                      />
                    : <MediaBadgeTile
                        mediaKind={item.preview.mediaKind}
                        contentLength={item.preview.contentLength}
                      />}
                </button>
              );
            }
            const message = {
              type: 'drey:inert-inscription-preview',
              protocolVersion: 1,
              inscriptionId: item.inscriptionId,
              rasterBase64: item.preview.rasterBase64,
              pngSha256: item.preview.pngSha256,
              pngWidth: item.preview.pngWidth,
              pngHeight: item.preview.pngHeight,
              fit: 'cover',
            };
            return (
              <button
                aria-label={t('home.collectibles.open', { item: label })}
                className={styles['collectiblesTile']}
                key={`${item.inscriptionId}:${item.preview.pngSha256}`}
                onClick={() => props.onOpen(item.inscriptionId)}
                type="button"
              >
                <iframe
                  aria-hidden="true"
                  onLoad={(event: SyntheticEvent<HTMLIFrameElement>) =>
                    event.currentTarget.contentWindow?.postMessage(message, '*')}
                  referrerPolicy="no-referrer"
                  sandbox="allow-scripts"
                  src={sandboxUrl()}
                  tabIndex={-1}
                  title={t('inscription.preview.iframe', { inscriptionId: item.inscriptionId })}
                />
              </button>
            );
          })}
          {Array.from({ length: missingCount }, (_, index) => (
            !authorityPending
              ? <UnavailableCollectibleTile
                  key={`unavailable:${index}`}
                  label={t('gallery.previewUnavailable')}
                />
              : <PendingCollectibleTile
                  key={`loading:${index}`}
                  label={t('home.collectibles')}
                  status={t('gallery.previewRendering')}
                />
          ))}
        </div>
      ) : null}
    </section>
  );
}
