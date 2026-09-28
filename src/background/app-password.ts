import {
  openVaultPayload,
  unlockVault,
  type UnlockedVault,
} from '@drey/core/domain/vault/vault';
import {
  unlockProfileCredential,
  unwrapProfileSecret,
} from '@drey/core/domain/vault/profile-credential';
import type { VaultRecordV1 } from '@drey/core/domain/vault/record';
import type { StorageArea } from '../adapters/storage/area';
import {
  loadProfileCredential,
  profileWalletSecret,
} from '../adapters/storage/profile-credential-store';

/**
 * Opens a wallet record with the one app password.
 *
 * A wallet added while the profile was unlocked is wrapped under the profile
 * key rather than the password, so `unlockVault(record, password)` can never
 * open it. Prove the password against the profile credential instead and
 * unwrap the wallet's profile-held DEK. Legacy wallets without a profile
 * wrapper keep the direct password unwrap. Read-only: nothing is linked or
 * migrated here. The caller owns and zeroizes the returned DEK.
 */
export async function unlockRecordWithAppPassword(
  local: StorageArea,
  record: VaultRecordV1,
  password: string,
): Promise<UnlockedVault> {
  const profile = await loadProfileCredential(local);
  const wrapper = profile === null ? null : profileWalletSecret(profile, record.vaultId);
  if (profile === null || wrapper === null) return unlockVault(record, password);
  const profileKey = await unlockProfileCredential(profile.credential, password);
  let dek: Uint8Array | undefined;
  try {
    dek = unwrapProfileSecret(wrapper, profileKey);
    return { vaultId: record.vaultId, dek, payload: openVaultPayload(record, dek) };
  } catch (error) {
    dek?.fill(0);
    throw error;
  } finally {
    profileKey.fill(0);
  }
}
