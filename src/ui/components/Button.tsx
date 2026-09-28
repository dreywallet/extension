import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import styles from './Button.module.css';

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  /** compact: the same button, sized for dense toolbars and list rows. */
  size?: 'default' | 'compact';
  children: ReactNode;
}>(function Button(props, ref) {
  const { variant = 'primary', size = 'default', className, type, ...rest } = props;
  const classes = [
    styles['button'],
    styles[variant],
    size === 'compact' ? styles['compact'] : null,
    className,
  ].filter(Boolean).join(' ');
  return <button ref={ref} type={type ?? 'button'} className={classes} {...rest} />;
});
