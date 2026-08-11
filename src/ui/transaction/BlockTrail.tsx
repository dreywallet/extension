import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import {
  presentBlockTrail,
  type BlockTrailRecordKind,
  type BlockTrailStatus,
} from './block-trail-presentation';
import styles from './BlockTrail.module.css';

export function BlockTrail(props: {
  status: BlockTrailStatus;
  statusLabel: string;
  height?: number | null;
  recordKind?: BlockTrailRecordKind;
  compact?: boolean;
}): ReactNode {
  const { t } = useI18n();
  const height = props.height ?? null;
  const presentation = presentBlockTrail(props.status, height, props.recordKind);
  const previousRank = useRef<number | null>(null);
  const [settlingRank, setSettlingRank] = useState<number | null>(null);

  useEffect(() => {
    const previous = previousRank.current;
    const next = presentation.progressRank;
    previousRank.current = next;
    if (previous === null || next === null || next <= previous) {
      setSettlingRank(null);
      return;
    }
    setSettlingRank(next);
    const timer = window.setTimeout(() => setSettlingRank(null), 200);
    return () => window.clearTimeout(timer);
  }, [presentation.progressRank]);

  return (
    <section
      className={`${styles['trail']} ${props.compact ? styles['compact'] : ''}`}
      aria-label={t('blockTrail.title')}
    >
      <h2 className={styles['title']}>{t('blockTrail.title')}</h2>
      <ol className={styles['steps']}>
        {presentation.steps.map((step, index) => {
          const label = step.id === 'recorded'
            ? presentation.recordKind === 'observed'
              ? t('blockTrail.step.observed')
              : t('blockTrail.step.recorded')
            : step.id === 'network'
              ? step.state === 'warning' || step.state === 'danger'
                ? props.statusLabel
                : presentation.recordKind === 'observed' && step.state === 'current'
                  ? t('blockTrail.detail.waiting')
                  : t('blockTrail.step.network')
              : step.state === 'current'
                ? t('blockTrail.detail.waiting')
                : t('blockTrail.step.confirmation');
          const detail = step.id === 'confirmation' && step.state === 'complete' && height !== null
            ? t('blockTrail.detail.block', { height: height.toLocaleString() })
            : null;
          return (
            <li
              aria-current={step.state === 'current' || step.state === 'warning' ||
                step.state === 'danger' ? 'step' : undefined}
              className={styles['step']}
              data-settle={settlingRank === index + 1}
              data-state={step.state}
              key={step.id}
            >
              <span className={styles['marker']} aria-hidden="true">
                {step.state === 'complete' ? '✓' : index + 1}
              </span>
              <span className={styles['copy']}>
                <strong>{label}</strong>
                {detail === null ? null : <span>{detail}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
