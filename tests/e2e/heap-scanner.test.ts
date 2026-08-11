import { describe, expect, it } from 'vitest';
import { createSecretScanner } from './heap-scanner';

const SECRET = 'drey-heap-scanner-unit-secret';
const OTHER = 'drey-heap-scanner-unit-other';

describe('heap snapshot secret scanner', () => {
  it('reports nothing for a clean stream', () => {
    const scanner = createSecretScanner([{ label: 'secret', value: SECRET }]);
    scanner.push('{"strings":["alpha","beta"]}');
    expect(scanner.labels()).toEqual([]);
  });

  it('finds a secret contained in one chunk', () => {
    const scanner = createSecretScanner([{ label: 'secret', value: SECRET }]);
    scanner.push(`{"strings":["${SECRET}"]}`);
    expect(scanner.labels()).toEqual(['secret']);
  });

  it('finds a secret split across a chunk boundary at every split point', () => {
    for (let split = 1; split < SECRET.length; split += 1) {
      const scanner = createSecretScanner([{ label: 'secret', value: SECRET }]);
      scanner.push(`prefix-${SECRET.slice(0, split)}`);
      scanner.push(`${SECRET.slice(split)}-suffix`);
      expect(scanner.labels(), `split at ${split}`).toEqual(['secret']);
    }
  });

  it('finds a secret spread across three chunks', () => {
    const scanner = createSecretScanner([{ label: 'secret', value: SECRET }]);
    const third = Math.floor(SECRET.length / 3);
    scanner.push(SECRET.slice(0, third));
    scanner.push(SECRET.slice(third, third * 2));
    scanner.push(SECRET.slice(third * 2));
    expect(scanner.labels()).toEqual(['secret']);
  });

  it('carries no more than the longest secret between chunks', () => {
    // A stale tail would make an unrelated later chunk match by accident.
    const scanner = createSecretScanner([{ label: 'secret', value: SECRET }]);
    scanner.push(SECRET.slice(0, 5));
    scanner.push('x'.repeat(SECRET.length * 4));
    scanner.push(SECRET.slice(5));
    expect(scanner.labels()).toEqual([]);
  });

  it('reports each distinct secret once, by label, sorted', () => {
    const scanner = createSecretScanner([
      { label: 'zulu', value: SECRET },
      { label: 'alpha', value: OTHER },
    ]);
    scanner.push(`${SECRET} ${OTHER} ${SECRET}`);
    expect(scanner.labels()).toEqual(['alpha', 'zulu']);
  });

  it('never exposes a secret value through its findings', () => {
    const scanner = createSecretScanner([{ label: 'secret', value: SECRET }]);
    scanner.push(SECRET);
    expect(JSON.stringify(scanner.labels())).not.toContain(SECRET);
  });

  it('ignores empty secret values instead of matching everything', () => {
    const scanner = createSecretScanner([{ label: 'unset', value: '' }]);
    scanner.push('any content at all');
    expect(scanner.labels()).toEqual([]);
  });
});
