import { describe, expect, it, vi } from 'vitest';
import { registerFirstRunOnboarding } from '../../src/background/first-run';

function setup(options: { hasProfile?: boolean; openFails?: boolean } = {}) {
  let listener: ((details: { reason: string }) => void) | null = null;
  const openTab = vi.fn(() => options.openFails === true
    ? Promise.reject(new Error('no window'))
    : Promise.resolve());
  registerFirstRunOnboarding({
    onInstalled: { addListener: (next) => { listener = next; } },
    openTab,
    getUrl: (path) => `chrome-extension://id${path}`,
    hasProfile: () => Promise.resolve(options.hasProfile ?? false),
  });
  return { fire: (reason: string) => listener?.({ reason }), openTab };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('first-run onboarding', () => {
  it('opens onboarding on a fresh install', async () => {
    const { fire, openTab } = setup();
    fire('install');
    await settle();
    expect(openTab).toHaveBeenCalledExactlyOnceWith('chrome-extension://id/onboarding.html');
  });

  it.each(['update', 'chrome_update', 'shared_module_update'])('stays quiet on %s', async (reason) => {
    const { fire, openTab } = setup();
    fire(reason);
    await settle();
    expect(openTab).not.toHaveBeenCalled();
  });

  it('stays quiet when an install event finds an existing profile', async () => {
    const { fire, openTab } = setup({ hasProfile: true });
    fire('install');
    await settle();
    expect(openTab).not.toHaveBeenCalled();
  });

  it('swallows a tab-creation failure', async () => {
    const { fire, openTab } = setup({ openFails: true });
    expect(() => fire('install')).not.toThrow();
    await settle();
    expect(openTab).toHaveBeenCalledOnce();
  });
});
