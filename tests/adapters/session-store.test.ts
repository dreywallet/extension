import { describe, expect, it } from 'vitest';
import {
  clearSession,
  getSession,
  putSession,
  setSessionAccessTrusted,
  type UnlockSession,
} from '../../src/adapters/session/session-store';
import { makeFakeArea } from './fake-area';

const SESSION: UnlockSession = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  vaultId: 'v-1',
  dekB64: btoa('\0'.repeat(32)),
  deadline: 1_752_969_600_000,
};

describe('session-store', () => {
  it('restricts access to trusted contexts (§7.4)', async () => {
    const area = makeFakeArea();
    await setSessionAccessTrusted(area);
    expect(area.accessLevel).toBe('TRUSTED_CONTEXTS');
    expect(area.accessLevelCalls).toBe(1);
  });

  it('round-trips a session and clears it', async () => {
    const area = makeFakeArea();
    await putSession(area, SESSION);
    expect(await getSession(area)).toEqual(SESSION);

    await clearSession(area);
    expect(await getSession(area)).toBeNull();
  });

  it('clears a malformed session or non-32-byte DEK', async () => {
    const area = makeFakeArea();
    expect(await getSession(area)).toBeNull();

    area.store.set('squirrel:session', { vaultId: 'v-1' }); // missing dekB64/deadline
    expect(await getSession(area)).toBeNull();
    expect(area.store.has('squirrel:session')).toBe(false);

    area.store.set('squirrel:session', { ...SESSION, dekB64: 'AAAA' });
    expect(await getSession(area)).toBeNull();
    expect(area.store.has('squirrel:session')).toBe(false);
  });
});
