/**
 * Wire-level checks for the extension-local Vault coordinator ops (C0-C1):
 * registry composition, sender gating, payload validation, the locked-privacy
 * gate, and the fact that the channel gate is enforced by the worker rather
 * than negotiated in a payload.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dispatch } from '../../src/background/dispatch';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import type { MessageEnvelope, SenderContext } from '@drey/core/messaging/envelope';
import { OP_SCHEMAS, type OpSpec } from '@drey/core/messaging/ops';
import { bytesToBase64 } from '@drey/core/domain/vault/encoding';
import { PASSWORD } from '@drey/core/testing/vault-helpers';
import { EXTENSION_OP_SCHEMAS } from '../../src/messaging/extension-ops';
import { PASSKEY_OP_SCHEMAS } from '../../src/messaging/passkey-ops';
import { VAULT_COORDINATOR_OP_SCHEMAS } from '../../src/messaging/vault-coordinator-ops';
import { COMMUNITY_VAULT_OP_SCHEMAS } from '../../src/messaging/community-vault-ops';
import { makeHarness } from './service-helpers';

beforeAll(installTestCryptoProvider);

const OPS = Object.keys(VAULT_COORDINATOR_OP_SCHEMAS);

const CHALLENGE = {
  sessionIdHex: 'ab'.repeat(16),
  challengeNonceHex: 'cd'.repeat(32),
  transcriptHashHex: 'ef'.repeat(32),
  expiresAtMs: '4102444800000',
};

function env(sender: SenderContext, op: string, payload: unknown): MessageEnvelope {
  return { protocolVersion: 1, requestId: 'req-0', sender, op, payload };
}

// `coordinator: false` must be spelled explicitly: passing `undefined` for a
// defaulted parameter would silently re-enable the gate this suite is testing.
async function readySetup(coordinator = true) {
  const h = makeHarness(undefined, {
    network: 'signet',
    ...(coordinator
      ? { vaultCoordinatorCapability: { network: 'signet', movement: 'full' } as const }
      : {}),
  });
  const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
  const { sessionId } = await h.service.unlock({ vaultId, password: PASSWORD });
  return { h, vaultId, expectation: { expectedVaultId: vaultId, expectedSessionId: sessionId } };
}

describe('vault coordinator op registry', () => {
  it('extends the core registry without shadowing a core or passkey op', () => {
    for (const op of OPS) {
      expect(op in OP_SCHEMAS, op).toBe(false);
      expect(op in PASSKEY_OP_SCHEMAS, op).toBe(false);
      expect(op in EXTENSION_OP_SCHEMAS, op).toBe(true);
    }
    // The composed registry is the union, with nothing lost in the merge.
    expect(Object.keys(EXTENSION_OP_SCHEMAS)).toHaveLength(
      Object.keys(OP_SCHEMAS).length + Object.keys(PASSKEY_OP_SCHEMAS).length +
        OPS.length + Object.keys(COMMUNITY_VAULT_OP_SCHEMAS).length + 5,
    );
  });

  it('gates every op behind an unlocked session (§7.5)', () => {
    for (const [op, spec] of Object.entries<OpSpec>(VAULT_COORDINATOR_OP_SCHEMAS)) {
      expect(spec.requiresUnlock, op).toBe(true);
      // No coordinator op opts out of the dispatcher's pre-handler gate.
      expect(spec.handlerEnforcesUnlock, op).toBeUndefined();
    }
  });

  it('exposes exactly one secret-bearing response, and only after reauthentication', () => {
    // Only revealRole returns words. The Recovery C ceremony carries bounded
    // public records and never has a mnemonic-shaped response.
    const sanctioned = ['vaultCoordinator.revealRole'];
    for (const [op, spec] of Object.entries(VAULT_COORDINATOR_OP_SCHEMAS)) {
      const shape =
        (spec.response as unknown as { shape?: Record<string, unknown> }).shape ?? {};
      const carriesSecret = 'mnemonic' in shape;
      expect(carriesSecret, op).toBe(sanctioned.includes(op));
      if (carriesSecret) {
        // The sanctioned exception must demand the password in its request.
        expect(spec.request.safeParse({
          expectedVaultId: 'v', expectedSessionId: '00000000-0000-4000-8000-000000000001',
        }).success, op).toBe(false);
      }
      // No response schema anywhere accepts raw key material.
      expect(
        spec.response.safeParse({ seedHex: 'ff', entropyHex: 'ff', dekB64: 'AA==' }).success,
        op,
      ).toBe(false);
    }
  });

  it('never exposes the coordinator to an untrusted sender', () => {
    for (const [op, spec] of Object.entries(VAULT_COORDINATOR_OP_SCHEMAS)) {
      expect(spec.allowedSenders, op).not.toContain('content-bridge');
      expect(spec.allowedSenders, op).not.toContain('approval');
    }
  });

  it('closes the Recovery Center evidence response over every locally verified fact', () => {
    const response = VAULT_COORDINATOR_OP_SCHEMAS['vaultCoordinator.recoveryCReadiness'].response;
    const complete = {
      state: 'not_started',
      localRole: 'absent',
      policyState: 'absent',
      phoneSignerPaired: false,
      standaloneRecoveryPackageAvailable: true,
      policyId: null,
      setupComplete: false,
      kitExported: false,
      backupCheckComplete: false,
      ready: false,
    };
    expect(response.safeParse(complete).success).toBe(true);
    expect(response.safeParse({
      ...complete,
      standaloneRecoveryPackageAvailable: undefined,
    }).success).toBe(false);
    expect(response.safeParse({ ...complete, recoveryScore: 100 }).success).toBe(false);
    expect(response.safeParse({ ...complete, localRole: 'unknown' }).success).toBe(false);
    expect(response.safeParse({ ...complete, policyState: 'present' }).success).toBe(false);
  });
});

describe('vault coordinator dispatch', () => {
  it('rejects an untrusted sender before the handler runs', async () => {
    const s = await readySetup();
    for (const op of OPS) {
      const res = await dispatch(env('content-bridge', op, { ...s.expectation }), s.h.service);
      expect(res, op).toEqual({ ok: false, code: 'ERR_UNAUTHORIZED_CONTEXT' });
    }
  });

  it('answers ERR_LOCKED for every op once locked', async () => {
    const s = await readySetup();
    await s.h.service.lock();
    // Payload validation runs before the unlock gate, so each op gets a
    // schema-valid body: the point is the gate, not the parser.
    const bodies: Record<string, Record<string, unknown>> = {
      'vaultCoordinator.status': {},
      'vaultCoordinator.roleOrigin': {},
      'vaultCoordinator.createRole': { password: PASSWORD, label: 'A' },
      'vaultCoordinator.restoreRole': {
        password: PASSWORD,
        label: 'A',
        // The disposable public fixture phrase; it is checksum-validated by the
        // request schema before the unlock gate this case is actually testing.
        mnemonic: 'grace frog zone boss dawn market donate wagon amateur stadium puppy kind',
      },
      'vaultCoordinator.proveRole': { password: PASSWORD, ...CHALLENGE },
      'vaultCoordinator.revealRole': { password: PASSWORD },
      'vaultCoordinator.beginRoleRecoveryExport': {},
      'vaultCoordinator.exportRoleRecovery': {
        password: PASSWORD,
        credentialIdB64: bytesToBase64(new Uint8Array(16).fill(1)),
        prfSaltB64: bytesToBase64(new Uint8Array(32).fill(3)),
        prfOutputB64: bytesToBase64(new Uint8Array(32).fill(4)),
        assertionClientDataJSONB64: bytesToBase64(new TextEncoder().encode('{}')),
        assertionAuthenticatorDataB64: bytesToBase64(new Uint8Array(37).fill(5)),
        assertionSignatureB64: bytesToBase64(new Uint8Array(8).fill(6)),
      },
      'vaultCoordinator.removeRole': { password: PASSWORD, roleId: 'role-a' },
      'vaultCoordinator.beginImport': {},
      'vaultCoordinator.beginRecoveryCSetup': {},
      'vaultCoordinator.importRecoveryCSetupResponse': { responseHex: '00' },
      'vaultCoordinator.cancelRecoveryCSetup': {},
      'vaultCoordinator.importSigner': { role: 'mobile-b', originHex: 'ab', proofResultHex: 'cd' },
      'vaultCoordinator.createPolicy': {
        password: PASSWORD,
        vaultLabel: 'Vault',
        signerLabels: ['A', 'B', 'C'],
        birthdayHeight: null,
      },
      'vaultCoordinator.policy': {},
      'vaultCoordinator.policyPairingQr': { password: PASSWORD },
      'vaultCoordinator.acknowledgePolicyPairing': { policyId: '11'.repeat(32) },
      'vaultCoordinator.recoveryKit': {},
      'vaultCoordinator.acknowledgeRecoveryKitExport': { policyId: '11'.repeat(32) },
      'vaultCoordinator.beginRecoveryCBackupCheck': {},
      'vaultCoordinator.importRecoveryCBackupCheckResponse': { responseHex: '00' },
      'vaultCoordinator.recoveryCReadiness': {},
      'vaultCoordinator.removePolicy': { password: PASSWORD, policyId: '11'.repeat(32) },
      // C3-C6. Every one of these can move value or observe a real chain, so
      // the locked gate matters more here than anywhere else on the surface.
      'vaultCoordinator.scan': {},
      'vaultCoordinator.depositAddress': { index: 0 },
      'vaultCoordinator.buildPlan': { amountSats: '50000', feeRateSatPerKvB: '5000' },
      'vaultCoordinator.buildCpfp': { feeRateSatPerKvB: '5000' },
      'vaultCoordinator.plan': {},
      'vaultCoordinator.signPlan': { password: PASSWORD },
      'vaultCoordinator.signMobileRequest': {
        password: PASSWORD,
        psbtHex: 'ab',
        approvalEnvelope: {
          version: 1,
          network: 'signet',
          policyId: '11'.repeat(32),
          planId: '22'.repeat(16),
          planDigest: '33'.repeat(32),
          senderOriginHex: 'ab',
          senderChannelIdHex: '44'.repeat(32),
          recipientChannelIdHex: '55'.repeat(32),
          counter: '1',
          expiresAtMs: '9999999999999',
          antiReplayNonceHex: '66'.repeat(32),
          transcriptHashHex: '77'.repeat(32),
          stage: 'request',
          payloadHex: 'ab',
          payloadHash: '88'.repeat(32),
          authenticationSignatureHex: '99'.repeat(64),
        },
      },
      'vaultCoordinator.combinePlan': { psbtHexes: ['ab', 'cd'] },
      'vaultCoordinator.finalizePlan': { psbtHex: 'ab' },
      'vaultCoordinator.broadcastPlan': { transactionHex: 'ab' },
      'vaultCoordinator.reconcilePlan': { planId: '22'.repeat(16) },
      'vaultCoordinator.discardPlan': { planId: '22'.repeat(16) },
    };
    for (const op of OPS) {
      const res = await dispatch(
        env('fullpage', op, { ...bodies[op], ...s.expectation }),
        s.h.service,
      );
      expect(res, op).toEqual({ ok: false, code: 'ERR_LOCKED' });
    }
  });

  it('rejects unknown request fields rather than ignoring them', async () => {
    const s = await readySetup();
    const res = await dispatch(
      env('fullpage', 'vaultCoordinator.status', { ...s.expectation, network: 'mainnet' }),
      s.h.service,
    );
    expect(res).toEqual({ ok: false, code: 'ERR_INVALID_PAYLOAD' });
  });

  it('will not let a payload switch the coordinator on', async () => {
    // The whole point of the §8 gate: the surface is off because the build
    // said so, and there is no field that can say otherwise.
    const s = await readySetup(false);
    // The well-formed request is refused by the worker's gate...
    await expect(
      dispatch(env('fullpage', 'vaultCoordinator.roleOrigin', { ...s.expectation }), s.h.service),
    ).resolves.toEqual({ ok: false, code: 'ERR_VAULT_COORDINATOR_UNAVAILABLE' });

    // ...and every attempt to smuggle an enabling field in is refused earlier
    // still, by the strict request schema. Neither path can return ok.
    for (const extra of [
      { network: 'signet' },
      { available: true },
      { vaultCoordinatorNetwork: 'signet' },
    ]) {
      await expect(
        dispatch(
          env('fullpage', 'vaultCoordinator.roleOrigin', { ...s.expectation, ...extra }),
          s.h.service,
        ),
        JSON.stringify(extra),
      ).resolves.toEqual({ ok: false, code: 'ERR_INVALID_PAYLOAD' });
    }
  });

  it('routes a valid status request through to the service', async () => {
    const s = await readySetup();
    const res = await dispatch(
      env('fullpage', 'vaultCoordinator.status', { ...s.expectation }),
      s.h.service,
    );
    expect(res).toEqual({
      ok: true,
      result: {
        available: true,
        network: 'signet',
        movement: 'full',
        bound: null,
        role: 'absent',
        policy: 'absent',
        importPending: [],
      },
    });
  });

  it('routes one session-bound Recovery Center evidence read without invoking heavy paths', async () => {
    const s = await readySetup();
    const policy = vi.spyOn(s.h.service, 'vaultCoordinatorPolicy');
    const kit = vi.spyOn(s.h.service, 'vaultCoordinatorRecoveryKit');
    const deposit = vi.spyOn(s.h.service, 'vaultCoordinatorDepositAddress');

    await expect(
      dispatch(
        env('fullpage', 'vaultCoordinator.recoveryCReadiness', { ...s.expectation }),
        s.h.service,
      ),
    ).resolves.toEqual({
      ok: true,
      result: {
        state: 'not_started',
        localRole: 'absent',
        policyState: 'absent',
        phoneSignerPaired: false,
        standaloneRecoveryPackageAvailable: true,
        policyId: null,
        setupComplete: false,
        kitExported: false,
        backupCheckComplete: false,
        ready: false,
      },
    });
    expect(policy).not.toHaveBeenCalled();
    expect(kit).not.toHaveBeenCalled();
    expect(deposit).not.toHaveBeenCalled();

    await expect(
      dispatch(
        env('fullpage', 'vaultCoordinator.recoveryCReadiness', {
          ...s.expectation,
          expectedSessionId: '00000000-0000-4000-8000-000000000099',
        }),
        s.h.service,
      ),
    ).resolves.toEqual({ ok: false, code: 'ERR_LOCKED' });
  });

  it('carries the coordinator error codes end to end', async () => {
    const s = await readySetup();
    const res = await dispatch(
      env('fullpage', 'vaultCoordinator.revealRole', { password: PASSWORD, ...s.expectation }),
      s.h.service,
    );
    // A widened code must survive the dispatcher rather than degrade to
    // ERR_INTERNAL — the whole reason WireErrorCode is composed centrally.
    expect(res).toEqual({ ok: false, code: 'ERR_VAULT_ROLE_MISSING' });
  });
});
