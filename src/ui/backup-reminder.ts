/**
 * The deferred-backup reminder opens onboarding with this hash so onboarding
 * resumes the phrase backup directly instead of showing Create/Restore, where
 * the obvious next click would make a second wallet.
 */
export const BACKUP_INTENT_HASH = '#backup';

export function openBackupOnboarding(): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`/onboarding.html${BACKUP_INTENT_HASH}`) });
}
