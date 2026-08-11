/**
 * Error mapping for the worker (spec §5.2): domain VaultErrorCodes and
 * service-level failures become stable envelope ErrorCodes so callers never see
 * the raw domain error type.
 */
import type { VaultErrorCode } from '@drey/core/domain/vault/errors';
import type { WireErrorCode } from '../messaging/extension-ops';

/** A state-machine failure that already carries a wire error code (e.g. not-found). */
export class RpcError extends Error {
  readonly code: WireErrorCode;
  constructor(code: WireErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'RpcError';
    this.code = code;
  }
}

export function vaultErrorToCode(code: VaultErrorCode): WireErrorCode {
  switch (code) {
    case 'wrong-password':
      return 'ERR_WRONG_PASSWORD';
    case 'weak-password':
      return 'ERR_WEAK_PASSWORD';
    case 'tampered':
      return 'ERR_VAULT_TAMPERED';
    case 'unsupported-version':
      return 'ERR_UNSUPPORTED_VERSION';
    // decrypt-failed and crypto-provider-not-initialized are internal
    // conditions, not caller-actionable — surface them as a generic internal
    // error.
    case 'decrypt-failed':
    case 'crypto-provider-not-initialized':
      return 'ERR_INTERNAL';
    // Passkey envelope codes (ADR 0007 Workstreams A1/A2): raised only by the
    // extension-local passkey.* ops, mapped onto extension-local wire codes.
    case 'identity-mismatch':
      return 'ERR_PASSKEY_IDENTITY_MISMATCH';
    case 'invalid-prf-output':
      return 'ERR_PASSKEY_INVALID_PRF';
    case 'duplicate-credential':
      return 'ERR_PASSKEY_DUPLICATE';
  }
}
