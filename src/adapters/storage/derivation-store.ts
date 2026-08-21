/**
 * Per-account derivation-state persistence (spec §8.1) over chrome.storage.local.
 *
 * The domain reserves change indexes purely (counter-based never-reuse); this
 * adapter enforces the caller contract that the advanced state is persisted
 * *before* the reserved index is used — so a change index is burned even if the
 * worker dies before the transaction broadcasts.
 */
import { z } from 'zod';
import type { AddressKind, Network } from '@drey/core/domain/keys/derivation';
import {
  BIP32_INDEX_EXHAUSTED,
  initialDerivationState,
  reserveChangeIndex,
  type AccountDerivationStateV1,
} from '@drey/core/domain/keys/derivation-state';
import { getJson, setJson, type StorageArea } from './area';
import { derivationKey } from './keys';

const stateSchema = z
  .object({
    version: z.literal(1),
    network: z.enum(['mainnet', 'signet', 'regtest']),
    kind: z.enum(['payment', 'ordinals']),
    accountIndex: z.number().int().nonnegative().max(BIP32_INDEX_EXHAUSTED - 1),
    externalMode: z.literal('stable'),
    nextExternalIndex: z.literal(0),
    nextChangeIndex: z.number().int().nonnegative().max(BIP32_INDEX_EXHAUSTED),
  })
  .strict();

export async function loadDerivationState(
  area: StorageArea,
  vaultId: string,
  network: Network,
  kind: AddressKind,
  account: number,
  accountId?: string,
  legacyFallback = false,
): Promise<AccountDerivationStateV1> {
  const initial = initialDerivationState(kind, network, account); // validates the requested account
  const key = derivationKey(vaultId, network, kind, account, accountId);
  let raw = await getJson<unknown>(area, key);
  if (raw === undefined && accountId !== undefined && legacyFallback) {
    raw = await getJson<unknown>(area, derivationKey(vaultId, network, kind, account));
  }
  if (raw === undefined) return initial;

  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid persisted derivation state: ${key}`);
  if (
    parsed.data.network !== network ||
    parsed.data.kind !== kind ||
    parsed.data.accountIndex !== account
  ) {
    throw new Error(`persisted derivation state does not match storage key: ${key}`);
  }
  return parsed.data;
}

export async function saveDerivationState(
  area: StorageArea,
  vaultId: string,
  state: AccountDerivationStateV1,
  accountId?: string,
): Promise<void> {
  const parsed = stateSchema.safeParse(state);
  if (!parsed.success) throw new Error('refusing to persist invalid derivation state');
  await setJson(
    area,
    derivationKey(
      vaultId,
      parsed.data.network,
      parsed.data.kind,
      parsed.data.accountIndex,
      accountId,
    ),
    parsed.data,
  );
}

/**
 * Reserve the next change index and persist the burned counter before returning
 * it (spec §8.1 burn-at-reservation). The caller may only use the returned
 * index after this resolves.
 */
export async function reserveChangeIndexPersisted(
  area: StorageArea,
  vaultId: string,
  state: AccountDerivationStateV1,
  accountId?: string,
): Promise<{ index: number; state: AccountDerivationStateV1 }> {
  const next = reserveChangeIndex(state);
  await saveDerivationState(area, vaultId, next.state, accountId);
  return next;
}
