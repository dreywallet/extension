import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { AccountListResult } from '@drey/core/messaging/ops';
import { isWalletDataChangedEvent } from '@drey/core/messaging/events';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import { useI18n } from '../../ui/i18n';
import { useRpc } from '../../ui/hooks/use-rpc';
import { Button } from '../../ui/components/Button';
import { AccountMark } from '../../ui/components/AccountMark';
import { WatchOnlyAccountImport } from './accounts/WatchOnlyAccountImport';
import { PublicAccountExport } from './accounts/PublicAccountExport';
import styles from './fullpage.module.css';

export function ManageAccounts(props: {
  expectation: ActiveSessionExpectation;
  onBack: () => void;
}): ReactNode {
  const { t } = useI18n();
  const rpc = useRpc();
  const [accounts, setAccounts] = useState<AccountListResult['accounts']>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [restoredAccount, setRestoredAccount] = useState<number | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const accountsRef = useRef(accounts);
  const { expectedVaultId, expectedSessionId } = props.expectation;

  const load = useCallback((detectAutomaticRestore = false) => {
    setLoading(true);
    void rpc('account.list', { expectedVaultId, expectedSessionId }).then((result) => {
      if (result.ok) {
        if (detectAutomaticRestore) {
          const previouslyHidden = new Set(
            accountsRef.current.filter((account) => account.hidden).map((account) => account.accountId),
          );
          const restored = result.result.accounts.find(
            (account) => !account.hidden && previouslyHidden.has(account.accountId),
          );
          if (restored) setRestoredAccount(restored.account);
        }
        setAccounts(result.result.accounts);
        accountsRef.current = result.result.accounts;
        setError(false);
      } else {
        setError(true);
      }
      setLoading(false);
      setBusy(null);
    });
  }, [expectedSessionId, expectedVaultId, rpc]);

  useEffect(() => {
    load();
    const onMessage = (message: unknown): void => {
      if (isWalletDataChangedEvent(message) && message.reason === 'account') load(true);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [load]);

  async function setHidden(accountId: string, hidden: boolean): Promise<void> {
    setBusy(accountId);
    setError(false);
    const result = await rpc('account.visibility.set', {
      accountId,
      hidden,
      ...props.expectation,
    });
    if (result.ok) {
      setConfirming(null);
      load();
    } else {
      setError(true);
      setBusy(null);
    }
  }

  async function removeWatchAccount(accountId: string): Promise<void> {
    setBusy(accountId);
    setError(false);
    const result = await rpc('account.remove', { accountId, ...props.expectation });
    if (!result.ok) {
      setError(true);
      setBusy(null);
      return;
    }
    setRemoving(null);
    load();
  }

  const visible = accounts.filter((account) => !account.hidden);
  const hidden = accounts.filter((account) => account.hidden);
  const standardAccounts = accounts.filter((account) => account.signingSource === 'software');
  const highestStandard = standardAccounts.reduce((highest, account) =>
    highest === null || account.account > highest.account ? account : highest,
  null as AccountListResult['accounts'][number] | null);
  const canAddStandard = highestStandard?.hasHistory === true;

  async function addStandardAccount(): Promise<void> {
    if (!canAddStandard || adding) return;
    setAdding(true);
    setError(false);
    const result = await rpc('account.add', props.expectation);
    if (result.ok) load();
    else {
      setError(true);
      setAdding(false);
    }
  }
  const blockerText = (blocker: NonNullable<AccountListResult['accounts'][number]['hideBlocker']>) =>
    t(`account.manage.blocker.${blocker}`);

  const row = (account: AccountListResult['accounts'][number]): ReactNode => (
    <article
      key={account.accountId}
      className={styles['vaultRow']}
      aria-label={t('account.number', { account: account.account + 1 })}
    >
      <div className={styles['accountDetails']}>
        <span className={styles['accountHeading']}>
          {accounts.length > 1 ? <AccountMark seed={account.accountId} size="md" /> : null}
          <strong>{account.name}</strong>
        </span>
        <p className={styles['rowLabel']}>
          {account.signingSource === 'none'
            ? t('account.watchOnly')
            : account.active
            ? t('account.manage.active')
            : account.hasHistory
              ? t('account.manage.history')
              : t('account.manage.noHistory')}
        </p>
        {!account.hidden && account.hideBlocker !== null ? (
          <p className={styles['rowLabel']}>{blockerText(account.hideBlocker)}</p>
        ) : null}
        {confirming === account.accountId ? (
          <div className={styles['advisory']} role="note">
            <p>{t('account.manage.hideConfirm')}</p>
            <div className={styles['row']}>
              <Button variant="secondary" onClick={() => setConfirming(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                onClick={() => void setHidden(account.accountId, true)}
                disabled={busy !== null}
              >
                {t('account.manage.hide')}
              </Button>
            </div>
          </div>
        ) : null}
        {exporting === account.accountId ? (
          <PublicAccountExport
            accountId={account.accountId}
            accountName={account.name}
            expectation={props.expectation}
            onClose={() => setExporting(null)}
          />
        ) : null}
        {removing === account.accountId ? (
          <div className={styles['advisory']} role="note">
            <p>{t('account.manage.removeConfirm')}</p>
            <div className={styles['row']}>
              <Button variant="secondary" onClick={() => setRemoving(null)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => void removeWatchAccount(account.accountId)} disabled={busy !== null}>
                {t('account.manage.remove')}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
      {confirming === account.accountId || removing === account.accountId || exporting === account.accountId
        ? null
        : account.signingSource === 'none' ? (
        <div className={styles['row']}>
          <Button variant="secondary" onClick={() => setExporting(account.accountId)} disabled={busy !== null}>
            {t('account.manage.export')}
          </Button>
          <Button variant="secondary" onClick={() => setRemoving(account.accountId)} disabled={busy !== null}>
            {t('account.manage.remove')}
          </Button>
          {account.active ? (
            <span className={styles['badge']}>{t('settings.vaults.active')}</span>
          ) : null}
        </div>
      ) : (
        <div className={styles['row']}>
          <Button variant="secondary" onClick={() => setExporting(account.accountId)} disabled={busy !== null}>
            {t('account.manage.export')}
          </Button>
          {account.active ? (
            <span className={styles['badge']}>{t('settings.vaults.active')}</span>
          ) : account.hidden ? (
            <Button variant="secondary" onClick={() => void setHidden(account.accountId, false)} disabled={busy !== null}>
              {t('account.manage.show')}
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => setConfirming(account.accountId)} disabled={!account.canHide || busy !== null}>
              {t('account.manage.hide')}
            </Button>
          )}
        </div>
      )}
    </article>
  );

  return (
    <>
      <Button variant="ghost" onClick={props.onBack}>{t('common.back')}</Button>
      <h1 className={styles['title']}>{t('account.manage.title')}</h1>
      <p className={styles['rowLabel']}>{t('account.manage.body')}</p>
      <p className={styles['rowLabel']}>{t('account.manage.recovery')}</p>
      <div className={styles['row']}>
        <Button
          onClick={() => void addStandardAccount()}
          disabled={!canAddStandard || adding}
          title={canAddStandard ? undefined : t('account.manage.addGapRule')}
        >
          {t('account.add')}
        </Button>
        <Button variant="secondary" onClick={() => setImportOpen((current) => !current)}>
          {t('account.manage.import')}
        </Button>
        <Button
          variant="secondary"
          onClick={() => void rpc('scan.start', { mode: 'rescan', ...props.expectation })}
        >
          {t('account.manage.rescan')}
        </Button>
      </div>
      {!canAddStandard ? <p className={styles['rowLabel']}>{t('account.manage.addGapRule')}</p> : null}
      {importOpen ? (
        <WatchOnlyAccountImport
          expectation={props.expectation}
          accounts={accounts}
          network={accounts[0]?.accountId.startsWith('acct_mainnet_') ? 'mainnet' : 'signet'}
          onClose={() => setImportOpen(false)}
          onImported={() => { setImportOpen(false); load(); }}
        />
      ) : null}
      {loading ? <p>{t('common.loading')}</p> : null}
      {error ? <p role="alert" className={styles['error']}>{t('account.manage.error')}</p> : null}
      {restoredAccount !== null ? (
        <p role="status" className={styles['advisory']}>
          {t('account.manage.restored', { account: restoredAccount + 1 })}
        </p>
      ) : null}
      {!loading ? <section className={styles['section']}>{visible.map(row)}</section> : null}
      {hidden.length > 0 ? (
        <details className={styles['accountArchive']}>
          <summary>{t('account.manage.archived', { count: hidden.length })}</summary>
          <section className={styles['section']}>{hidden.map(row)}</section>
        </details>
      ) : null}
    </>
  );
}
