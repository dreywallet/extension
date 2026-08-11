/**
 * Download / QR / print transport for the ADR 0007 §6 public recovery kit.
 *
 * The kit arrives as `kitHex` from `vaultCoordinator.recoveryKit` and is
 * public, non-spending material by construction — but §6 calls it highly
 * privacy-sensitive, so the copy tells the user to store it safely rather than
 * implying it is harmless. This component only re-encodes what it was handed:
 * no RPC, no storage, no secret can flow through it.
 *
 * Each transport lands where `read-kit --kit <file>` can consume it: the
 * download is the file itself, the printout is whitespace-wrapped hex the
 * reader strips, and the QR frames are self-labelling uppercase chunks whose
 * concatenation is the same hex (see kit-transport.ts).
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '../../../ui/i18n';
import { Button } from '../../../ui/components/Button';
import { QrCode } from '../../../ui/components/QrCode';
import styles from '../fullpage.module.css';
import {
  vaultKitFileBody,
  vaultKitFileName,
  vaultKitQrFrames,
} from './kit-transport';

export function VaultKitTransport(props: {
  kitHex: string;
  policyId: string;
  onDownloadStarted?: () => void;
}): ReactNode {
  const { t } = useI18n();
  const [showQr, setShowQr] = useState(false);
  const frames = useMemo(
    () => (showQr ? vaultKitQrFrames(props.kitHex) : []),
    [showQr, props.kitHex],
  );

  function download(): void {
    const url = URL.createObjectURL(
      new Blob([vaultKitFileBody(props.kitHex)], { type: 'text/plain' }),
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = vaultKitFileName(props.policyId);
    anchor.click();
    props.onDownloadStarted?.();
    // Chromium snapshots the blob when the download starts; deferring the
    // revoke one tick avoids racing that start in slower environments.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <>
      <div className={styles['row']}>
        <Button variant="secondary" data-testid="vault-kit-download" onClick={download}>
          {t('vault.kit.download')}
        </Button>
        <Button
          variant="secondary"
          data-testid="vault-kit-qr-toggle"
          onClick={() => setShowQr((current) => !current)}
        >
          {showQr ? t('vault.kit.qr.hide') : t('vault.kit.qr.show')}
        </Button>
        <Button variant="secondary" data-testid="vault-kit-print" onClick={() => window.print()}>
          {t('vault.kit.print')}
        </Button>
      </div>
      {showQr ? (
        <>
          <p className={styles['rowLabel']}>{t('vault.kit.qr.body')}</p>
          <div data-testid="vault-kit-qr-frames">
            {frames.map((frame) => (
              <div key={frame.index}>
                <p className={styles['rowLabel']}>
                  {t('vault.kit.qr.part', { index: frame.index, count: frame.count })}
                </p>
                <QrCode
                  value={frame.text}
                  alt={t('vault.kit.qr.alt', { index: frame.index, count: frame.count })}
                  size={280}
                />
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
