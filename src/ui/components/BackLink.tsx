import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import styles from './BackLink.module.css';

/**
 * The one way back from a sub-page: a quiet "← Back" at the top left, so it
 * never competes with the page's own actions or sits beside a destructive one.
 */
export function BackLink(props: { onClick: () => void; disabled?: boolean }): ReactNode {
  const { t } = useI18n();
  return (
    <button type="button" className={styles['back']} onClick={props.onClick} disabled={props.disabled}>
      <span aria-hidden="true">←</span> {t('common.back')}
    </button>
  );
}
