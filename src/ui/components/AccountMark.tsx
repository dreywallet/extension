import { useMemo, type ReactNode } from 'react';
import { accountMark } from '../account-mark';
import styles from './AccountMark.module.css';

/**
 * Deterministic per-account identity art (§10.4 shape, never colour alone).
 *
 * Rendered as one inert SVG path built from locally computed data, following the
 * `QrCode.tsx` precedent, so it needs no image source and works unchanged under
 * the approval page's stricter CSP — which allows no `img-src` at all.
 *
 * Decorative by default: wherever the account is already named in text, the mark
 * must not announce itself a second time. Pass `label` only where it is the
 * accessible name for something.
 *
 * It identifies an account; it does not verify one. Callers must not present it
 * as a safety check or let it stand in for a displayed address.
 */
export function AccountMark(props: {
  seed: string;
  label?: string | undefined;
  size?: 'sm' | 'md' | undefined;
  className?: string | undefined;
}): ReactNode {
  const mark = useMemo(() => accountMark(props.seed), [props.seed]);
  const labelled = props.label !== undefined && props.label !== '';
  return (
    <svg
      className={[styles['mark'], styles[props.size ?? 'sm'], props.className]
        .filter(Boolean)
        .join(' ')}
      viewBox={`0 0 ${mark.size} ${mark.size}`}
      focusable="false"
      shapeRendering="crispEdges"
      {...(labelled
        ? { role: 'img', 'aria-label': props.label }
        : { 'aria-hidden': true })}
    >
      <rect className={styles['ground']} width={mark.size} height={mark.size} />
      <path className={styles['cells']} d={mark.path} />
    </svg>
  );
}
