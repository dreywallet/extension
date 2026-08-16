import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type SyntheticEvent,
} from 'react';
import { primaryInscriptionForPreview } from '@drey/core/domain/ordinals/satpoint';
import type { InscriptionRef } from '@drey/core/domain/gateway/contract';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import {
  useInscriptionThumbnail,
  type InscriptionThumbnailPreview,
  type InscriptionThumbnailState,
} from '../../ui/hooks/use-inscription-thumbnail';
import { Button } from '../../ui/components/Button';
import { useI18n } from '../../ui/i18n';
import styles from './fullpage.module.css';

export function UtxoInscriptionThumbnail(props: {
  inscriptions: readonly InscriptionRef[];
  txid: string;
  accountId: string;
  expectation: ActiveSessionExpectation;
  scope: string;
  enabled: boolean;
}): React.ReactElement | null {
  const { t } = useI18n();
  const inscription = primaryInscriptionForPreview(props.inscriptions);
  if (inscription === null) return null;
  return <LoadedUtxoInscriptionThumbnail {...props} inscription={inscription} label={
    props.inscriptions.length === 1
      ? t('utxos.inscriptionPreview')
      : t('utxos.inscriptionPreviewCount', { count: props.inscriptions.length })
  } />;
}

function RasterPreview(props: {
  preview: Extract<InscriptionThumbnailPreview, { kind: 'raster' }>;
  inscriptionId: string;
  label: string;
  fit: 'cover' | 'contain';
  large?: boolean | undefined;
  onReady?: (() => void) | undefined;
  onFailed?: (() => void) | undefined;
}): React.ReactElement {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const message = useMemo(() => ({
    type: 'drey:inert-inscription-preview',
    protocolVersion: 1,
    inscriptionId: props.inscriptionId,
    rasterBase64: props.preview.rasterBase64,
    pngSha256: props.preview.pngSha256,
    pngWidth: props.preview.pngWidth,
    pngHeight: props.preview.pngHeight,
    fit: props.fit,
  }), [props.fit, props.inscriptionId, props.preview]);

  useEffect(() => {
    setReady(false);
    setFailed(false);
    const timeout = setTimeout(() => {
      setFailed(true);
      props.onFailed?.();
    }, 5_000);
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.source !== frame.current?.contentWindow || event.data === null ||
          typeof event.data !== 'object' || Array.isArray(event.data)) return;
      const candidate = event.data as Record<string, unknown>;
      if (candidate['type'] !== 'drey:inert-inscription-preview-ready' ||
          candidate['protocolVersion'] !== 1 ||
          candidate['inscriptionId'] !== props.inscriptionId) return;
      clearTimeout(timeout);
      setReady(true);
      props.onReady?.();
    };
    window.addEventListener('message', receive);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener('message', receive);
    };
  }, [message, props.inscriptionId, props.onFailed, props.onReady]);

  return (
    <>
      {!ready && !failed ? <LoadingVisual large={props.large} /> : null}
      {failed ? <span aria-hidden="true" className={styles['utxoPreviewGlyph']}>INS</span> : null}
      <iframe
        aria-hidden="true"
        className={`${styles['utxoPreviewFrame']} ${ready ? styles['utxoPreviewFrameReady'] : ''}`}
        onLoad={(event: SyntheticEvent<HTMLIFrameElement>) =>
          event.currentTarget.contentWindow?.postMessage(message, '*')}
        ref={frame}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts"
        src={chrome.runtime.getURL('inscription-preview.html')}
        tabIndex={-1}
        title={props.label}
      />
    </>
  );
}

function PreviewVisual(props: {
  preview: InscriptionThumbnailPreview | null;
  state: InscriptionThumbnailState;
  inscriptionId: string;
  label: string;
  fit: 'cover' | 'contain';
  large?: boolean | undefined;
  onRasterReady?: (() => void) | undefined;
  onRasterFailed?: (() => void) | undefined;
}): React.ReactElement {
  if (props.state === 'loading') {
    return <LoadingVisual large={props.large} />;
  }
  if (props.preview?.kind === 'raster') {
    return <RasterPreview preview={props.preview} inscriptionId={props.inscriptionId}
      label={props.label} fit={props.fit} large={props.large}
      onReady={props.onRasterReady} onFailed={props.onRasterFailed} />;
  }
  if (props.preview?.kind === 'text') {
    return <span aria-hidden="true" className={styles['utxoPreviewGlyph']}>Aa</span>;
  }
  if (props.preview?.kind === 'mediaBadge') {
    return <span aria-hidden="true" className={styles['utxoPreviewGlyph']}>
      {props.preview.mediaKind === 'audio' ? '♫' : '▶'}
    </span>;
  }
  return <span aria-hidden="true" className={styles['utxoPreviewGlyph']}>INS</span>;
}

function LoadingVisual(props: { large?: boolean | undefined }): React.ReactElement {
  return (
    <span aria-hidden="true" className={styles['utxoPreviewSkeleton']}>
      <span className={`${styles['utxoPreviewLoadingMark']} ${props.large
        ? styles['utxoPreviewLoadingMarkLarge'] : ''}`}>•••</span>
    </span>
  );
}

function LoadedUtxoInscriptionThumbnail(props: {
  inscriptions: readonly InscriptionRef[];
  inscription: InscriptionRef;
  txid: string;
  accountId: string;
  expectation: ActiveSessionExpectation;
  scope: string;
  enabled: boolean;
  label: string;
}): React.ReactElement {
  const { t } = useI18n();
  const { preview, state, setNode } = useInscriptionThumbnail({
    scope: props.scope,
    expectation: props.expectation,
    accountId: props.accountId,
    txid: props.txid,
    inscriptionId: props.inscription.inscriptionId,
    enabled: props.enabled,
  });
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [rasterReady, setRasterReady] = useState(false);
  const [rasterFailed, setRasterFailed] = useState(false);
  const handleRasterReady = useCallback(() => setRasterReady(true), []);
  const handleRasterFailed = useCallback(() => setRasterFailed(true), []);
  const openLabel = t('utxos.openInscriptionPreview', { label: props.label });
  const rasterPending = preview?.kind === 'raster' && !rasterReady && !rasterFailed;
  const interactive = state === 'ready' && !rasterPending && !rasterFailed;
  const tileLabel = state === 'loading' || rasterPending
    ? t('utxos.inscriptionPreviewLoading')
    : state === 'unavailable' || state === 'idle' || rasterFailed
      ? t('utxos.inscriptionPreviewUnavailable')
      : openLabel;

  useEffect(() => {
    setRasterReady(false);
    setRasterFailed(false);
  }, [preview]);

  const close = (): void => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => {
    if (state !== 'ready') setOpen(false);
  }, [state]);

  return (
    <>
      <button
        aria-label={tileLabel}
        className={styles['utxoPreviewTile']}
        disabled={!interactive}
        onClick={() => setOpen(true)}
        ref={(node) => {
          trigger.current = node;
          setNode(node);
        }}
        type="button"
      >
        <PreviewVisual preview={preview} state={state} inscriptionId={props.inscription.inscriptionId}
          label={props.label} fit="cover" onRasterReady={handleRasterReady}
          onRasterFailed={handleRasterFailed} />
        {props.inscriptions.length > 1 ? (
          <span aria-hidden="true" className={styles['utxoPreviewCount']}>
            +{props.inscriptions.length - 1}
          </span>
        ) : null}
      </button>
      {open && preview !== null ? (
        <div className={styles['utxoPreviewBackdrop']} role="presentation"
          onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
            if (event.target === event.currentTarget) close();
          }}>
          <section aria-label={props.label} aria-modal="true"
            className={styles['utxoPreviewDialog']} role="dialog"
            onKeyDown={(event) => {
              if (event.key !== 'Tab') return;
              event.preventDefault();
              closeButton.current?.focus();
            }}>
            <div className={styles['utxoPreviewDialogHeader']}>
              <h2>{props.label}</h2>
              <Button autoFocus ref={closeButton} variant="ghost" onClick={close}>
                {t('common.close')}
              </Button>
            </div>
            <div className={styles['utxoPreviewDialogMedia']}>
              <PreviewVisual preview={preview} state="ready"
                inscriptionId={props.inscription.inscriptionId} label={props.label}
                fit="contain" large />
              {props.inscriptions.length > 1 ? (
                <span aria-hidden="true" className={styles['utxoPreviewCount']}>
                  +{props.inscriptions.length - 1}
                </span>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
