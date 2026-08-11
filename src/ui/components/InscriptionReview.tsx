import { useCallback, useMemo, useRef, type ReactNode, type SyntheticEvent } from 'react';
import styles from './InscriptionReview.module.css';
import { MediaBadgeTile, TextExcerptTile } from './PreviewTile';
import { useI18n, type MessageKey } from '../i18n';

export interface InscriptionReviewItem {
  inscriptionId: string;
  number: number | null;
  satpoint: string;
  outpoint: { txid: string; vout: number };
  movement: 'received' | 'sent' | 'retained';
  coLocationGroup: string;
  qualifiedPartialAuthorization: boolean;
  preview:
    | { kind: 'raster'; rasterBase64: string; pngSha256: string; pngWidth: number; pngHeight: number }
    | { kind: 'placeholder'; reason: string }
    | { kind: 'text'; textMime: 'text/plain' | 'application/json'; excerpt: string; truncated: boolean }
    | { kind: 'mediaBadge'; mediaKind: 'audio' | 'video'; contentLength: number };
}

const INSCRIPTION_ID = /^[0-9a-f]{64}i(?:0|[1-9][0-9]*)$/u;
const TXID = /^[0-9a-f]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_RASTER_BASE64_LENGTH = 1_398_104;
const PLACEHOLDER_REASONS = new Set([
  'active_content', 'recursive_content', 'unknown_content', 'unsupported_content',
  'oversized_content', 'mime_mismatch', 'content_length_mismatch', 'decode_failed',
  'render_pending', 'unavailable', 'approval_budget',
]);
const MAX_EXCERPT_LENGTH = 4_096;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function previewItem(value: unknown): InscriptionReviewItem['preview'] | null {
  const candidate = record(value);
  if (!candidate) return null;
  if (candidate['kind'] === 'raster') {
    const rasterBase64 = candidate['rasterBase64'];
    const pngSha256 = candidate['pngSha256'];
    if (typeof rasterBase64 !== 'string' || rasterBase64.length === 0 ||
        rasterBase64.length > MAX_RASTER_BASE64_LENGTH || !BASE64.test(rasterBase64) ||
        typeof pngSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(pngSha256) ||
        typeof candidate['pngWidth'] !== 'number' || !Number.isSafeInteger(candidate['pngWidth']) ||
        candidate['pngWidth'] < 1 || candidate['pngWidth'] > 512 ||
        typeof candidate['pngHeight'] !== 'number' || !Number.isSafeInteger(candidate['pngHeight']) ||
        candidate['pngHeight'] < 1 || candidate['pngHeight'] > 512) return null;
    return {
      kind: 'raster', rasterBase64, pngSha256,
      pngWidth: candidate['pngWidth'], pngHeight: candidate['pngHeight'],
    };
  }
  if (candidate['kind'] === 'placeholder' && typeof candidate['reason'] === 'string' &&
      PLACEHOLDER_REASONS.has(candidate['reason'])) {
    return { kind: 'placeholder', reason: candidate['reason'] };
  }
  if (candidate['kind'] === 'text') {
    const excerpt = candidate['excerpt'];
    const textMime = candidate['textMime'];
    if (typeof excerpt !== 'string' || excerpt.length === 0 ||
        excerpt.length > MAX_EXCERPT_LENGTH ||
        (textMime !== 'text/plain' && textMime !== 'application/json') ||
        typeof candidate['truncated'] !== 'boolean') return null;
    return { kind: 'text', textMime, excerpt, truncated: candidate['truncated'] };
  }
  if (candidate['kind'] === 'mediaBadge') {
    const mediaKind = candidate['mediaKind'];
    const contentLength = candidate['contentLength'];
    if ((mediaKind !== 'audio' && mediaKind !== 'video') ||
        typeof contentLength !== 'number' || !Number.isSafeInteger(contentLength) ||
        contentLength < 0) return null;
    return { kind: 'mediaBadge', mediaKind, contentLength };
  }
  return null;
}

export function parseInscriptionReview(value: unknown): {
  items: InscriptionReviewItem[];
  valid: boolean;
} {
  if (value === undefined) return { items: [], valid: true };
  if (!Array.isArray(value)) return { items: [], valid: false };
  const items: InscriptionReviewItem[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    const candidate = record(raw);
    const outpoint = record(candidate?.['outpoint']);
    const preview = previewItem(candidate?.['preview']);
    const rawNumber = candidate?.['number'];
    const number = rawNumber === undefined ? null : rawNumber;
    const satpoint = typeof candidate?.['satpoint'] === 'string'
      ? /^([0-9a-f]{64}):((?:0|[1-9][0-9]*)):((?:0|[1-9][0-9]*))$/u.exec(candidate['satpoint'])
      : null;
    if (!candidate || !outpoint || !preview ||
        typeof candidate['inscriptionId'] !== 'string' || !INSCRIPTION_ID.test(candidate['inscriptionId']) ||
        !satpoint ||
        typeof outpoint['txid'] !== 'string' || !TXID.test(outpoint['txid']) ||
        typeof outpoint['vout'] !== 'number' || !Number.isSafeInteger(outpoint['vout']) || outpoint['vout'] < 0 ||
        satpoint[1] !== outpoint['txid'] || Number(satpoint[2]) !== outpoint['vout'] ||
        !['received', 'sent', 'retained'].includes(String(candidate['movement'])) ||
        typeof candidate['coLocationGroup'] !== 'string' || candidate['coLocationGroup'].length === 0 ||
        typeof candidate['qualifiedPartialAuthorization'] !== 'boolean' ||
        (number !== null && (typeof number !== 'number' || !Number.isSafeInteger(number))) ||
        ids.has(candidate['inscriptionId'])) return { items: [], valid: false };
    ids.add(candidate['inscriptionId']);
    items.push({
      inscriptionId: candidate['inscriptionId'],
      number: number as number | null,
      satpoint: candidate['satpoint'] as string,
      outpoint: { txid: outpoint['txid'], vout: outpoint['vout'] },
      movement: candidate['movement'] as InscriptionReviewItem['movement'],
      coLocationGroup: candidate['coLocationGroup'],
      qualifiedPartialAuthorization: candidate['qualifiedPartialAuthorization'],
      preview,
    });
  }
  return { items, valid: true };
}

function sandboxUrl(): string {
  const runtime = (globalThis as typeof globalThis & { chrome?: typeof chrome }).chrome?.runtime;
  return runtime?.getURL
    ? runtime.getURL('inscription-preview.html')
    : new URL('/inscription-preview.html', window.location.href).href;
}

function RasterPreview(props: {
  inscriptionId: string;
  rasterBase64: string;
  pngSha256: string;
  pngWidth: number;
  pngHeight: number;
}): ReactNode {
  const { t } = useI18n();
  const iframe = useRef<HTMLIFrameElement | null>(null);
  const message = useMemo(() => ({
    type: 'drey:inert-inscription-preview',
    protocolVersion: 1,
    inscriptionId: props.inscriptionId,
    rasterBase64: props.rasterBase64,
    pngSha256: props.pngSha256,
    pngWidth: props.pngWidth,
    pngHeight: props.pngHeight,
  }), [props.inscriptionId, props.pngHeight, props.pngSha256, props.pngWidth, props.rasterBase64]);
  const load = useCallback((event: SyntheticEvent<HTMLIFrameElement>) => {
    event.currentTarget.contentWindow?.postMessage(message, '*');
  }, [message]);
  return (
    <iframe
      className={styles['preview']}
      onLoad={load}
      ref={iframe}
      referrerPolicy="no-referrer"
      sandbox="allow-scripts"
      src={sandboxUrl()}
      title={t('inscription.preview.iframe', { inscriptionId: props.inscriptionId })}
    />
  );
}

function movementKey(movement: InscriptionReviewItem['movement']): MessageKey {
  if (movement === 'received') return 'inscription.movement.received';
  if (movement === 'sent') return 'inscription.movement.sent';
  return 'inscription.movement.retained';
}

function placeholderReasonKey(reason: string): MessageKey {
  const labels: Record<string, MessageKey> = {
    active_content: 'inscription.preview.reason.active',
    recursive_content: 'inscription.preview.reason.recursive',
    unknown_content: 'inscription.preview.reason.unknown',
    unsupported_content: 'inscription.preview.reason.unsupported',
    oversized_content: 'inscription.preview.reason.oversized',
    mime_mismatch: 'inscription.preview.reason.mime',
    content_length_mismatch: 'inscription.preview.reason.length',
    decode_failed: 'inscription.preview.reason.decode',
    render_pending: 'inscription.preview.reason.pending',
    unavailable: 'inscription.preview.reason.unavailable',
    approval_budget: 'inscription.preview.reason.budget',
  };
  return labels[reason] ?? 'inscription.preview.reason.unknown';
}


export function InscriptionReview(props: {
  items: readonly InscriptionReviewItem[];
  acknowledgementChecked: boolean;
  onAcknowledgementChange: (checked: boolean) => void;
  primaryInscriptionId?: string | undefined;
  compact?: boolean;
}): ReactNode {
  const { t } = useI18n();
  const groups = useMemo(() => {
    const grouped = new Map<string, InscriptionReviewItem[]>();
    for (const item of props.items) {
      const existing = grouped.get(item.coLocationGroup);
      if (existing) existing.push(item);
      else grouped.set(item.coLocationGroup, [item]);
    }
    return [...grouped.entries()]
      .map(([group, items]) => [
        group,
        [...items].sort((a, b) =>
          a.inscriptionId === props.primaryInscriptionId
            ? -1
            : b.inscriptionId === props.primaryInscriptionId ? 1 : 0),
      ] as const)
      .sort(([, a], [, b]) =>
        a.some((item) => item.inscriptionId === props.primaryInscriptionId)
          ? -1
          : b.some((item) => item.inscriptionId === props.primaryInscriptionId) ? 1 : 0);
  }, [props.items, props.primaryInscriptionId]);
  const visibleGroups = useMemo(() => {
    if (!props.compact || props.primaryInscriptionId === undefined) return groups;
    return groups
      .map(([group, items]) => [
        group,
        items.filter((item) => item.inscriptionId === props.primaryInscriptionId),
      ] as const)
      .filter(([, items]) => items.length > 0);
  }, [groups, props.compact, props.primaryInscriptionId]);
  const needsAcknowledgement = props.items.some((item) => item.preview.kind === 'placeholder');
  if (props.items.length === 0) return null;

  return (
    <section
      className={`${styles['review']} ${props.compact ? styles['compactReview'] : ''}`}
      aria-label={props.compact ? t('inscription.review.heading') : undefined}
      aria-labelledby={props.compact ? undefined : 'inscription-review-heading'}
    >
      {props.compact ? null : (
        <h2 className={styles['heading']} id="inscription-review-heading">
          {t('inscription.review.heading')}
        </h2>
      )}
      {visibleGroups.map(([group, items], groupIndex) => (
        <section
          className={styles['group']}
          key={group}
          aria-label={props.compact && items.length === 1
            ? t('inscription.review.location')
            : undefined}
          aria-labelledby={props.compact && items.length === 1
            ? undefined
            : `inscription-group-${groupIndex}`}
        >
          {!props.compact || items.length > 1 ? (
            <h3 className={styles['groupHeading']} id={`inscription-group-${groupIndex}`}>
              {items.length === 1
                ? t('inscription.review.location')
                : t('inscription.review.coLocated', { count: items.length })}
            </h3>
          ) : null}
          {items.map((item) => (
            <article className={styles['card']} key={item.inscriptionId} aria-labelledby={`inscription-${item.inscriptionId}`}>
              {props.compact ? null : (
                <div className={styles['status']}>
                  <span className={styles['badge']}>{t(movementKey(item.movement))}</span>
                  {item.qualifiedPartialAuthorization
                    ? <span>{t('inscription.review.partialAuthorization')}</span>
                    : null}
                </div>
              )}
              {item.preview.kind === 'raster' ? (
                <RasterPreview
                  inscriptionId={item.inscriptionId}
                  rasterBase64={item.preview.rasterBase64}
                  pngSha256={item.preview.pngSha256}
                  pngWidth={item.preview.pngWidth}
                  pngHeight={item.preview.pngHeight}
                />
              ) : item.preview.kind === 'text' ? (
                <TextExcerptTile excerpt={item.preview.excerpt} truncated={item.preview.truncated} />
              ) : item.preview.kind === 'mediaBadge' ? (
                <MediaBadgeTile
                  mediaKind={item.preview.mediaKind}
                  contentLength={item.preview.contentLength}
                />
              ) : (
                <div className={styles['placeholder']} role="status">
                  <strong>{t('inscription.preview.unavailable')}</strong>
                  <p>{t(placeholderReasonKey(item.preview.reason))}</p>
                </div>
              )}
              <strong id={`inscription-${item.inscriptionId}`}>
                {props.compact
                  ? item.number === null ? t('gallery.unnumbered') : `#${item.number}`
                  : t('inscription.review.id')}
              </strong>
              {props.compact ? null : (
                <>
                  <code className={styles['identifier']}>{item.inscriptionId}</code>
                  <span className={styles['location']}>
                    {t('inscription.review.satpoint')}: {item.satpoint}
                  </span>
                  <span className={styles['location']}>
                    {t('inscription.review.outpoint')}: {item.outpoint.txid}:{item.outpoint.vout}
                  </span>
                </>
              )}
            </article>
          ))}
        </section>
      ))}
      {needsAcknowledgement ? (
        <label className={styles['acknowledgement']}>
          <input
            checked={props.acknowledgementChecked}
            onChange={(event) => props.onAcknowledgementChange(event.target.checked)}
            type="checkbox"
          />
          <span>{t('inscription.preview.acknowledge')}</span>
        </label>
      ) : null}
    </section>
  );
}
