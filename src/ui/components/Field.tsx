import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';
import styles from './Field.module.css';

/** Labeled input with optional error line. Password fields keep paste enabled (§7.2). */
export const Field = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string | undefined;
}>(function Field(props, ref): ReactNode {
  const { label, error, className, ...rest } = props;
  const id = useId();
  const errorId = `${id}-error`;
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
        aria-describedby={error !== undefined ? errorId : undefined}
        {...rest}
      />
      {error !== undefined ? (
        <span role="alert" id={errorId} className={styles['error']}>
          {error}
        </span>
      ) : null}
    </div>
  );
});
