import { useEffect, useState, type ReactNode } from 'react';
import { Button } from '../../../ui/components/Button';
import { QrCode } from '../../../ui/components/QrCode';
import styles from '../fullpage.module.css';

/** The physical signer reliably decoded 60-byte fragments at this rate. */
export const VAULT_QR_FRAME_INTERVAL_MS = 1_500;

function pageIsVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false;
}

export function AnimatedQrFrames(props: {
  frames: readonly string[];
  alt: string;
  stepLabel: string;
  progressLabel: (current: number, total: number) => string;
  pauseLabel: string;
  resumeLabel: string;
  previousLabel: string;
  nextLabel: string;
}): ReactNode {
  const frameCount = props.frames.length;
  const [index, setIndex] = useState(0);
  const [manuallyPaused, setManuallyPaused] = useState(false);
  const [visible, setVisible] = useState(pageIsVisible);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);

  useEffect(() => {
    setIndex(0);
    setManuallyPaused(false);
  }, [props.frames]);

  useEffect(() => {
    const onVisibilityChange = (): void => {
      const nextVisible = pageIsVisible();
      setVisible(nextVisible);
      if (nextVisible) setIndex(0);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = (event: MediaQueryListEvent): void => setReducedMotion(event.matches);
    setReducedMotion(preference.matches);
    preference.addEventListener('change', onChange);
    return () => preference.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (frameCount <= 1 || manuallyPaused || !visible || reducedMotion) return undefined;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % frameCount);
    }, VAULT_QR_FRAME_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [frameCount, manuallyPaused, reducedMotion, visible]);

  if (frameCount === 0) return null;
  const safeIndex = Math.min(index, frameCount - 1);
  const current = safeIndex + 1;
  const progress = props.progressLabel(current, frameCount);

  return (
    <div className={styles['vaultQrStage']}>
      <p className={styles['vaultStepLabel']}>{props.stepLabel}</p>
      <QrCode value={props.frames[safeIndex]!} alt={`${props.alt}. ${progress}`} />
      <p aria-live="polite">{progress}</p>
      {frameCount > 1 ? (
        <>
          {!reducedMotion ? (
            <Button
              variant="secondary"
              aria-pressed={manuallyPaused}
              onClick={() => setManuallyPaused((paused) => !paused)}
            >
              {manuallyPaused ? props.resumeLabel : props.pauseLabel}
            </Button>
          ) : null}
          <div className={styles['row']}>
            <Button
              variant="secondary"
              disabled={safeIndex === 0}
              onClick={() => setIndex((currentIndex) => Math.max(0, currentIndex - 1))}
            >
              {props.previousLabel}
            </Button>
            <Button
              variant="secondary"
              disabled={safeIndex >= frameCount - 1}
              onClick={() => setIndex((currentIndex) => Math.min(frameCount - 1, currentIndex + 1))}
            >
              {props.nextLabel}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
