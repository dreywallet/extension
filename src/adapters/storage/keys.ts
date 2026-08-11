/**
 * chrome.storage.local key namespace. All wallet-owned keys are prefixed so
 * they never collide with WXT/other extension state.
 */
import type { AddressKind, Network } from '@drey/core/domain/keys/derivation';

const NS = 'squirrel';

/** Object map { [vaultId]: VaultRecordV1 } — the committed vault set. */
export const VAULTS_KEY = `${NS}:vaults`;
/** Staging slot for the §25.2 keep-old-until-validated swap. */
export const VAULTS_STAGING_KEY = `${NS}:vaults:staging`;
/** Raw records that could not be parsed/migrated. Never discarded by normal writes. */
export const VAULTS_QUARANTINE_KEY = `${NS}:vaults:quarantine`;
export const ACTIVE_VAULT_KEY = `${NS}:activeVaultId`;
export const CONFIG_KEY = `${NS}:config`;
/** Object map { [vaultId]: VaultMeta } — plaintext per-vault flags (§7.1 backup gate). */
export const VAULT_META_KEY = `${NS}:vaultMeta`;
/** Non-secret UI preferences (accent and language; legacy records may include theme); UI-owned. */
export const UI_PREFS_KEY = `${NS}:uiPrefs`;
/** Bounded, non-secret per-vault dismissal state for recovered-address education. */
export const RECOVERED_ADDRESS_NOTICE_KEY = `${NS}:recoveredAddressNotices`;
/** Array of passkey-wrapped-DEK envelopes (ADR 0007 §5); ciphertext only, no secrets. */
export const PASSKEY_ENVELOPES_KEY = `${NS}:passkeyEnvelopes`;
/** Array of enrolled-credential public keys (A2.1) — assertion verification anchors. */
export const PASSKEY_CREDENTIALS_KEY = `${NS}:passkeyCredentials`;
/**
 * The disposable signet Vault Desktop role A (ADR 0007 §§1-2, Workstream C0).
 * Deliberately outside the `squirrel:vaults` map: role A is a separate Bitcoin
 * root with its own encrypted record, never a Spending wallet entry, and it is
 * only ever written by a build whose channel enables the Vault coordinator.
 */
export const VAULT_COORDINATOR_ROLE_KEY = `${NS}:vaultCoordinator:roleA`;
/**
 * The in-progress signer import (ADR 0007 §2, Workstream C1): the challenge
 * this coordinator minted and whichever peer origins have since proven
 * possession against it. Transient setup state — cleared once a policy is
 * committed, and replaced outright by starting a new import.
 */
export const VAULT_COORDINATOR_IMPORT_KEY = `${NS}:vaultCoordinator:import`;
/**
 * Public-only Recovery C ceremony state: setup challenge/completion, exact
 * policy-bound kit export acknowledgement, backup-check challenge, and final
 * ready-to-fund completion. No mnemonic, seed, xprv, or private derivative may
 * ever enter this record.
 */
export const VAULT_COORDINATOR_RECOVERY_C_KEY = `${NS}:vaultCoordinator:recoveryC`;
/**
 * The committed watch-only Vault policy (ADR 0007 §§3-4, Workstream C1). Public
 * material only — three signer origins and both checksummed descriptors — but
 * privacy-sensitive, and load-bearing for recovery: like the role record it is
 * never silently discarded when it fails to parse.
 */
export const VAULT_COORDINATOR_POLICY_KEY = `${NS}:vaultCoordinator:policy`;
/**
 * Approved Vault plans, keyed by planId (ADR 0007 §7, Workstream C3).
 *
 * `core/vectors/vault-asset-policy-v1.md` defers this into C: RBF and CPFP
 * validation require "the complete previous immutable plan", and core will not
 * accept a summary or a txid in its place. It must come from signer-local
 * storage rather than from whoever proposes the replacement, or a coordinator
 * could describe a parent transaction that never existed.
 */
export const VAULT_COORDINATOR_PLANS_KEY = `${NS}:vaultCoordinator:plans`;

export function derivationKey(
  vaultId: string,
  network: Network,
  kind: AddressKind,
  account: number,
  accountId?: string,
): string {
  return accountId === undefined
    ? `${NS}:derivation:${vaultId}:${network}:${kind}:${account}`
    : `${NS}:derivation:${vaultId}:${network}:${accountId}:${kind}:${account}`;
}
