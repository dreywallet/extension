import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
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

/**
 * One Settings entry: title and a one-line summary on the left, a chevron on
 * the right, and the whole row is the control. Every page-opening entry looks
 * and behaves the same. The accessible name is "Open <title>" unless the
 * caller supplies its established label.
 */
function SettingRow(props: {
  title: string;
  summary?: string | undefined;
  onOpen: () => void;
  label?: string;
}): ReactNode {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className={styles['settingRow']}>
      <div className={styles['settingText']}>
        <h3 id={`${id}-title`} className={styles['settingRowTitle']}>{props.title}</h3>
        {props.summary !== undefined
          ? <p className={styles['rowLabel']}>{props.summary}</p>
          : null}
      </div>
      <button
        type="button"
        className={styles['settingRowButton']}
        aria-label={props.label ?? `${t('common.open')} ${props.title}`}
        onClick={props.onOpen}
      >
        <span aria-hidden="true">›</span>
      </button>
    </div>
  );
}

/** A labelled group of settings rows. */
function SettingsGroup(props: { title: string; children: ReactNode }): ReactNode {
  const id = useId();
  return (
    <section className={styles['settingsGroup']} aria-labelledby={id}>
      <h2 id={id} className={styles['settingsGroupTitle']}>{props.title}</h2>
      <div className={styles['settingsCard']}>{props.children}</div>
    </section>
  );
}

export function Settings(props: { session: SessionView }): ReactNode {
  const { t, lang, setLang } = useI18n();
  const { accent, setAccent } = useAccent();
  const rpc = useRpc();

  const [idleTimeoutMs, setIdleTimeoutMs] = useState<number | null>(null);
  const [highSecurityMode, setHighSecurityMode] = useState(false);
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

  const changePasswordForm = (
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
  );

  // Most important first: the wallet and its backup, security, the people
  // and sites it talks to, then how it looks. Rarely needed tools sit last,
  // collapsed.
  return (
    <div className={styles['settingsPage']}>
      <h1 className={styles['title']}>{t('settings.title')}</h1>

      <SettingsGroup title={t('settings.group.wallet')}>
        <SettingRow
          title={t('settings.walletAccounts.title')}
          summary={`${activeWallet?.name ?? t('settings.vaults')} · ${
            activeAccount?.name ?? t('account.number', { account: props.session.activeAccount + 1 })}`}
          label={t('settings.walletAccounts.open')}
          onOpen={() => (window.location.hash = FULLPAGE_HASH.walletAccounts)}
        />
        {props.session.capabilities.canRevealSeed ? (
          <SettingRow
            title={t('settings.recovery.entry')}
            summary={t('settings.recovery.summary')}
            label={t('settings.recovery.manage')}
            onOpen={() => (window.location.hash = FULLPAGE_HASH.recovery)}
          />
        ) : null}
      </SettingsGroup>

      <SettingsGroup title={t('settings.security')}>
        <div className={styles['settingRow']}>
          <div className={styles['settingText']}>
            <label className={styles['settingRowTitle']} htmlFor="high-security-mode">
              {t('settings.highSecurity')}
            </label>
            <p className={styles['rowLabel']}>{t('settings.highSecurity.help')}</p>
          </div>
          <input
            id="high-security-mode"
            className={styles['switch']}
            type="checkbox"
            checked={highSecurityMode}
            onChange={(event) => void toggleHighSecurity(event.target.checked)}
          />
        </div>
        <div className={`${styles['settingRow']} ${styles['settingRowWrap']}`}>
          <div className={styles['settingText']}>
            <span className={styles['settingRowTitle']}>{t('settings.idleTimeout')}</span>
          </div>
          <div className={styles['segmented']} role="radiogroup" aria-label={t('settings.idleTimeout')}>
            {TIMEOUTS.map((option) => (
              <Button
                key={option.ms}
                variant={idleTimeoutMs === option.ms ? 'primary' : 'secondary'}
                size="compact"
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
          <SettingRow
            title={t('settings.passkeys.entry')}
            summary={t('passkey.settings.entrySummary')}
            onOpen={() => (window.location.hash = FULLPAGE_HASH.passkeys)}
          />
        ) : null}
        <details className={styles['settingDisclosure']}>
          <summary>
            <span className={styles['settingText']}>
              <strong className={styles['settingRowTitle']}>{t('settings.changePassword')}</strong>
              <small className={styles['rowLabel']}>{t('settings.changePassword.summary')}</small>
            </span>
          </summary>
          <div className={styles['settingDisclosureBody']}>{changePasswordForm}</div>
        </details>
        <div className={styles['settingRow']}>
          <div className={styles['settingText']}>
            <span className={styles['settingRowTitle']}>{t('nav.lock')}</span>
            <p className={styles['rowLabel']}>{t('settings.lock.summary')}</p>
          </div>
          <Button
            variant="secondary"
            size="compact"
            onClick={() => {
              void rpc('vault.lock', {}).then(() => props.session.refresh());
            }}
          >
            {t('settings.lockNow')}
          </Button>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('settings.group.contacts')}>
        <SettingRow
          title={t('settings.contacts')}
          summary={t('settings.contacts.summary')}
          onOpen={() => (window.location.hash = FULLPAGE_HASH.addressBook)}
        />
        <div className={styles['settingBlock']}>
          <h3 className={styles['settingRowTitle']}>{t('settings.connectedSites')}</h3>
          {connectedSites.length === 0
            ? <p className={styles['rowLabel']} role="status">{t('settings.connectedSites.empty')}</p>
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
              <Button variant="danger" size="compact" onClick={() => void revokeSite(site.resourceId)}>
                {t('settings.connectedSites.disconnect')}
              </Button>
            </div>
          ))}
          <p className={styles['rowLabel']}>
            <a href={FULLPAGE_HASH.siteBlocked}>{t('settings.connectedSites.blockedHelp')}</a>
          </p>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('settings.appearance')}>
        <div className={`${styles['settingRow']} ${styles['settingRowWrap']}`}>
          <div className={styles['settingText']}>
            <span className={styles['settingRowTitle']}>{t('settings.accent')}</span>
          </div>
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
        <div className={`${styles['settingRow']} ${styles['settingRowWrap']}`}>
          <div className={styles['settingText']}>
            <span className={styles['settingRowTitle']}>{t('settings.language')}</span>
          </div>
          <div className={styles['segmented']} role="radiogroup" aria-label={t('settings.language')}>
            {LANGS.map((option) => (
              <Button
                key={option.value}
                variant={lang === option.value ? 'primary' : 'secondary'}
                size="compact"
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
      </SettingsGroup>

      <details className={styles['disclosureSection']}>
        <summary>
          <span>
            <strong>{t('settings.advanced')}</strong>
            <small>{t('settings.advanced.summary')}</small>
          </span>
        </summary>
        <div className={styles['settingsCard']}>
          <div className={`${styles['settingRow']} ${styles['settingRowWrap']}`}>
            <div className={styles['settingText']}>
              <h3 className={styles['settingRowTitle']}>{t('scan.rescan')}</h3>
              <p className={styles['rowLabel']}>{t('scan.rescan.hint')}</p>
            </div>
            {props.session.expectation !== null && !rescanning ? (
              <Button variant="secondary" size="compact" onClick={() => setRescanning(true)}>
                {t('scan.rescan')}
              </Button>
            ) : null}
          </div>
          {props.session.expectation !== null && rescanning ? (
            <div className={styles['settingBlock']}>
              <ScanProgress expectation={props.session.expectation} autoStart="rescan" />
            </div>
          ) : null}
          <SettingRow
            title={t('communityVault.title')}
            summary={t('communityVault.entry.summary')}
            onOpen={() => (window.location.hash = FULLPAGE_HASH.communityVault)}
          />
          {vaultCoordinatorChannelEnabled() ? (
            <SettingRow
              title={t('settings.vault.entry')}
              summary={t('vault.settings.entrySummary')}
              onOpen={() => (window.location.hash = FULLPAGE_HASH.vault)}
            />
          ) : null}
          {props.session.capabilities.canSignMessages ? (
            <SettingRow
              title={t('settings.messageSigning')}
              summary={t('settings.messageSigning.summary')}
              onOpen={() => (window.location.hash = FULLPAGE_HASH.messageSigning)}
            />
          ) : null}
        </div>
      </details>

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
