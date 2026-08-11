/**
 * Passkey credential public-key sidecar (A2.1, review Finding 1).
 *
 * At enrollment the worker binds each credential's public key (SPKI, from
 * AuthenticatorAttestationResponse.getPublicKey()) so that every later unlock
 * can verify a fresh assertion signature instead of trusting a bare PRF
 * output. The records are public data (a public key, an ID, a timestamp) but
 * they are an *authorization* surface: an envelope with no bound credential
 * record is never offered for a ceremony and can never unlock.
 *
 * Like passkey-store, the root value is loaded tolerantly (malformed →
 * empty, which fails closed to password unlock) and consumers validate each
 * record before trusting it.
 */
import { base64ToBytes, bytesToBase64 } from '@drey/core/domain/vault/encoding';
import type { PasskeyCoseAlg } from '../../background/webauthn-verify';
import { getJson, setJson, type StorageArea } from './area';
import { PASSKEY_CREDENTIALS_KEY } from './keys';

export interface PasskeyCredentialRecord {
  vaultId: string;
  credentialIdB64: string;
  publicKeyAlg: PasskeyCoseAlg;
  publicKeySpkiB64: string;
  createdAtMs: number;
}

function isCanonicalBase64(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return bytesToBase64(base64ToBytes(value)) === value;
  } catch {
    return false;
  }
}

function isCredentialRecord(value: unknown): value is PasskeyCredentialRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['vaultId'] === 'string' &&
    isCanonicalBase64(record['credentialIdB64']) &&
    (record['publicKeyAlg'] === -7 || record['publicKeyAlg'] === -257) &&
    isCanonicalBase64(record['publicKeySpkiB64']) &&
    typeof record['createdAtMs'] === 'number'
  );
}

export async function loadPasskeyCredentials(area: StorageArea): Promise<PasskeyCredentialRecord[]> {
  const raw = await getJson<unknown>(area, PASSKEY_CREDENTIALS_KEY);
  if (!Array.isArray(raw)) return [];
  return raw.filter(isCredentialRecord);
}

export async function savePasskeyCredentials(
  area: StorageArea,
  records: readonly PasskeyCredentialRecord[],
): Promise<void> {
  await setJson(area, PASSKEY_CREDENTIALS_KEY, records);
}

/** The bound public key for one vault + credential, or null when unbound. */
export function passkeyCredentialFor(
  records: readonly PasskeyCredentialRecord[],
  vaultId: string,
  credentialIdB64: string,
): PasskeyCredentialRecord | null {
  return (
    records.find(
      (record) => record.vaultId === vaultId && record.credentialIdB64 === credentialIdB64,
    ) ?? null
  );
}
