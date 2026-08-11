import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../ui/i18n';
import { useRpc } from '../../ui/hooks/use-rpc';
import { errorMessageKey } from '../../ui/errors';
import { Button } from '../../ui/components/Button';
import { Field } from '../../ui/components/Field';
import { MnemonicGrid } from '../../ui/components/MnemonicGrid';
import { WordInput } from '../../ui/components/WordInput';
import { pickPositions } from '../../ui/random';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import styles from './onboarding.module.css';

/**
 * Resume path for an unlocked vault whose §7.1 backup gate is still closed
 * (e.g. the user closed the onboarding tab between reveal and verify). Offers
 * the typed-word verification directly, plus a password-gated return to the
 * dedicated phrase screen for users who lost their notes.
 */
export function ResumeVerify(props: { onDone: () => void; expectation: ActiveSessionExpectation }): ReactNode {
  const { t } = useI18n();
  const rpc = useRpc();

  const [positions, setPositions] = useState<[number, number, number]>(() => pickPositions());
  const [typed, setTyped] = useState<[string, string, string]>(['', '', '']);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [password, setPassword] = useState('');
  const words = useRef<string[] | null>(null);
  const [wordsReady, setWordsReady] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [step, setStep] = useState<'verify' | 'reauth' | 'reveal'>('verify');

  useEffect(() => () => {
    words.current?.fill('');
    words.current = null;
  }, []);

  async function submitVerify(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await rpc('vault.verifyBackup', {
        words: positions.map((index, i) => ({ index, word: typed[i]?.trim() ?? '' })),
        ...props.expectation,
      });
      if (!result.ok) {
        setError(t(errorMessageKey(result.code)));
        return;
      }
      if (result.result.verified) {
        props.onDone();
        return;
      }
      setPositions(pickPositions());
      setTyped(['', '', '']);
      setError(t('onboarding.verify.failed'));
    } finally {
      setBusy(false);
    }
  }

  async function reveal(): Promise<void> {
    setRevealError(null);
    setBusy(true);
    try {
      const result = await rpc('vault.revealMnemonic', { password, ...props.expectation });
      if (!result.ok) {
        setRevealError(t(errorMessageKey(result.code)));
        return;
      }
      setPassword('');
      words.current = result.result.mnemonic.split(' ');
      setWordsReady(true);
      setStep('reveal');
    } finally {
      setBusy(false);
    }
  }

  function beginPhraseReview(): void {
    setTyped(['', '', '']);
    setError(null);
    setRevealError(null);
    words.current?.fill('');
    words.current = null;
    setWordsReady(false);
    setPassword('');
    setStep('reauth');
  }

  function advanceToVerify(): void {
    words.current?.fill('');
    words.current = null;
    setWordsReady(false);
    setPositions(pickPositions());
    setTyped(['', '', '']);
    setStep('verify');
  }

  if (step === 'reauth') {
    return (
      <form
        className={styles['form']}
        onSubmit={(event) => {
          event.preventDefault();
          void reveal();
        }}
      >
        <h1 className={styles['title']}>{t('onboarding.verify.review')}</h1>
        <p className={styles['subtitle']}>{t('onboarding.verify.reviewBody')}</p>
        <Field
          label={t('unlock.password')}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
        />
        {revealError !== null ? <p role="alert" className={styles['error']}>{revealError}</p> : null}
        <div className={styles['actions']}>
          <Button variant="secondary" onClick={() => setStep('verify')} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={busy || password === ''}>
            {t('reveal.reauth.submit')}
          </Button>
        </div>
      </form>
    );
  }

  if (step === 'reveal') {
    return (
      <div className={styles['form']}>
        <h1 className={styles['title']}>{t('onboarding.reveal.title')}</h1>
        <p className={styles['subtitle']}>{t('onboarding.reveal.body')}</p>
        <div className={`${styles['warning']} ${styles['danger']}`} role="note">
          {t('onboarding.reveal.warning')}
        </div>
        {wordsReady && words.current !== null
          ? <MnemonicGrid words={words.current} />
          : <p>{t('common.loading')}</p>}
        <p className={styles['hint']}>{t('onboarding.reveal.noScreenshot')}</p>
        <div className={styles['actions']}>
          <span />
          <Button onClick={advanceToVerify} disabled={!wordsReady}>
            {t('onboarding.reveal.written')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className={styles['form']}
      onSubmit={(e) => {
        e.preventDefault();
        void submitVerify();
      }}
    >
      <h1 className={styles['title']}>{t('onboarding.verify.title')}</h1>
      <p className={styles['subtitle']}>{t('onboarding.verify.body')}</p>
      <div className={styles['wordRow']}>
        {positions.map((position, i) => (
          <WordInput
            key={`${position}-${i}`}
            label={t('onboarding.verify.wordN', { position: position + 1 })}
            value={typed[i] ?? ''}
            onChange={(e) => {
              const next: [string, string, string] = [...typed];
              next[i] = e.target.value;
              setTyped(next);
            }}
          />
        ))}
      </div>
      {error !== null ? (
        <p role="alert" className={styles['error']}>
          {error}
        </p>
      ) : null}
      <div className={styles['actions']}>
        <Button variant="secondary" onClick={beginPhraseReview} disabled={busy}>
          {t('onboarding.verify.review')}
        </Button>
        <Button type="submit" disabled={busy || typed.some((w) => w.trim() === '')}>
          {t('onboarding.verify.submit')}
        </Button>
      </div>
    </form>
  );
}
