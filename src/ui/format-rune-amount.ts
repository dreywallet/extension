import { formatRuneQuantity } from '@drey/core/domain/runes/amounts';

/** Exact display grouping, including values beyond Number precision. Inputs stay ungrouped. */
export function formatRuneAmount(value: string, divisibility: number, locale: string, symbol: string | null): string {
  const decimal = locale.startsWith('es') ? ',' : '.';
  const group = decimal === ',' ? '.' : ',';
  const [whole, fraction] = formatRuneQuantity(value, divisibility, locale).split(decimal);
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  return `${grouped}${fraction ? decimal + fraction : ''} ${symbol || '¤'}`;
}
