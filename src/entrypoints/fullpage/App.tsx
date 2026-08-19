import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../../ui/i18n';
import { useSession } from '../../ui/hooks/use-session';
import { useSessionActivity } from '../../ui/hooks/use-session-activity';
import { Settings } from './Settings';
import { ManageAccounts } from './ManageAccounts';
import { WalletAccountSettings } from './WalletAccountSettings';
import { RecoverySettings } from './RecoverySettings';
import { RevealSeedSettings } from './RevealSeedSettings';
import { PasskeySettings } from './PasskeySettings';
import { passkeySettingsAvailable } from '../../ui/passkey/availability';
import { vaultCoordinatorChannelEnabled } from '../../ui/vault/availability';
import { VaultCoordinator } from './VaultCoordinator';
import { CommunityVault } from './CommunityVault';
import { MessageSigning } from './MessageSigning';
import { AddressBook } from './AddressBook';
import { Unlock } from '../../ui/components/Unlock';
import { Button } from '../../ui/components/Button';
import { Transactions } from './Transactions';
import { BlockedSiteSupport } from './BlockedSiteSupport';
import { BrandMark } from '../../ui/components/BrandMark';
import { FullpageNav } from './FullpageNav';
import {
  FULLPAGE_HASH,
  fullpageViewFromHash,
  transactionFullpageHash,
  type FullpageView,
  type PrimaryFullpageView,
  type TransactionSection,
} from './routes';
import styles from './fullpage.module.css';

function PageShell(props: { children: ReactNode }): ReactNode {
  return <div className={styles['page']}><BrandMark />{props.children}</div>;
}

export function App(): ReactNode {
  const { t } = useI18n();
  const session = useSession();
  useSessionActivity(session.expectation);
  const [view, setView] = useState<FullpageView>(
    () => fullpageViewFromHash(window.location.hash),
  );
  const [pendingRecipient, setPendingRecipient] = useState<string | null>(null);

  useEffect(() => {
    const onHash = (): void => setView(fullpageViewFromHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigateTransactions = useCallback((section: TransactionSection) => {
    window.location.hash = transactionFullpageHash(section);
  }, []);
  const navigatePrimary = useCallback((destination: PrimaryFullpageView) => {
    window.location.hash = FULLPAGE_HASH[destination];
  }, []);
  const navigateSettings = useCallback(() => {
    navigatePrimary('settings');
  }, [navigatePrimary]);
  const sendToRecipient = useCallback((address: string) => {
    setPendingRecipient(address);
    window.location.hash = FULLPAGE_HASH.send;
  }, []);
  const openAddressBook = useCallback(() => {
    window.location.hash = FULLPAGE_HASH.addressBook;
  }, []);
  const consumePendingRecipient = useCallback(() => setPendingRecipient(null), []);

  if (session.state === 'loading') {
    return <PageShell>{t('common.loading')}</PageShell>;
  }

  if (session.state === 'error') {
    return (
      <PageShell>
        <p role="alert">{t('common.error.internal')}</p>
        <Button onClick={session.refresh}>{t('common.retry')}</Button>
      </PageShell>
    );
  }

  if (view === 'siteBlocked') {
    return <PageShell><BlockedSiteSupport /></PageShell>;
  }

  if (session.state === 'no-vault') {
    return (
      <PageShell>
        <h1 className={styles['title']}>{t('launch.welcome')}</h1>
        <p>{t('app.tagline')}</p>
        <Button onClick={() => window.location.assign(chrome.runtime.getURL('/onboarding.html'))}>
          {t('launch.getStarted')}
        </Button>
      </PageShell>
    );
  }

  if (session.state === 'locked') {
    return (
      <PageShell>
        {session.quarantinedVaultCount > 0 ? (
          <p role="alert">{t('common.error.quarantined')}</p>
        ) : null}
        <Unlock
          vaults={session.vaults}
          preferredUnlockVaultId={session.preferredUnlockVaultId}
          onUnlocked={session.refresh}
        />
      </PageShell>
    );
  }

  if (session.expectation === null) {
    return <PageShell>{t('common.loading')}</PageShell>;
  }

  return (
    <PageShell>
      {session.quarantinedVaultCount > 0 ? (
        <p role="alert">{t('common.error.quarantined')}</p>
      ) : null}
      {view === 'recovery' && session.capabilities.canRevealSeed ? (
        <RecoverySettings
          key={`${session.expectation.expectedVaultId}:${session.expectation.expectedSessionId}`}
          expectation={session.expectation}
          onBack={() => (window.location.hash = FULLPAGE_HASH.settings)}
          onReveal={() => (window.location.hash = FULLPAGE_HASH.reveal)}
          onVault={() => (window.location.hash = FULLPAGE_HASH.vault)}
        />
      ) : view === 'walletAccounts' ? (
        <WalletAccountSettings
          session={session}
          onBack={() => (window.location.hash = FULLPAGE_HASH.settings)}
          onManageAccounts={() => (window.location.hash = FULLPAGE_HASH.accounts)}
        />
      ) : view === 'accounts' ? (
        <ManageAccounts
          expectation={session.expectation}
          onBack={() => (window.location.hash = FULLPAGE_HASH.walletAccounts)}
        />
      ) : view === 'reveal' && session.capabilities.canRevealSeed ? (
        <RevealSeedSettings
          expectation={session.expectation}
          onBack={() => (window.location.hash = FULLPAGE_HASH.recovery)}
        />
      ) : view === 'passkeys' && passkeySettingsAvailable() ? (
        <PasskeySettings
          expectation={session.expectation}
          onBack={() => (window.location.hash = FULLPAGE_HASH.settings)}
        />
      ) : view === 'vault' && vaultCoordinatorChannelEnabled() ? (
        <VaultCoordinator
          expectation={session.expectation}
          onBack={() => (window.location.hash = FULLPAGE_HASH.settings)}
        />
      ) : view === 'communityVault' ? (
        <CommunityVault
          expectation={session.expectation}
          onBack={() => (window.location.hash = FULLPAGE_HASH.settings)}
        />
      ) : view === 'messageSigning' && session.capabilities.canSignMessages &&
          session.activeAccountId !== null ? (
        <MessageSigning
          expectation={session.expectation}
          accountId={session.activeAccountId}
          onBack={() => (window.location.hash = FULLPAGE_HASH.settings)}
        />
      ) : view === 'addressBook' ? (
        <AddressBook
          expectation={session.expectation}
          onBack={() => (window.location.hash = FULLPAGE_HASH.settings)}
          onSend={sendToRecipient}
        />
      ) : (view === 'send' || view === 'utxos' || view === 'activity') &&
          session.activeAccountId !== null ? (
        <Transactions
          expectedVaultId={session.expectation.expectedVaultId}
          expectedSessionId={session.expectation.expectedSessionId}
          capabilities={session.capabilities}
          accountId={session.activeAccountId}
          initialAccount={session.activeAccount}
          initialRecipient={pendingRecipient ?? undefined}
          selectableAccounts={session.selectableAccounts}
          accountSummaries={session.accountSummaries}
          initialSection={view}
          onNavigate={navigateTransactions}
          onOpenSettings={navigateSettings}
          onOpenAddressBook={openAddressBook}
          onInitialRecipientConsumed={consumePendingRecipient}
        />
      ) : (
        <>
          <FullpageNav current="settings" onNavigate={navigatePrimary} />
          <Settings session={session} />
        </>
      )}
    </PageShell>
  );
}
