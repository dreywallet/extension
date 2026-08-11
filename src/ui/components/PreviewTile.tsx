import type { ReactNode } from 'react';
import styles from './PreviewTile.module.css';
import { useI18n } from '../i18n';

/**
 * Signed non-raster preview tiles shared by the gallery, home, activity, and
 * approval surfaces. Text excerpts and media badges arrive inside the signed
 * envelope (schema-bounded plain text and enum fields), so they render in the
 * host document — no sandbox frame is involved and no untrusted bytes exist.
 */

export function formatContentLength(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function TextExcerptTile(props: {
  excerpt: string;
  truncated: boolean;
  onOpen?: (() => void) | undefined;
}): ReactNode {
  const { t } = useI18n();
  const body = (
    <>
      <pre className={styles['excerpt']}>{props.excerpt}</pre>
      {props.truncated
        ? <span className={styles['truncated']}>{t('inscription.preview.textTruncated')}</span>
        : null}
    </>
  );
  if (props.onOpen === undefined) return <div className={styles['text']}>{body}</div>;
  return (
    <button
      className={`${styles['text']} ${styles['openable']}`}
      onClick={props.onOpen}
      title={t('gallery.openMedia')}
      type="button"
    >
      {body}
    </button>
  );
}

export function MediaBadgeTile(props: {
  mediaKind: 'audio' | 'video';
  contentLength: number;
  onOpen?: (() => void) | undefined;
}): ReactNode {
  const { t } = useI18n();
  const label = t(props.mediaKind === 'audio'
    ? 'inscription.preview.audioBadge'
    : 'inscription.preview.videoBadge');
  const body = (
    <>
      <span aria-hidden="true" className={styles['badgeIcon']}>
        {props.mediaKind === 'audio' ? '♫' : '▶'}
      </span>
      <span className={styles['badgeLabel']}>{label}</span>
      <span className={styles['badgeSize']}>{formatContentLength(props.contentLength)}</span>
    </>
  );
  if (props.onOpen === undefined) {
    return <div aria-label={label} className={styles['badge']} role="img">{body}</div>;
  }
  return (
    <button
      className={`${styles['badge']} ${styles['openable']}`}
      onClick={props.onOpen}
      title={t('gallery.openMedia')}
      type="button"
    >
      {body}
    </button>
  );
}
