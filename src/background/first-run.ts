/**
 * Open onboarding once, on a fresh install. Chrome hides a new extension's
 * toolbar icon in the puzzle-piece menu, so without this the first run
 * depends on the user finding the icon on their own. Updates and browser
 * restarts do not reopen it, and neither does an install event that finds a
 * profile already present (a reinstall of an unpacked build keeps storage).
 */
export type FirstRunDeps = {
  onInstalled: { addListener: (listener: (details: { reason: string }) => void) => void };
  openTab: (url: string) => Promise<unknown>;
  getUrl: (path: string) => string;
  hasProfile: () => Promise<boolean>;
};

export function registerFirstRunOnboarding(deps: FirstRunDeps): void {
  deps.onInstalled.addListener((details) => {
    if (details.reason !== 'install') return;
    void deps.hasProfile()
      .then((exists) => exists ? undefined : deps.openTab(deps.getUrl('/onboarding.html')))
      .catch(() => undefined);
  });
}
