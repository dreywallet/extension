import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import styles from './Field.module.css';

/** Labeled input with optional hint and error lines. Password fields keep paste enabled (§7.2). */
export const Field = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
}>(function Field(props, ref): ReactNode {
  const { label, hint, error, className, ...rest } = props;
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint !== undefined ? hintId : null, error !== undefined ? errorId : null]
    .filter((value): value is string => value !== null)
    .join(' ') || undefined;
  return (
    <div className={[styles['field'], className].filter(Boolean).join(' ')}>
      <label className={styles['label']} htmlFor={id}>
        {label}
      </label>
      <input
        ref={ref}
        id={id}
        className={styles['input']}
        aria-invalid={error !== undefined || undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {hint !== undefined ? (
        <span id={hintId} className={styles['hint']}>
          {hint}
        </span>
      ) : null}
      {error !== undefined ? (
        <span role="alert" id={errorId} className={styles['error']}>
          {error}
        </span>
      ) : null}
    </div>
  );
});
