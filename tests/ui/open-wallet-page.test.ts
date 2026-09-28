import { afterEach, describe, expect, it, vi } from 'vitest';
import { openWalletPage } from '../../src/ui/open-wallet-page';

const BASE = 'chrome-extension://drey/fullpage.html';

function stubChrome(contexts: Array<{ tabId: number; windowId: number; documentUrl?: string }>) {
  const chromeStub = {
    runtime: {
      getURL: (path: string) => `chrome-extension://drey${path}`,
      getContexts: vi.fn(() => Promise.resolve(contexts)),
      ContextType: { TAB: 'TAB' },
    },
    tabs: { create: vi.fn(() => Promise.resolve()), update: vi.fn(() => Promise.resolve()) },
    windows: { update: vi.fn(() => Promise.resolve()) },
  };
  vi.stubGlobal('chrome', chromeStub);
  return chromeStub;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('openWalletPage', () => {
  it('opens a new wallet tab when none is open', async () => {
    const stub = stubChrome([{ tabId: 3, windowId: 1, documentUrl: 'chrome-extension://drey/onboarding.html' }]);
    await openWalletPage('#/settings');
    expect(stub.tabs.create).toHaveBeenCalledWith({ url: `${BASE}#/settings` });
    expect(stub.tabs.update).not.toHaveBeenCalled();
  });

  it('switches an open wallet tab to the section and focuses it', async () => {
    const stub = stubChrome([{ tabId: 7, windowId: 2, documentUrl: `${BASE}#/send` }]);
    await openWalletPage('#/settings');
    expect(stub.tabs.update).toHaveBeenCalledWith(7, { active: true, url: `${BASE}#/settings` });
    expect(stub.windows.update).toHaveBeenCalledWith(2, { focused: true });
    expect(stub.tabs.create).not.toHaveBeenCalled();
  });

  it('only focuses a tab already on that section, so its state is kept', async () => {
    const stub = stubChrome([{ tabId: 7, windowId: 2, documentUrl: `${BASE}#/settings` }]);
    await openWalletPage('#/settings');
    expect(stub.tabs.update).toHaveBeenCalledWith(7, { active: true });
  });

  it('falls back to a new tab when the lookup fails', async () => {
    const stub = stubChrome([]);
    stub.runtime.getContexts.mockRejectedValueOnce(new Error('unsupported'));
    await openWalletPage('#/send');
    expect(stub.tabs.create).toHaveBeenCalledWith({ url: `${BASE}#/send` });
  });

  it('changes section in place inside the full page', async () => {
    const stub = stubChrome([]);
    window.history.replaceState(null, '', '/fullpage.html');
    await openWalletPage('#/send/activity');
    expect(window.location.hash).toBe('#/send/activity');
    expect(stub.tabs.create).not.toHaveBeenCalled();
  });
});
