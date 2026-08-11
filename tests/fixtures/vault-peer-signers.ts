/**
 * Disposable signet peer signers for the Vault coordinator's import ceremony
 * (ADR 0007 §2, Workstream C1).
 *
 * The extension never generates roles B or C — that is the whole point of the
 * import — so testing the ceremony needs two roots that can actually answer a
 * proof-of-possession challenge. `core/vectors/vault-contracts-v1.json` ships
 * the *public* origins for A/B/C but deliberately writes no private material,
 * so it cannot produce a proof. These two roots fill exactly that gap.
 *
 * PUBLIC DISPOSABLE TEST MATERIAL. Freshly generated for this fixture, signet
 * only, never funded, never reused, and published in this file by definition.
 * They stand in for a mobile signer and an offline recovery ceremony; nothing
 * here is or may become a production role B.
 */
import { HDKey } from '@scure/bip32';
import { mnemonicToSeed } from '@drey/core/domain/keys/mnemonic';
import {
  bip32Versions,
  type VaultProofOfPossessionInputV1,
  type VaultProofOfPossessionResultV1,
  type VaultSignerOriginV1,
  type VaultSignerRole,
} from '@drey/core/domain/vault/multisig-contracts';
import {
  parseRecoveryCBackupCheckChallenge,
  parseRecoveryCSetupChallenge,
  recoveryCSetupChallengeDigest,
  serializeRecoveryCBackupCheckResponse,
  serializeRecoveryCSetupResponse,
  serializeVaultProofResult,
  serializeVaultSignerOrigin,
} from '@drey/core/domain/vault/multisig-encoding';
import { bytesToHex, hexToBytes } from '@drey/core/domain/vault/encoding';
import {
  deriveVaultRoleOrigin,
  signVaultProofOfPossession,
} from '@drey/core/domain/vault/multisig-role';
import {
  recoveryCSetupProofInput,
  signRecoveryCBackupCheck,
} from '@drey/core/domain/vault/recovery-c-ceremony';
import type { VaultCoordinatorNetwork } from '../../src/background/vault-capability';

export type PeerRole = 'mobile-b' | 'recovery-c';

/** The disposable peer roots. Signet, unfunded, public by construction. */
export const PEER_MNEMONICS: Readonly<Record<PeerRole, string>> = {
  'mobile-b': 'grace frog zone boss dawn market donate wagon amateur stadium puppy kind',
  'recovery-c': 'radar radio saddle shallow volcano garlic inquiry ring elite afraid runway satisfy',
};

/**
 * A disposable Desktop A root, for the C5 signing tests only.
 *
 * The coordinator generates its own role A and never discloses the seed to a
 * caller, so a test that needs A to *sign* cannot get the key out of the
 * service; it composes a policy from three roots it holds instead. That is
 * exactly what a signing test should do — it exercises the signing code, not
 * the storage ceremony C0 already covers.
 *
 * PUBLIC DISPOSABLE TEST MATERIAL, freshly generated for this fixture, signet
 * only, never funded, never reused. It is not, and may not become, a role A
 * that protects anything.
 */
export const DESKTOP_A_MNEMONIC =
  'rifle inch raccoon spend thumb sentence language topic describe pudding glide trim';

/** All three roles of the fixture policy, in core's canonical A, B, C order. */
export const SIGNER_MNEMONICS: Readonly<Record<VaultSignerRole, string>> = {
  'desktop-a': DESKTOP_A_MNEMONIC,
  ...PEER_MNEMONICS,
};

/**
 * A fourth disposable root, used only to stand in for *somebody else's* role A
 * when a test needs a policy this profile could never sign for. Kept separate
 * from the two peer roots because reusing one of those would collide on
 * fingerprint and xpub — one seed yields one BIP48 account regardless of which
 * logical role label is attached to it.
 */
export const FOREIGN_DESKTOP_MNEMONIC =
  'calm hockey convince vast doctor weasel unveil rabbit senior next leader mix';

/** The pinned public identities, so a derivation regression is loud. */
export const PEER_FINGERPRINTS: Readonly<Record<PeerRole, string>> = {
  'mobile-b': 'de5b636e',
  'recovery-c': '96603e56',
};

/** The same, for all three roles. Three distinct roots, so three distinct labels. */
export const SIGNER_FINGERPRINTS: Readonly<Record<VaultSignerRole, string>> = {
  'desktop-a': 'f3c37891',
  ...PEER_FINGERPRINTS,
};

export function peerSeed(role: PeerRole): Uint8Array {
  return mnemonicToSeed(PEER_MNEMONICS[role]);
}

/**
 * The public BIP48 origin of any fixture role.
 *
 * Network-parameterized because the ADR 0007 §8.1 pilot bound only governs
 * mainnet plans, so proving it needs a mainnet policy over these same
 * disposable roots. The roots stay unfunded either way — a plan is validated
 * against evidence, not against a chain — but a mainnet *fixture* root must
 * never be treated as anything but public test material.
 */
export function signerOrigin(
  role: VaultSignerRole,
  network: VaultCoordinatorNetwork = 'signet',
): VaultSignerOriginV1 {
  const seed = mnemonicToSeed(SIGNER_MNEMONICS[role]);
  try {
    return deriveVaultRoleOrigin(seed, role, network);
  } finally {
    seed.fill(0);
  }
}

/**
 * The BIP32 master root a fixture role signs with.
 *
 * Core's signing functions take a depth-0 `HDKey` and re-derive the whole
 * BIP48 path themselves, re-checking the master fingerprint, account xpub, and
 * every child against the policy before a private key is used. Handing them an
 * account node instead would skip precisely those checks.
 */
export function signerRoot(
  role: VaultSignerRole,
  network: VaultCoordinatorNetwork = 'signet',
): HDKey {
  const seed = mnemonicToSeed(SIGNER_MNEMONICS[role]);
  try {
    return HDKey.fromMasterSeed(seed, bip32Versions(network));
  } finally {
    seed.fill(0);
  }
}

/** A root that is in no policy under test — the foreign-key negative case. */
export function foreignSignerRoot(): HDKey {
  const seed = mnemonicToSeed(FOREIGN_DESKTOP_MNEMONIC);
  try {
    return HDKey.fromMasterSeed(seed, bip32Versions('signet'));
  } finally {
    seed.fill(0);
  }
}

export function peerOrigin(role: PeerRole): VaultSignerOriginV1 {
  const seed = peerSeed(role);
  try {
    return deriveVaultRoleOrigin(seed, role, 'signet');
  } finally {
    seed.fill(0);
  }
}

export function peerOriginHex(role: PeerRole): string {
  return bytesToHex(serializeVaultSignerOrigin(peerOrigin(role)));
}

/** Answer the standalone tool's public setup exchange with fixture Recovery C. */
export function recoveryCSetupResponseHex(challengeHex: string): string {
  const challenge = parseRecoveryCSetupChallenge(hexToBytes(challengeHex));
  const seed = peerSeed('recovery-c');
  try {
    const origin = deriveVaultRoleOrigin(seed, 'recovery-c', challenge.network);
    return bytesToHex(serializeRecoveryCSetupResponse({
      version: 1,
      challengeDigestHex: recoveryCSetupChallengeDigest(challenge),
      origin,
      proof: {
        ...signVaultProofOfPossession(
          seed,
          recoveryCSetupProofInput(challenge, origin),
          (BigInt(challenge.createdAtMs) + 1n).toString(),
        ),
        role: 'recovery-c',
      },
    }));
  } finally {
    seed.fill(0);
  }
}

/** Re-enter the public fixture words against a policy-bound backup challenge. */
export function recoveryCBackupResponseHex(challengeHex: string): string {
  const challenge = parseRecoveryCBackupCheckChallenge(hexToBytes(challengeHex));
  const seed = peerSeed('recovery-c');
  try {
    return bytesToHex(serializeRecoveryCBackupCheckResponse(
      signRecoveryCBackupCheck(
        seed,
        challenge,
        (BigInt(challenge.createdAtMs) + 1n).toString(),
      ),
    ));
  } finally {
    seed.fill(0);
  }
}

/**
 * Answer a coordinator-minted challenge as this peer would.
 *
 * Deliberately built through the same `vault-role.ts` construction the
 * coordinator uses for its own role: a peer that signed some other way would
 * prove that the verifier accepts only one encoding, not that the ceremony
 * works, and a future mobile signer is expected to reproduce this exact scheme.
 */
export function peerProof(
  role: PeerRole,
  challenge: {
    sessionIdHex: string;
    challengeNonceHex: string;
    transcriptHashHex: string;
    expiresAtMs: string;
  },
  nowMs?: string,
): VaultProofOfPossessionResultV1 {
  const seed = peerSeed(role);
  const input: VaultProofOfPossessionInputV1 = {
    version: 1,
    origin: peerOrigin(role),
    sessionIdHex: challenge.sessionIdHex,
    challengeNonceHex: challenge.challengeNonceHex,
    transcriptHashHex: challenge.transcriptHashHex,
    expiresAtMs: challenge.expiresAtMs,
  };
  try {
    return signVaultProofOfPossession(seed, input, nowMs);
  } finally {
    seed.fill(0);
  }
}

export function peerProofHex(
  role: PeerRole,
  challenge: Parameters<typeof peerProof>[1],
  nowMs?: string,
): string {
  return bytesToHex(serializeVaultProofResult(peerProof(role, challenge, nowMs)));
}
