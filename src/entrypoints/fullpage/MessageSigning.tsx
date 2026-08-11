import { useMemo, useState, type ReactNode } from 'react';
import { validateBip322Message } from '@drey/core/domain/transactions/bip322';
import type { MessageSignResult } from '@drey/core/messaging/ops';
import { useI18n } from '../../ui/i18n';
import { useRpc } from '../../ui/hooks/use-rpc';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import { errorMessageKey } from '../../ui/errors';
import { Button } from '../../ui/components/Button';
import { Field } from '../../ui/components/Field';
import styles from './fullpage.module.css';

type AddressKind = 'payment' | 'ordinals';
type Review = { message: string; addressKind: AddressKind; address: string };

function validMessageBytes(message: string): Uint8Array | null {
  if (message.length === 0) return null;
  try {
    return validateBip322Message(message);
  } catch {
    return null;
  }
}

export function MessageSigning(props: {
  expectation: ActiveSessionExpectation;
  accountId: string;
  onBack: () => void;
}): ReactNode {
  const { t } = useI18n();
  const rpc = useRpc();
  const [message, setMessage] = useState('');
  const [addressKind, setAddressKind] = useState<AddressKind>('payment');
  const [review, setReview] = useState<Review | null>(null);
  const [result, setResult] = useState<MessageSignResult | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const messageBytes = useMemo(() => validMessageBytes(message), [message]);
  const byteCount = new TextEncoder().encode(message).length;

  async function beginReview(): Promise<void> {
    if (messageBytes === null) return;
    setBusy(true);
    setError(null);
    try {
      const response = await rpc('address.receive', {
        accountId: props.accountId,
        kind: addressKind,
        ...props.expectation,
      });
      if (!response.ok) {
        setError(t(errorMessageKey(response.code)));
        return;
      }
      setReview({ message, addressKind, address: response.result.address });
    } finally {
      setBusy(false);
    }
  }

  async function sign(): Promise<void> {
    if (review === null || password === '') return;
    setBusy(true);
    setError(null);
    try {
      const response = await rpc('message.sign', {
        accountId: props.accountId,
        addressKind: review.addressKind,
        message: review.message,
        password,
        ...props.expectation,
      });
      if (!response.ok) {
        setError(t(errorMessageKey(response.code)));
        return;
      }
      if (response.result.address !== review.address) {
        setError(t('common.error.internal'));
        return;
      }
      setPassword('');
      setResult(response.result);
    } finally {
      setBusy(false);
    }
  }

  async function copySignature(): Promise<void> {
    if (result === null) return;
    try {
      await navigator.clipboard.writeText(result.signature);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function reset(): void {
    setMessage('');
    setAddressKind('payment');
    setReview(null);
    setResult(null);
    setPassword('');
    setError(null);
    setCopied(false);
  }

  if (result !== null && review !== null) {
    return (
      <>
        <Button variant="ghost" onClick={props.onBack}>{t('common.back')}</Button>
        <h1 className={styles['title']}>{t('messageSigning.resultTitle')}</h1>
        <section className={styles['section']}>
          <dl className={styles['details']}>
            <div><dt>{t('messageSigning.address')}</dt><dd>{result.address}</dd></div>
            <div><dt>{t('messageSigning.message')}</dt><dd className={styles['preWrap']}>{review.message}</dd></div>
          </dl>
          <label className={styles['pasteField']}>
            <span className={styles['pasteLabel']}>{t('messageSigning.signature')}</span>
            <textarea className={styles['advancedTextarea']} value={result.signature} readOnly rows={5} />
          </label>
          <div className={styles['row']}>
            <Button variant="secondary" onClick={() => void copySignature()}>
              {t('messageSigning.copy')}
            </Button>
            <Button onClick={reset}>{t('messageSigning.new')}</Button>
          </div>
          {copied ? <p role="status" className={styles['success']}>{t('messageSigning.copied')}</p> : null}
          <details className={styles['inlineDetails']}>
            <summary>{t('send.review.details')}</summary>
            <p className={styles['rowLabel']}>{t('messageSigning.hash')}</p>
            <code className={styles['code']}>{result.messageHashHex}</code>
          </details>
        </section>
      </>
    );
  }

  if (review !== null) {
    return (
      <>
        <Button variant="ghost" onClick={() => { setReview(null); setPassword(''); setError(null); }}>
          {t('common.back')}
        </Button>
        <h1 className={styles['title']}>{t('messageSigning.reviewTitle')}</h1>
        <section className={styles['section']}>
          <p className={styles['advisory']} role="note">{t('messageSigning.warning')}</p>
          <dl className={styles['details']}>
            <div><dt>{t('messageSigning.address')}</dt><dd>{review.address}</dd></div>
            <div><dt>{t('messageSigning.message')}</dt><dd className={styles['preWrap']}>{review.message}</dd></div>
          </dl>
          <Field
            label={t('messageSigning.confirmPassword')}
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
          />
          {error !== null ? <p role="alert" className={styles['error']}>{error}</p> : null}
          <div className={styles['row']}>
            <span />
            <Button disabled={busy || password === ''} onClick={() => void sign()}>
              {t('messageSigning.sign')}
            </Button>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <Button variant="ghost" onClick={props.onBack}>{t('common.back')}</Button>
      <h1 className={styles['title']}>{t('messageSigning.title')}</h1>
      <p className={styles['rowLabel']}>{t('messageSigning.intro')}</p>
      <section className={styles['section']}>
        <label className={styles['pasteField']}>
          <span className={styles['pasteLabel']}>{t('messageSigning.message')}</span>
          <textarea
            className={styles['pasteTextarea']}
            aria-label={t('messageSigning.message')}
            value={message}
            placeholder={t('messageSigning.message.placeholder')}
            rows={8}
            onChange={(event) => setMessage(event.target.value)}
          />
          <span className={byteCount > 4096 ? styles['error'] : styles['pasteHint']}>
            {t('messageSigning.bytes', { count: byteCount })}
          </span>
        </label>
        <div>
          <p className={styles['pasteLabel']}>{t('messageSigning.addressKind')}</p>
          <div className={styles['segmented']} role="radiogroup" aria-label={t('messageSigning.addressKind')}>
            {(['payment', 'ordinals'] as const).map((kind) => (
              <Button
                key={kind}
                variant={addressKind === kind ? 'primary' : 'secondary'}
                role="radio"
                aria-checked={addressKind === kind}
                onClick={() => setAddressKind(kind)}
              >
                {t(kind === 'payment' ? 'messageSigning.payment' : 'messageSigning.ordinals')}
              </Button>
            ))}
          </div>
        </div>
        {error !== null ? <p role="alert" className={styles['error']}>{error}</p> : null}
        <div className={styles['row']}>
          <span />
          <Button disabled={busy || messageBytes === null} onClick={() => void beginReview()}>
            {t('messageSigning.review')}
          </Button>
        </div>
      </section>
    </>
  );
}
