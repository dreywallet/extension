import { describe, expect, it } from 'vitest';
import {
  completeSeedWord, couldBecomeSeedWord, isSeedWord, splitPastedPhrase,
} from '../../src/ui/seed-words';

describe('seed word typing help', () => {
  it('completes a unique prefix of three or more letters', () => {
    expect(completeSeedWord('aban')).toBe('abandon');
    expect(completeSeedWord('  ZOO ')).toBe('zoo');
    expect(completeSeedWord('abs')).toBe('abs'); // absent, absorb, abstract…
    expect(completeSeedWord('ab')).toBe('ab'); // too short to decide
    expect(completeSeedWord('act')).toBe('act'); // a word and a prefix
    expect(completeSeedWord('xyzq')).toBe('xyzq');
  });

  it('only flags text that can no longer become a word', () => {
    expect(couldBecomeSeedWord('')).toBe(true);
    expect(couldBecomeSeedWord('aba')).toBe(true);
    expect(couldBecomeSeedWord('abq')).toBe(false);
    expect(isSeedWord('Abandon')).toBe(true);
    expect(isSeedWord('aband')).toBe(false);
  });

  it('reads numbered, line-separated and comma-separated phrases', () => {
    expect(splitPastedPhrase('1. abandon 2. ability\n3) able')).toEqual(['abandon', 'ability', 'able']);
    expect(splitPastedPhrase('abandon, ability,able')).toEqual(['abandon', 'ability', 'able']);
    expect(splitPastedPhrase('1 abandon\n2 ability')).toEqual(['abandon', 'ability']);
    expect(splitPastedPhrase('   ')).toEqual([]);
  });
});
