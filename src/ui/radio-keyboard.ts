import type { KeyboardEvent } from 'react';

/** WAI-ARIA radiogroup keyboard behavior for button-backed segmented controls. */
export function handleRadioKey<T>(
  event: KeyboardEvent<HTMLButtonElement>,
  values: readonly T[],
  selected: T,
  onSelect: (value: T) => void,
): void {
  let nextIndex: number | null = null;
  const currentIndex = values.indexOf(selected);
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    nextIndex = (currentIndex + 1) % values.length;
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    nextIndex = (currentIndex - 1 + values.length) % values.length;
  } else if (event.key === 'Home') {
    nextIndex = 0;
  } else if (event.key === 'End') {
    nextIndex = values.length - 1;
  }
  if (nextIndex === null) return;
  const next = values[nextIndex];
  if (next === undefined) return;
  event.preventDefault();
  onSelect(next);
  const group = event.currentTarget.closest('[role="radiogroup"]');
  const radios = group?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
  radios?.[nextIndex]?.focus();
}
