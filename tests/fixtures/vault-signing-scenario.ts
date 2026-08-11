/**
 * A complete, signable disposable-signet Vault scenario (Workstream C5).
 *
 * Shared by the signing suite and the hardware-signer compatibility probe
 * because both need the same thing: a policy whose three roots are all
 * available to sign with, an approved plan, its evidence, and the PSBT the
 * coordinator built. C1's fixtures stop short of this — they hold public
 * origins for the peers and the coordinator keeps role A's seed to itself, so
 * neither can produce a second signature.
 *
 * Everything here is public disposable signet material. Nothing is funded, and
 * the prevouts are fabricated: a plan is validated against evidence, not
 * against a chain, so a signing test needs no live UTXO. Nothing in this file
 * or its consumers broadcasts.
 */
import { deriveVaultOutput } from '@drey/core/domain/vault/multisig-descriptors';
import type { VaultSignerOriginV1 } from '@drey/core/domain/vault/multisig-contracts';
import { composeVaultPolicyRecord } from '../../src/background/vault-policy';
import {
  buildVaultWithdrawal,
  type VaultWithdrawalPlan,
} from '../../src/background/vault-plan';
import {
  vaultBackendInstanceIdHash,
  vaultClassificationRevisionHash,
  VAULT_EVIDENCE_TTL_MS,
  type VaultEvidenceSourceV1,
  type VaultUtxoV1,
} from '../../src/background/vault-evidence';
import type {
  VaultCoordinatorCapability,
  VaultCoordinatorNetwork,
} from '../../src/background/vault-capability';
import { signerOrigin } from './vault-peer-signers';

/** The only capability that may sign: signet, full movement (ADR 0007 §8). */
export const SIGNET_FULL: VaultCoordinatorCapability = { network: 'signet', movement: 'full' };

/** The pilot posture: a real network, and no signing (ADR 0007 §8, amended). */
export const MAINNET_UNSIGNED_ONLY: VaultCoordinatorCapability = {
  network: 'mainnet',
  movement: 'unsigned-only',
};

/** Reviewed production-mainnet signing and coordination authority. */
export const MAINNET_PRODUCTION: VaultCoordinatorCapability = {
  network: 'mainnet',
  movement: 'production-mainnet',
};

export const SCENARIO_NOW_MS = 1_752_969_600_000;

const TIP = { height: 250_500, hash: 'aa'.repeat(32) };

/** A P2WPKH address standing in for the paired Spending wallet, per network. */
export const PAIRED_SPENDING_ADDRESS = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const PAIRED_SPENDING_ADDRESSES: Readonly<Record<VaultCoordinatorNetwork, string>> = {
  signet: PAIRED_SPENDING_ADDRESS,
  mainnet: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
};

export function pairedSpendingAddress(network: VaultCoordinatorNetwork): string {
  return PAIRED_SPENDING_ADDRESSES[network];
}

// Composition hashes, so this cannot run before the crypto provider is
// installed in a suite's beforeAll.
const cached = new Map<
  VaultCoordinatorNetwork,
  ReturnType<typeof composeVaultPolicyRecord>['identity']
>();

/** The 2-of-3 policy over the three fixture roots, in canonical A, B, C order. */
export function scenarioPolicy(
  network: VaultCoordinatorNetwork = 'signet',
): ReturnType<typeof composeVaultPolicyRecord>['identity'] {
  const hit = cached.get(network);
  if (hit) return hit;
  const identity = composeVaultPolicyRecord(
    network,
    [
      signerOrigin('desktop-a', network),
      signerOrigin('mobile-b', network),
      signerOrigin('recovery-c', network),
    ] as [VaultSignerOriginV1, VaultSignerOriginV1, VaultSignerOriginV1],
    {
      createdAtMs: '1735689600000',
      birthdayHeight: 250_000,
      vaultLabel: 'Signing Vault (disposable test)',
      signerLabels: ['Desktop', 'Mobile', 'Recovery'],
    },
  ).identity;
  cached.set(network, identity);
  return identity;
}

export function scenarioSource(
  network: VaultCoordinatorNetwork = 'signet',
): VaultEvidenceSourceV1 {
  return {
    network,
    backendInstanceIdHash: vaultBackendInstanceIdHash('gateway-1'),
    classificationRevisionHash: vaultClassificationRevisionHash('rev-1'),
    coreTip: TIP,
    indexTip: TIP,
    historyTip: TIP,
    ordTip: TIP,
    observedAtMs: String(SCENARIO_NOW_MS),
    validUntilMs: String(SCENARIO_NOW_MS + VAULT_EVIDENCE_TTL_MS),
  };
}

/** A proven-clean cardinal Vault output at the given receive index. */
export function scenarioUtxo(
  index: number,
  valueSats: string,
  network: VaultCoordinatorNetwork = 'signet',
): VaultUtxoV1 {
  const derived = deriveVaultOutput(scenarioPolicy(network), 'receive', index);
  return {
    txid: (index + 1).toString(16).padStart(2, '0').repeat(32),
    vout: 0,
    valueSats,
    scriptPubKeyHex: derived.scriptPubKeyHex,
    branch: 'receive',
    derivationIndex: index,
    confirmations: 6,
    walletCreatedUnconfirmedChange: false,
    primaryClass: 'cardinal_clean',
    confidence: 'authoritative',
    classificationComplete: true,
    satRangesComplete: true,
    inscriptions: [],
    rareSatDetected: false,
    unsupportedAssetDetected: false,
    userFrozen: false,
    dustQuarantined: false,
    refusal: null,
  };
}

/**
 * An approved ordinary cardinal withdrawal: plan, evidence, and the PSBT the
 * coordinator built, all already through the B3-safe wrapper C3 uses.
 */
export function scenarioWithdrawal(
  overrides: {
    utxos?: readonly VaultUtxoV1[];
    amountSats?: string;
    feeRateSatPerKvB?: string;
    capability?: VaultCoordinatorCapability;
  } = {},
): VaultWithdrawalPlan {
  const capability = overrides.capability ?? SIGNET_FULL;
  const network = capability.network;
  return buildVaultWithdrawal({
    policy: scenarioPolicy(network),
    capability,
    source: scenarioSource(network),
    utxos: overrides.utxos ?? [scenarioUtxo(0, '400000', network)],
    destinationAddress: pairedSpendingAddress(network),
    pairedSpendingWalletIdHash: 'bb'.repeat(32),
    amountSats: overrides.amountSats ?? '100000',
    feeRateSatPerKvB: overrides.feeRateSatPerKvB ?? '5000',
    changeDerivationIndex: 0,
    planId: 'cc'.repeat(16),
    requestId: 'dd'.repeat(16),
    createdAtMs: String(SCENARIO_NOW_MS),
    expiresAtMs: String(SCENARIO_NOW_MS + VAULT_EVIDENCE_TTL_MS),
  });
}
