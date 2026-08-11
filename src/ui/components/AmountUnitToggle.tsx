import type { ReactNode } from 'react';
import { useActivityUnit } from '../UiRoot';
import { useI18n } from '../i18n';
import { handleRadioKey } from '../radio-keyboard';
import type { ActivityUnit } from '../prefs';
import styles from './AmountUnitToggle.module.css';

const UNITS = ['btc', 'sats'] as const;

export function AmountUnitToggle(): ReactNode {
  const { t } = useI18n();
  const { activityUnit, setActivityUnit } = useActivityUnit();

  return (
    <span
      className={styles['toggle']}
      role="radiogroup"
      aria-label={t('activity.units')}
    >
      {UNITS.map((unit) => (
        <button
          key={unit}
          type="button"
          role="radio"
          aria-checked={activityUnit === unit}
          tabIndex={activityUnit === unit ? 0 : -1}
          onClick={() => setActivityUnit(unit)}
          onKeyDown={(event) => {
            handleRadioKey(
              event,
              UNITS,
              activityUnit,
              (next: ActivityUnit) => setActivityUnit(next),
            );
          }}
        >
          {unit === 'btc' ? 'BTC' : 'sats'}
        </button>
      ))}
    </span>
  );
}
