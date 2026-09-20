import { useCallback, useEffect, useRef, useState } from 'react';
import type { RuneDraft } from '../../messaging/rune-ops';
import type { ActiveSessionExpectation } from './use-session';
import { useRpc } from './use-rpc';

export function meaningfulRuneDraft(draft: RuneDraft | null): draft is RuneDraft {
  return draft !== null && (draft.recipient.trim() !== '' || draft.quantity.trim() !== '');
}

/** Saving form data never chooses a screen. Writes are dispatched in edit order. */
export function useRuneDraft(expectation: ActiveSessionExpectation, accountId: string) {
  const rpc = useRpc();
  const [draft, setDraft] = useState<RuneDraft | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const [writeFailed, setWriteFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const revision = useRef(0);
  const tail = useRef(Promise.resolve(true));
  const { expectedVaultId, expectedSessionId } = expectation;
  useEffect(() => {
    let active = true;
    const initial = revision.current;
    void tail.current.then(() => rpc('runes.draft', { expectedVaultId, expectedSessionId, accountId })).then((result) => {
      if (!active || revision.current !== initial) return;
      if (result.ok) setDraft(meaningfulRuneDraft(result.result.draft) ? result.result.draft : null);
      setReadFailed(!result.ok);
      setLoaded(true);
    });
    return () => { active = false; };
  }, [rpc, expectedVaultId, expectedSessionId, accountId, attempt]);

  const save = useCallback((next: RuneDraft | null) => {
    const current = ++revision.current;
    setDraft(next);
    setLoaded(true);
    const write = tail.current.then(async () => {
      const result = await rpc('runes.draft', { expectedVaultId, expectedSessionId, accountId, draft: next });
      if (revision.current === current) setWriteFailed(!result.ok);
      return result.ok;
    });
    tail.current = write;
    return write;
  }, [rpc, expectedVaultId, expectedSessionId, accountId]);
  return { draft, loaded, failed: readFailed || writeFailed, save, retry: () => { if (readFailed) setAttempt((value) => value + 1); else void save(draft); } };
}
