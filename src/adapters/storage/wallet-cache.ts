/**
 * Encrypted wallet cache — port and codec (spec §5.1 IndexedDB cache, §7.5
 * locked privacy).
 *
 * Records are sealed with XChaCha20-Poly1305 under the active vault's DEK —
 * the same primitive and AAD-binding style as the vault payload — so cache
 * content at rest is ciphertext only, unreadable while locked (the DEK lives
 * solely in chrome.storage.session and is zeroized after each use). The AAD
 * binds vaultId, network, record type, and key: a record moved between
 * vaults, networks, or slots fails authentication instead of decrypting in
 * the wrong context.
 *
 * This module is IndexedDB-free (unit-testable with an in-memory fake); the
 * sole IDB-touching implementation is wallet-cache-idb.ts.
 */
import type { z } from 'zod';
import { aeadEncrypt, aeadDecrypt, NONCE_BYTES } from '@drey/core/domain/vault/crypto';
import { utf8ToBytes } from '@drey/core/domain/vault/encoding';
import type { AeadBox } from '@drey/core/domain/vault/record';
import type { Network } from '@drey/core/domain/keys/derivation';

export type WalletCacheRecordType =
  | 'utxos'
  | 'history'
  | 'scanState'
  | 'accountsMeta'
  | 'publicAccountDefinition'
  | 'accountSigningBinding'
  | 'plans'
  | 'broadcastRecovery'
  | 'providerBroadcastRecovery'
  | 'marketplaceWorkflows'
  | 'marketplaceReservations'
  | 'gallery'
  | 'transactions'
  | 'activityEvidence'
  | 'labels'
  | 'addressBook';

export interface WalletCacheKey {
  vaultId: string;
  network: Network;
  type: WalletCacheRecordType;
  /** e.g. "a0:payment" for per-(account,lane) utxos; "all" for singletons. */
  key: string;
}

export interface WalletCacheRecord extends WalletCacheKey {
  v: 1;
  box: AeadBox;
  updatedAt: number;
}

export interface WalletCachePort {
  get(key: WalletCacheKey): Promise<WalletCacheRecord | undefined>;
  put(record: WalletCacheRecord): Promise<void>;
  delete(key: WalletCacheKey): Promise<void>;
  listKeys(vaultId: string, network: Network, type: WalletCacheRecordType): Promise<string[]>;
  clearVault(vaultId: string): Promise<void>;
}

function aadFor(key: WalletCacheKey): string {
  return `walletcache:1:${key.vaultId}:${key.network}:${key.type}:${key.key}`;
}

/**
 * JSON with bigint sats as tagged decimal strings. The codec is symmetric and
 * schema-validated after decrypt, so a stale or foreign shape rejects instead
 * of deserializing garbage.
 */
const BIGINT_TAG = '__sats__:';

export function encodeCachePlaintext(value: unknown): Uint8Array {
  return utf8ToBytes(
    JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? `${BIGINT_TAG}${v}` : v)),
  );
}

export function decodeCachePlaintext(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes), (_k, v: unknown) =>
    typeof v === 'string' && v.startsWith(BIGINT_TAG) ? BigInt(v.slice(BIGINT_TAG.length)) : v,
  );
}

export function sealRecord(
  dek: Uint8Array,
  value: unknown,
  key: WalletCacheKey,
  nonce: Uint8Array,
  updatedAt: number,
): WalletCacheRecord {
  if (nonce.length !== NONCE_BYTES) throw new Error(`nonce must be ${NONCE_BYTES} bytes`);
  return {
    v: 1,
    ...key,
    box: aeadEncrypt(dek, encodeCachePlaintext(value), aadFor(key), nonce),
    updatedAt,
  };
}

/** Throws VaultError('decrypt-failed') on wrong context; ZodError on shape drift. */
export function openRecord<T>(dek: Uint8Array, record: WalletCacheRecord, schema: z.ZodType<T>): T {
  const plain = decodeCachePlaintext(aeadDecrypt(dek, record.box, aadFor(record)));
  return schema.parse(plain);
}
