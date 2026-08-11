import { useState, type ReactNode } from 'react';
import { useI18n } from '../../ui/i18n';
import { useSession } from '../../ui/hooks/use-session';
import { useSessionActivity } from '../../ui/hooks/use-session-activity';
import { Button } from '../../ui/components/Button';
import { Unlock } from '../../ui/components/Unlock';
import { BrandMark } from '../../ui/components/BrandMark';
import { Shell } from './Shell';
import { OpenSidePanelButton } from './OpenSidePanelButton';
import type { WalletSurface } from './surface';
import styles from './popup.module.css';

function openOnboarding(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL('/onboarding.html') });
}

export function App(props: { surface?: WalletSurface }): ReactNode {
  const { t } = useI18n();
  const session = useSession();
  useSessionActivity(session.expectation);
  const [sidePanelError, setSidePanelError] = useState<string | null>(null);
  const surface = props.surface ?? 'popup';
  const surfaceClassName = [
    styles['popup'],
    surface === 'sidepanel' ? styles['sidePanel'] : null,
  ].filter(Boolean).join(' ');
  const standaloneSidePanelControl = surface === 'popup' ? (
    <div className={styles['standaloneSurfaceControl']}>
      <OpenSidePanelButton onErrorChange={setSidePanelError} />
    </div>
  ) : null;
  const standaloneSidePanelError = sidePanelError === null ? null : (
    <p className={styles['surfaceError']} role="alert">{sidePanelError}</p>
  );

  if (session.state === 'loading') {
    return (
      <div className={surfaceClassName}>
        <div className={styles['center']}><BrandMark />{t('common.loading')}</div>
      </div>
    );
  }

  if (session.state === 'error') {
    return (
      <div className={surfaceClassName}>
        {standaloneSidePanelControl}
        <div className={styles['center']}>
          <BrandMark />
          {standaloneSidePanelError}
          <p role="alert">{t('common.error.internal')}</p>
          <Button onClick={session.refresh}>{t('common.retry')}</Button>
        </div>
      </div>
    );
  }

  if (session.state === 'no-vault') {
    return (
      <div className={surfaceClassName}>
        {standaloneSidePanelControl}
        <div className={styles['center']}>
          <BrandMark />
          {standaloneSidePanelError}
          <h1 style={{ margin: 0 }}>{t('launch.welcome')}</h1>
          <p className={styles['muted']}>{t('app.tagline')}</p>
          <Button onClick={openOnboarding}>{t('launch.getStarted')}</Button>
        </div>
      </div>
    );
  }

  if (session.state === 'locked') {
    return (
      <div className={surfaceClassName}>
        {standaloneSidePanelControl}
        <div className={styles['center']}>
          <BrandMark />
          {standaloneSidePanelError}
          {session.quarantinedVaultCount > 0 ? (
            <p role="alert">{t('common.error.quarantined')}</p>
          ) : null}
          <Unlock
            vaults={session.vaults}
            preferredUnlockVaultId={session.preferredUnlockVaultId}
            onUnlocked={session.refresh}
          />
        </div>
      </div>
    );
  }

  if (session.state === 'unverified') {
    return (
      <div className={surfaceClassName}>
        {standaloneSidePanelControl}
        <div className={styles['center']}>
          <BrandMark />
          {standaloneSidePanelError}
          <h1 style={{ margin: 0 }}>{t('backupGate.title')}</h1>
          <p className={styles['muted']}>{t('backupGate.body')}</p>
          <Button onClick={openOnboarding}>{t('backupGate.action')}</Button>
        </div>
      </div>
    );
  }

  return (
    <Shell
      session={session}
      surface={surface}
      sidePanelError={sidePanelError}
      onSidePanelErrorChange={setSidePanelError}
    />
  );
}
