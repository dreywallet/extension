import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeRpc } from '../../src/adapters/rpc-client';

afterEach(() => vi.unstubAllGlobals());

function installResponse(response: unknown): void {
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: () => Promise.resolve(response),
    },
  });
}

describe('rpc response validation', () => {
  it('accepts a response matching the operation schema', async () => {
    installResponse({ ok: true, result: { locked: true } });
    await expect(makeRpc('popup')('vault.lock', {})).resolves.toEqual({ ok: true, result: { locked: true } });
  });

  it('maps malformed success and error envelopes to ERR_INTERNAL', async () => {
    installResponse({ ok: true, result: { locked: false } });
    await expect(makeRpc('popup')('vault.lock', {})).resolves.toEqual({ ok: false, code: 'ERR_INTERNAL' });

    installResponse({ ok: false, code: 'NOT_A_REAL_CODE' });
    await expect(makeRpc('popup')('vault.lock', {})).resolves.toEqual({ ok: false, code: 'ERR_INTERNAL' });
  });

  it('maps an undefined worker response to ERR_INTERNAL', async () => {
    installResponse(undefined);
    await expect(makeRpc('popup')('vault.lock', {})).resolves.toEqual({ ok: false, code: 'ERR_INTERNAL' });
  });

  it('preserves the extension-local gateway availability code', async () => {
    installResponse({ ok: false, code: 'ERR_GATEWAY_UNAVAILABLE' });
    await expect(makeRpc('popup')('vault.lock', {})).resolves.toEqual({
      ok: false,
      code: 'ERR_GATEWAY_UNAVAILABLE',
    });
  });
});
