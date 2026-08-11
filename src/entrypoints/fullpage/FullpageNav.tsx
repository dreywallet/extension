import type { ReactNode } from 'react';
import { Button } from '../../ui/components/Button';
import { useI18n } from '../../ui/i18n';
import type { PrimaryFullpageView } from './routes';
import styles from './fullpage.module.css';

const DESTINATIONS = [
  { view: 'send', label: 'transactions.nav.send' },
  { view: 'utxos', label: 'transactions.nav.utxos' },
  { view: 'activity', label: 'transactions.nav.activity' },
  { view: 'settings', label: 'nav.settings' },
] as const;

export function FullpageNav(props: {
  current: PrimaryFullpageView;
  onNavigate: (destination: PrimaryFullpageView) => void;
  settingsDisabled?: boolean;
}): ReactNode {
  const { t } = useI18n();

  return (
    <nav className={styles['subnav']} aria-label={t('nav.fullpage')}>
      {DESTINATIONS.map((destination) => {
        const current = props.current === destination.view;
        return (
          <Button
            key={destination.view}
            variant={current ? 'primary' : 'ghost'}
            aria-current={current ? 'page' : undefined}
            disabled={destination.view === 'settings' && props.settingsDisabled === true}
            onClick={() => props.onNavigate(destination.view)}
          >
            {t(destination.label)}
          </Button>
        );
      })}
    </nav>
  );
}
