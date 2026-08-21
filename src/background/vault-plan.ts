/** Thin extension adapter over coordinator-neutral @drey/core Vault planning. */
import { bytesToHex } from '@drey/core/domain/vault/encoding';
import type { VaultAssetPolicyEvidenceV1 } from '@drey/core/domain/vault/multisig-asset-policy';
import type { VaultPolicyIdentityV1, VaultUnsignedPlanV1 } from '@drey/core/domain/vault/multisig-contracts';
import { canonicalVaultPlanBytes } from '@drey/core/domain/vault/multisig-encoding';
import {
  assertVaultDepositAddress,
  buildVaultCardinalWithdrawal,
  buildVaultCpfp,
  buildVaultInscriptionWithdrawal,
  parseApprovedVaultPlan,
  selectVaultCardinalInputs,
  VaultPlanBuildError,
  type VaultPlanBuildErrorCode,
} from '@drey/core/domain/vault/multisig-planning';
import type { VaultEvidenceSourceV1, VaultUtxoV1 } from '@drey/core/domain/vault/multisig-evidence';
import type { VaultApprovedPlanV1 } from '../adapters/storage/vault-coordinator-store';
import type { VaultCoordinatorPlanSummary } from '../messaging/vault-coordinator-ops';
import type { VaultCoordinatorCapability } from './vault-capability';

export { assertVaultDepositAddress, buildVaultInscriptionWithdrawal, selectVaultCardinalInputs };
export { buildVaultCpfp };
export { VaultPlanBuildError as VaultPlanError };
export type VaultPlanErrorCode = VaultPlanBuildErrorCode;

export interface VaultWithdrawalRequest {
  policy: VaultPolicyIdentityV1;
  capability: VaultCoordinatorCapability;
  source: VaultEvidenceSourceV1;
  utxos: readonly VaultUtxoV1[];
  destinationAddress: string;
  pairedSpendingWalletIdHash: string;
  feeRateSatPerKvB: string;
  changeDerivationIndex: number;
  planId: string;
  requestId: string;
  createdAtMs: string;
  expiresAtMs: string;
  movement?: 'cardinal' | 'inscription';
  amountSats?: string;
  inscriptionId?: string;
}

export interface VaultWithdrawalPlan {
  plan: VaultUnsignedPlanV1;
  evidence: VaultAssetPolicyEvidenceV1;
  psbtHex: string;
  selected: readonly VaultUtxoV1[];
}

export function buildVaultWithdrawal(request: VaultWithdrawalRequest): VaultWithdrawalPlan {
  if (request.capability.network !== request.policy.network) {
    throw new VaultPlanBuildError('not_vault_owned', 'build authority and Vault policy networks differ');
  }
  const common = {
    policy: request.policy,
    source: request.source,
    utxos: request.utxos,
    destinationAddress: request.destinationAddress,
    pairedSpendingWalletIdHash: request.pairedSpendingWalletIdHash,
    feeRateSatPerKvB: request.feeRateSatPerKvB,
    changeDerivationIndex: request.changeDerivationIndex,
    planId: request.planId,
    requestId: request.requestId,
    createdAtMs: request.createdAtMs,
    expiresAtMs: request.expiresAtMs,
    broadcastIntent: 'broadcast',
  } as const;
  if (request.movement === 'inscription') {
    if (request.inscriptionId === undefined) {
      throw new VaultPlanBuildError('unsupported_inscription', 'exact inscription ID is required');
    }
    return buildVaultInscriptionWithdrawal({ ...common, inscriptionId: request.inscriptionId });
  }
  if (request.amountSats === undefined) {
    throw new VaultPlanBuildError('insufficient_funds', 'cardinal amount is required');
  }
  return buildVaultCardinalWithdrawal({ ...common, amountSats: request.amountSats });
}

export function approvedPlanRecord(
  built: VaultWithdrawalPlan,
  destinationAddress: string,
  approvedAt: number,
): VaultApprovedPlanV1 {
  return {
    schemaVersion: 1,
    planId: built.plan.planId,
    planDigest: built.plan.planDigest,
    policyId: built.plan.policyId,
    approvedAt,
    canonicalPlanHex: bytesToHex(canonicalVaultPlanBytes(built.plan)),
    psbtHex: built.psbtHex,
    combinedPsbtHex: null,
    finalizedTransactionHex: null,
    evidence: built.evidence,
    destinationAddress,
    broadcast: null,
    broadcastLifecycle: null,
  };
}

export function summarizeVaultPlan(
  plan: VaultUnsignedPlanV1,
  destinationAddress: string,
): VaultCoordinatorPlanSummary {
  if (plan.network === 'regtest') throw new Error('regtest Vault coordinator is disabled');
  return {
    planId: plan.planId,
    planDigest: plan.planDigest,
    policyId: plan.policyId,
    network: plan.network,
    kind: 'withdrawal',
    replacement: plan.replacement.kind,
    destinationAddress,
    amountSats: plan.amountSats,
    changeSats: plan.changeSats,
    feeSats: plan.feeSats,
    feeRateSatPerKvB: plan.feeRateSatPerKvB,
    vsize: plan.vsize,
    inputCount: plan.inputs.length,
    outputs: plan.outputs.map((output) => ({
      outputIndex: output.outputIndex,
      purpose: output.purpose,
      valueSats: output.valueSats,
      address: output.address,
    })),
    assetEffects: plan.assetEffects.map((effect) => ({
      kind: effect.kind,
      assetId: effect.assetId,
      protected: effect.protected,
    })),
    createdAtMs: plan.createdAtMs,
    expiresAtMs: plan.expiresAtMs,
  };
}

export function parseApprovedPlan(record: {
  planDigest: string;
  canonicalPlanHex: string;
}): VaultUnsignedPlanV1 | null {
  return parseApprovedVaultPlan(record);
}
