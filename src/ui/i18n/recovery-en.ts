/** Browser-specific recovery wording; portable recovery semantics stay in en.ts. */
export const recoveryEn = {
  'recovery.platform.randomSource':
    'Randomness source: this browser’s cryptographically secure random generator (Web Crypto).',
  'recovery.forgot.link': 'Forgot password?',
  'recovery.forgot.title': 'Forgot your password?',
  'recovery.forgot.body':
    'No one can reset or recover your app password — not even Drey. It never leaves this device. Your bitcoin is safe as long as you have your recovery phrase.',
  'recovery.forgot.stepsTitle': 'To start over with your recovery phrase:',
  'recovery.forgot.step1': 'Right-click the Drey icon in your browser toolbar and choose Remove from Chrome.',
  'recovery.forgot.step2': 'Install Drey again from the Chrome Web Store.',
  'recovery.forgot.step3': 'Choose Restore a wallet and enter your recovery phrase.',
  'recovery.forgot.warning':
    'Removing Drey deletes every wallet on this device. Only do this if you have the recovery phrase for each one, and your Vault recovery kit if you use Drey Vault.',
  'recovery.forgot.back': 'Back to unlock',
} as const;

export type RecoveryMessageKey = keyof typeof recoveryEn;
