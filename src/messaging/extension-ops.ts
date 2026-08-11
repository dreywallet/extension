/**
 * The single composition point for the extension's RPC surface.
 *
 * `@drey/core` owns the portable wallet protocol (`OP_SCHEMAS`) because mobile
 * consumes it too. Surfaces that are inherently browser-extension-shaped are
 * layered on here instead of widening the shared protocol:
 *
 * - popup Home hydration reads a browser-session snapshot;
 * - passkey unlock (ADR 0007 §5) is bound to a Chromium extension RP origin;
 * - the Vault coordinator (ADR 0007 §8) is an extension-owned surface whose
 *   network and movement authority are fixed at bundle time.
 *
 * Both extend the wire error enum, so `WireErrorCode` lives here as well: the
 * dispatcher, rpc client, and UI error mapping must all speak the same widened
 * union, or a leaked code would degrade to ERR_INTERNAL — fail closed.
 *
 * Note what this registry does and does not assert. It declares which ops
 * exist and how their payloads are shaped; it is not the availability gate.
 * Coordinator ops are declared unconditionally so their types stay static, and
 * are refused at runtime by the worker unless the build channel injected a
 * coordinator network (see WalletServiceDeps.vaultCoordinatorNetwork).
 */
import { z } from 'zod';
import { ErrorCode } from '@drey/core/messaging/envelope';
import { OP_SCHEMAS, type OpSpec } from '@drey/core/messaging/ops';
import { PASSKEY_ERROR_CODES, PASSKEY_OP_SCHEMAS, type PasskeyErrorCode } from './passkey-ops';
import {
  VAULT_COORDINATOR_ERROR_CODES,
  VAULT_COORDINATOR_OP_SCHEMAS,
  type VaultCoordinatorErrorCode,
} from './vault-coordinator-ops';

const EXTENSION_ERROR_CODES = [
  'ERR_INVALID_ADDRESS',
  // A transport or service-availability failure. Keep this distinct from
  // ERR_DATA_STALE: gallery.media.open uses the latter only when a freshly
  // verified gateway revision has overtaken the wallet's classification, so
  // the popup can safely synchronize instead of retrying every outage.
  'ERR_GATEWAY_UNAVAILABLE',
] as const;

const extensionLocalOpSchemas = {
  'wallet.home.snapshot': {
    request: OP_SCHEMAS['wallet.home'].request,
    response: z.object({
      home: OP_SCHEMAS['wallet.home'].response.nullable(),
    }).strict(),
    allowedSenders: ['popup', 'sidepanel', 'fullpage'],
    requiresUnlock: true,
    // The handler validates the exact session while reading the bound record,
    // avoiding a redundant queue entry in the generic dispatcher.
    handlerEnforcesUnlock: true,
  },
  /**
   * Home-only paint projection. Unlike gallery.cached, the worker revalidates
   * every returned item against the current encrypted UTXO/gallery records
   * before exposing its inert preview bytes.
   */
  'gallery.home.cached': {
    request: OP_SCHEMAS['gallery.cached'].request,
    response: OP_SCHEMAS['gallery.cached'].response,
    allowedSenders: ['popup', 'sidepanel'],
    requiresUnlock: true,
    // The handler validates the exact session while assembling the local
    // projection, avoiding a redundant queue entry in the generic dispatcher.
    handlerEnforcesUnlock: true,
  },
  'session.touch': {
    request: z.object({
      expectedVaultId: z.string().min(1),
      expectedSessionId: z.string().uuid(),
    }).strict(),
    response: z.object({ deadline: z.number().int().positive() }).strict(),
    allowedSenders: ['popup', 'sidepanel', 'fullpage'],
    requiresUnlock: true,
    handlerEnforcesUnlock: true,
  },
} satisfies Record<string, OpSpec>;

/** Core registry plus every extension-local surface. */
export const EXTENSION_OP_SCHEMAS = {
  ...OP_SCHEMAS,
  ...extensionLocalOpSchemas,
  ...PASSKEY_OP_SCHEMAS,
  ...VAULT_COORDINATOR_OP_SCHEMAS,
};

export type ExtensionLocalOp = keyof typeof extensionLocalOpSchemas;

export type ExtensionWireErrorCode =
  | typeof EXTENSION_ERROR_CODES[number]
  | PasskeyErrorCode
  | VaultCoordinatorErrorCode;

export type WireErrorCode = ErrorCode | ExtensionWireErrorCode;

export const WireErrorCode: z.ZodType<WireErrorCode> = z.union([
  ErrorCode,
  z.enum(EXTENSION_ERROR_CODES),
  z.enum(PASSKEY_ERROR_CODES),
  z.enum(VAULT_COORDINATOR_ERROR_CODES),
]);
