import { useState, type ReactNode } from 'react';
import { useI18n } from '../../ui/i18n';
import { useRpc } from '../../ui/hooks/use-rpc';
import type { SessionView } from '../../ui/hooks/use-session';
import { errorMessageKey } from '../../ui/errors';
import { Button } from '../../ui/components/Button';
import { Field } from '../../ui/components/Field';
import { AccountSelector } from '../../ui/components/AccountSelector';
import styles from './fullpage.module.css';

export function WalletAccountSettings(props: {
  session: SessionView;
  onBack: () => void;
  onManageAccounts: () => void;
}): ReactNode {
  const { t } = useI18n();
  const rpc = useRpc();
  const [switchTarget, setSwitchTarget] = useState<string | null>(null);
  const [switchPassword, setSwitchPassword] = useState('');
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);
  const [removePassword, setRemovePassword] = useState('');
  const [removeBackedUp, setRemoveBackedUp] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const activeWallet = props.session.vaults.find(
    (wallet) => wallet.vaultId === props.session.activeVaultId,
  );

  async function submitSwitch(): Promise<void> {
    if (switchTarget === null) return;
    setSwitchError(null);
    setBusy(true);
    try {
      const result = await rpc('vault.switch', {
        vaultId: switchTarget,
        password: switchPassword,
      });
      if (!result.ok) {
        setSwitchError(t(errorMessageKey(result.code)));
        return;
      }
      setSwitchTarget(null);
      setSwitchPassword('');
      props.session.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function submitRemove(): Promise<void> {
    if (removeTarget === null || props.session.expectation === null || !removeBackedUp) return;
    setRemoveError(null);
    setBusy(true);
    try {
      const result = await rpc('vault.remove', {
        targetVaultId: removeTarget,
        password: removePassword,
        ...props.session.expectation,
      });
      if (!result.ok) {
        setRemoveError(t(errorMessageKey(result.code)));
        return;
      }
      setRemoveTarget(null);
      setRemovePassword('');
      setRemoveBackedUp(false);
      props.session.refresh();
    } finally {
      setBusy(false);
    }
  }

  const removeWalletName = props.session.vaults.find(
    (wallet) => wallet.vaultId === removeTarget,
  )?.name ?? '';

  return (
    <>
      <Button variant="ghost" onClick={props.onBack}>{t('common.back')}</Button>
      <div className={styles['walletAccountsHeader']}>
        <h1 className={styles['title']}>{t('settings.walletAccounts.title')}</h1>
        <p className={styles['rowLabel']}>{t('settings.walletAccounts.summary')}</p>
      </div>

      <section className={`${styles['section']} ${styles['activeWalletCard']}`}>
        <div className={styles['walletIdentity']}>
          <div>
            <p className={styles['walletIdentityLabel']}>
              {t('settings.walletAccounts.currentWallet')}
            </p>
            <h2 className={styles['sectionTitle']}>
              {activeWallet?.name ?? t('settings.vaults')}
            </h2>
          </div>
          <span className={styles['badge']}>{t('settings.vaults.active')}</span>
        </div>
        <div className={styles['accountIdentity']}>
          <div>
            <h3>{t('settings.walletAccounts.accountsIn', {
              wallet: activeWallet?.name ?? t('settings.vaults'),
            })}</h3>
            <p className={styles['rowLabel']}>{t('account.sameRecoveryPhrase')}</p>
          </div>
          <AccountSelector session={props.session} showManageAction={false} />
        </div>
        <div className={styles['walletAccountActions']}>
          <Button onClick={props.onManageAccounts}>{t('account.manage')}</Button>
        </div>
        <details className={styles['inlineDetails']}>
          <summary>{t('account.model.title')}</summary>
          <p className={styles['rowLabel']}>{t('account.model.body')}</p>
          <p className={styles['rowLabel']}>{t('account.model.migration')}</p>
        </details>
      </section>

      <section className={styles['section']}>
        <h2 className={styles['sectionTitle']}>{t('settings.vaults')}</h2>
        {props.session.vaults.map((wallet) => (
          <div
            key={wallet.vaultId}
            className={`${styles['vaultRow']} ${styles['walletManagementRow']}`}
          >
            <span>{wallet.name}</span>
            <div className={styles['walletRowActions']}>
              {wallet.vaultId === props.session.activeVaultId ? (
                <span className={styles['badge']}>{t('settings.vaults.active')}</span>
              ) : (
                <Button variant="secondary" onClick={() => setSwitchTarget(wallet.vaultId)}>
                  {t('settings.vaults.switch')}
                </Button>
              )}
              <Button variant="secondary" onClick={() => {
                setRemoveTarget(wallet.vaultId);
                setRemovePassword('');
                setRemoveBackedUp(false);
                setRemoveError(null);
              }}>
                {t('settings.vaults.remove')}
              </Button>
            </div>
          </div>
        ))}
        <Button
          variant="secondary"
          onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('/onboarding.html') })}
        >
          {t('settings.vaults.add')}
        </Button>
        {switchTarget !== null ? (
          <form
            className={styles['form']}
            onSubmit={(event) => {
              event.preventDefault();
              void submitSwitch();
            }}
          >
            <h3>{t('settings.vaults.switchTitle')}</h3>
            <p className={styles['rowLabel']}>{t('settings.vaults.switchBody')}</p>
            <Field
              label={t('unlock.password')}
              type="password"
              value={switchPassword}
              onChange={(event) => setSwitchPassword(event.target.value)}
              autoComplete="current-password"
            />
            {switchError !== null ? (
              <p role="alert" className={styles['error']}>{switchError}</p>
            ) : null}
            <div className={styles['row']}>
              <Button variant="secondary" onClick={() => {
                setSwitchTarget(null);
                setSwitchPassword('');
                setSwitchError(null);
              }}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={busy || switchPassword === ''}>
                {t('settings.vaults.switchTitle')}
              </Button>
            </div>
          </form>
        ) : null}
        {removeTarget !== null ? (
          <form
            className={styles['form']}
            onSubmit={(event) => {
              event.preventDefault();
              void submitRemove();
            }}
          >
            <h3>{t('settings.vaults.removeTitle', { wallet: removeWalletName })}</h3>
            <p className={styles['rowLabel']}>{t('settings.vaults.removeBody')}</p>
            <Field
              label={t('unlock.password')}
              type="password"
              value={removePassword}
              onChange={(event) => setRemovePassword(event.target.value)}
              autoComplete="current-password"
            />
            <label className={styles['rowLabel']}>
              <input
                type="checkbox"
                checked={removeBackedUp}
                onChange={(event) => setRemoveBackedUp(event.target.checked)}
              />{' '}
              {t('settings.vaults.removeBackup')}
            </label>
            {removeError !== null ? (
              <p role="alert" className={styles['error']}>{removeError}</p>
            ) : null}
            <div className={styles['row']}>
              <Button variant="secondary" onClick={() => setRemoveTarget(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                disabled={busy || removePassword === '' || !removeBackedUp}
              >
                {t('settings.vaults.removeNamed', { wallet: removeWalletName })}
              </Button>
            </div>
          </form>
        ) : null}
      </section>
    </>
  );
}
