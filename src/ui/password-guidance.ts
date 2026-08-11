import { normalizePassword } from '@drey/core/domain/vault/password';

// Deliberately small and local: this is immediate, advisory UX only. The worker
// keeps the stable 12-character policy and never rejects a password from this
// list, avoiding brittle network checks or a large runtime dependency.
const COMMON_NEW_PASSWORDS = new Set([
  '123456789012',
  'iloveyou1234',
  'letmeinletmein',
  'password1234',
  'qwertyuiop12',
]);

export function isCommonNewPassword(password: string): boolean {
  return COMMON_NEW_PASSWORDS.has(normalizePassword(password).toLocaleLowerCase('en-US'));
}
