import { useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../../ui/i18n';
import { useRpc } from '../../ui/hooks/use-rpc';
import { errorMessageKey } from '../../ui/errors';
import { Button } from '../../ui/components/Button';
import { WordInput } from '../../ui/components/WordInput';
import { pickPositions } from '../../ui/random';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import styles from './fullpage.module.css';
import type { BackupMetadataV1 } from '@drey/core/domain/vault/backup-metadata';

type Mode = 'overview' | 'check' | 'success' | 'full' | 'fullSuccess';
type TypedWords = [string, string, string];

const EMPTY_WORDS: TypedWords = ['', '', ''];

/**
 * Recovery care without seed reveal. The trusted worker compares three words;
 * this surface never receives the mnemonic and retains typed words only for the
 * current attempt.
 */
export function RecoverySettings(props: {
  expectation: ActiveSessionExpectation;
  onBack: () => void;
  onReveal: () => void;
}): ReactNode {
  const { t } = useI18n();
  const rpc = useRpc();
  const [mode, setMode] = useState<Mode>('overview');
  const [positions, setPositions] = useState<[number, number, number]>(() => pickPositions());
  const [typed, setTyped] = useState<TypedWords>(EMPTY_WORDS);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [metadata, setMetadata] = useState<BackupMetadataV1 | null>(null);
  const [fullPhrase, setFullPhrase] = useState('');
  const [fullPassphrase, setFullPassphrase] = useState('');
  const wordCount = metadata?.wordCount ?? 12;

  function clearAttempt(): void {
    setTyped(EMPTY_WORDS);
    setFullPhrase('');
    setFullPassphrase('');
    setError(null);
  }

  function openCheck(randomize = false): void {
    clearAttempt();
    if (randomize) setPositions(pickPositions(wordCount));
    setMode('check');
  }

  function returnToOverview(randomize = false): void {
    clearAttempt();
    if (randomize) setPositions(pickPositions(wordCount));
    setMode('overview');
  }

  function leave(action: () => void): void {
    clearAttempt();
    action();
  }

  async function submitCheck(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await rpc('vault.verifyBackup', {
        words: positions.map((index, i) => ({ index, word: typed[i]?.trim() ?? '' })),
        wordCount,
        ...props.expectation,
      });
      // Typed recovery words do not survive any completed worker response.
      setTyped(EMPTY_WORDS);
      if (!result.ok) {
        setError(t(errorMessageKey(result.code)));
        return;
      }
      if (!result.result.verified) {
        setError(t('recovery.check.failed'));
        return;
      }
      setMode('success');
      setMetadata((current) => current === null ? current : {
        ...current, usageGatePassed: true, lastSpotCheckAt: Date.now(),
      });
    } finally {
      setBusy(false);
    }
  }

  async function submitFullCheck(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const result = await rpc('vault.verifyFullRecovery', {
        mnemonic: fullPhrase.trim(),
        ...(fullPassphrase !== '' ? { passphrase: fullPassphrase } : {}),
        ...props.expectation,
      });
      setFullPhrase('');
      setFullPassphrase('');
      if (!result.ok) {
        setError(t(result.code === 'ERR_INVALID_PAYLOAD'
          ? 'recovery.full.failed'
          : errorMessageKey(result.code)));
        return;
      }
      if (!result.result.verified) {
        setError(t('recovery.full.failed'));
        return;
      }
      setMetadata((current) => current === null ? current : {
        ...current, lastFullRecoveryCheckAt: Date.now(),
      });
      setMode('fullSuccess');
    } finally {
      setBusy(false);
    }
  }

  // Defense in depth: typed words are dropped with every navigation path and
  // when this route unmounts because the wallet locks or the session changes.
  useEffect(() => {
    let current = true;
    void rpc('backup.status', props.expectation).then((result) => {
      if (!current || !result.ok || result.result.metadata === undefined) return;
      setMetadata(result.result.metadata);
      if (result.result.metadata.wordCount !== null) {
        setPositions(pickPositions(result.result.metadata.wordCount));
      }
    });
    return () => {
      current = false;
      setTyped(EMPTY_WORDS);
      setFullPhrase('');
      setFullPassphrase('');
    };
  }, [props.expectation, rpc]);

  if (mode === 'full') {
    return (
      <>
        <p className={styles['eyebrow']}>{t('recovery.eyebrow')}</p>
        <h1 className={styles['title']}>{t('recovery.full.title')}</h1>
        <section className={`${styles['section']} ${styles['recoveryCheck']}`}>
          <p className={styles['recoveryLead']}>{t('recovery.full.body')}</p>
          {metadata !== null && metadata.usesPassphrase !== false ? (
            <p className={styles['advisory']} role="note">{t('recovery.passphrase.warning')}</p>
          ) : null}
          <form onSubmit={(event) => { event.preventDefault(); void submitFullCheck(); }}>
            <label className={styles['rowLabel']} htmlFor="full-recovery-phrase">
              {t('recovery.full.words')}
            </label>
            <textarea
              id="full-recovery-phrase"
              className={styles['advancedTextarea']}
              rows={5}
              value={fullPhrase}
              onChange={(event) => setFullPhrase(event.target.value)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
            <WordInput
              label={t('recovery.full.passphrase')}
              masked
              value={fullPassphrase}
              onChange={(event) => setFullPassphrase(event.target.value)}
            />
            {error !== null ? <p role="alert" className={styles['error']}>{error}</p> : null}
            <div className={styles['row']}>
              <Button variant="secondary" disabled={busy} onClick={() => returnToOverview()}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={busy || fullPhrase.trim() === ''}>
                {t('recovery.full.submit')}
              </Button>
            </div>
          </form>
        </section>
      </>
    );
  }

  if (mode === 'check') {
    return (
      <>
        <p className={styles['eyebrow']}>{t('recovery.eyebrow')}</p>
        <h1 className={styles['title']}>{t('recovery.check.title')}</h1>
        <section className={`${styles['section']} ${styles['recoveryCheck']}`}>
          <p className={styles['recoveryLead']}>{t('recovery.check.body')}</p>
          <form
            className={styles['form']}
            onSubmit={(event) => {
              event.preventDefault();
              void submitCheck();
            }}
          >
            <div className={styles['recoveryWordRow']}>
              {positions.map((position, i) => (
                <WordInput
                  key={position}
                  label={t('onboarding.verify.wordN', { position: position + 1 })}
                  value={typed[i] ?? ''}
                  onChange={(event) => {
                    const next: TypedWords = [...typed];
                    next[i] = event.target.value;
                    setTyped(next);
                  }}
                />
              ))}
            </div>
            <p className={styles['rowLabel']}>{t('recovery.check.privacy')}</p>
            {error !== null ? <p role="alert" className={styles['error']}>{error}</p> : null}
            <div className={styles['row']}>
              <Button variant="secondary" disabled={busy} onClick={() => returnToOverview()}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={busy || typed.some((word) => word.trim() === '')}>
                {t('recovery.check.submit')}
              </Button>
            </div>
          </form>
        </section>
      </>
    );
  }

  if (mode === 'success') {
    return (
      <>
        <p className={styles['eyebrow']}>{t('recovery.eyebrow')}</p>
        <h1 className={styles['title']}>{t('recovery.title')}</h1>
        <section className={`${styles['section']} ${styles['recoverySuccess']}`}>
          <div className={styles['successMark']} aria-hidden="true">✓</div>
          <div>
            <h2 className={styles['sectionTitle']}>{t('recovery.check.success.title')}</h2>
            <p className={styles['recoveryLead']}>{t('recovery.check.success.body')}</p>
          </div>
          <div className={styles['row']}>
            <Button variant="secondary" onClick={() => openCheck(true)}>
              {t('recovery.check.again')}
            </Button>
            <Button onClick={() => returnToOverview(true)}>{t('recovery.check.done')}</Button>
          </div>
        </section>
      </>
    );
  }

  if (mode === 'fullSuccess') {
    return (
      <>
        <p className={styles['eyebrow']}>{t('recovery.eyebrow')}</p>
        <h1 className={styles['title']}>{t('recovery.title')}</h1>
        <section className={`${styles['section']} ${styles['recoverySuccess']}`}>
          <div className={styles['successMark']} aria-hidden="true">✓</div>
          <div>
            <h2 className={styles['sectionTitle']}>{t('recovery.full.success.title')}</h2>
            <p className={styles['recoveryLead']}>{t('recovery.full.success.body')}</p>
          </div>
          <div className={styles['row']}>
            <Button onClick={() => returnToOverview()}>{t('recovery.check.done')}</Button>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <div className={styles['row']}>
        <Button variant="ghost" onClick={() => leave(props.onBack)}>{t('common.back')}</Button>
      </div>
      <p className={styles['eyebrow']}>{t('recovery.eyebrow')}</p>
      <h1 className={styles['title']}>{t('recovery.title')}</h1>
      <section className={`${styles['section']} ${styles['recoveryHero']}`}>
        <div>
          <h2 className={styles['sectionTitle']}>{t('recovery.intro.title')}</h2>
          <p className={styles['recoveryLead']}>{t('recovery.intro.body', { wordCount })}</p>
        </div>
        <ul className={styles['recoveryList']}>
          <li>{t('recovery.guidance.offline')}</li>
          <li>{t('recovery.guidance.control', { wordCount })}</li>
          <li>{t('recovery.guidance.support')}</li>
        </ul>
        <div className={styles['recoveryPrimaryAction']}>
          <div>
            <h2 className={styles['sectionTitle']}>{t('recovery.check.title')}</h2>
            <p className={styles['rowLabel']}>{t('recovery.check.summary')}</p>
          </div>
          <Button onClick={() => openCheck()}>{t('recovery.check.start')}</Button>
        </div>
        <div className={styles['recoveryPrimaryAction']}>
          <div>
            <h2 className={styles['sectionTitle']}>{t('recovery.full.title')}</h2>
            <p className={styles['rowLabel']}>{t('recovery.full.summary')}</p>
          </div>
          <Button variant="secondary" onClick={() => { clearAttempt(); setMode('full'); }}>
            {t('recovery.full.start')}
          </Button>
        </div>
        {metadata !== null && metadata.usesPassphrase !== false ? (
          <p className={styles['advisory']} role="note">{t('recovery.passphrase.warning')}</p>
        ) : null}
        <details>
          <summary>{t('recovery.generation.title')}</summary>
          <p className={styles['rowLabel']}>
            {metadata?.origin === 'generated'
              ? t('recovery.generation.generated', {
                  wordCount: metadata.wordCount,
                  entropyBits: metadata.wordCount === 12 ? 128 : ((metadata.wordCount ?? 12) / 3) * 32,
                })
              : metadata?.origin === 'imported'
                ? t('recovery.generation.imported', { wordCount: metadata.wordCount })
                : t('recovery.generation.legacy')}
          </p>
          {metadata?.origin === 'generated' ? (
            <>
              <p className={styles['rowLabel']}>{t('recovery.platform.randomSource')}</p>
              <p className={styles['rowLabel']}>{t('recovery.generation.check')}</p>
            </>
          ) : null}
        </details>
      </section>

      <section className={`${styles['section']} ${styles['sensitiveAction']}`}>
        <div>
          <p className={styles['sensitiveLabel']}>{t('recovery.sensitive.label')}</p>
          <h2 className={styles['sectionTitle']}>{t('recovery.sensitive.title')}</h2>
          <p className={styles['rowLabel']}>{t('recovery.sensitive.body', { wordCount })}</p>
        </div>
        <Button variant="secondary" onClick={() => leave(props.onReveal)}>
          {t('recovery.sensitive.action')}
        </Button>
      </section>
    </>
  );
}
