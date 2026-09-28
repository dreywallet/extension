import { beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD } from '@drey/core/testing/vault-helpers';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { loadVaults } from '../../src/adapters/storage/vault-store';
import { unlockRecordWithAppPassword } from '../../src/background/app-password';
import { makeHarness } from './service-helpers';

beforeAll(installTestCryptoProvider);

/**
 * A wallet added while the profile is unlocked (onboarding `existingProfile`)
 * is wrapped under the profile key, not the app password. Every password gate
 * on that wallet must still accept the one app password.
 */
async function secondWalletSetup() {
  const h = makeHarness();
  const first = await h.service.create({ name: 'First', password: PASSWORD });
  await h.service.unlock({ vaultId: first.vaultId, password: PASSWORD });
  const second = await h.service.create({ name: 'Second' });
  const unlocked = await h.service.switchVault({ vaultId: second.vaultId, password: PASSWORD });
  return {
    h,
    first,
    second,
    expectation: { expectedVaultId: second.vaultId, expectedSessionId: unlocked.sessionId },
  };
}

describe('app password on wallets added under an unlocked profile', () => {
  it('reauthenticates dApp approvals with the app password', async () => {
    const { h } = await secondWalletSetup();
    await expect(h.service.providerReauthenticate(PASSWORD)).resolves.toBeUndefined();
    await expect(h.service.providerReauthenticate('not-the-app-password'))
      .rejects.toMatchObject({ code: 'wrong-password' });
  });

  it('creates a Community Vault owner root with the app password', async () => {
    const { h, expectation } = await secondWalletSetup();
    await expect(h.service.communityVaultCreate({
      campaignId: 'campaign-2', ownerId: 'owner-0', label: 'Second wallet', password: PASSWORD, ...expectation,
    })).resolves.toMatchObject({ owner: { readiness: 'needs-recovery' } });
  });

  it('opens both profile-wrapped and password-created wallets, and nothing else', async () => {
    const { h, first, second } = await secondWalletSetup();
    const map = await loadVaults(h.local);
    for (const vaultId of [first.vaultId, second.vaultId]) {
      const unlocked = await unlockRecordWithAppPassword(h.local, map[vaultId]!, PASSWORD);
      expect(unlocked.vaultId).toBe(vaultId);
      expect(unlocked.payload.version).toBe(1);
      unlocked.dek.fill(0);
      await expect(unlockRecordWithAppPassword(h.local, map[vaultId]!, 'not-the-app-password'))
        .rejects.toMatchObject({ code: 'wrong-password' });
    }
  });
});
