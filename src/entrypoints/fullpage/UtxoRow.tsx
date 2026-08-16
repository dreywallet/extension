/**
 * One row of the §14.4 UTXO manager.
 *
 * The collapsed row carries only what distinguishes this coin from the next:
 * amount, a short outpoint, and whichever single fact the group header has not
 * already stated. §10.3 puts derivation paths and other technical detail behind
 * the disclosure, and the per-row actions live there too so an ordinary row is
 * two lines tall.
 *
 * The privacy signals rendered here are advisory only — they never gate
 * selection, and eligibility comes solely from `utxo.eligible`/`utxo.reasons`,
 * which the worker derives from the single §11.2 predicate.
 */
import { useState } from 'react';
import type { OpResult } from '../../adapters/rpc-client';
import { Button } from '../../ui/components/Button';
import { useI18n } from '../../ui/i18n';
import type { MessageKey } from '../../ui/i18n/en';
import { handleRadioKey } from '../../ui/radio-keyboard';
import {
  classHelpKey,
  classificationKey,
  primaryReason,
  reasonKey,
  shortOutpoint,
  type UtxoGroupKey,
} from '../../ui/utxo-presentation';
import type { UtxoLabel, UtxoLabelPreset } from '@drey/core/domain/classification/labels';
import styles from './fullpage.module.css';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import { UtxoInscriptionThumbnail } from './UtxoInscriptionThumbnail';

type Utxo = OpResult<'utxo.list'>['utxos'][number];

const LABEL_PRESETS: readonly UtxoLabelPreset[] = [
  'exchange_withdrawal',
  'peer_payment',
  'purchase',
  'savings',
  'mining',
];

const PRESET_KEYS: Record<UtxoLabelPreset, MessageKey> = {
  exchange_withdrawal: 'utxos.label.preset.exchangeWithdrawal',
  peer_payment: 'utxos.label.preset.peerPayment',
  purchase: 'utxos.label.preset.purchase',
  savings: 'utxos.label.preset.savings',
  mining: 'utxos.label.preset.mining',
};

const LABEL_TEXT_MAX = 64;

export interface UtxoRowProps {
  utxo: Utxo;
  group: UtxoGroupKey;
  selected: boolean;
  /**
   * False for a coin the current account cannot spend. Eligibility (§11.2) is
   * still the worker's answer and is never re-derived here; this is the
   * separate, purely local fact that `selectCoins` builds one plan under one
   * account, so a coin from another account can never be part of this one.
   */
  selectable: boolean;
  previewEnabled: boolean;
  previewScope: string;
  expectation: ActiveSessionExpectation;
  accountId: string;
  lang: string;
  onToggleSelect: (checked: boolean) => void;
  onFreeze: () => void;
  onRescue: () => void;
  onSweep: () => void;
  onSetLabel: (label: UtxoLabel | null) => void | Promise<void>;
}

export function UtxoRow(props: UtxoRowProps): React.ReactElement {
  const { t } = useI18n();
  const { utxo, group } = props;
  const [editing, setEditing] = useState(false);
  const [preset, setPreset] = useState<UtxoLabelPreset | null>(utxo.label?.preset ?? null);
  const [text, setText] = useState(utxo.label?.text ?? '');

  const trimmed = text.trim();
  const canSave = preset !== null || trimmed !== '';
  const outpoint = shortOutpoint(utxo.txid, utxo.vout);
  const amount = BigInt(utxo.valueSats).toLocaleString(props.lang);
  const reason = primaryReason(utxo);

  // What the group header already says is not repeated per row. In `protected`
  // the differentiator is which kind of asset it is; in `unavailable` the
  // reasons genuinely vary from row to row.
  const showClass = group === 'protected';
  const showInscriptionPreview = group === 'protected' && utxo.inscriptions.length > 0;
  const classHelp = classHelpKey(utxo.classification);
  const showReason = group === 'unavailable' && reason !== null;
  // Whatever the collapsed row has not already said. `primaryReason` picks the
  // headline; the rest stay reachable in the disclosure instead of vanishing,
  // but nothing is stated twice.
  const secondaryReasons = utxo.reasons.filter((entry) => entry !== reason);
  // Two suppressions, both "say it once". Staleness is wallet-wide and the
  // section states it in its own banner. `not_cardinal_clean` is exactly what
  // the class help above explains, in more useful words, so keeping the generic
  // line would repeat it. A protected coin that is *also* frozen still says so.
  const detailReasons = (showReason ? secondaryReasons : utxo.reasons)
    .filter((entry) => entry !== 'classification_stale' || reason === 'classification_stale')
    .filter((entry) => entry !== 'not_cardinal_clean' || classHelp === null);

  const describeLabel = (label: UtxoLabel): string => {
    const parts: string[] = [];
    if (label.preset !== null) parts.push(t(PRESET_KEYS[label.preset]));
    if (label.text !== null) parts.push(label.text);
    return parts.join(' · ');
  };

  const openEditor = (): void => {
    setPreset(utxo.label?.preset ?? null);
    setText(utxo.label?.text ?? '');
    setEditing(true);
  };

  const save = (): void => {
    if (!canSave) return;
    void props.onSetLabel({ preset, text: trimmed === '' ? null : trimmed });
    setEditing(false);
  };

  return (
    <div className={styles['utxo']}>
      <div className={styles['utxoHead']}>
        <label className={styles['utxoSelect']}>
          <input
            type="checkbox"
            disabled={!utxo.eligible || !props.selectable}
            checked={props.selected}
            aria-label={t('utxos.selectCoin', { outpoint, amount })}
            onChange={(event) => { props.onToggleSelect(event.target.checked); }}
          />{' '}
          <strong>{amount} sats</strong>
        </label>
        <span className={styles['utxoTags']}>
          {utxo.label === null
            ? null
            : <span className={styles['labelChip']}>{describeLabel(utxo.label)}</span>}
          {showClass
            && (utxo.classification !== 'inscribed' || !showInscriptionPreview)
            ? <span className={styles['utxoClass']}>{t(classificationKey(utxo.classification))}</span>
            : null}
          {showInscriptionPreview ? (
            <UtxoInscriptionThumbnail
              accountId={props.accountId}
              enabled={props.previewEnabled}
              expectation={props.expectation}
              inscriptions={utxo.inscriptions}
              scope={props.previewScope}
              txid={utxo.txid}
            />
          ) : null}
        </span>
      </div>

      {showReason && reason !== null
        ? <span className={styles['utxoReason']}>{t(reasonKey(reason, utxo.classification))}</span>
        : null}

      {/* Only where the disabled checkbox would otherwise be unexplained: an
          eligible coin the current account cannot pull into this selection. An
          ineligible row already carries its own reason. */}
      {utxo.eligible && !props.selectable
        ? <span className={styles['utxoReason']}>{t('utxos.otherAccount')}</span>
        : null}

      <details className={styles['utxoDetails']}>
        {/* The visible text is the outpoint alone; the label says what opening
            it does without dropping the identifier from the announcement. */}
        <summary
          className={styles['utxoSummary']}
          aria-label={t('utxos.rowDetails', { outpoint })}
        >
          <span className={styles['utxoOutpoint']}>{outpoint}</span>
        </summary>

        <dl className={styles['utxoFacts']}>
          <dt>{t('utxos.outpoint')}</dt>
          <dd><code className={styles['code']}>{utxo.txid}:{utxo.vout}</code></dd>
          <dt>{t('utxos.path')}</dt>
          <dd>{utxo.path}</dd>
          <dt>{t('utxos.valueAfterFee')}</dt>
          <dd>{BigInt(utxo.effectiveValueSats).toLocaleString(props.lang)} sats</dd>
        </dl>

        {/* What this particular protection means. The group header can only
            state what the whole band shares. */}
        {classHelp === null ? null : <p className={styles['labelHelp']}>{t(classHelp)}</p>}

        {detailReasons.length > 0 ? (
          <span className={styles['utxoReason']}>
            {detailReasons
              .map((entry) => t(reasonKey(entry, utxo.classification)))
              .join(' · ')}
          </span>
        ) : null}

        {editing ? (
          <div className={styles['labelEditor']}>
            <span
              className={styles['presetPicker']}
              role="radiogroup"
              aria-label={t('utxos.label.heading')}
            >
              {LABEL_PRESETS.map((candidate, index) => (
                <button
                  key={candidate}
                  type="button"
                  role="radio"
                  className={styles['presetOption']}
                  aria-checked={preset === candidate}
                  // With nothing chosen the group still needs one tab stop.
                  tabIndex={preset === null ? (index === 0 ? 0 : -1) : (preset === candidate ? 0 : -1)}
                  onClick={() => { setPreset(preset === candidate ? null : candidate); }}
                  onKeyDown={(event) => {
                    handleRadioKey(event, LABEL_PRESETS, preset ?? LABEL_PRESETS[0]!, setPreset);
                  }}
                >
                  {t(PRESET_KEYS[candidate])}
                </button>
              ))}
            </span>
            <label className={styles['labelNote']}>
              {t('utxos.label.noteLabel')}
              <input
                type="text"
                value={text}
                maxLength={LABEL_TEXT_MAX}
                placeholder={t('utxos.label.notePlaceholder')}
                onChange={(event) => { setText(event.target.value); }}
              />
            </label>
            <p className={styles['labelHelp']}>{t('utxos.label.help')}</p>
            <div className={styles['utxoActions']}>
              <Button onClick={save} disabled={!canSave}>{t('utxos.label.save')}</Button>
              <Button variant="secondary" onClick={() => { setEditing(false); }}>
                {t('utxos.label.cancel')}
              </Button>
              {utxo.label !== null ? (
                <Button
                  variant="ghost"
                  onClick={() => { void props.onSetLabel(null); setEditing(false); }}
                >
                  {t('utxos.label.remove')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* A frozen coin already explains itself through its reason line, so the
            help renders only while freezing is still an offer. */}
        {utxo.classification === 'cardinal_clean' && !utxo.dustQuarantined && !utxo.frozen
          ? <p className={styles['labelHelp']}>{t('utxos.freeze.help')}</p>
          : null}

        <div className={styles['utxoActions']}>
          {editing ? null : (
            <Button variant="ghost" onClick={openEditor}>
              {utxo.label === null ? t('utxos.label.add') : t('utxos.label.edit')}
            </Button>
          )}
          {utxo.wrongLane === 'protected_wrong_address'
            ? <Button variant="secondary" onClick={props.onRescue}>{t('utxos.rescue')}</Button>
            : null}
          {utxo.wrongLane === 'reserved_ordinal_lane_btc'
            ? <Button variant="secondary" onClick={props.onSweep}>{t('utxos.sweep')}</Button>
            : null}
          {utxo.classification === 'cardinal_clean' && !utxo.dustQuarantined
            ? (
              <Button variant="secondary" onClick={props.onFreeze}>
                {utxo.frozen ? t('utxos.unfreeze') : t('utxos.freeze')}
              </Button>
            )
            : null}
        </div>
      </details>
    </div>
  );
}
