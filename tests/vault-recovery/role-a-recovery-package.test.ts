import { beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, TEST_PARAMS } from '@drey/core/testing/vault-helpers';
import { entropyToMnemonic, mnemonicToSeed } from '@drey/core/domain/keys/mnemonic';
import { bytesToBase64, bytesToHex } from '@drey/core/domain/vault/encoding';
import { deriveVaultRoleOrigin } from '@drey/core/domain/vault/multisig-role';
import { createVaultRecord, unlockVault, webCryptoDeps, zeroize } from '@drey/core/domain/vault/vault';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import {
  createVaultRoleARecoveryPackage,
  decodeVaultRoleARecoveryPackage,
  encodeVaultRoleARecoveryPackage,
  unwrapVaultRoleARecoveryPackage,
} from '../../src/vault-recovery/role-a-recovery-package';

beforeAll(installTestCryptoProvider);

const entropy = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
const mnemonic = entropyToMnemonic(entropy);
const seed = mnemonicToSeed(mnemonic);
const prfOutput = new Uint8Array(32).fill(41);

async function fixture() {
  const roleId = 'desktop-role-a-recovery-test';
  const secret = await createVaultRecord({
    vaultId: roleId,
    name: 'vault-role-desktop-a',
    password: PASSWORD,
    payload: { version: 1, entropyHex: bytesToHex(entropy), seedHex: bytesToHex(seed) },
    kdfParams: TEST_PARAMS,
  }, webCryptoDeps());
  const unlocked = await unlockVault(secret, PASSWORD);
  try {
    return createVaultRoleARecoveryPackage({
      network: 'mainnet',
      roleId,
      origin: deriveVaultRoleOrigin(seed, 'desktop-a', 'mainnet'),
      secret,
      dek: unlocked.dek,
      prfOutput,
      rpOrigin: 'chrome-extension://kngidlmmbfmnoeimngkajdlbdenlhgof',
      credentialIdB64: bytesToBase64(new Uint8Array(32).fill(17)),
      prfSalt: new Uint8Array(32).fill(18),
      hkdfSalt: new Uint8Array(32).fill(19),
      nonce: new Uint8Array(24).fill(20),
      createdAtMs: 1_754_438_400_000,
    });
  } finally {
    zeroize(unlocked.dek);
  }
}

describe('Vault Role A offline recovery package', () => {
  it('round-trips the exact Role A words without the app password', async () => {
    const created = await fixture();
    const decoded = decodeVaultRoleARecoveryPackage(encodeVaultRoleARecoveryPackage(created));
    const recovered = unwrapVaultRoleARecoveryPackage(decoded, prfOutput);
    try {
      expect(recovered.mnemonic).toBe(mnemonic);
      expect(recovered.origin).toEqual(created.origin);
    } finally {
      zeroize(recovered.entropy);
    }
  });

  it('fails closed for the wrong passkey output or any identity graft', async () => {
    const created = await fixture();
    expect(() => unwrapVaultRoleARecoveryPackage(created, new Uint8Array(32).fill(99))).toThrow();
    expect(() => decodeVaultRoleARecoveryPackage(JSON.stringify({
      ...created,
      network: 'signet',
    }))).toThrow('malformed');
    expect(() => decodeVaultRoleARecoveryPackage(JSON.stringify({
      ...created,
      origin: { ...created.origin, accountXpub: created.origin.accountXpub.replace(/.$/u, '1') },
    }))).toThrow();
    expect(() => decodeVaultRoleARecoveryPackage(JSON.stringify({ ...created, extra: true }))).toThrow('malformed');
  });

  it('bounds imported files before parsing', () => {
    expect(() => decodeVaultRoleARecoveryPackage('x'.repeat(256 * 1024 + 1))).toThrow('too large');
    expect(() => decodeVaultRoleARecoveryPackage('{')).toThrow('valid JSON');
  });
});
