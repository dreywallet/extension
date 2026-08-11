import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../../ui/i18n';
import { useRpc } from '../../ui/hooks/use-rpc';
import { errorMessageKey } from '../../ui/errors';
import { Button } from '../../ui/components/Button';
import { Field } from '../../ui/components/Field';
import { MnemonicGrid } from '../../ui/components/MnemonicGrid';
import { WordInput } from '../../ui/components/WordInput';
import { pickPositions } from '../../ui/random';
import { checkPasswordPolicy } from '@drey/core/domain/vault/password';
import { isCommonNewPassword } from '../../ui/password-guidance';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import styles from './onboarding.module.css';
import { passkeySettingsAvailable } from '../../ui/passkey/availability';
import { PasskeyOffer } from './PasskeyOffer';

type Step = 'password' | 'reveal' | 'verify' | 'reauth' | 'passkey';

export function CreateFlow(props: {
  existingProfile?: boolean;
  defaultWalletName?: string;
  onDone: () => void;
  onBack: () => void;
}): ReactNode {
  const { t } = useI18n();
  const rpc = useRpc();
  const [step, setStep] = useState<Step>('password');

  // -- password step state ----------------------------------------------------
  const [name, setName] = useState(props.defaultWalletName ?? 'Wallet 1');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operationId = useRef(globalThis.crypto.randomUUID()).current;
  const [sessionExpectation, setSessionExpectation] = useState<ActiveSessionExpectation | null>(null);
  const passwordStepReady = props.existingProfile
    ? password !== ''
    : checkPasswordPolicy(password).ok && confirm !== '' && password === confirm;

  // -- reveal step state (mnemonic confined here; cleared before verify) ------
  const words = useRef<string[] | null>(null);
  const [wordsReady, setWordsReady] = useState(false);
  const [wordsHidden, setWordsHidden] = useState(false);

  // -- verify step state ------------------------------------------------------
  const [positions, setPositions] = useState<[number, number, number]>(() => pickPositions());
  const [typed, setTyped] = useState<[string, string, string]>(['', '', '']);
  const verifyFailed = useRef(false);

  async function submitPassword(): Promise<void> {
    setError(null);
    if (!props.existingProfile && !checkPasswordPolicy(password).ok) {
      setError(t('onboarding.password.tooShort'));
      return;
    }
    if (!props.existingProfile && password !== confirm) {
      setError(t('onboarding.password.mismatch'));
      return;
    }
    setBusy(true);
    try {
      const created = await rpc('vault.create', {
        name: name.trim() || props.defaultWalletName || 'Wallet 1', password, operationId,
      });
      if (!created.ok) {
        setError(t(errorMessageKey(created.code)));
        return;
      }
      const unlocked = await rpc('vault.unlock', { vaultId: created.result.vaultId, password });
      if (!unlocked.ok) {
        setError(t(errorMessageKey(unlocked.code)));
        return;
      }
      const expectation = {
        expectedVaultId: unlocked.result.vaultId,
        expectedSessionId: unlocked.result.sessionId,
      };
      setSessionExpectation(expectation);
      const revealed = await rpc('vault.revealMnemonic', { password, ...expectation });
      if (!revealed.ok) {
        setError(t(errorMessageKey(revealed.code)));
        return;
      }
      words.current = revealed.result.mnemonic.split(' ');
      setWordsReady(true);
      // The password's job is done; drop it from React state now.
      setPassword('');
      setConfirm('');
      setStep('reveal');
    } finally {
      setBusy(false);
    }
  }

  function advanceToVerify(): void {
    words.current?.fill('');
    words.current = null; // the UI forgets the mnemonic — the worker verifies
    setWordsReady(false);
    setPositions(pickPositions());
    setTyped(['', '', '']);
    setStep('verify');
  }

  function beginPhraseReview(): void {
    // Invalidate the visible challenge before any phrase can be revealed.
    // Returning through the reveal step creates an unrelated fresh challenge.
    words.current?.fill('');
    words.current = null;
    setWordsReady(false);
    setTyped(['', '', '']);
    setError(null);
    setPassword('');
    setStep('reauth');
  }

  async function reviewPhrase(): Promise<void> {
    if (sessionExpectation === null) {
      setError(t('common.error.locked'));
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const revealed = await rpc('vault.revealMnemonic', { password, ...sessionExpectation });
      if (!revealed.ok) {
        setError(t(errorMessageKey(revealed.code)));
        return;
      }
      words.current = revealed.result.mnemonic.split(' ');
      setWordsReady(true);
      setPassword('');
      setWordsHidden(false);
      setStep('reveal');
    } finally {
      setBusy(false);
    }
  }

  async function submitVerify(): Promise<void> {
    setError(null);
    if (sessionExpectation === null) {
      setError(t('common.error.locked'));
      return;
    }
    setBusy(true);
    try {
      const result = await rpc('vault.verifyBackup', {
        words: positions.map((index, i) => ({ index, word: typed[i]?.trim() ?? '' })),
        ...sessionExpectation,
      });
      if (!result.ok) {
        setError(t(errorMessageKey(result.code)));
        return;
      }
      if (result.result.verified) {
        if (passkeySettingsAvailable()) setStep('passkey');
        else props.onDone();
        return;
      }
      verifyFailed.current = true;
      setPositions(pickPositions());
      setTyped(['', '', '']);
      setError(t('onboarding.verify.failed'));
    } finally {
      setBusy(false);
    }
  }

  // Defense in depth: if this component unmounts for any reason, the mnemonic
  // state is dropped with it (React state is not otherwise cleared on nav).
  useEffect(() => () => {
    words.current?.fill('');
    words.current = null;
  }, []);

  if (step === 'passkey' && sessionExpectation !== null) {
    return <PasskeyOffer expectation={sessionExpectation} onDone={props.onDone} />;
  }

  if (step === 'password') {
    return (
      <form
        className={styles['form']}
        onSubmit={(e) => {
          e.preventDefault();
          void submitPassword();
        }}
      >
        <h1 className={styles['title']}>
          {t(props.existingProfile ? 'onboarding.password.existing.title' : 'onboarding.password.title')}
        </h1>
        <p className={styles['subtitle']}>
          {t(props.existingProfile ? 'onboarding.password.existing.body' : 'onboarding.password.body')}
        </p>
        {passkeySettingsAvailable() ? (
          <p className={styles['hint']}>{t('passkey.onboarding.passwordNote')}</p>
        ) : null}
        <Field
          label={t('onboarding.password.vaultName')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Field
          label={t('onboarding.password.password')}
          type={showPasswords ? 'text' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={props.existingProfile ? 'current-password' : 'new-password'}
        />
        {!props.existingProfile ? (
          <Field
            label={t('onboarding.password.confirm')}
            type={showPasswords ? 'text' : 'password'}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
        ) : null}
        <label className={styles['hint']}>
          <input
            type="checkbox"
            checked={showPasswords}
            onChange={(event) => setShowPasswords(event.target.checked)}
          />{' '}
          {t('onboarding.password.show')}
        </label>
        <div className={styles['feedbackSlot']} aria-live="polite">
          {error !== null ? (
            <p role="alert" className={styles['error']}>{error}</p>
          ) : !props.existingProfile && confirm !== '' && password !== confirm ? (
            <p role="status" className={styles['warning']}>
              {t('onboarding.password.mismatch')}
            </p>
          ) : !props.existingProfile && isCommonNewPassword(password) ? (
            <p role="status" className={styles['warning']}>{t('onboarding.password.common')}</p>
          ) : (
            <p className={styles['hint']}>
              {t(props.existingProfile
                ? 'onboarding.password.existing.hint'
                : 'onboarding.password.hint')}
            </p>
          )}
        </div>
        <div className={styles['actions']}>
          <Button variant="secondary" onClick={props.onBack} disabled={busy}>
            {t('common.back')}
          </Button>
          <Button type="submit" disabled={busy || !passwordStepReady}>
            {t('common.continue')}
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
          ? <MnemonicGrid words={words.current} masked={wordsHidden} />
          : <p>{t('common.loading')}</p>}
        <Button variant="secondary" onClick={() => setWordsHidden((hidden) => !hidden)}>
          {t(wordsHidden ? 'onboarding.reveal.show' : 'onboarding.reveal.hide')}
        </Button>
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

  if (step === 'reauth') {
    return (
      <form
        className={styles['form']}
        onSubmit={(event) => {
          event.preventDefault();
          void reviewPhrase();
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
        {error !== null ? <p role="alert" className={styles['error']}>{error}</p> : null}
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
            key={`${position}-${verifyFailed.current ? 'r' : 'f'}`}
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
