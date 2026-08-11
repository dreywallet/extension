import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '../../../ui/components/Button';
import { createQrVideoFrameDecoder } from '../../../ui/vault/qr-scanner/frame-decoder';
import { AccountUrFrameDecoder } from '../../../ui/accounts/account-ur-decoder';
import { useI18n } from '../../../ui/i18n';
import styles from '../fullpage.module.css';

type ScannerPhase = 'idle' | 'requesting' | 'scanning' | 'paused' | 'error';

export type WatchQrPayload =
  | { kind: 'text'; value: string }
  | { kind: 'ur'; type: string; cbor: Uint8Array };

export function WatchAccountScanner(props: {
  onPayload(payload: WatchQrPayload): void;
  maxPayloadBytes?: number;
}): ReactNode {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationRef = useRef<number | null>(null);
  const generation = useRef(0);
  const [phase, setPhase] = useState<ScannerPhase>('idle');
  const [message, setMessage] = useState(t('watch.scanner.startHint'));
  const [progress, setProgress] = useState<{ received: number; expected: number } | null>(null);

  const releaseCamera = useCallback(() => {
    generation.current += 1;
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (videoRef.current !== null) videoRef.current.srcObject = null;
  }, []);

  const stop = useCallback((next: ScannerPhase) => {
    releaseCamera();
    setPhase(next);
  }, [releaseCamera]);

  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible' && streamRef.current !== null) {
        stop('paused');
        setMessage(t('watch.scanner.paused'));
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      releaseCamera();
    };
  }, [releaseCamera, stop, t]);

  async function start(): Promise<void> {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (video === null || canvas === null) return;
    stop('requesting');
    setMessage(t('watch.scanner.requesting'));
    setProgress(null);
    const currentGeneration = generation.current;
    try {
      if (navigator.mediaDevices?.getUserMedia === undefined) {
        setMessage(t('watch.scanner.unavailable'));
        stop('error');
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      });
      if (generation.current !== currentGeneration) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;
      video.srcObject = stream;
      await video.play();
      if (generation.current !== currentGeneration) return;
      const decoder = await createQrVideoFrameDecoder(canvas);
      const transport = new AccountUrFrameDecoder(props.maxPayloadBytes);
      let lastScanAt = 0;
      setPhase('scanning');
      setMessage(t('watch.scanner.scanning', { decoder: decoder.kind === 'barcode-detector' ? 'the browser QR reader' : 'the built-in QR reader' }));

      const scan = async (now: number): Promise<void> => {
        if (generation.current !== currentGeneration) return;
        if (now - lastScanAt >= 100) {
          lastScanAt = now;
          let result;
          try {
            result = await decoder.detect(video);
          } catch {
            setMessage(t('watch.scanner.readerFailed'));
            stop('error');
            return;
          }
          if (generation.current !== currentGeneration) return;
          if (result.status === 'ambiguous') {
            setMessage(t('watch.scanner.ambiguous'));
            stop('error');
            return;
          }
          if (result.status === 'decoded') {
            try {
              if (!result.value.toLowerCase().startsWith('ur:')) {
                props.onPayload({ kind: 'text', value: result.value });
                setMessage(t('watch.scanner.captured'));
                stop('idle');
                return;
              }
              const received = transport.receive(result.value);
              if (received.status === 'complete') {
                props.onPayload({ kind: 'ur', type: received.type, cbor: received.cbor });
                setProgress({ received: 1, expected: 1 });
                setMessage(t('watch.scanner.complete'));
                stop('idle');
                return;
              }
              setProgress({ received: received.received, expected: received.expected });
              setMessage(t('watch.scanner.progress', { percent: Math.round(received.percent * 100) }));
            } catch (error) {
              setMessage(error instanceof Error ? error.message : 'This QR code could not be read.');
              stop('error');
              return;
            }
          }
        }
        animationRef.current = requestAnimationFrame((next) => void scan(next));
      };
      animationRef.current = requestAnimationFrame((now) => void scan(now));
    } catch (error) {
      if (generation.current !== currentGeneration) return;
      const name = error instanceof DOMException ? error.name : '';
      setMessage(t(name === 'NotAllowedError' || name === 'SecurityError'
        ? 'watch.scanner.denied'
        : 'watch.scanner.failed'));
      stop('error');
    }
  }

  return (
    <section className={styles['section']} aria-label={t('watch.scanner.label')}>
      <video ref={videoRef} muted playsInline aria-label={t('watch.scanner.preview')} className={styles['scannerVideo']} />
      <canvas ref={canvasRef} hidden />
      <p role={phase === 'error' ? 'alert' : 'status'}>{message}</p>
      {progress !== null ? <progress value={progress.received} max={progress.expected} /> : null}
      <div className={styles['row']}>
        <Button disabled={phase === 'requesting' || phase === 'scanning'} onClick={() => void start()}>
          {phase === 'paused' ? t('watch.scanner.resume') : t('watch.scanner.start')}
        </Button>
        <Button variant="secondary" onClick={() => stop('idle')}>{t('watch.scanner.stop')}</Button>
      </div>
    </section>
  );
}
