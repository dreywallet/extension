/**
 * A collapsible band of the §14.4 UTXO manager.
 *
 * Grouping is what keeps the screen short: everything that would otherwise
 * repeat on every row — "these are protected", "these are postage" — is stated
 * once in the header, so the rows themselves carry only what differs. Only
 * `available` opens by default; a holder with nine inscriptions sees three
 * summary lines instead of nine explanations.
 */
import { useState, type ReactNode } from 'react';
import { Button } from '../../ui/components/Button';
import { useI18n } from '../../ui/i18n';
import {
  GROUP_HELP_KEYS,
  GROUP_TITLE_KEYS,
  type UtxoGroupKey,
} from '../../ui/utxo-presentation';
import styles from './fullpage.module.css';

export interface UtxoGroupProps {
  group: UtxoGroupKey;
  count: number;
  total: bigint;
  lang: string;
  /** Select-all is offered only where selection is possible. */
  onToggleAll?: (() => void) | undefined;
  allSelected?: boolean | undefined;
  children: (open: boolean) => ReactNode;
}

export function UtxoGroup(props: UtxoGroupProps): React.ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(props.group === 'available');
  const countLine = props.count === 1
    ? t('utxos.group.countOne', { total: props.total.toLocaleString(props.lang) })
    : t('utxos.group.count', {
        count: props.count.toLocaleString(props.lang),
        total: props.total.toLocaleString(props.lang),
      });

  return (
    <details className={styles['utxoGroup']} open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={styles['utxoGroupSummary']}>
        <span className={styles['utxoGroupTitle']}>{t(GROUP_TITLE_KEYS[props.group])}</span>
        <span className={styles['utxoGroupCount']}>{countLine}</span>
      </summary>
      <div className={styles['utxoGroupBody']}>
        <div className={styles['utxoGroupIntro']}>
          <p className={styles['labelHelp']}>{t(GROUP_HELP_KEYS[props.group])}</p>
          {/* Deselect all, not Clear: this covers only the group, while the
              action bar's Clear drops the whole selection. */}
          {props.onToggleAll === undefined ? null : (
            <Button variant="ghost" onClick={props.onToggleAll}>
              {props.allSelected ? t('utxos.deselectAll') : t('utxos.selectAll')}
            </Button>
          )}
        </div>
        {props.children(open)}
      </div>
    </details>
  );
}
