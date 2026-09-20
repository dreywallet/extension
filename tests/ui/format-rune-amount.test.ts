import { describe, expect, it } from 'vitest';
import { formatRuneAmount } from '../../src/ui/format-rune-amount';
describe('Rune amount display', () => {
  it('groups EN and ES without changing precision', () => {
    expect(formatRuneAmount('473038', 2, 'en', '⧉')).toBe('4,730.38 ⧉');
    expect(formatRuneAmount('473038', 2, 'es', '⧉')).toBe('4.730,38 ⧉');
    expect(formatRuneAmount('340282366920938463463374607431768211455', 0, 'en', null)).toBe('340,282,366,920,938,463,463,374,607,431,768,211,455 ¤');
    expect(formatRuneAmount('1', 38, 'en', null)).toBe('0.00000000000000000000000000000000000001 ¤');
  });
});
