import type { ReactNode } from 'react';
import { Button } from '../../ui/components/Button';
import { useI18n } from '../../ui/i18n';
import { FULLPAGE_HASH } from './routes';
import styles from './fullpage.module.css';

/** Local-only help for origins rejected by the signed phishing policy. */
export function BlockedSiteSupport(): ReactNode {
  const { t } = useI18n();
  return (
    <section aria-labelledby="blocked-site-title">
      <h1 id="blocked-site-title" className={styles['title']}>{t('blockedSite.title')}</h1>
      <p role="alert">{t('blockedSite.alert')}</p>
      <h2 className={styles['sectionTitle']}>{t('blockedSite.appealTitle')}</h2>
      <p>{t('blockedSite.appealBody')} <code>ERR_PHISHING_BLOCKED</code>.</p>
      <p>{t('blockedSite.secretWarning')}</p>
      <Button onClick={() => { window.location.hash = FULLPAGE_HASH.settings; }}>
        {t('blockedSite.back')}
      </Button>
    </section>
  );
}
