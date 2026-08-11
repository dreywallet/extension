/**
 * Production Vault optical loop. It returns only fully decoded authenticated
 * context or a standards-valid PSBT to the owning ceremony.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { FixedRateUrDecoder } from '@drey/core/domain/ur/fixed-rate';
import { UrTransportError, type UrTransportErrorCode } from '@drey/core/domain/ur/errors';
import {
  DREY_VAULT_CONTEXT_UR_TYPE,
  decodeVaultContextCbor,
  decodeVaultPsbtCbor,
  type DecodedVaultQrContext,
} from '@drey/core/domain/vault/multisig-qr';
import { bytesToHex, hexToBytes } from '@drey/core/domain/vault/encoding';
import { setCryptoProvider } from '@drey/core/domain/vault/crypto-provider';
import {
  parseVaultSignerOrigin,
  serializeVaultSignerOrigin,
} from '@drey/core/domain/vault/multisig-encoding';
import { useI18n, type MessageKey } from '../../../ui/i18n';
import { Button } from '../../../ui/components/Button';
import {
  createQrVideoFrameDecoder,
  type QrFrameResult,
} from '../../../ui/vault/qr-scanner/frame-decoder';
import { createLibsodiumCryptoProvider } from '../../../adapters/crypto/libsodium-provider';
import styles from '../fullpage.module.css';

const GRAPH_MARKER = 'DREY_PRODUCTION_VAULT_SCANNER_v1';
const cryptoReady = createLibsodiumCryptoProvider().then((provider) => {
  setCryptoProvider(provider);
});
export type VaultTransportPayload =
  | { kind: 'context'; context: DecodedVaultQrContext }
  | { kind: 'psbt'; psbtHex: string }
  | { kind: 'origin'; originHex: string };

type Phase = 'idle' | 'requesting' | 'scanning' | 'paused' | 'complete' | 'denied' | 'unavailable' | 'error';

function errorKey(code: UrTransportErrorCode): MessageKey {
  switch (code) {
    case 'mixed-session':
      return 'vault.transportScanner.error.mixed';
    case 'conflicting-duplicate':
    case 'checksum-mismatch':
    case 'invalid-bytewords':
      return 'vault.transportScanner.error.tampered';
    case 'invalid-type':
      return 'vault.transportScanner.error.type';
    case 'unsupported-mixed-part':
      return 'vault.transportScanner.error.unsupported';
    case 'invalid-ur':
    case 'invalid-cbor':
    case 'limit-exceeded':
      return 'vault.transportScanner.error.invalid';
  }
}

export default function VaultTransportScanner(props: {
  kind?: 'origin' | 'context' | 'psbt';
  onComplete?(payload: VaultTransportPayload): void;
  onClose(): void;
}): ReactNode {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animationRef = useRef<number | null>(null);
  const generation = useRef(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ received: number; expected: number } | null>(null);

  const releaseCamera = useCallback(() => {
    generation.current += 1;
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    if (videoRef.current !== null) videoRef.current.srcObject = null;
  }, []);

  const stop = useCallback((next: Phase) => {
    releaseCamera();
    setPhase(next);
  }, [releaseCamera]);

  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible' && streamRef.current !== null) {
        stop('paused');
        setMessage(t('vault.transportScanner.background'));
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
    setMessage(null);
    setProgress(null);
    const currentGeneration = generation.current;
    try {
      await cryptoReady;
      if (generation.current !== currentGeneration) return;
      if (navigator.mediaDevices?.getUserMedia === undefined) {
        setMessage(t('vault.transportScanner.unavailable'));
        stop('unavailable');
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
      const frameDecoder = await createQrVideoFrameDecoder(canvas);
      if (generation.current !== currentGeneration) return;
      const kind = props.kind ?? 'context';
      const transport = new FixedRateUrDecoder({
        ...(kind === 'context' ? { expectedType: DREY_VAULT_CONTEXT_UR_TYPE } : {}),
        maxFragmentLength: 250,
        maxMessageLength: 1_048_576,
        maxParts: 4_096,
      });
      let lastScanAt = 0;
      let received = 0;
      let expected = 0;
      setPhase('scanning');
      setMessage(t('vault.transportScanner.scanning', { decoder: frameDecoder.kind }));

      const scan = async (now: number): Promise<void> => {
        if (generation.current !== currentGeneration) return;
        if (now - lastScanAt >= 100) {
          lastScanAt = now;
          let detected: QrFrameResult;
          try {
            detected = await frameDecoder.detect(video);
          } catch {
            setMessage(t('vault.transportScanner.error.generic'));
            stop('error');
            return;
          }
          if (generation.current !== currentGeneration) return;
          if (detected.status === 'ambiguous') {
            setMessage(t('vault.transportScanner.error.ambiguous'));
            stop('error');
            return;
          }
          if (detected.status === 'decoded') {
            try {
              if (kind === 'origin') {
                const normalized = detected.value.trim().toLowerCase();
                const origin = parseVaultSignerOrigin(hexToBytes(normalized));
                if (origin.role !== 'mobile-b' ||
                    bytesToHex(serializeVaultSignerOrigin(origin)) !== normalized) {
                  throw new Error('not a canonical Mobile B origin');
                }
                setProgress({ received: 1, expected: 1 });
                setMessage(t('vault.transportScanner.complete'));
                stop('complete');
                props.onComplete?.({ kind: 'origin', originHex: normalized });
                return;
              }
              const result = transport.receive(detected.value);
              if (result.status === 'duplicate') {
                received = result.received;
                expected = result.expected;
                setMessage(t('vault.transportScanner.duplicate'));
              } else if (result.status === 'accepted') {
                received = result.received;
                expected = result.expected;
                setProgress({ received: result.received, expected: result.expected });
                setMessage(t('vault.transportScanner.progress', {
                  received: result.received,
                  expected: result.expected,
                }));
              } else {
                const payload: VaultTransportPayload = kind === 'context'
                  ? { kind: 'context', context: decodeVaultContextCbor(result.type, result.cborMessage) }
                  : { kind: 'psbt', psbtHex: decodeVaultPsbtCbor(result.type, result.cborMessage) };
                const finalCount = expected > 0 ? expected : Math.max(received, 1);
                setProgress({ received: finalCount, expected: finalCount });
                setMessage(t('vault.transportScanner.complete'));
                stop('complete');
                props.onComplete?.(payload);
                return;
              }
            } catch (error) {
              setMessage(t(error instanceof UrTransportError
                ? errorKey(error.code)
                : 'vault.transportScanner.error.generic'));
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
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setMessage(t('vault.transportScanner.denied'));
        stop('denied');
      } else if (name === 'NotFoundError' || name === 'NotReadableError') {
        setMessage(t('vault.transportScanner.unavailable'));
        stop('unavailable');
      } else {
        setMessage(t('vault.transportScanner.error.generic'));
        stop('error');
      }
    }
  }

  return (
    <section className={styles['section']} data-testid="vault-transport-scanner" data-graph={GRAPH_MARKER}>
      <h3 className={styles['sectionTitle']}>{t('vault.transportScanner.title')}</h3>
      <p className={styles['advisory']}>{t('vault.transportScanner.body')}</p>
      <video
        ref={videoRef}
        muted
        playsInline
        aria-label={t('vault.transportScanner.video')}
        className={styles['scannerVideo']}
      />
      <canvas ref={canvasRef} hidden />
      {message !== null ? (
        <p role={phase === 'error' || phase === 'denied' || phase === 'unavailable' ? 'alert' : 'status'}>
          {message}
        </p>
      ) : null}
      {progress !== null ? (
        <progress value={progress.received} max={progress.expected}>
          {`${progress.received}/${progress.expected}`}
        </progress>
      ) : null}
      <div className={styles['row']}>
        <Button disabled={phase === 'requesting' || phase === 'scanning'} onClick={() => void start()}>
          {phase === 'paused' ? t('vault.transportScanner.resume') : t('vault.transportScanner.start')}
        </Button>
        <Button variant="secondary" onClick={() => stop('idle')}>
          {t('vault.transportScanner.cancel')}
        </Button>
        <Button variant="secondary" onClick={() => { stop('idle'); props.onClose(); }}>
          {t('common.close')}
        </Button>
      </div>
    </section>
  );
}
