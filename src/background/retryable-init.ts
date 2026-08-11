/**
 * Memoize one successful async initialization while allowing a later caller
 * to retry after a transient failure. Concurrent callers always share the
 * same attempt.
 */
export function retryableInit<T>(initialize: () => Promise<T>): () => Promise<T> {
  let current: Promise<T> | undefined;
  return () => {
    current ??= initialize().catch((error: unknown) => {
      current = undefined;
      throw error;
    });
    return current;
  };
}
