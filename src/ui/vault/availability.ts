/**
 * UI-side Vault coordinator gating (ADR 0007 §8, Workstream C0).
 *
 * The channel gate is compile-time: only never-distributed channels carry the
 * coordinator. The worker enforces the same gate independently through its
 * injected `vaultCoordinatorCapability`, so this helper only decides whether
 * the surface renders — and never whether it may move value, which the worker
 * alone decides from that capability. The `typeof` guard keeps non-WXT
 * contexts (vitest without the define, tooling) fail-closed rather than
 * throwing — absence means unavailable, never available.
 */
export function vaultCoordinatorChannelEnabled(): boolean {
  return typeof __VAULT_COORDINATOR_ENABLED__ !== 'undefined' && __VAULT_COORDINATOR_ENABLED__;
}
