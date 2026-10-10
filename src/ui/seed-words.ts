import { wordlist as english } from '@scure/bip39/wordlists/english';

/**
 * Typing help for recovery-phrase entry. The BIP39 English list is public and
 * every word is identified by its first four letters, so completing a unique
 * prefix saves typing without guessing. Nothing here stores or sends a word.
 */
const WORDS: readonly string[] = english;
const WORD_SET = new Set(WORDS);

export function isSeedWord(value: string): boolean {
  return WORD_SET.has(value.trim().toLowerCase());
}

/** True while the text can still become a valid word as the user keeps typing. */
export function couldBecomeSeedWord(value: string): boolean {
  const prefix = value.trim().toLowerCase();
  return prefix === '' || WORDS.some((word) => word.startsWith(prefix));
}

/**
 * The word a finished entry stands for: an exact word, or the only word that
 * starts with at least three typed letters. Anything else is returned as typed
 * (trimmed and lowercased) so the user sees and fixes it.
 */
export function completeSeedWord(value: string): string {
  const prefix = value.trim().toLowerCase();
  if (prefix.length < 3 || WORD_SET.has(prefix)) return prefix;
  const matches = WORDS.filter((word) => word.startsWith(prefix));
  return matches.length === 1 ? matches[0]! : prefix;
}

/**
 * Words from pasted text, tolerating the ways people write phrases down:
 * "1. abandon 2. ability", one word per line, or comma-separated lists.
 */
export function splitPastedPhrase(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,;]+/u)
    .map((token) => token.replace(/^\d+[.):-]?/u, '').replace(/[^a-z]/gu, ''))
    .filter((token) => token !== '');
}
