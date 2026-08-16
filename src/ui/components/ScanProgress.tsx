/**
 * §8.2 scan progress surface: per-account/lane progress, backend status,
 * cancellation, and the Extended-scan opt-in prompt. Shared between the
 * onboarding restore step and the Settings rescan surface.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { isScanProgressEvent } from '@drey/core/messaging/events';
import type { WalletHomeResult } from '@drey/core/messaging/ops';
import type { ActiveSessionExpectation } from '../hooks/use-session';
import { useGatewayStatus } from '../hooks/use-gateway-status';
import { useRpc } from '../hooks/use-rpc';
import { useI18n } from '../i18n';
import { Button } from './Button';
import { GatewayBadge } from './GatewayBadge';
import styles from './ScanProgress.module.css';

type ScanStatus = WalletHomeResult['scan'];

const ACTIVE_POLL_MS = 1_000;

export function ScanProgress(props: {
  expectation: ActiveSessionExpectation;
  /** Kick off this scan mode when idle (onboarding uses 'initial'). */
  autoStart?: 'initial' | 'rescan';
  /** Called when a scan settles (completed, cancelled, or failed). */
  onSettled?: (kind: ScanStatus['kind']) => void;
}): ReactNode {
  const { t } = useI18n();
  const rpc = useRpc();
  const gateway = useGatewayStatus();
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [startError, setStartError] = useState(false);
  const [extendSkipped, setExtendSkipped] = useState(false);
  const started = useRef(false);
  const settled = useRef(false);
  const { expectation, autoStart, onSettled } = props;

  const refresh = useCallback(() => {
    void rpc('scan.status', { ...expectation }).then((res) => {
      if (res.ok) setStatus(res.result);
    });
  }, [expectation, rpc]);

  const start = useCallback((mode: 'initial' | 'rescan' | 'resume') => {
    setStartError(false);
    settled.current = false;
    void rpc('scan.start', { mode, ...expectation }).then((response) => {
      if (!response.ok) {
        setStartError(true);
        return;
      }
      refresh();
    });
  }, [expectation, refresh, rpc]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, ACTIVE_POLL_MS);
    const onMessage = (message: unknown): void => {
      if (isScanProgressEvent(message)) refresh();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      clearInterval(timer);
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, [refresh]);

  useEffect(() => {
    if (status === null) return;
    if (status.kind !== 'awaiting_extend' && extendSkipped) setExtendSkipped(false);
    const isSettled =
      status.kind === 'completed' || status.kind === 'cancelled' || status.kind === 'failed';
    // An explicit start intent (onboarding initial, Settings rescan) starts a
    // NEW scan from idle or any settled state — a live worker still reporting
    // the previous scan's completion must not swallow the rescan. The stale
    // settled status must also not fire onSettled for the scan we're replacing.
    if ((status.kind === 'idle' || isSettled) && autoStart !== undefined && !started.current) {
      started.current = true;
      start(autoStart);
      return;
    }
    if (isSettled && !settled.current) {
      settled.current = true;
      onSettled?.(status.kind);
    }
  }, [status, extendSkipped, autoStart, onSettled, start]);

  if (status === null) return <p>{t('common.loading')}</p>;

  const laneLabel = (lane: 'payment' | 'ordinals') =>
    lane === 'payment' ? t('scan.lane.payment') : t('scan.lane.ordinals');

  return (
    <div className={styles['scan']}>
      <div className={styles['headerRow']}>
        <span className={styles['title']}>{t('scan.title')}</span>
        <GatewayBadge view={gateway} />
      </div>

      {status.kind === 'running' ? (
        <>
          <progress
            className={styles['bar']}
            max={status.unitsTotal}
            value={status.unitsDone}
            aria-label={t('scan.title')}
          />
          <p className={styles['line']} role="status">
            {status.currentUnit?.source === 'xverse'
              ? t('scan.scanningLegacy')
              : t('scan.scanning', {
                  account: (status.currentUnit?.account ?? 0) + 1,
                  lane: laneLabel(status.currentUnit?.lane ?? 'payment'),
                })}{' '}
            ({t('scan.progress', { done: status.unitsDone, total: status.unitsTotal })})
          </p>
          <Button
            variant="secondary"
            onClick={() => {
              if (status.scanId !== null) {
                void rpc('scan.cancel', { scanId: status.scanId, ...expectation }).then(refresh);
              }
            }}
          >
            {t('scan.cancel')}
          </Button>
        </>
      ) : null}

      {status.kind === 'awaiting_extend' ? (
        extendSkipped ? (
          <p className={styles['line']} role="status">
            {t('scan.completed')}
          </p>
        ) : (
          <>
            <p className={styles['line']} role="status">
              {t('scan.extendPrompt')}
            </p>
            <div className={styles['actionsRow']}>
              <Button
                onClick={() => {
                  if (status.scanId !== null) {
                    settled.current = false;
                    void rpc('scan.extend', { scanId: status.scanId, ...expectation }).then(refresh);
                  }
                }}
              >
                {t('scan.extend')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  // Declining the Extended scan settles this surface locally;
                  // the worker keeps the boundary state so it can be re-offered.
                  setExtendSkipped(true);
                  onSettled?.('completed');
                }}
              >
                {t('scan.skip')}
              </Button>
            </div>
          </>
        )
      ) : null}

      {status.kind === 'interrupted' ? (
        <>
          <p className={styles['line']} role="status">
            {t('scan.interrupted')}
          </p>
          <Button
            onClick={() => {
              settled.current = false;
              start('resume');
            }}
          >
            {t('scan.resume')}
          </Button>
        </>
      ) : null}

      {status.kind === 'completed' ? (
        <p className={styles['line']} role="status">
          {status.historyPartial ? t('scan.completedPartial') : t('scan.completed')}
        </p>
      ) : null}
      {status.kind === 'cancelled' ? (
        <p className={styles['line']} role="status">
          {t('scan.cancelled')}
        </p>
      ) : null}
      {status.kind === 'failed' ? (
        <>
          <p role="alert" className={styles['error']}>
            {status.failureReason === 'data_limit' ? t('scan.dataLimit') : t('scan.failed')}
          </p>
          <Button
            onClick={() => {
              started.current = true;
              start('resume');
            }}
          >
            {t('scan.retry')}
          </Button>
        </>
      ) : null}
      {startError && status.kind !== 'failed' ? (
        <>
          <p role="alert" className={styles['error']}>
            {t('scan.startFailed')}
          </p>
          <Button
            onClick={() => {
              started.current = true;
              start(autoStart ?? 'rescan');
            }}
          >
            {t('scan.retry')}
          </Button>
        </>
      ) : null}
    </div>
  );
}
