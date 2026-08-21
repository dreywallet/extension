import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n, type Language, type MessageKey } from '../../ui/i18n';
import { ACCENT_PREFS } from '../../ui/accent';
import { useAccent } from '../../ui/UiRoot';
import { useRpc } from '../../ui/hooks/use-rpc';
import type { SessionView } from '../../ui/hooks/use-session';
import { errorMessageKey } from '../../ui/errors';
import { Button } from '../../ui/components/Button';
import { Field } from '../../ui/components/Field';
import { ScanProgress } from '../../ui/components/ScanProgress';
import { handleRadioKey } from '../../ui/radio-keyboard';
import { isWalletDataChangedEvent } from '@drey/core/messaging/events';
import { FULLPAGE_HASH } from './routes';
import { passkeySettingsAvailable } from '../../ui/passkey/availability';
import { vaultCoordinatorChannelEnabled } from '../../ui/vault/availability';
import { checkPasswordPolicy } from '@drey/core/domain/vault/password';
import { isCommonNewPassword } from '../../ui/password-guidance';
import styles from './fullpage.module.css';

const LANGS: { value: Language; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
];
const TIMEOUTS = [
  { ms: 3_600_000, key: 'settings.idleTimeout.1h' },
  { ms: 43_200_000, key: 'settings.idleTimeout.12h' },
  { ms: 86_400_000, key: 'settings.idleTimeout.24h' },
  { ms: 604_800_000, key: 'settings.idleTimeout.1w' },
] as const;
type IdleTimeoutMs = (typeof TIMEOUTS)[number]['ms'];
const TIMEOUT_VALUES: readonly IdleTimeoutMs[] = TIMEOUTS.map((entry) => entry.ms);

export function Settings(props: { session: SessionView }): ReactNode {
  const { t, lang, setLang } = useI18n();
  const { accent, setAccent } = useAccent();
  const rpc = useRpc();

  const [idleTimeoutMs, setIdleTimeoutMs] = useState<number | null>(null);
  const [highSecurityMode, setHighSecurityMode] = useState(false);
  const [advancedPsbtSigning, setAdvancedPsbtSigning] = useState(false);
  const [connectedSites, setConnectedSites] = useState<Array<{
    resourceId: string; origin: string; network: string; account: number; categories: string[];
  }>>([]);
  const expectedVaultId = props.session.expectation?.expectedVaultId ?? null;
  const expectedSessionId = props.session.expectation?.expectedSessionId ?? null;
  const selectedTimeout = TIMEOUT_VALUES.find((value) => value === idleTimeoutMs) ?? TIMEOUT_VALUES[0]!;
  const activeWallet = props.session.vaults.find(
    (wallet) => wallet.vaultId === props.session.activeVaultId,
  );
  const activeAccount = props.session.accountSummaries.find(
    (account) => account.accountId === props.session.activeAccountId,
  );
  const configGeneration = useRef(0);
  const sitesGeneration = useRef(0);
  const resumeScheduled = useRef(false);
  const loadConfig = useCallback(() => {
    const generation = ++configGeneration.current;
    void rpc('config.get', {}).then((r) => {
      if (generation === configGeneration.current && r.ok) {
        setIdleTimeoutMs(r.result.idleTimeoutMs);
        setHighSecurityMode(r.result.highSecurityMode);
        setAdvancedPsbtSigning(r.result.advancedPsbtSigning);
      }
    });
  }, [rpc]);
  const loadSites = useCallback(() => {
    const generation = ++sitesGeneration.current;
    if (expectedVaultId === null || expectedSessionId === null) {
      setConnectedSites([]);
      return;
    }
    void rpc('provider.sites.list', { expectedVaultId, expectedSessionId }).then((result) => {
      if (generation === sitesGeneration.current && result.ok) setConnectedSites(result.result.sites);
    });
  }, [expectedSessionId, expectedVaultId, rpc]);
  useEffect(() => {
    loadConfig();
    loadSites();
    return () => {
      configGeneration.current += 1;
      sitesGeneration.current += 1;
    };
  }, [loadConfig, loadSites]);
  useEffect(() => {
    const refreshAfterResume = (): void => {
      if (document.visibilityState === 'hidden' || resumeScheduled.current) return;
      resumeScheduled.current = true;
      queueMicrotask(() => {
        resumeScheduled.current = false;
        loadConfig();
        loadSites();
      });
    };
    const onMessage = (message: unknown): void => {
      if (!isWalletDataChangedEvent(message)) return;
      if (message.reason === 'config') loadConfig();
      if (message.reason === 'permissions') loadSites();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    window.addEventListener('focus', refreshAfterResume);
    document.addEventListener('visibilitychange', refreshAfterResume);
    return () => {
      resumeScheduled.current = false;
      chrome.runtime.onMessage.removeListener(onMessage);
      window.removeEventListener('focus', refreshAfterResume);
      document.removeEventListener('visibilitychange', refreshAfterResume);
    };
  }, [loadConfig, loadSites]);

  async function pickTimeout(ms: IdleTimeoutMs): Promise<void> {
    if (props.session.expectation === null) return;
    const r = await rpc('config.set', { idleTimeoutMs: ms, ...props.session.expectation });
    if (r.ok) setIdleTimeoutMs(r.result.idleTimeoutMs);
  }

  async function toggleAdvancedPsbt(enabled: boolean): Promise<void> {
    if (props.session.expectation === null) return;
    const result = await rpc('config.set', {
      advancedPsbtSigning: enabled,
      ...props.session.expectation,
    });
    if (result.ok) setAdvancedPsbtSigning(result.result.advancedPsbtSigning);
  }

  async function toggleHighSecurity(enabled: boolean): Promise<void> {
    if (props.session.expectation === null) return;
    const result = await rpc('config.set', {
      highSecurityMode: enabled,
      ...props.session.expectation,
    });
    if (result.ok) setHighSecurityMode(result.result.highSecurityMode);
  }

  async function revokeSite(resourceId: string): Promise<void> {
    if (props.session.expectation === null) return;
    const result = await rpc('provider.sites.revoke', { resourceId, ...props.session.expectation });
    if (result.ok && result.result.revoked) {
      setConnectedSites((sites) => sites.filter((site) => site.resourceId !== resourceId));
    }
  }

  // -- change password --------------------------------------------------------
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNew, setConfirmNew] = useState('');
  const [showChangePasswords, setShowChangePasswords] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwDone, setPwDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [rescanning, setRescanning] = useState(false);
  const passwordChangeReady = oldPassword !== '' &&
    checkPasswordPolicy(newPassword).ok &&
    confirmNew !== '' &&
    newPassword === confirmNew;

  async function submitChangePassword(): Promise<void> {
    setPwError(null);
    setPwDone(false);
    if (!checkPasswordPolicy(newPassword).ok) {
      setPwError(t('onboarding.password.tooShort'));
      return;
    }
    if (newPassword !== confirmNew) {
      setPwError(t('onboarding.password.mismatch'));
      return;
    }
    setBusy(true);
    try {
      const r = await rpc('vault.changePassword', { oldPassword, newPassword });
      if (!r.ok) {
        setPwError(t(errorMessageKey(r.code)));
        return;
      }
      setOldPassword('');
      setNewPassword('');
      setConfirmNew('');
      setPwDone(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles['settingsPage']}>
      <h1 className={styles['title']}>{t('settings.title')}</h1>

      <section className={`${styles['section']} ${styles['walletAccountsEntry']}`}>
        <div>
          <h2 className={styles['sectionTitle']}>{t('settings.walletAccounts.title')}</h2>
          <p className={styles['rowLabel']}>{t('settings.walletAccounts.summary')}</p>
        </div>
        <div className={styles['walletAccountsEntryAction']}>
          <strong>
            {activeWallet?.name ?? t('settings.vaults')}
            {' · '}
            {activeAccount?.name ?? t('account.number', { account: props.session.activeAccount + 1 })}
          </strong>
          <Button onClick={() => (window.location.hash = FULLPAGE_HASH.walletAccounts)}>
            {t('settings.walletAccounts.open')}
          </Button>
        </div>
      </section>

      <section className={styles['section']}>
        <h2 className={styles['sectionTitle']}>{t('settings.appearance')}</h2>
        <div className={styles['row']}>
          <span className={styles['rowLabel']}>{t('settings.accent')}</span>
          <div
            className={styles['accentPicker']}
            role="radiogroup"
            aria-label={t('settings.accent')}
          >
            {ACCENT_PREFS.map((option) => (
              <button
                key={option}
                type="button"
                className={styles['accentOption']}
                data-accent-option={option}
                role="radio"
                aria-checked={accent === option}
                tabIndex={accent === option ? 0 : -1}
                onClick={() => setAccent(option)}
                onKeyDown={(event) => handleRadioKey(event, ACCENT_PREFS, accent, setAccent)}
              >
                <span className={styles['accentSwatch']} aria-hidden="true">
                  {accent === option ? <span className={styles['accentCheck']}>✓</span> : null}
                </span>
                <span>{t(`settings.accent.${option}`)}</span>
              </button>
            ))}
          </div>
        </div>
        <div className={styles['row']}>
          <span className={styles['rowLabel']}>{t('settings.language')}</span>
          <div className={styles['segmented']} role="radiogroup" aria-label={t('settings.language')}>
            {LANGS.map((option) => (
              <Button
                key={option.value}
                variant={lang === option.value ? 'primary' : 'secondary'}
                role="radio"
                aria-checked={lang === option.value}
                tabIndex={lang === option.value ? 0 : -1}
                onClick={() => setLang(option.value)}
                onKeyDown={(event) =>
                  handleRadioKey(
                    event,
                    LANGS.map((entry) => entry.value),
                    lang,
                    setLang,
                  )
                }
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      </section>

      {props.session.capabilities.canRevealSeed ? (
        <section className={`${styles['section']} ${styles['recoverySettingsCard']}`}>
          <div>
            <h2 className={styles['sectionTitle']}>{t('settings.recovery.entry')}</h2>
            <p className={styles['rowLabel']}>{t('settings.recovery.summary')}</p>
          </div>
          <Button onClick={() => (window.location.hash = FULLPAGE_HASH.recovery)}>
            {t('settings.recovery.manage')}
          </Button>
        </section>
      ) : null}

      <section className={`${styles['section']} ${styles['recoverySettingsCard']}`}>
        <div>
          <h2 className={styles['sectionTitle']}>{t('communityVault.title')}</h2>
          <p className={styles['rowLabel']}>{t('communityVault.entry.summary')}</p>
        </div>
        <Button onClick={() => (window.location.hash = FULLPAGE_HASH.communityVault)}>
          {t('communityVault.entry.open')}
        </Button>
      </section>

      <section className={styles['section']}>
        <h2 className={styles['sectionTitle']}>{t('settings.contacts')}</h2>
        <div className={styles['row']}>
          <div>
            <p className={styles['rowLabel']}>{t('settings.contacts.summary')}</p>
          </div>
          <Button variant="secondary" onClick={() => (window.location.hash = FULLPAGE_HASH.addressBook)}>
            {t('settings.contacts')}
          </Button>
        </div>
      </section>

      <section className={styles['section']}>
        <h2 className={styles['sectionTitle']}>{t('settings.connectedSites')}</h2>
        <p><a href={FULLPAGE_HASH.siteBlocked}>{t('settings.connectedSites.blockedHelp')}</a></p>
        {connectedSites.length === 0
          ? (
              <div className={styles['emptyState']} role="status">
                <p className={styles['rowLabel']}>{t('settings.connectedSites.empty')}</p>
              </div>
            )
          : null}
        {connectedSites.map((site) => (
          <div key={site.resourceId} className={styles['vaultRow']}>
            <div>
              <strong>{site.origin}</strong>
              <p className={styles['rowLabel']}>
                {site.network === 'mainnet'
                  ? t('home.network.mainnet')
                  : site.network === 'regtest'
                    ? t('home.network.regtest')
                    : t('home.network.signet')}
                {' · '}{t('approval.accountNumber', { number: site.account + 1 })}
                {' · '}{site.categories.map((category) =>
                  t(`approval.category.${category}` as MessageKey)).join(', ')}
              </p>
            </div>
            <Button variant="danger" onClick={() => void revokeSite(site.resourceId)}>
              {t('settings.connectedSites.disconnect')}
            </Button>
          </div>
        ))}
      </section>

      <section className={styles['section']}>
        <h2 className={styles['sectionTitle']}>{t('settings.security')}</h2>
        <div className={styles['row']}>
          <label className={styles['rowLabel']} htmlFor="high-security-mode">
            {t('settings.highSecurity')}
          </label>
          <input
            id="high-security-mode"
            type="checkbox"
            checked={highSecurityMode}
            onChange={(event) => void toggleHighSecurity(event.target.checked)}
          />
        </div>
        <p className={styles['rowLabel']}>{t('settings.highSecurity.help')}</p>
        <div className={styles['row']}>
          <span className={styles['rowLabel']}>{t('settings.idleTimeout')}</span>
          <div className={styles['segmented']} role="radiogroup" aria-label={t('settings.idleTimeout')}>
            {TIMEOUTS.map((option) => (
              <Button
                key={option.ms}
                variant={idleTimeoutMs === option.ms ? 'primary' : 'secondary'}
                role="radio"
                aria-checked={idleTimeoutMs === option.ms}
                tabIndex={idleTimeoutMs === option.ms || (idleTimeoutMs === null && option === TIMEOUTS[0]) ? 0 : -1}
                onClick={() => void pickTimeout(option.ms)}
                onKeyDown={(event) =>
                  handleRadioKey(
                    event,
                    TIMEOUT_VALUES,
                    selectedTimeout,
                    (value) => void pickTimeout(value),
                  )
                }
              >
                {t(option.key)}
              </Button>
            ))}
          </div>
        </div>
        {passkeySettingsAvailable() ? (
          <div className={styles['row']}>
            <span className={styles['rowLabel']}>{t('settings.passkeys.entry')}</span>
            <Button
              variant="secondary"
              onClick={() => (window.location.hash = FULLPAGE_HASH.passkeys)}
            >
              {t('settings.passkeys.entry')}
            </Button>
          </div>
        ) : null}
        <div className={styles['row']}>
          <span className={styles['rowLabel']}>{t('nav.lock')}</span>
          <Button
            variant="secondary"
            onClick={() => {
              void rpc('vault.lock', {}).then(() => props.session.refresh());
            }}
          >
            {t('settings.lockNow')}
          </Button>
        </div>
      </section>

      <details className={styles['disclosureSection']}>
        <summary>
          <span>
            <strong>{t('settings.advanced')}</strong>
            <small>{t('settings.advanced.summary')}</small>
          </span>
        </summary>
        <div className={styles['disclosureContent']}>
          {vaultCoordinatorChannelEnabled() ? (
            <div className={styles['row']}>
              <span className={styles['rowLabel']}>{t('settings.vault.entry')}</span>
              <Button
                variant="secondary"
                onClick={() => (window.location.hash = FULLPAGE_HASH.vault)}
              >
                {t('settings.vault.entry')}
              </Button>
            </div>
          ) : null}
          {props.session.capabilities.canSignMessages ? (
            <div className={styles['row']}>
              <div>
                <p className={styles['rowLabel']}>{t('settings.messageSigning')}</p>
                <p className={styles['rowLabel']}>{t('settings.messageSigning.summary')}</p>
              </div>
              <Button
                variant="secondary"
                onClick={() => (window.location.hash = FULLPAGE_HASH.messageSigning)}
              >
                {t('settings.messageSigning')}
              </Button>
            </div>
          ) : null}
          <div className={styles['row']}>
            <label className={styles['rowLabel']} htmlFor="advanced-psbt-signing">
              {t('settings.advancedPsbt')}
            </label>
            <input
              id="advanced-psbt-signing"
              type="checkbox"
              checked={advancedPsbtSigning}
              onChange={(event) => void toggleAdvancedPsbt(event.target.checked)}
            />
          </div>
          <p className={styles['rowLabel']}>{t('settings.advancedPsbt.help')}</p>
        </div>
      </details>

      <details className={styles['disclosureSection']}>
        <summary>
          <span>
            <strong>{t('settings.changePassword')}</strong>
            <small>{t('settings.changePassword.summary')}</small>
          </span>
        </summary>
        <div className={styles['disclosureContent']}>
          <form
            className={styles['form']}
            onSubmit={(e) => {
              e.preventDefault();
              void submitChangePassword();
            }}
          >
          <Field
            label={t('settings.changePassword.old')}
            type={showChangePasswords ? 'text' : 'password'}
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
            autoComplete="current-password"
          />
          <Field
            label={t('settings.changePassword.new')}
            type={showChangePasswords ? 'text' : 'password'}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
          />
          <Field
            label={t('settings.changePassword.confirm')}
            type={showChangePasswords ? 'text' : 'password'}
            value={confirmNew}
            onChange={(e) => setConfirmNew(e.target.value)}
            autoComplete="new-password"
          />
          <label>
            <input
              type="checkbox"
              checked={showChangePasswords}
              onChange={(event) => setShowChangePasswords(event.target.checked)}
            />{' '}
            {t('onboarding.password.show')}
          </label>
          <div className={styles['formFeedback']} aria-live="polite">
            {pwError !== null ? (
              <p role="alert" className={styles['error']}>{pwError}</p>
            ) : pwDone ? (
              <p role="status" className={styles['success']}>
                {t('settings.changePassword.done')}
              </p>
            ) : confirmNew !== '' && newPassword !== confirmNew ? (
              <p role="status" className={styles['advisory']}>
                {t('onboarding.password.mismatch')}
              </p>
            ) : isCommonNewPassword(newPassword) ? (
              <p role="status" className={styles['advisory']}>
                {t('onboarding.password.common')}
              </p>
            ) : (
              <p className={styles['rowLabel']}>{t('settings.changePassword.hint')}</p>
            )}
          </div>
          <div className={styles['row']}>
            <span />
            <Button
              type="submit"
              disabled={
                busy || !passwordChangeReady || props.session.quarantinedVaultCount > 0
              }
            >
              {t('settings.changePassword')}
            </Button>
          </div>
          </form>
        </div>
      </details>

      <section className={styles['section']}>
        <h2 className={styles['sectionTitle']}>{t('scan.rescan')}</h2>
        <p className={styles['rowLabel']}>{t('scan.rescan.hint')}</p>
        {props.session.expectation !== null ? (
          rescanning ? (
            <ScanProgress expectation={props.session.expectation} autoStart="rescan" />
          ) : (
            <Button variant="secondary" onClick={() => setRescanning(true)}>
              {t('scan.rescan')}
            </Button>
          )
        ) : null}
      </section>

      {/* §18.5 MUST: the privacy policy and onboarding disclose that the
          hosted gateway can correlate queried scripts by connection. Kept
          reachable after onboarding so it is not a one-time flash. */}
      <details className={styles['disclosureSection']}>
        <summary>
          <span>
            <strong>{t('privacy.gateway.title')}</strong>
            <small>{t('privacy.gateway.settingsSummary')}</small>
          </span>
        </summary>
        <div className={styles['disclosureContent']}>
          <p className={styles['rowLabel']}>{t('privacy.gateway.body')}</p>
          <p className={styles['rowLabel']}>{t('privacy.gateway.correlation')}</p>
        </div>
      </details>
    </div>
  );
}
