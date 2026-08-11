import type { ReactNode } from 'react';
import styles from './BrandMark.module.css';

/** In-product wordmark paired with the same mark used by the extension icon. */
export function BrandMark(props: {
  compact?: boolean | undefined;
  className?: string | undefined;
}): ReactNode {
  return (
    <span
      className={[
        styles['brand'],
        props.compact === true ? styles['compact'] : null,
        props.className,
      ].filter(Boolean).join(' ')}
      aria-label="DREY"
    >
      <img
        aria-hidden="true"
        className={styles['mark']}
        decoding="async"
        draggable={false}
        height={128}
        src="/icon/128.png"
        width={128}
      />
      <span className={styles['wordmark']} aria-hidden="true">DREY</span>
    </span>
  );
}
