import { beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  addProfileSecret,
  createProfileCredential,
} from '@drey/core/domain/vault/profile-credential';
import {
  loadProfileCredential,
  saveProfileCredential,
} from '../../src/adapters/storage/profile-credential-store';
import { PROFILE_CREDENTIAL_KEY, PROFILE_CREDENTIAL_STAGING_KEY } from '../../src/adapters/storage/keys';
import { makeFakeArea } from './fake-area';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';

beforeAll(installTestCryptoProvider);

describe('profile credential store', () => {
  it('keeps the verified canonical record after an interrupted staged write', async () => {
    const area = makeFakeArea();
    const created = await createProfileCredential({
      profileId: 'default',
      password: 'correct horse battery staple',
      kdfParams: {
        paramsVersion: 1,
        algorithm: 'argon2id13',
        opsLimit: 1,
        memLimitBytes: 64 * 1024 * 1024,
        parallelism: 1,
      },
    }, {
      random: (length) => new Uint8Array(randomBytes(length)),
      now: () => 1_753_920_000_000,
    });
    const secret = new Uint8Array(randomBytes(32));
    try {
      const wrapper = addProfileSecret({
        profileId: 'default',
        profileKey: created.profileKey,
        secretId: 'wallet-1',
        kind: 'wallet-dek',
        secret,
      }, { random: (length) => new Uint8Array(randomBytes(length)) });
      const state = { version: 1 as const, credential: created.credential, secrets: [wrapper] };
      await saveProfileCredential(area, state);
      expect(await loadProfileCredential(area)).toEqual(state);

      area.store.set(PROFILE_CREDENTIAL_STAGING_KEY, { version: 1, broken: true });
      expect(await loadProfileCredential(area)).toEqual(state);
      expect(area.store.has(PROFILE_CREDENTIAL_STAGING_KEY)).toBe(false);
      expect(area.store.has(PROFILE_CREDENTIAL_KEY)).toBe(true);
    } finally {
      created.profileKey.fill(0);
      secret.fill(0);
    }
  });
});
