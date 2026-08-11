/**
 * Portable, passkey-encrypted backup of Vault Role A (ADR 0007 §6).
 *
 * The package contains the existing password-encrypted Role A record plus a
 * second envelope that wraps the record's random DEK with a fresh WebAuthn PRF
 * output. The offline extension page can therefore recover the same record
 * without the app password, while the passkey remains only one Vault role and
 * can never spend alone. The public origin is re-derived after decryption; it
 * is never trusted merely because it appeared in this JSON file.
 *
 * JSON is deliberate here: the file is an open, inspectable archive format,
 * not a signing transcript. Strict schemas reject unknown fields, and every
 * security-relevant identity is authenticated either by PasskeyEnvelopeV1's
 * AAD or VaultRecordV1's AAD and then independently re-derived.
 */
import { z } from 'zod';
import { entropyToMnemonic, mnemonicToSeed } from '@drey/core/domain/keys/mnemonic';
import { bytesToHex, hexToBytes } from '@drey/core/domain/vault/encoding';
import {
  createPasskeyEnvelope,
  parsePasskeyEnvelope,
  passkeyEnvelopeV1Schema,
  unwrapPasskeyDek,
  type PasskeyEnvelopeV1,
} from '@drey/core/domain/vault/passkey-envelope';
import {
  vaultRecordV1Schema,
  type VaultRecordV1,
} from '@drey/core/domain/vault/record';
import {
  serializeVaultSignerOrigin,
} from '@drey/core/domain/vault/multisig-encoding';
import {
  vaultSignerOriginSchema,
  type VaultSignerOriginV1,
} from '@drey/core/domain/vault/multisig-contracts';
import { deriveVaultRoleOrigin } from '@drey/core/domain/vault/multisig-role';
import { openVaultPayload, zeroize } from '@drey/core/domain/vault/vault';

export const VAULT_ROLE_A_RECOVERY_FORMAT = 'drey-vault-role-a-recovery' as const;
export const VAULT_ROLE_A_RECOVERY_VERSION = 1 as const;

export interface VaultRoleARecoveryPackageV1 {
  format: typeof VAULT_ROLE_A_RECOVERY_FORMAT;
  version: typeof VAULT_ROLE_A_RECOVERY_VERSION;
  network: 'mainnet' | 'signet';
  roleId: string;
  origin: VaultSignerOriginV1 & { role: 'desktop-a' };
  secret: VaultRecordV1;
  passkeyEnvelope: PasskeyEnvelopeV1;
}

const schema: z.ZodType<VaultRoleARecoveryPackageV1> = z.object({
  format: z.literal(VAULT_ROLE_A_RECOVERY_FORMAT),
  version: z.literal(VAULT_ROLE_A_RECOVERY_VERSION),
  network: z.enum(['mainnet', 'signet']),
  roleId: z.string().min(1).max(64),
  origin: vaultSignerOriginSchema.and(z.object({ role: z.literal('desktop-a') })),
  secret: vaultRecordV1Schema,
  passkeyEnvelope: passkeyEnvelopeV1Schema,
}).strict().superRefine((value, ctx) => {
  if (value.origin.network !== value.network) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['origin'], message: 'origin network mismatch' });
  }
  if (value.secret.vaultId !== value.roleId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['secret'], message: 'secret role binding mismatch' });
  }
  if (
    value.passkeyEnvelope.vaultId !== value.roleId ||
    value.passkeyEnvelope.network !== value.network
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['passkeyEnvelope'],
      message: 'passkey envelope role binding mismatch',
    });
  }
});

export function parseVaultRoleARecoveryPackage(
  value: unknown,
): VaultRoleARecoveryPackageV1 {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error('malformed Vault Role A recovery package');
  // Core's parser preserves its typed unsupported-version/tamper checks.
  parsePasskeyEnvelope(parsed.data.passkeyEnvelope);
  return parsed.data;
}

export function encodeVaultRoleARecoveryPackage(
  value: VaultRoleARecoveryPackageV1,
): string {
  const parsed = parseVaultRoleARecoveryPackage(value);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

export function decodeVaultRoleARecoveryPackage(
  text: string,
): VaultRoleARecoveryPackageV1 {
  if (new TextEncoder().encode(text).length > 256 * 1024) {
    throw new Error('Vault Role A recovery package is too large');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Vault Role A recovery package is not valid JSON');
  }
  return parseVaultRoleARecoveryPackage(value);
}

export function createVaultRoleARecoveryPackage(input: {
  network: 'mainnet' | 'signet';
  roleId: string;
  origin: VaultSignerOriginV1 & { role: 'desktop-a' };
  secret: VaultRecordV1;
  dek: Uint8Array;
  prfOutput: Uint8Array;
  rpOrigin: string;
  credentialIdB64: string;
  prfSalt: Uint8Array;
  hkdfSalt: Uint8Array;
  nonce: Uint8Array;
  createdAtMs: number;
}): VaultRoleARecoveryPackageV1 {
  if (input.secret.vaultId !== input.roleId) throw new Error('Role A record identity mismatch');
  const passkeyEnvelope = createPasskeyEnvelope({
    dek: input.dek,
    prfOutput: input.prfOutput,
    rpOrigin: input.rpOrigin,
    vaultId: input.roleId,
    network: input.network,
    credentialIdB64: input.credentialIdB64,
    label: 'Vault Role A offline recovery',
    createdAtMs: input.createdAtMs,
    prfSalt: input.prfSalt,
    hkdfSalt: input.hkdfSalt,
    nonce: input.nonce,
  });
  const value = parseVaultRoleARecoveryPackage({
    format: VAULT_ROLE_A_RECOVERY_FORMAT,
    version: VAULT_ROLE_A_RECOVERY_VERSION,
    network: input.network,
    roleId: input.roleId,
    origin: input.origin,
    secret: input.secret,
    passkeyEnvelope,
  });
  // Creation is not complete unless the exact package immediately opens and
  // reproduces the advertised signer. This catches adapter or identity drift
  // before the user is handed a backup that only looks recoverable.
  const verified = unwrapVaultRoleARecoveryPackage(value, input.prfOutput);
  zeroize(verified.entropy);
  return value;
}

export function unwrapVaultRoleARecoveryPackage(
  value: unknown,
  prfOutput: Uint8Array,
): { mnemonic: string; entropy: Uint8Array; origin: VaultSignerOriginV1 & { role: 'desktop-a' } } {
  const parsed = parseVaultRoleARecoveryPackage(value);
  const dek = unwrapPasskeyDek({
    envelope: parsed.passkeyEnvelope,
    prfOutput,
    expected: {
      rpOrigin: parsed.passkeyEnvelope.rpOrigin,
      vaultId: parsed.roleId,
      network: parsed.network,
    },
  });
  let seed: Uint8Array | null = null;
  let regeneratedSeed: Uint8Array | null = null;
  try {
    const payload = openVaultPayload(parsed.secret, dek);
    if (payload.passphrase !== undefined) {
      throw new Error('Role A recovery package unexpectedly contains a BIP39 passphrase');
    }
    const entropy = hexToBytes(payload.entropyHex);
    const mnemonic = entropyToMnemonic(entropy);
    seed = hexToBytes(payload.seedHex);
    regeneratedSeed = mnemonicToSeed(mnemonic);
    if (bytesToHex(seed) !== bytesToHex(regeneratedSeed)) {
      zeroize(entropy);
      throw new Error('Role A entropy and seed do not agree');
    }
    const origin = deriveVaultRoleOrigin(regeneratedSeed, 'desktop-a', parsed.network);
    if (
      bytesToHex(serializeVaultSignerOrigin(origin)) !==
      bytesToHex(serializeVaultSignerOrigin(parsed.origin))
    ) {
      zeroize(entropy);
      throw new Error('Role A recovery package does not reproduce its public signer');
    }
    return { mnemonic, entropy, origin };
  } finally {
    zeroize(dek);
    if (seed !== null) zeroize(seed);
    if (regeneratedSeed !== null) zeroize(regeneratedSeed);
  }
}
