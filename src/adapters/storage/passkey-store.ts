/**
 * Passkey envelope persistence over chrome.storage.local (ADR 0007 §5, A2).
 *
 * The store holds an array of raw envelope values and deliberately does NOT
 * validate them on load: classification (valid / wrong identity / malformed)
 * is the wallet service's job, per record, with core's fail-closed parser. A
 * write therefore never silently drops a record it merely cannot read — only
 * explicit removal (passkey.remove, purge, vault removal) discards entries.
 *
 * Envelopes are convenience ciphertext: losing them degrades to password
 * unlock (the fail-closed direction), so a malformed root value degrades to
 * an empty list rather than quarantining. Entries that are not plain objects
 * can never be attributed to a vault or credential and are dropped at read
 * time for the same reason.
 */
import { getJson, setJson, type StorageArea } from './area';
import { PASSKEY_ENVELOPES_KEY } from './keys';

/** A stored envelope value: unvalidated, but always a plain object. */
export type RawPasskeyEnvelope = Record<string, unknown>;

function isPlainObject(value: unknown): value is RawPasskeyEnvelope {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function loadPasskeyEnvelopes(area: StorageArea): Promise<RawPasskeyEnvelope[]> {
  const raw = await getJson<unknown>(area, PASSKEY_ENVELOPES_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPlainObject);
}

export async function savePasskeyEnvelopes(
  area: StorageArea,
  envelopes: readonly RawPasskeyEnvelope[],
): Promise<void> {
  await setJson(area, PASSKEY_ENVELOPES_KEY, envelopes);
}

/** Entries attributable to one vault by their raw vaultId field. */
export function passkeyEnvelopesForVault(
  envelopes: readonly RawPasskeyEnvelope[],
  vaultId: string,
): RawPasskeyEnvelope[] {
  return envelopes.filter((entry) => entry['vaultId'] === vaultId);
}
