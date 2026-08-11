import type { InputHTMLAttributes, ReactNode } from 'react';
import { Field } from './Field';

/**
 * Input for a single seed word: everything that could leak or "help" is off —
 * no autocomplete, autocorrect, spellcheck, or capitalization.
 */
export function WordInput(
  props: InputHTMLAttributes<HTMLInputElement> & {
    label: string;
    error?: string | undefined;
    masked?: boolean;
  },
): ReactNode {
  const { masked = false, ...input } = props;
  return (
    <Field
      {...input}
      type={masked ? 'password' : 'text'}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="none"
      spellCheck={false}
      inputMode="text"
    />
  );
}
