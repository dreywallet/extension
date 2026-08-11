import { beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD } from '@drey/core/testing/vault-helpers';
import { bytesToBase64 } from '@drey/core/domain/vault/encoding';
import { zeroize } from '@drey/core/domain/vault/vault';
import { savePasskeyCredentials } from '../../src/adapters/storage/passkey-credentials';
import {
  decodeVaultRoleARecoveryPackage,
  unwrapVaultRoleARecoveryPackage,
} from '../../src/vault-recovery/role-a-recovery-package';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { SoftwarePasskey } from '../helpers/software-passkey';
import { makeHarness } from './service-helpers';

beforeAll(installTestCryptoProvider);

const RP_ORIGIN = 'chrome-extension://lgcnmmbgabemdkgacjpcdebbjmmblbmn';
const credentialIdB64 = bytesToBase64(new Uint8Array(32).fill(7));
const prfSaltB64 = bytesToBase64(new Uint8Array(32).fill(9));
const prfOutput = new Uint8Array(32).fill(10);

async function setup() {
  const h = makeHarness(undefined, {
    network: 'signet',
    passkeyRpOrigin: RP_ORIGIN,
    vaultCoordinatorCapability: { network: 'signet', movement: 'full' },
  });
  const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
  const unlocked = await h.service.unlock({ vaultId, password: PASSWORD });
  const expectation = { expectedVaultId: vaultId, expectedSessionId: unlocked.sessionId };
  const role = await h.service.vaultCoordinatorCreateRole({
    password: PASSWORD,
    label: 'Desktop A',
    ...expectation,
  });
  const passkey = await SoftwarePasskey.create(credentialIdB64);
  await savePasskeyCredentials(h.local, [{
    vaultId,
    credentialIdB64,
    publicKeyAlg: passkey.publicKeyAlg,
    publicKeySpkiB64: passkey.publicKeySpkiB64,
    createdAtMs: 1,
  }]);
  return { h, expectation, role, passkey };
}

async function exportRequest(s: Awaited<ReturnType<typeof setup>>) {
  const { challengeB64 } = await s.h.service.vaultCoordinatorBeginRoleRecoveryExport(
    s.expectation,
  );
  const assertion = await s.passkey.assert({ challengeB64, rpOrigin: RP_ORIGIN });
  return {
    password: PASSWORD,
    credentialIdB64,
    prfSaltB64,
    prfOutputB64: bytesToBase64(prfOutput),
    ...assertion,
    ...s.expectation,
  };
}

describe('Vault Role A recovery export', () => {
  it('requires password plus a verified passkey and produces an offline-openable package', async () => {
    const s = await setup();
    const result = await s.h.service.vaultCoordinatorExportRoleRecovery(await exportRequest(s));
    expect(result).toMatchObject({
      fileName: 'drey-vault-role-a-recovery.json',
      credentialIdB64,
      rpOrigin: RP_ORIGIN,
    });
    const recoveryPackage = decodeVaultRoleARecoveryPackage(result.packageJson);
    const recovered = unwrapVaultRoleARecoveryPackage(recoveryPackage, prfOutput);
    try {
      expect(recovered.mnemonic.split(' ')).toHaveLength(12);
      expect(recovered.origin).toEqual(s.role.role.origin);
    } finally {
      zeroize(recovered.entropy);
    }
  });

  it('rejects a wrong password, tampered assertion, or unbound credential', async () => {
    const s = await setup();
    const request = await exportRequest(s);
    await expect(s.h.service.vaultCoordinatorExportRoleRecovery({
      ...request,
      password: 'wrong password',
    })).rejects.toBeTruthy();
    await expect(s.h.service.vaultCoordinatorExportRoleRecovery(request)).rejects.toMatchObject({
      code: 'ERR_PASSKEY_UNAVAILABLE',
    });
    const tampered = await exportRequest(s);
    await expect(s.h.service.vaultCoordinatorExportRoleRecovery({
      ...tampered,
      assertionSignatureB64: bytesToBase64(new Uint8Array(64).fill(1)),
    })).rejects.toMatchObject({ code: 'ERR_PASSKEY_INVALID_PRF' });
    const unbound = await exportRequest(s);
    await expect(s.h.service.vaultCoordinatorExportRoleRecovery({
      ...unbound,
      credentialIdB64: bytesToBase64(new Uint8Array(32).fill(99)),
    })).rejects.toMatchObject({ code: 'ERR_PASSKEY_UNAVAILABLE' });
  });
});
