import { useState, type ReactNode } from 'react';
import { useI18n } from '../../ui/i18n';
import { useSession } from '../../ui/hooks/use-session';
import { CreateFlow } from './CreateFlow';
import { RestoreFlow } from './RestoreFlow';
import { ResumeVerify } from './ResumeVerify';
import { Button } from '../../ui/components/Button';
import { BrandMark } from '../../ui/components/BrandMark';
import styles from './onboarding.module.css';

type Route = 'welcome' | 'create' | 'restore' | 'done';

export function App(): ReactNode {
  const { t } = useI18n();
  const session = useSession();
  const [route, setRoute] = useState<Route>('welcome');

  if (route === 'welcome' && session.state === 'loading') {
    return (
      <div className={styles['page']}>
        <div className={styles['card']}><BrandMark className={styles['brand']} />{t('common.loading')}</div>
      </div>
    );
  }

  if (route === 'welcome' && session.state === 'error') {
    return (
      <div className={styles['page']}>
        <div className={styles['card']}>
          <BrandMark className={styles['brand']} />
          <p role="alert">{t('common.error.internal')}</p>
          <Button onClick={session.refresh}>{t('common.retry')}</Button>
        </div>
      </div>
    );
  }

  if (route === 'welcome' && session.quarantinedVaultCount > 0) {
    return (
      <div className={styles['page']}>
        <div className={styles['card']}>
          <BrandMark className={styles['brand']} />
          <p role="alert">{t('common.error.quarantined')}</p>
        </div>
      </div>
    );
  }

  // A vault exists, is unlocked, but the §7.1 gate is still closed: resume
  // verification instead of offering to create a second vault.
  if (route === 'welcome' && session.state === 'unverified') {
    return (
      <div className={styles['page']}>
        <div className={styles['card']}>
          <BrandMark className={styles['brand']} />
          {session.expectation !== null ? (
            <ResumeVerify expectation={session.expectation} onDone={() => setRoute('done')} />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className={styles['page']}>
      <div className={styles['card']}>
        <BrandMark className={styles['brand']} />
        {route === 'welcome' ? (
          <>
            <h1 className={styles['title']}>{t('onboarding.welcome.title')}</h1>
            <p className={styles['subtitle']}>{t('onboarding.welcome.subtitle')}</p>
            <div className={styles['tiles']}>
              <button type="button" className={styles['tile']} onClick={() => setRoute('create')}>
                <span className={styles['tileTitle']}>{t('onboarding.create.title')}</span>
                <span className={styles['tileSubtitle']}>{t('onboarding.create.subtitle')}</span>
              </button>
              <button type="button" className={styles['tile']} onClick={() => setRoute('restore')}>
                <span className={styles['tileTitle']}>{t('onboarding.restore.title')}</span>
                <span className={styles['tileSubtitle']}>{t('onboarding.restore.subtitle')}</span>
              </button>
            </div>
          </>
        ) : null}
        {route === 'create' ? (
          <CreateFlow
            existingProfile={session.vaults.length > 0}
            defaultWalletName={`Wallet ${session.vaults.length + 1}`}
            onDone={() => setRoute('done')}
            onBack={() => setRoute('welcome')}
          />
        ) : null}
        {route === 'restore' ? (
          <RestoreFlow
            existingProfile={session.vaults.length > 0}
            defaultWalletName={`Wallet ${session.vaults.length + 1}`}
            onDone={() => setRoute('done')}
            onBack={() => setRoute('welcome')}
          />
        ) : null}
        {route === 'done' ? (
          <>
            <h1 className={styles['title']}>{t('onboarding.done.title')}</h1>
            <p className={styles['subtitle']}>{t('onboarding.done.body')}</p>
            {/* §18.5 MUST: onboarding discloses the hosted-gateway
                relationship. Kept to one sentence — this is the moment the
                user wants to press Finish — with the full correlation and IP
                disclosure in Settings. */}
            <p className={styles['subtitle']}>{t('privacy.gateway.short')}</p>
            <div className={styles['actions']}>
              <span />
              <Button onClick={() => window.close()}>{t('onboarding.done.close')}</Button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
