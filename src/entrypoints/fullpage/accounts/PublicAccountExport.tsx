import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PublicAccountDefinitionV1 } from '@drey/core/domain/accounts/public-account';
import {
  bitcoinCoreDescriptorJson,
  encodeAccountDescriptor,
  publicAccountKeyExpressions,
} from '@drey/core/domain/accounts/public-account-interchange';
import { FixedRateUrEncoder } from '@drey/core/domain/ur/fixed-rate';
import type { ActiveSessionExpectation } from '../../../ui/hooks/use-session';
import { useRpc } from '../../../ui/hooks/use-rpc';
import { Button } from '../../../ui/components/Button';
import { QrCode } from '../../../ui/components/QrCode';
import { useI18n } from '../../../ui/i18n';
import styles from '../fullpage.module.css';

async function copy(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

function downloadJson(name: string, value: string): void {
  const url = URL.createObjectURL(new Blob([value], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${name.trim().replace(/[^a-z0-9]+/giu, '-').replace(/^-|-$/gu, '') || 'public-account'}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function AnimatedAccountQr(props: { definition: PublicAccountDefinitionV1 }): ReactNode {
  const { t } = useI18n();
  const encoder = useMemo(
    () => new FixedRateUrEncoder('account-descriptor', encodeAccountDescriptor(props.definition)),
    [props.definition],
  );
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (encoder.frames.length === 1) return undefined;
    const timer = window.setInterval(() => setIndex((current) => (current + 1) % encoder.frames.length), 250);
    return () => window.clearInterval(timer);
  }, [encoder]);
  return (
    <div className={styles['exportQr']}>
      <QrCode value={encoder.frames[index]!} alt={t('watch.export.qrAlt')} size={260} />
      <p role="status">{encoder.frames.length === 1
        ? t('watch.export.static')
        : t('watch.export.frame', { current: index + 1, total: encoder.frames.length })}</p>
    </div>
  );
}

export function PublicAccountExport(props: {
  accountId: string;
  accountName: string;
  expectation: ActiveSessionExpectation;
  onClose(): void;
}): ReactNode {
  const rpc = useRpc();
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [definition, setDefinition] = useState<PublicAccountDefinitionV1 | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function authenticate(): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await rpc('account.public.export', {
      accountId: props.accountId,
      password,
      ...props.expectation,
    });
    setBusy(false);
    setPassword('');
    if (!result.ok) {
      setError(result.code === 'ERR_WRONG_PASSWORD'
        ? 'Wrong password. Public account data was not exported.'
        : 'The public account could not be exported. Unlock again and retry.');
      return;
    }
    setDefinition(result.result.definition);
  }

  async function copyNamed(label: string, value: string): Promise<void> {
    try {
      await copy(value);
      setCopied(label);
    } catch {
      setError('Copy failed. Try the download option instead.');
    }
  }

  const json = definition === null ? null : bitcoinCoreDescriptorJson(definition);
  const keys = definition === null ? null : publicAccountKeyExpressions(definition);

  return (
    <section className={`${styles['section']} ${styles['exportPanel']}`} aria-labelledby={`export-${props.accountId}`}>
      <h3 id={`export-${props.accountId}`} className={styles['sectionTitle']}>{t('watch.export.title')}</h3>
      <p className={styles['advisory']}>
        {t('watch.export.warning')}
      </p>
      {definition === null ? (
        <form className={styles['exportAuthForm']} onSubmit={(event) => { event.preventDefault(); void authenticate(); }}>
          <label className={styles['exportField']}>
            <span>{t('watch.export.password')}</span>
            <input
              className={styles['exportInput']}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
            />
          </label>
          <div className={styles['exportActions']}>
            <Button type="button" variant="secondary" onClick={props.onClose}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={busy || password === ''}>{t('watch.export.continue')}</Button>
          </div>
        </form>
      ) : (
        <>
          <div className={styles['exportResult']}>
            <AnimatedAccountQr definition={definition} />
            <div className={styles['exportFormats']}>
              <p>{t('watch.export.current')}</p>
              <div className={styles['exportFormatActions']}>
                <Button onClick={() => json !== null && downloadJson(props.accountName, json)}>{t('watch.export.download')}</Button>
                <Button variant="secondary" onClick={() => json !== null && void copyNamed('JSON', json)}>{t('watch.export.copyJson')}</Button>
                <Button variant="secondary" onClick={() => keys !== null && void copyNamed('public keys', `${keys.payment}\n${keys.ordinals}`)}>{t('watch.export.copyKeys')}</Button>
              </div>
              {copied !== null ? <p role="status">{t('watch.export.copied', { item: copied })}</p> : null}
            </div>
          </div>
          <details className={styles['exportDisclosure']}>
            <summary>{t('watch.export.advanced')}</summary>
            <pre className={`${styles['code']} ${styles['exportCode']}`}>{[
              definition.lanes.payment.receiveDescriptor,
              definition.lanes.payment.changeDescriptor,
              definition.lanes.ordinals.receiveDescriptor,
              definition.lanes.ordinals.changeDescriptor,
            ].join('\n\n')}</pre>
            <div className={styles['exportActions']}>
              <Button variant="secondary" onClick={() => void copyNamed('descriptors', [
                definition.lanes.payment.receiveDescriptor,
                definition.lanes.payment.changeDescriptor,
                definition.lanes.ordinals.receiveDescriptor,
                definition.lanes.ordinals.changeDescriptor,
              ].join('\n'))}>{t('watch.export.copyDescriptors')}</Button>
            </div>
          </details>
          <div className={styles['exportActions']}>
            <Button variant="ghost" onClick={props.onClose}>{t('watch.export.close')}</Button>
          </div>
        </>
      )}
      {error !== null ? <p role="alert" className={styles['error']}>{error}</p> : null}
    </section>
  );
}
