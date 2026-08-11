/**
 * A secret to look for in a heap snapshot. Only `label` may ever reach a
 * reporter, an assertion message, or a log line; `value` must stay in process
 * memory so a scanner finding never becomes the leak it was meant to catch.
 */
export type NamedSecret = { readonly label: string; readonly value: string };

export type SecretScanner = {
  push(chunk: string): void;
  labels(): string[];
};

/**
 * Streaming substring scanner. Heap snapshots arrive as many megabytes of JSON
 * across CDP chunks, so the snapshot is never assembled, retained, or written
 * to disk. A carry-over tail one character shorter than the longest secret
 * keeps a value that straddles a chunk boundary detectable.
 */
export function createSecretScanner(secrets: readonly NamedSecret[]): SecretScanner {
  const longest = Math.max(0, ...secrets.map(({ value }) => value.length));
  const overlap = Math.max(0, longest - 1);
  const found = new Set<string>();
  let tail = '';
  return {
    push(chunk: string): void {
      const window = tail + chunk;
      for (const { label, value } of secrets) {
        if (value.length > 0 && window.includes(value)) found.add(label);
      }
      // slice(-0) would return the whole window, so guard the empty case.
      tail = overlap === 0 ? '' : window.slice(Math.max(0, window.length - overlap));
    },
    labels(): string[] {
      return [...found].sort();
    },
  };
}
