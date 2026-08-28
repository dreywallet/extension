import { useId, type ReactNode } from 'react';
import type {
  ProviderPsbtApprovalExplanationV1,
} from '@drey/core/domain/transactions/provider-psbt-approval';
import { useI18n } from '../../ui/i18n';
import styles from './approval.module.css';

export type ProviderTransactionGroupPresentation =
  | {
      kind: 'independent';
      transactionCount: number;
      netWalletDebitSats: string;
      feeExposureSats: string;
    }
  | {
      /**
       * Reserved for a Core-derived linked-group explanation. Callers must not
       * build these economics or outcome strings from page-supplied metadata.
       */
      kind: 'linked';
      transactionCount: number;
      maximumWalletDebitSats: string;
      maximumNetworkFeeSats: string;
      branchEconomicsExact: boolean;
      sharedFundingConflictCount: number;
      outcomeGroups: readonly {
        id: string;
        settlements: readonly ProviderTransactionGroupOutcome[];
        recovery: ProviderTransactionGroupOutcome;
      }[];
    };

interface ProviderTransactionGroupOutcome {
  id: string;
  guaranteedWalletReturnSats: string;
  maximumWalletDebitSats: string;
}

function absoluteSats(value: string): string {
  const amount = BigInt(value);
  return (amount < 0n ? -amount : amount).toString();
}

/**
 * One group-level hierarchy for today's independent batches and future
 * Core-proven linked groups. The discriminated input prevents linked branch
 * fees from accidentally using the independent batch's additive exposure.
 */
export function ProviderTransactionGroupReview(props: {
  presentation: ProviderTransactionGroupPresentation;
}): ReactNode {
  const { t, lang } = useI18n();
  const headingId = useId();
  const presentation = props.presentation;
  const debit = presentation.kind === 'independent'
    ? presentation.netWalletDebitSats
    : presentation.maximumWalletDebitSats;
  const fee = presentation.kind === 'independent'
    ? presentation.feeExposureSats
    : presentation.maximumNetworkFeeSats;
  const entering = presentation.kind === 'independent' && BigInt(debit) < 0n;
  const formatSats = (value: string): string =>
    `${BigInt(value).toLocaleString(lang)} sats`;

  return (
    <section className={styles['transactionGroup']} aria-labelledby={headingId}
      data-testid="approval-transaction-group">
      <div className={styles['transactionSummary']}>
        <h2 id={headingId}>{t(presentation.transactionCount === 1
          ? 'approvalUi.batch.countOne'
          : presentation.kind === 'independent'
            ? 'approvalUi.batch.count'
            : 'approvalUi.group.linkedCount',
        { count: presentation.transactionCount })}</h2>
        <dl className={styles['amountSummary']}>
          <div className={styles['primaryAmount']}>
            <dt>{presentation.kind === 'linked'
              ? t(presentation.branchEconomicsExact
                ? 'approval.psbt.maximumDebit'
                : 'approvalUi.group.conservativeDebit')
              : entering
                ? t('approvalUi.enteringWallet')
                : t('approvalUi.leavingWallet')}</dt>
            <dd>{formatSats(absoluteSats(debit))}</dd>
          </div>
          <div className={styles['feeAmount']}>
            <dt>{presentation.kind === 'linked'
              ? t(presentation.branchEconomicsExact
                ? 'approvalUi.group.maximumFees'
                : 'approvalUi.group.conservativeFees')
              : t('approvalUi.batch.feeExposure')}</dt>
            <dd>{formatSats(fee)}</dd>
          </div>
        </dl>
      </div>
      <p className={styles['groupRelease']}>
        {t('approvalUi.group.signedTogether')}
      </p>
      {presentation.kind === 'linked' ? (
        <>
          {presentation.branchEconomicsExact ? null : (
            <p className={styles['groupRelease']} role="note">
              {t('approvalUi.group.conservativeBody')}
            </p>
          )}
          {presentation.sharedFundingConflictCount > 0 ? (
            <aside className={styles['sharedFunding']} role="note"
              aria-label={t('approvalUi.group.sharedFundingTitle')}
              data-testid="approval-shared-funding">
              <strong>{t('approvalUi.group.sharedFundingTitle')}</strong>
              <span>{t('approvalUi.group.sharedFundingBody')}</span>
            </aside>
          ) : null}
          {presentation.outcomeGroups.length > 0 ? (
            <section className={styles['groupOutcomes']}
              aria-label={t('approvalUi.group.possibleOutcomes')}>
              <h3>{t('approvalUi.group.possibleOutcomes')}</h3>
              <div className={styles['outcomeGroups']}>
                {presentation.outcomeGroups.map((group, groupIndex) => (
                  <article className={styles['outcomeGroup']} key={group.id}>
                    <h4>{t(presentation.outcomeGroups.length === 1
                      ? 'approvalUi.group.outcomeSet'
                      : 'approvalUi.group.outcomeSetNumbered', { number: groupIndex + 1 })}</h4>
                    <ul>
                      {group.settlements.map((outcome) => (
                        <Outcome key={outcome.id} outcome={outcome}
                          title={t('approvalUi.group.settlementOutcome')} />
                      ))}
                      <Outcome outcome={group.recovery}
                        title={t('approvalUi.group.recoveryOutcome')} />
                    </ul>
                    <p>{t('approvalUi.group.oneOutcome')}</p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function Outcome(props: {
  outcome: ProviderTransactionGroupOutcome;
  title: string;
}): ReactNode {
  const { t, lang } = useI18n();
  const formatSats = (value: string): string =>
    `${BigInt(value).toLocaleString(lang)} sats`;
  return (
    <li>
      <strong>{props.title}</strong>
      <span>{t('approvalUi.group.guaranteedReturn', {
        amount: formatSats(props.outcome.guaranteedWalletReturnSats),
      })}</span>
      <span>{t('approvalUi.group.outcomeMaximumDebit', {
        amount: formatSats(props.outcome.maximumWalletDebitSats),
      })}</span>
    </li>
  );
}

/** Plain-language signature effects shown before the raw technical payload. */
export function ProviderSighashEffects(props: ({
  explanation: ProviderPsbtApprovalExplanationV1;
  explanations?: never;
} | {
  explanation?: never;
  explanations: readonly {
    explanation: ProviderPsbtApprovalExplanationV1;
    deferredFee: boolean;
  }[];
}) & { deferredFee?: boolean }): ReactNode {
  const { t } = useI18n();
  const headingId = useId();
  const explanations = 'explanations' in props
    ? props.explanations
    : [{ explanation: props.explanation, deferredFee: props.deferredFee === true }];
  const sighashes = explanations.flatMap((item) => item.explanation.sighashes.map((sighash) => ({
    sighash,
    deferredFee: item.deferredFee,
  })));
  const deferredCount = explanations.filter((item) => item.deferredFee).length;
  const groups = [...sighashes.reduce((byRule, item) => {
    const { sighash, deferredFee } = item;
    const key = [sighash.raw, sighash.inputSet, sighash.outputs, sighash.fee, deferredFee].join(':');
    const group = byRule.get(key);
    if (group) group.inputIndexes.push(sighash.inputIndex);
    else byRule.set(key, { sighash, deferredFee, inputIndexes: [sighash.inputIndex] });
    return byRule;
  }, new Map<string, {
    sighash: ProviderPsbtApprovalExplanationV1['sighashes'][number];
    deferredFee: boolean;
    inputIndexes: number[];
  }>()).values()];
  return (
    <section className={styles['signatureRules']} aria-labelledby={headingId}
      data-testid="approval-signature-rules">
      <h3 id={headingId}>{t('approvalUi.signatureRules.title')}</h3>
      {deferredCount > 0 ? (
        <p className={styles['deferredFee']}>
          <strong>{t(deferredCount === explanations.length
            ? 'approvalUi.signatureRules.deferredFeeTitle'
            : 'approvalUi.signatureRules.someDeferredFeeTitle')}</strong>
          <span>{t(deferredCount === explanations.length
            ? 'approvalUi.signatureRules.deferredFeeBody'
            : 'approvalUi.signatureRules.someDeferredFeeBody')}</span>
        </p>
      ) : null}
      <div className={styles['signatureRuleItems']}>
        {groups.map(({ sighash, deferredFee, inputIndexes }) => (
          <article key={`${sighash.raw}:${sighash.inputSet}:${sighash.outputs}:${sighash.fee}:${deferredFee}`}>
            <div className={styles['signatureRuleHeading']}>
              <strong>{inputIndexes.length === 1
                ? t('approvalUi.signatureRules.input', { number: inputIndexes[0]! + 1 })
                : t('approvalUi.signatureRules.inputCount', { count: inputIndexes.length })}</strong>
              <code>{sighash.name}</code>
            </div>
            <p>{[
              t(sighash.inputSet === 'fixed'
                ? 'approvalUi.signatureRules.inputsFixed'
                : 'approvalUi.signatureRules.inputsChangeable'),
              t(sighash.outputs === 'all'
                ? 'approvalUi.signatureRules.outputsFixed'
                : inputIndexes.length === 1
                  ? 'approvalUi.signatureRules.outputCorresponding'
                  : 'approvalUi.signatureRules.outputsCorrespondingEach',
              inputIndexes.length === 1 ? {
                number: (sighash.correspondingOutputIndex ?? sighash.inputIndex) + 1,
              } : {}),
              t(deferredFee && sighash.fee === 'fixed'
                ? 'approvalUi.signatureRules.feeDeferred'
                : sighash.fee === 'fixed'
                  ? 'approvalUi.signatureRules.feeFixed'
                  : 'approvalUi.signatureRules.feeChangeable'),
            ].join(' ')}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
