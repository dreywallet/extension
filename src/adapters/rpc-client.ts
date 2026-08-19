/**
 * Typed RPC client for extension UI surfaces (spec §5.2): builds a validated
 * envelope and sends it to the sole authority (the service worker). UIs are
 * pure RPC clients — they hold no vault material. Request/response types are
 * inferred from the op registry, so a UI call site cannot drift from the
 * worker's schemas without a compile error. The registry is the extension's
 * merged one: core OP_SCHEMAS plus the extension-local passkey ops, and error
 * codes are validated against the widened extension wire-code union.
 */
import type { z } from 'zod';
import { makeEnvelope, type SenderContext } from '@drey/core/messaging/envelope';
import { EXTENSION_OP_SCHEMAS, WireErrorCode } from '../messaging/extension-ops';

type Schemas = typeof EXTENSION_OP_SCHEMAS;
export type Op = keyof Schemas;
export type OpRequest<O extends Op> = z.infer<Schemas[O]['request']>;
export type OpResult<O extends Op> = z.infer<Schemas[O]['response']>;
export type RpcResult<O extends Op> =
  | { ok: true; result: OpResult<O> }
  | { ok: false; code: WireErrorCode };

export type Rpc = <O extends Op>(op: O, payload: OpRequest<O>) => Promise<RpcResult<O>>;

export function makeRpc(sender: SenderContext): Rpc {
  return async (op, payload) => {
    try {
      let raw: unknown;
      if (typeof __BUILD_CHANNEL__ !== 'undefined' && __BUILD_CHANNEL__ === 'test') {
        const recoveryFixtureRequested = typeof window !== 'undefined' &&
          window.location.search.includes('dreyRecoveryScenario=');
        if (recoveryFixtureRequested) {
          const fixture = await import('../entrypoints/fullpage/recovery-center-e2e-fixtures');
          const candidate = fixture.recoveryCenterE2eFixtureResponse(op, payload, window.location.href);
          raw = candidate.requested
            ? candidate.response
            : await chrome.runtime.sendMessage(makeEnvelope(sender, op, payload));
        } else {
          raw = await chrome.runtime.sendMessage(makeEnvelope(sender, op, payload));
        }
      } else {
        raw = await chrome.runtime.sendMessage(makeEnvelope(sender, op, payload));
      }
      if ((raw as { ok?: unknown } | null)?.ok === true) {
        const parsed = EXTENSION_OP_SCHEMAS[op].response.safeParse((raw as { result?: unknown }).result);
        return parsed.success ? { ok: true, result: parsed.data } : { ok: false, code: 'ERR_INTERNAL' };
      }
      if ((raw as { ok?: unknown } | null)?.ok === false) {
        const code = WireErrorCode.safeParse((raw as { code?: unknown }).code);
        if (code.success) return { ok: false, code: code.data };
      }
      return { ok: false, code: 'ERR_INTERNAL' };
    } catch {
      // Worker unreachable (restarting/killed): surface as a typed internal
      // error instead of an unhandled rejection in the UI.
      return { ok: false, code: 'ERR_INTERNAL' };
    }
  };
}
