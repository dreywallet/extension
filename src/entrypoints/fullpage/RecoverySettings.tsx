import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useI18n, type MessageKey } from '../../ui/i18n';
import { useRpc } from '../../ui/hooks/use-rpc';
import { errorMessageKey } from '../../ui/errors';
import { Button } from '../../ui/components/Button';
import { WordInput } from '../../ui/components/WordInput';
import { pickPositions } from '../../ui/random';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import styles from './fullpage.module.css';
import type { BackupMetadataV1 } from '@drey/core/domain/vault/backup-metadata';
import { vaultCoordinatorChannelEnabled } from '../../ui/vault/availability';
import {
  presentExtensionRecoveryCenter,
  type ExtensionRecoveryCenterEvidence,
  type RecoveryCenterActionId,
  type RecoveryPresentationItem,
} from './recovery-center-presentation';

type Mode = 'overview' | 'check' | 'success' | 'full' | 'fullSuccess';
type TypedWords = [string, string, string];

const EMPTY_WORDS: TypedWords = ['', '', ''];

const STATE_KEYS = {
  ready: 'recovery.overview.state.ready',
  action_needed: 'recovery.overview.state.actionNeeded',
  not_checked: 'recovery.overview.state.notChecked',
  not_applicable: 'recovery.overview.state.notApplicable',
} as const satisfies Record<RecoveryPresentationItem['state'], MessageKey>;

const ACTION_KEYS: Record<RecoveryCenterActionId, MessageKey> = {
  'repair-vault': 'recovery.overview.action.resolveVault',
  'continue-recovery-key': 'recovery.overview.action.finishRecoveryKey',
  'save-recovery-kit': 'recovery.overview.action.saveRecoveryKit',
  'verify-vault-backup': 'recovery.overview.action.checkRecoveryKey',
  'verify-spending-backup': 'recovery.overview.action.checkSpendingBackup',
  'test-full-recovery': 'recovery.overview.action.fullRecoveryTest',
  'spot-check': 'recovery.overview.action.spotCheck',
  'setup-vault': 'recovery.overview.action.setUpVault',
  'open-vault': 'recovery.overview.action.openVault',
};

/**
 * Recovery care without seed reveal. The trusted worker compares three words;
 * this surface never receives the mnemonic and retains typed words only for the
 * current attempt.
 */
export function RecoverySettings(props: {
  expectation: ActiveSessionExpectation;
  onBack: () => void;
  onReveal: () => void;
  onVault: () => void;
}): ReactNode {
  const { t, lang } = useI18n();
  const rpc = useRpc();
  const [mode, setMode] = useState<Mode>('overview');
  const [positions, setPositions] = useState<[number, number, number]>(() => pickPositions());
  const [typed, setTyped] = useState<TypedWords>(EMPTY_WORDS);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [metadata, setMetadata] = useState<BackupMetadataV1 | null>(null);
  const [fullPhrase, setFullPhrase] = useState('');
  const [fullPassphrase, setFullPassphrase] = useState('');
  const [evidence, setEvidence] = useState<ExtensionRecoveryCenterEvidence | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [partialFailure, setPartialFailure] = useState(false);
  const loadGeneration = useRef(0);
  const loadInFlight = useRef<Promise<boolean> | null>(null);
  const hasPresentedEvidence = useRef(false);
  const resumeScheduled = useRef(false);
  const vaultCapability = vaultCoordinatorChannelEnabled();
  const wordCount = metadata?.wordCount ?? 12;
  const expectedVaultId = props.expectation.expectedVaultId;
  const expectedSessionId = props.expectation.expectedSessionId;

  const loadEvidence = useCallback((supersede = false): Promise<boolean> => {
    if (!supersede && loadInFlight.current !== null) return loadInFlight.current;
    const generation = ++loadGeneration.current;
    if (!hasPresentedEvidence.current) setLoadState('loading');
    const expectation = { expectedVaultId, expectedSessionId };
    const run = Promise.all([
      rpc('backup.status', expectation),
      vaultCapability
        ? rpc('vaultCoordinator.recoveryCReadiness', expectation)
        : Promise.resolve(null),
    ]).then(([spending, vault]) => {
      if (generation !== loadGeneration.current) return false;
      const vaultReadSucceeded = !vaultCapability || (vault !== null && vault.ok);
      const anyReadSucceeded = spending.ok || (vaultCapability && vault !== null && vault.ok);
      if (!anyReadSucceeded) {
        setMetadata(null);
        setPartialFailure(hasPresentedEvidence.current);
        if (hasPresentedEvidence.current) {
          setEvidence({
            vaultCapability,
            now: Date.now(),
            spending: { state: 'unknown' },
            vault: { state: 'unknown' },
          });
          setLoadState('ready');
        } else {
          setEvidence(null);
          setLoadState('error');
        }
        return false;
      }
      const nextMetadata = spending.ok ? spending.result.metadata ?? null : null;
      setMetadata(nextMetadata);
      if (nextMetadata?.wordCount !== null && nextMetadata?.wordCount !== undefined) {
        setPositions(pickPositions(nextMetadata.wordCount));
      }
      setEvidence({
        vaultCapability,
        now: Date.now(),
        spending: spending.ok ? {
          state: 'known', backupVerified: spending.result.backupVerified, metadata: nextMetadata,
        } : { state: 'unknown' },
        vault: vaultCapability && vault !== null && vault.ok
          ? {
              state: 'known',
              available: true,
              localRole: vault.result.localRole,
              policy: vault.result.policyState === 'usable' ? 'present' : vault.result.policyState,
              phone: vault.result.phoneSignerPaired ? 'paired' :
                vault.result.policyState === 'usable' ? 'not_paired' : 'unknown',
              recoveryKey: vault.result.localRole === 'absent' ? null : {
                state: vault.result.state,
                setupComplete: vault.result.setupComplete,
                kitExported: vault.result.kitExported,
                backupCheckComplete: vault.result.backupCheckComplete,
                ready: vault.result.ready,
              },
              independentExit: vault.result.standaloneRecoveryPackageAvailable
                ? 'available'
                : 'unavailable',
            }
          : { state: 'unknown' },
      });
      hasPresentedEvidence.current = true;
      setPartialFailure(!spending.ok || !vaultReadSucceeded);
      setLoadState('ready');
      return spending.ok;
    });
    loadInFlight.current = run;
    void run.finally(() => {
      if (loadInFlight.current === run) loadInFlight.current = null;
    });
    return run;
  }, [expectedSessionId, expectedVaultId, rpc, vaultCapability]);

  const clearAttempt = useCallback((): void => {
    setTyped(EMPTY_WORDS);
    setFullPhrase('');
    setFullPassphrase('');
    setError(null);
  }, []);

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
      if (!await loadEvidence(true)) {
        setError(t('recovery.overview.failure.body'));
        return;
      }
      setMode('success');
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
      if (!await loadEvidence(true)) {
        setError(t('recovery.overview.failure.body'));
        return;
      }
      setMode('fullSuccess');
    } finally {
      setBusy(false);
    }
  }

  // One bounded local read per source on mount and foreground resume. The
  // generation token prevents a previous session or rapid retry from painting
  // over current evidence.
  useEffect(() => {
    hasPresentedEvidence.current = false;
    loadInFlight.current = null;
    setEvidence(null);
    setMetadata(null);
    setPartialFailure(false);
    setLoadState('loading');
    void loadEvidence();
    return () => {
      loadGeneration.current += 1;
      loadInFlight.current = null;
      setTyped(EMPTY_WORDS);
      setFullPhrase('');
      setFullPassphrase('');
    };
  }, [loadEvidence]);

  useEffect(() => {
    const refreshAfterResume = (): void => {
      if (document.visibilityState === 'hidden') {
        clearAttempt();
        setMode('overview');
        return;
      }
      if (resumeScheduled.current) return;
      resumeScheduled.current = true;
      queueMicrotask(() => {
        resumeScheduled.current = false;
        void loadEvidence();
      });
    };
    window.addEventListener('focus', refreshAfterResume);
    document.addEventListener('visibilitychange', refreshAfterResume);
    return () => {
      resumeScheduled.current = false;
      window.removeEventListener('focus', refreshAfterResume);
      document.removeEventListener('visibilitychange', refreshAfterResume);
    };
  }, [clearAttempt, loadEvidence]);

  const presentation = useMemo(
    () => evidence === null ? null : presentExtensionRecoveryCenter(evidence),
    [evidence],
  );

  function valueFor(item: RecoveryPresentationItem): string {
    if (item.verifiedAt !== undefined) {
      const date = new Intl.DateTimeFormat(lang, { dateStyle: 'medium' }).format(item.verifiedAt);
      return t(item.id === 'spending-full-recovery'
        ? 'recovery.overview.date.tested'
        : 'recovery.overview.date.checked', { date });
    }
    if (item.id === 'spending-spot-check') return t('recovery.overview.date.notChecked');
    if (item.id === 'spending-full-recovery') return t('recovery.overview.date.notTested');
    return t(item.valueKey);
  }

  function runAction(action: RecoveryCenterActionId): void {
    if (action === 'verify-spending-backup' || action === 'spot-check') {
      openCheck(action === 'spot-check');
      return;
    }
    if (action === 'test-full-recovery') {
      clearAttempt();
      setMode('full');
      return;
    }
    leave(props.onVault);
  }

  function statusList(items: readonly RecoveryPresentationItem[]): ReactNode {
    return (
      <ul className={styles['recoveryStatusList']}>
        {items.map((item) => {
          const state = t(STATE_KEYS[item.state]);
          const title = t(item.labelKey);
          const detail = valueFor(item);
          return (
            <li
              key={item.id}
              className={styles['recoveryStatusItem']}
              data-state={item.state}
              aria-label={t('recovery.overview.state.accessible', { state, item: title, detail })}
            >
              <span className={styles['recoveryStatusIcon']} aria-hidden="true">
                {item.state === 'ready' ? '✓' : item.state === 'action_needed' ? '!' : '—'}
              </span>
              <span className={styles['recoveryStatusCopy']}>
                <strong>{title}</strong>
                <span>{detail}</span>
              </span>
              <span className={styles['recoveryStatusState']}>{state}</span>
            </li>
          );
        })}
      </ul>
    );
  }

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
      {loadState === 'error' ? (
        <section className={`${styles['section']} ${styles['recoveryLoadError']}`} role="alert">
          <div>
            <h2 className={styles['sectionTitle']}>{t('recovery.overview.failure.title')}</h2>
            <p className={styles['recoveryLead']}>{t('recovery.overview.failure.body')}</p>
          </div>
          <Button onClick={() => { void loadEvidence(); }}>
            {t('recovery.overview.failure.retry')}
          </Button>
        </section>
      ) : loadState === 'loading' || presentation === null ? (
        <section className={styles['section']} aria-busy="true">
          <p className={styles['recoveryLead']}>{t('common.loading')}</p>
        </section>
      ) : (
        <>
          {partialFailure ? (
            <section className={`${styles['section']} ${styles['recoveryLoadError']}`} role="alert">
              <div>
                <h2 className={styles['sectionTitle']}>{t('recovery.overview.failure.title')}</h2>
                <p className={styles['recoveryLead']}>{t('recovery.overview.failure.body')}</p>
              </div>
              <Button onClick={() => { void loadEvidence(); }}>
                {t('recovery.overview.failure.retry')}
              </Button>
            </section>
          ) : null}
          <section className={`${styles['section']} ${styles['recoveryOverviewSection']}`}
            aria-labelledby="spending-recovery-heading">
            <div>
              <h2 id="spending-recovery-heading" className={styles['sectionTitle']}>
                {t('recovery.overview.spending.title')}
              </h2>
              <p className={styles['recoveryLead']}>{t('recovery.overview.spending.body')}</p>
              {presentation.spendingWordCount !== null ? (
                <p className={styles['recoveryPhraseLength']}>
                  <span>{t('recovery.overview.spending.phraseLength')}</span>
                  <strong>{t('recovery.overview.spending.wordCount', {
                    wordCount: presentation.spendingWordCount,
                  })}</strong>
                </p>
              ) : null}
            </div>
            {statusList(presentation.items.slice(0, 3))}
            {metadata !== null && metadata.usesPassphrase !== false ? (
              <p className={styles['advisory']} role="note">{t('recovery.passphrase.warning')}</p>
            ) : null}
            {evidence?.spending.state === 'known' ? (
              <details className={styles['recoveryTechnical']}>
                <summary>{t('recovery.generation.title')}</summary>
                <p className={styles['rowLabel']}>
                  {metadata?.origin === 'generated'
                    ? t('recovery.generation.generated', {
                        wordCount: metadata.wordCount,
                        entropyBits: metadata.wordCount === 12
                          ? 128
                          : ((metadata.wordCount ?? 12) / 3) * 32,
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
            ) : null}
          </section>

          {vaultCapability ? (
            <section className={`${styles['section']} ${styles['recoveryOverviewSection']}`}
              aria-labelledby="vault-protection-heading">
              <div>
                <h2 id="vault-protection-heading" className={styles['sectionTitle']}>
                  {t('recovery.overview.vault.title')}
                </h2>
                <p className={styles['recoveryLead']}>{t('recovery.overview.vault.body')}</p>
              </div>
              {presentation.vaultNotSetUp ? (
                <p className={styles['rowLabel']}>{t('recovery.overview.vault.notSetUp')}</p>
              ) : (
                <>
                  {statusList(presentation.items.slice(3).filter((item) =>
                    item.state !== 'not_applicable'))}
                  <details className={styles['recoveryTechnical']}>
                    <summary>{t('recovery.overview.technical.show')}</summary>
                    <p className={styles['rowLabel']}>{t('recovery.overview.technical.body')}</p>
                    <Button variant="ghost" onClick={() => leave(props.onVault)}>
                      {t('recovery.overview.action.openVault')}
                    </Button>
                  </details>
                </>
              )}
            </section>
          ) : null}

          {presentation.primaryActionId !== null ? (
            <section className={`${styles['section']} ${styles['recoveryNextStep']}`}
              aria-labelledby="recovery-next-step-heading">
              <div>
                <p className={styles['eyebrow']}>{t('recovery.overview.nextStep')}</p>
                <h2 id="recovery-next-step-heading" className={styles['sectionTitle']}>
                  {t(ACTION_KEYS[presentation.primaryActionId])}
                </h2>
              </div>
              <Button onClick={() => runAction(presentation.primaryActionId!)}>
                {t(ACTION_KEYS[presentation.primaryActionId])}
              </Button>
            </section>
          ) : null}
        </>
      )}

      {loadState === 'ready' && metadata !== null ? (
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
      ) : null}
    </>
  );
}
