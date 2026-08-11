import { useRef, useState, type ReactNode } from 'react';
import { wordlist as english } from '@scure/bip39/wordlists/english';
import { validateMnemonic } from '@drey/core/domain/keys/mnemonic';
import { useI18n } from '../../ui/i18n';
import { useRpc } from '../../ui/hooks/use-rpc';
import { errorMessageKey } from '../../ui/errors';
import { Button } from '../../ui/components/Button';
import { Field } from '../../ui/components/Field';
import { ScanProgress } from '../../ui/components/ScanProgress';
import { WordInput } from '../../ui/components/WordInput';
import { handleRadioKey } from '../../ui/radio-keyboard';
import { checkPasswordPolicy } from '@drey/core/domain/vault/password';
import { isCommonNewPassword } from '../../ui/password-guidance';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import styles from './onboarding.module.css';
import { passkeySettingsAvailable } from '../../ui/passkey/availability';
import { PasskeyOffer } from './PasskeyOffer';

const WORD_COUNTS = [12, 15, 18, 21, 24] as const;
type WordCount = (typeof WORD_COUNTS)[number];

const WORD_SET = new Set(english);

function isWordCount(value: number): value is WordCount {
  return WORD_COUNTS.some((count) => count === value);
}

type Step = 'words' | 'password' | 'scan' | 'passkey';

function walletLooksEmpty(home: {
  balances: Record<string, string | undefined>;
  collectiblesCount: number;
  wrongLaneCount: number;
  activity: readonly unknown[];
  dataGating: { state: string };
}): boolean {
  return home.dataGating.state === 'fresh' && home.collectiblesCount === 0 &&
    home.wrongLaneCount === 0 && home.activity.length === 0 &&
    Object.values(home.balances).every((value) => value === undefined || BigInt(value) === 0n);
}

export function RestoreFlow(props: {
  existingProfile?: boolean;
  defaultWalletName?: string;
  onDone: () => void;
  onBack: () => void;
}): ReactNode {
  const { t } = useI18n();
  const rpc = useRpc();
  const [step, setStep] = useState<Step>('words');

  const [count, setCount] = useState<WordCount>(12);
  const [words, setWords] = useState<string[]>(() => Array.from({ length: 12 }, () => ''));
  const [passphrase, setPassphrase] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [wordsHidden, setWordsHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const operationId = useRef(globalThis.crypto.randomUUID()).current;

  const [name, setName] = useState(props.defaultWalletName ?? 'Wallet 1');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [expectation, setExpectation] = useState<ActiveSessionExpectation | null>(null);
  const [emptyRestore, setEmptyRestore] = useState(false);
  const passwordStepReady = props.existingProfile
    ? password !== ''
    : checkPasswordPolicy(password).ok && confirm !== '' && password === confirm;

  if (step === 'passkey' && expectation !== null) {
    return <PasskeyOffer expectation={expectation} onDone={props.onDone} />;
  }

  function setCountAndResize(next: WordCount): void {
    setCount(next);
    setWords((prev) => Array.from({ length: next }, (_, i) => prev[i] ?? ''));
  }

  function normalized(): string {
    return words.map((w) => w.trim().toLowerCase().normalize('NFKD')).join(' ');
  }

  function submitWords(): void {
    setError(null);
    if (!validateMnemonic(normalized())) {
      setError(t('restore.invalidPhrase'));
      return;
    }
    setStep('password');
  }

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
      const restored = await rpc('vault.restore', {
        name: name.trim() || props.defaultWalletName || 'Wallet 1',
        password,
        mnemonic: normalized(),
        ...(passphrase !== '' ? { passphrase } : {}),
        operationId,
      });
      if (!restored.ok) {
        setError(t(errorMessageKey(restored.code)));
        return;
      }
      const unlocked = await rpc('vault.unlock', { vaultId: restored.result.vaultId, password });
      if (!unlocked.ok) {
        setError(t(errorMessageKey(unlocked.code)));
        return;
      }
      // Drop the phrase and password from UI state before leaving the flow.
      setWords(Array.from({ length: count }, () => ''));
      setPassphrase('');
      setShowPassphrase(false);
      setPassword('');
      setConfirm('');
      // §8.2: restore flows straight into the discovery scan (skippable — the
      // scan keeps running worker-side either way).
      setExpectation({
        expectedVaultId: restored.result.vaultId,
        expectedSessionId: unlocked.result.sessionId,
      });
      setStep('scan');
    } finally {
      setBusy(false);
    }
  }

  if (step === 'scan' && expectation !== null) {
    const inspectOutcome = async (kind: string): Promise<void> => {
      if (kind !== 'completed') return;
      const active = await rpc('account.active.get', { ...expectation });
      if (!active.ok) return;
      const home = await rpc('wallet.home', { accountId: active.result.accountId, ...expectation });
      if (home.ok) setEmptyRestore(walletLooksEmpty(home.result));
    };
    return (
      <div className={styles['form']}>
        <h1 className={styles['title']}>{t('scan.title')}</h1>
        <ScanProgress
          expectation={expectation}
          autoStart="initial"
          onSettled={(kind) => { void inspectOutcome(kind); }}
        />
        {emptyRestore ? (
          <section className={styles['warning']} role="status">
            <div>
              <strong>{t('scan.restoreEmpty.title')}</strong>
              <p>{t('scan.restoreEmpty.body')}</p>
              <p>{t('recovery.guidance.support')}</p>
            </div>
          </section>
        ) : null}
        <div className={styles['actions']}>
          <Button onClick={() => passkeySettingsAvailable() ? setStep('passkey') : props.onDone()}>
            {t('common.continue')}
          </Button>
        </div>
      </div>
    );
  }

  if (step === 'words') {
    return (
      <form
        className={styles['form']}
        onSubmit={(e) => {
          e.preventDefault();
          submitWords();
        }}
      >
        <h1 className={styles['title']}>{t('restore.title')}</h1>
        <div className={styles['form']} role="radiogroup" aria-label={t('restore.wordCount')}>
          <span className={styles['hint']}>{t('restore.wordCount')}</span>
          <div className={styles['wordRow']}>
            {WORD_COUNTS.map((c) => (
              <Button
                key={c}
                variant={c === count ? 'primary' : 'secondary'}
                role="radio"
                aria-checked={c === count}
                tabIndex={c === count ? 0 : -1}
                onClick={() => setCountAndResize(c)}
                onKeyDown={(event) => handleRadioKey(event, WORD_COUNTS, count, setCountAndResize)}
              >
                {t('restore.words', { count: c })}
              </Button>
            ))}
          </div>
        </div>
        <div className={styles['wordRow']}>
          {words.map((word, i) => {
            const trimmed = word.trim().toLowerCase();
            const invalid = trimmed !== '' && !WORD_SET.has(trimmed);
            return (
              <WordInput
                key={i}
                label={t('restore.wordN', { position: i + 1 })}
                value={word}
                masked={wordsHidden}
                error={invalid ? t('restore.invalidWord') : undefined}
                onChange={(e) => {
                  // Support pasting a whole space-separated phrase into word 1.
                  const parts = e.target.value.split(/\s+/u).filter((p) => p !== '');
                  if (parts.length > 1) {
                    if (i === 0 && isWordCount(parts.length)) {
                      setCount(parts.length);
                      setWords(parts);
                      setError(null);
                      return;
                    }
                    if (i + parts.length > words.length) {
                      setError(t('restore.invalidPhrase'));
                      return;
                    }
                    const next = [...words];
                    for (let j = 0; j < parts.length; j += 1) {
                      next[i + j] = parts[j] ?? '';
                    }
                    setWords(next);
                  } else {
                    const next = [...words];
                    next[i] = e.target.value;
                    setWords(next);
                  }
                }}
              />
            );
          })}
        </div>
        <Button variant="secondary" onClick={() => setWordsHidden((hidden) => !hidden)}>
          {t(wordsHidden ? 'restore.showWords' : 'restore.hideWords')}
        </Button>
        <details>
          <summary>{t('restore.passphrase.title')}</summary>
          <div className={styles['form']}>
            <p className={styles['hint']}>{t('restore.passphrase.body')}</p>
            <Field
              label={t('restore.passphrase.label')}
              type={showPassphrase ? 'text' : 'password'}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="off"
            />
            <label className={styles['hint']}>
              <input
                type="checkbox"
                checked={showPassphrase}
                onChange={(event) => setShowPassphrase(event.target.checked)}
              />{' '}
              {t(showPassphrase ? 'restore.passphrase.hide' : 'restore.passphrase.show')}
            </label>
          </div>
        </details>
        {error !== null ? (
          <p role="alert" className={styles['error']}>
            {error}
          </p>
        ) : null}
        <div className={styles['actions']}>
          <Button variant="secondary" onClick={props.onBack}>
            {t('common.back')}
          </Button>
          <Button type="submit" disabled={words.some((w) => w.trim() === '')}>
            {t('common.continue')}
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
        <Button variant="secondary" onClick={() => {
          setShowPassphrase(false);
          setStep('words');
        }} disabled={busy}>
          {t('common.back')}
        </Button>
        <Button type="submit" disabled={busy || !passwordStepReady}>
          {t('common.continue')}
        </Button>
      </div>
    </form>
  );
}
