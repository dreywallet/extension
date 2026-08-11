import { describe, expect, it } from 'vitest';
import { RECOVERED_ADDRESS_NOTICE_KEY } from '../../src/adapters/storage/keys';
import {
  dismissRecoveredAddressNotice,
  recoveredAddressNoticeDismissed,
} from '../../src/ui/recovered-address-notice';
import { installFakeChrome } from './fake-rpc';

describe('recovered-address notice persistence', () => {
  it('is vault-specific, versioned, and safely defaults malformed records', async () => {
    const storage = installFakeChrome({});
    expect(await recoveredAddressNoticeDismissed('vault-a')).toBe(false);
    await dismissRecoveredAddressNotice('vault-a');
    expect(await recoveredAddressNoticeDismissed('vault-a')).toBe(true);
    expect(await recoveredAddressNoticeDismissed('vault-b')).toBe(false);
    expect(storage.get(RECOVERED_ADDRESS_NOTICE_KEY)).toEqual({
      version: 1,
      dismissedVaultIds: ['vault-a'],
    });

    storage.set(RECOVERED_ADDRESS_NOTICE_KEY, {
      version: 99,
      dismissedVaultIds: ['vault-b'],
    });
    expect(await recoveredAddressNoticeDismissed('vault-b')).toBe(false);
  });

  it('bounds the non-secret record and retains the most recent vaults', async () => {
    const storage = installFakeChrome({});
    for (let index = 0; index < 101; index += 1) {
      await dismissRecoveredAddressNotice(`vault-${index}`);
    }
    expect(storage.get(RECOVERED_ADDRESS_NOTICE_KEY)).toEqual({
      version: 1,
      dismissedVaultIds: Array.from({ length: 100 }, (_, index) => `vault-${index + 1}`),
    });
  });

  it('hides the notice for the current popup when storage cannot be read', async () => {
    installFakeChrome({});
    const originalGet = chrome.storage.local.get;
    chrome.storage.local.get = () => Promise.reject(new Error('unavailable'));
    try {
      expect(await recoveredAddressNoticeDismissed('vault-a')).toBe(true);
    } finally {
      chrome.storage.local.get = originalGet;
    }
  });
});
