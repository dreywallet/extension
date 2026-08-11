/**
 * Unlock session in chrome.storage.session (spec §7.4).
 *
 * Holds only DEK-equivalent material — the base64 data-encryption key — bound
 * to the active vault and an idle deadline. The seed/entropy stay encrypted in
 * local; the DEK decrypts a record's payload on demand. This slot is never
 * written to chrome.storage.local, IndexedDB, logs, or telemetry, and access is
 * restricted to trusted contexts so the in-page content bridge can never read
 * it (spec §7.4). chrome.storage.session is in-memory and cleared on browser
 * restart, which satisfies the browser-restart lock path for free.
 */
import { z } from 'zod';
import { base64ToBytes, bytesToBase64 } from '@drey/core/domain/vault/encoding';
import type { StorageArea } from '../storage/area';

const SESSION_KEY = 'squirrel:session';

export type SessionAccessLevel = 'TRUSTED_CONTEXTS' | 'TRUSTED_AND_UNTRUSTED_CONTEXTS';

/** The session area additionally exposes access-level control. */
export interface SessionArea extends StorageArea {
  setAccessLevel(options: { accessLevel: SessionAccessLevel }): Promise<void>;
}

export interface UnlockSession {
  sessionId: string;
  vaultId: string;
  dekB64: string;
  deadline: number; // epoch ms; session is dead once now >= deadline
}

const sessionSchema = z
  .object({
    sessionId: z.string().uuid(),
    vaultId: z.string().min(1),
    dekB64: z.string().min(1),
    deadline: z.number().int().positive(),
  })
  .strict();

/** Restrict the session store to trusted extension contexts (spec §7.4). */
export async function setSessionAccessTrusted(area: SessionArea): Promise<void> {
  await area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
}

export async function putSession(area: StorageArea, session: UnlockSession): Promise<void> {
  await area.set({ [SESSION_KEY]: session });
}

export async function getSession(area: StorageArea): Promise<UnlockSession | null> {
  const out = await area.get(SESSION_KEY);
  const raw = out[SESSION_KEY];
  if (raw === undefined) return null;
  const parsed = sessionSchema.safeParse(raw);
  if (parsed.success) {
    try {
      const dek = base64ToBytes(parsed.data.dekB64);
      const canonical = dek.length === 32 && bytesToBase64(dek) === parsed.data.dekB64;
      dek.fill(0);
      if (canonical) return parsed.data;
    } catch {
      // Fall through to fail-closed cleanup below.
    }
  }
  // A malformed slot may still contain DEK-equivalent bytes. Do not merely
  // ignore it: remove it immediately so subsequent contexts cannot recover it.
  await clearSession(area);
  return null;
}

export async function clearSession(area: StorageArea): Promise<void> {
  await area.remove(SESSION_KEY);
}
