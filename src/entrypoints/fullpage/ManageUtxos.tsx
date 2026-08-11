/**
 * The §14.4 UTXO manager.
 *
 * Extracted from Transactions.tsx once the screen grew grouping and a selection
 * bar. Selection state still lives in Transactions.tsx because Send reads the
 * same set to seed `selectedOutpoints`.
 *
 * Two rules drive the layout. Anything true of a whole band of coins is stated
 * once in that band's header rather than on every row, and anything technical
 * sits behind a disclosure (§10.3). The fee selector sits beside the action it
 * feeds rather than above the list, because its only effect on the list is
 * which rows count as uneconomic.
 */
import type { ReactNode } from 'react';
import type { OpResult } from '../../adapters/rpc-client';
import { Button } from '../../ui/components/Button';
import { useI18n } from '../../ui/i18n';
import {
  groupUtxos,
  outpointKeyOf,
  totalSats,
} from '../../ui/utxo-presentation';
import type { UtxoLabel } from '@drey/core/domain/classification/labels';
import { UtxoGroup } from './UtxoGroup';
import { UtxoRow } from './UtxoRow';
import styles from './fullpage.module.css';

type Utxo = OpResult<'utxo.list'>['utxos'][number];

/** Consolidation is only meaningful once two inputs are merged. */
const MIN_CONSOLIDATION_INPUTS = 2;

export interface ManageUtxosProps {
  /** `null` while the first load is in flight, so empty never flashes. */
  utxos: Utxo[] | null;
  /**
   * The account Consolidate and Send will build their plan under. The list
   * itself stays wallet-wide — freeze, label, rescue, and sweep all address a
   * single outpoint and work across accounts — but a selection feeds
   * `selectCoins`, which spends from one account only.
   */
  account: number;
  privacyNotes: string[];
  selected: ReadonlySet<string>;
  onSelectedChange: (next: Set<string>) => void;
  lang: string;
  busy: boolean;
  feeChooser: ReactNode;
  onRefresh: () => void;
  onConsolidate: () => void;
  onFreeze: (utxo: Utxo) => void;
  onSetLabel: (utxo: Utxo, label: UtxoLabel | null) => void | Promise<void>;
  onRescue: (utxo: Utxo) => void;
  onSweep: (utxo: Utxo) => void;
}

export function ManageUtxos(props: ManageUtxosProps): React.ReactElement {
  const { t } = useI18n();
  const { utxos, selected } = props;
  const loading = utxos === null;
  const rows = utxos ?? [];
  const groups = groupUtxos(rows);

  // Eligible *and* reachable from the current account. Select All used to take
  // every eligible coin in the wallet, which in a multi-account wallet built a
  // selection selectCoins can never satisfy: it filters to one account and then
  // rejects the whole plan because the count no longer matches.
  const isSelectable = (utxo: Utxo): boolean => utxo.eligible && utxo.account === props.account;
  const selectable = rows.filter(isSelectable);
  const allSelectableSelected = selectable.length > 0 &&
    selectable.every((utxo) => selected.has(outpointKeyOf(utxo)));

  const selectedUtxos = rows.filter((utxo) => selected.has(outpointKeyOf(utxo)));
  const selectedTotal = totalSats(selectedUtxos);
  const canConsolidate = selected.size >= MIN_CONSOLIDATION_INPUTS && !props.busy;

  // One banner, not one line per row: staleness is a wallet-wide condition that
  // resolves on its own, so repeating it per coin reads as a stuck wallet.
  const verifying = rows.some((utxo) => utxo.reasons.includes('classification_stale'));

  const toggleAll = (): void => {
    const next = new Set(selected);
    if (allSelectableSelected) {
      for (const utxo of selectable) next.delete(outpointKeyOf(utxo));
    } else {
      for (const utxo of selectable) next.add(outpointKeyOf(utxo));
    }
    props.onSelectedChange(next);
  };

  const toggleOne = (key: string, checked: boolean): void => {
    const next = new Set(selected);
    if (checked) next.add(key); else next.delete(key);
    props.onSelectedChange(next);
  };

  if (loading) {
    return (
      <section className={styles['section']}>
        <h1 className={styles['title']}>{t('utxos.title')}</h1>
        <p className={styles['rowLabel']}>{t('utxos.body')}</p>
        <div className={styles['loadingState']} role="status">
          {t('utxos.loading')}
        </div>
      </section>
    );
  }

  return (
    <section className={styles['section']}>
      <h1 className={styles['title']}>{t('utxos.title')}</h1>
      <p className={styles['rowLabel']}>{t('utxos.body')}</p>

      {verifying ? <p role="status" className={styles['rowLabel']}>{t('utxos.verifying')}</p> : null}
      {props.privacyNotes.includes('stable_receive_address') ? (
        <p className={styles['rowLabel']}>{t('utxos.privacy.note.stableReceiveAddress')}</p>
      ) : null}

      {rows.length === 0
        ? <p className={styles['rowLabel']}>{t('utxos.empty')}</p>
        : null}

      {groups.map((group) => (
        <UtxoGroup
          key={group.key}
          group={group.key}
          count={group.utxos.length}
          total={group.total}
          lang={props.lang}
          allSelected={allSelectableSelected}
          onToggleAll={group.key === 'available' ? toggleAll : undefined}
        >
          {group.utxos.map((utxo) => {
            const key = outpointKeyOf(utxo);
            return (
              <UtxoRow
                key={key}
                utxo={utxo}
                group={group.key}
                lang={props.lang}
                selected={selected.has(key)}
                selectable={isSelectable(utxo)}
                onToggleSelect={(checked) => { toggleOne(key, checked); }}
                onFreeze={() => { props.onFreeze(utxo); }}
                onRescue={() => { props.onRescue(utxo); }}
                onSweep={() => { props.onSweep(utxo); }}
                onSetLabel={(label) => props.onSetLabel(utxo, label)}
              />
            );
          })}
        </UtxoGroup>
      ))}

      {props.feeChooser}

      <div className={[
        styles['utxoActionBar'],
        selected.size > 0 ? styles['utxoActionBarActive'] : null,
      ].filter(Boolean).join(' ')}>
        <span className={styles['utxoSelection']}>
          {selected.size === 0
            ? t('utxos.selectHint')
            : t('utxos.selectedSummary', {
                count: selected.size.toLocaleString(props.lang),
                total: selectedTotal.toLocaleString(props.lang),
              })}
        </span>
        <span className={styles['utxoActionButtons']}>
          <Button variant="ghost" onClick={props.onRefresh}>{t('utxos.refresh')}</Button>
          {selected.size > 0 ? (
            <Button variant="ghost" onClick={() => { props.onSelectedChange(new Set()); }}>
              {t('utxos.clearSelection')}
            </Button>
          ) : null}
          <Button onClick={props.onConsolidate} disabled={!canConsolidate}>
            {t('utxos.consolidate')}
          </Button>
        </span>
      </div>
    </section>
  );
}
