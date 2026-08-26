import {
  validateProfileCredentialStructure,
  validateProfileWrappedSecretStructure,
  type ProfileCredentialV1,
  type ProfileWrappedSecretV1,
} from '@drey/core/domain/vault/profile-credential';
import { getJson, setJson, type StorageArea } from './area';
import { PROFILE_CREDENTIAL_KEY, PROFILE_CREDENTIAL_STAGING_KEY } from './keys';

export interface StoredProfileCredentialV1 {
  version: 1;
  credential: ProfileCredentialV1;
  secrets: ProfileWrappedSecretV1[];
}

function parseProfileState(raw: unknown): StoredProfileCredentialV1 {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('profile credential is malformed');
  }
  const candidate = raw as Partial<StoredProfileCredentialV1>;
  if (candidate.version !== 1 || !Array.isArray(candidate.secrets)) {
    throw new Error('profile credential is malformed');
  }
  const credential = validateProfileCredentialStructure(candidate.credential);
  const secrets = candidate.secrets.map(validateProfileWrappedSecretStructure);
  const identities = new Set<string>();
  for (const secret of secrets) {
    if (secret.profileId !== credential.profileId) {
      throw new Error('profile secret belongs to another profile');
    }
    const identity = `${secret.kind}:${secret.secretId}`;
    if (identities.has(identity)) throw new Error('duplicate profile secret');
    identities.add(identity);
  }
  return { version: 1, credential, secrets };
}

export async function loadProfileCredential(
  area: StorageArea,
): Promise<StoredProfileCredentialV1 | null> {
  await area.remove(PROFILE_CREDENTIAL_STAGING_KEY);
  const raw = await getJson<unknown>(area, PROFILE_CREDENTIAL_KEY);
  return raw === undefined ? null : parseProfileState(raw);
}

export async function saveProfileCredential(
  area: StorageArea,
  value: StoredProfileCredentialV1,
): Promise<void> {
  const verified = parseProfileState(value);
  await setJson(area, PROFILE_CREDENTIAL_STAGING_KEY, verified);
  const staged = parseProfileState(await getJson<unknown>(area, PROFILE_CREDENTIAL_STAGING_KEY));
  await setJson(area, PROFILE_CREDENTIAL_KEY, staged);
  await area.remove(PROFILE_CREDENTIAL_STAGING_KEY);
}

export function profileWalletSecret(
  state: StoredProfileCredentialV1,
  vaultId: string,
): ProfileWrappedSecretV1 | null {
  return state.secrets.find((secret) =>
    secret.kind === 'wallet-dek' && secret.secretId === vaultId) ?? null;
}
