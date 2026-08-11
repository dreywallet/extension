/** Compile-time Vault coordinator authority (ADR 0007 production revision). */
import type { VaultUnsignedPlanV1 } from '@drey/core/domain/vault/multisig-contracts';

export type VaultCoordinatorNetwork = 'signet' | 'mainnet';
export type VaultCoordinatorMovement = 'full' | 'unsigned-only' | 'production-mainnet';

/**
 * Only reviewed source can construct one of these values. No runtime input,
 * gateway response, storage value, page context, or transport payload is part
 * of this decision.
 */
export type VaultCoordinatorCapability =
  | { network: 'signet'; movement: 'full' }
  | { network: 'mainnet'; movement: 'unsigned-only' }
  | { network: 'mainnet'; movement: 'production-mainnet' };

export function canSignVaultValue(capability: VaultCoordinatorCapability): boolean {
  return capability.movement === 'full' || capability.movement === 'production-mainnet';
}

/** Re-check the compile-time network authority at every plan boundary. */
export function assertVaultProductionAuthority(
  capability: VaultCoordinatorCapability,
  plan: VaultUnsignedPlanV1,
): void {
  if (capability.network !== plan.network) {
    throw new Error(`Vault plan network ${plan.network} differs from build authority ${capability.network}`);
  }
  if (capability.network === 'mainnet' && capability.movement !== 'production-mainnet' &&
      capability.movement !== 'unsigned-only') {
    throw new Error('mainnet Vault authority is not production-mainnet');
  }
}

export function resolveVaultCoordinatorCapability(
  network: VaultCoordinatorNetwork,
  movement: VaultCoordinatorMovement,
): VaultCoordinatorCapability | undefined {
  if (network === 'signet' && movement === 'full') return { network, movement };
  if (network === 'mainnet' && movement === 'unsigned-only') return { network, movement };
  if (network === 'mainnet' && movement === 'production-mainnet') return { network, movement };
  return undefined;
}
