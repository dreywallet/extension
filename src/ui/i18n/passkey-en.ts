/**
 * Extension-only English strings for passkey unlock (ADR 0007 §5, A2).
 *
 * Deliberately a separate catalog from en.ts: mobile keeps en.ts/es.ts
 * byte-identical to its own copies (mobile/tests/ui/i18n.test.ts), and
 * WebAuthn passkey unlock has no mobile equivalent, so these keys live only
 * in the extension and are merged into CATALOGS by i18n/index.tsx.
 *
 * Copy rules (ADR 0007 §5): a passkey is optional convenience; the password
 * always works; a passkey is never recovery material; removing an enrollment
 * here does not delete platform/cloud copies of the passkey itself.
 */
export const passkeyEn = {
  'passkey.error.duplicate': 'This passkey is already set up for this wallet.',
  'passkey.error.mismatch': 'This passkey record does not belong to this wallet or this build.',
  'passkey.error.invalidPrf': 'The passkey did not return usable key material. Use your password.',
  'passkey.error.unavailable': 'Passkey unlock is not available here. Use your password.',

  'passkey.unlock.button': 'Unlock with a passkey',
  'passkey.unlock.failed': 'Passkey unlock did not work. Enter your password instead.',
  'passkey.onboarding.passwordNote': 'After you back up this wallet, you can set up optional passkey unlock.',
  'passkey.onboarding.title': 'Unlock faster with a passkey',
  'passkey.onboarding.body': 'Optional: use Touch ID, your device, or a security key to unlock. Your password still works. A passkey cannot recover this wallet.',
  'passkey.onboarding.setup': 'Set up passkey',
  'passkey.onboarding.skip': 'Not now',

  'settings.passkeys.entry': 'Passkey unlock',

  'passkey.settings.title': 'Passkey unlock',
  'passkey.settings.intro':
    'A passkey (for example Touch ID or a security key) can unlock this wallet without typing your password. It is optional: your password always works, and a passkey is never a replacement for your recovery phrase.',
  'passkey.settings.none': 'No passkeys are set up for this wallet.',
  'passkey.settings.added': 'Added {date}',
  'passkey.settings.add': 'Add a passkey',
  'passkey.settings.add.body':
    'Enter your password to add a passkey. Your browser will then ask you to verify twice: once to create the passkey and once to confirm it can unlock this wallet.',
  'passkey.settings.label': 'Passkey name',
  'passkey.settings.defaultLabel': 'Passkey',
  'passkey.settings.rename': 'Rename',
  'passkey.settings.save': 'Save',
  'passkey.settings.remove': 'Remove',
  'passkey.settings.remove.body':
    'Enter your password to remove this passkey from Drey. It will no longer unlock this wallet. This does not delete the passkey from your device or its cloud sync — manage those in your system credential manager.',
  'passkey.settings.removed': 'Passkey removed.',
  'passkey.settings.unsupported':
    'This browser or device cannot create a passkey with the required key-derivation (PRF) support.',
  'passkey.settings.prfMissing':
    'This authenticator cannot be used: it does not support the required key-derivation (PRF) feature. Drey stored nothing, but a passkey may still have been created — you can delete it in your system credential manager.',
  'passkey.settings.verifyFailed':
    'The new passkey could not be confirmed, so Drey stored nothing. A passkey may still have been created — you can delete it in your system credential manager.',
  'passkey.settings.invalid.notice':
    '{count} stored passkey record(s) cannot be used by this wallet or build.',
  'passkey.settings.invalid.purge': 'Remove unusable records',
} as const;

export type PasskeyMessageKey = keyof typeof passkeyEn;
