import { describe, expect, it } from 'vitest';
import { EXTENSION_OP_SCHEMAS } from '../../src/messaging/extension-ops';
import {
  RECOVERY_CENTER_E2E_ISOLATION_MARKER,
  RECOVERY_CENTER_E2E_QUERY,
  RECOVERY_CENTER_E2E_SCENARIO_IDS,
  recoveryCenterE2eFixtureResponse,
} from '../../src/entrypoints/fullpage/recovery-center-e2e-fixtures';

const EXPECTATION = {
  expectedVaultId: 'recovery-center-safe-view',
  expectedSessionId: '00000000-0000-4000-8000-000000000042',
};

function href(id: string): string {
  return `chrome-extension://fixture/fullpage.html?${RECOVERY_CENTER_E2E_QUERY}=${id}` +
    '#/settings/recovery';
}

describe('packaged Recovery Center presentation fixtures', () => {
  it('keeps every fixed scenario schema-valid and non-secret', () => {
    expect(new Set(RECOVERY_CENTER_E2E_SCENARIO_IDS).size)
      .toBe(RECOVERY_CENTER_E2E_SCENARIO_IDS.length);
    expect(RECOVERY_CENTER_E2E_ISOLATION_MARKER).toBe('DREY_RECOVERY_CENTER_E2E_ONLY');

    for (const id of RECOVERY_CENTER_E2E_SCENARIO_IDS) {
      for (const [op, payload] of [
        ['session.snapshot', {}],
        ['backup.status', EXPECTATION],
        ['vaultCoordinator.recoveryCReadiness', EXPECTATION],
        ['session.touch', EXPECTATION],
      ] as const) {
        const candidate = recoveryCenterE2eFixtureResponse(op, payload, href(id));
        expect(candidate.requested, `${id}: ${op}`).toBe(true);
        if (!candidate.requested) continue;
        const response = candidate.response as { ok?: unknown; result?: unknown };
        expect(response.ok, `${id}: ${op}`).toBe(true);
        expect(
          EXTENSION_OP_SCHEMAS[op].response.safeParse(response.result).success,
          `${id}: ${op}`,
        ).toBe(true);
      }
    }
  });

  it('declines ordinary pages and fails closed for invalid fixture URLs or sessions', () => {
    expect(recoveryCenterE2eFixtureResponse(
      'session.snapshot', {}, 'chrome-extension://fixture/fullpage.html#/settings/recovery',
    )).toEqual({ requested: false });
    expect(recoveryCenterE2eFixtureResponse(
      'session.snapshot', {}, href('unknown'),
    )).toEqual({ requested: true, response: { ok: false, code: 'ERR_INTERNAL' } });
    expect(recoveryCenterE2eFixtureResponse(
      'backup.status', { ...EXPECTATION, expectedSessionId: crypto.randomUUID() },
      href('vault-ready'),
    )).toEqual({ requested: true, response: { ok: false, code: 'ERR_SESSION_STALE' } });
    expect(recoveryCenterE2eFixtureResponse(
      'vault.verifyBackup', EXPECTATION, href('vault-ready'),
    )).toEqual({ requested: true, response: { ok: false, code: 'ERR_INTERNAL' } });
  });
});
