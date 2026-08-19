/** Secure extension orchestration for one Community Vault owner root per campaign. */
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeed, restoreMnemonic, entropyToMnemonic } from '@drey/core/domain/keys/mnemonic';
import { bip32Versions } from '@drey/core/domain/keys/extended-key';
import { bytesToHex, hexToBytes } from '@drey/core/domain/vault/encoding';
import { createVaultRecord, unlockVault, zeroize, type VaultDeps } from '@drey/core/domain/vault/vault';
import type { Argon2idParams, VaultPayloadV1, VaultRecordV1 } from '@drey/core/domain/vault/record';
import {
  assertCommunityVaultPolicy,
  serializeCommunityVaultPolicy,
} from '@drey/core/domain/community-vault/policy';
import { approveCommunityVaultSpend } from '@drey/core/domain/community-vault/psbt';
import type { CommunityVaultCampaignRootV1 } from '@drey/core/domain/community-vault/contracts';
import type { StorageArea } from '../adapters/storage/area';
import type { UnlockSession } from '../adapters/session/session-store';
import {
  loadCommunityVaultOwners,
  saveCommunityVaultOwner,
  type CommunityVaultOwnerRecordV1,
} from '../adapters/storage/community-vault-store';
import type { ActiveSessionRequest } from '@drey/core/messaging/ops';
import type {
  CommunityVaultAcceptPolicyRequest,
  CommunityVaultConfirmRecoveryRequest,
  CommunityVaultCreateRequest,
  CommunityVaultOwnerResult,
  CommunityVaultPasswordCampaignRequest,
  CommunityVaultRestoreRequest,
  CommunityVaultSignRequest,
  CommunityVaultStatusRequest,
  CommunityVaultStatusResult,
  CommunityVaultSummary,
} from '../messaging/community-vault-ops';
import { RpcError } from './errors';

export interface CommunityVaultContext {
  local: StorageArea;
  vaultDeps: VaultDeps;
  calibrateKdf(): Promise<Argon2idParams>;
  runExclusive<T>(fn: () => Promise<T>): Promise<T>;
  activeRecord(expectation: ActiveSessionRequest): Promise<{ record: VaultRecordV1; session: UnlockSession }>;
  touchSessionLocked(session: UnlockSession): Promise<void>;
}

function rootFromSeed(seed: Uint8Array): HDKey {
  return HDKey.fromMasterSeed(seed, bip32Versions('mainnet'));
}

function rootPublic(root: HDKey): CommunityVaultCampaignRootV1 {
  if (!root.privateKey || !root.publicKey || root.depth !== 0 || root.index !== 0) {
    throw new Error('Community Vault owner root is not an independent BIP32 master');
  }
  return {
    version: 1,
    masterFingerprintHex: root.fingerprint.toString(16).padStart(8, '0'),
    originPath: 'm',
    campaignXpub: root.publicExtendedKey,
  };
}

function sameRoot(left: CommunityVaultCampaignRootV1, right: CommunityVaultCampaignRootV1): boolean {
  return left.masterFingerprintHex === right.masterFingerprintHex &&
    left.campaignXpub === right.campaignXpub && left.originPath === right.originPath;
}

function summary(record: CommunityVaultOwnerRecordV1): CommunityVaultSummary {
  const owner = record.policy?.owners.find((candidate) => candidate.ownerId === record.ownerId);
  const recoveryConfirmed = record.recoveryConfirmedAt !== null;
  return {
    campaignId: record.campaignId,
    ownerId: record.ownerId,
    label: record.label,
    createdAt: record.createdAt,
    campaignRoot: record.campaignRoot,
    recoveryConfirmed,
    policyId: record.policy?.policyId ?? null,
    capTableHash: record.policy?.capTableHash ?? null,
    units: owner ? [...owner.units] : [],
    mode: record.policy?.mode ?? null,
    readiness: !recoveryConfirmed ? 'needs-recovery' : record.policy === null ? 'needs-policy' : 'ready',
  };
}

function enrollment(record: CommunityVaultOwnerRecordV1): CommunityVaultOwnerResult['enrollment'] {
  return {
    version: 1,
    network: 'mainnet',
    campaignId: record.campaignId,
    ownerId: record.ownerId,
    campaignRoot: record.campaignRoot,
  };
}

async function loadRecord(ctx: CommunityVaultContext, campaignId: string): Promise<CommunityVaultOwnerRecordV1> {
  const stored = await loadCommunityVaultOwners(ctx.local);
  if (stored.unusableCampaignIds.includes(campaignId)) {
    throw new RpcError('ERR_COMMUNITY_VAULT_UNUSABLE', 'Community Vault owner record is unreadable');
  }
  const record = stored.records.find((candidate) => candidate.campaignId === campaignId);
  if (!record) throw new RpcError('ERR_COMMUNITY_VAULT_MISSING', 'Community Vault owner is missing');
  return record;
}

async function establish(
  ctx: CommunityVaultContext,
  input: CommunityVaultCreateRequest | CommunityVaultRestoreRequest,
  material: { entropy: Uint8Array; seed: Uint8Array },
  spending: VaultPayloadV1,
): Promise<CommunityVaultOwnerRecordV1> {
  const stored = await loadCommunityVaultOwners(ctx.local);
  if (stored.records.some((record) => record.campaignId === input.campaignId) ||
      stored.unusableCampaignIds.includes(input.campaignId)) {
    throw new RpcError('ERR_COMMUNITY_VAULT_EXISTS', 'this campaign already has an owner root');
  }
  const entropyHex = bytesToHex(material.entropy);
  const seedHex = bytesToHex(material.seed);
  if (entropyHex === spending.entropyHex || seedHex === spending.seedHex) {
    throw new RpcError('ERR_UNSAFE_TRANSACTION', 'Community Vault root must be independent of the Spending wallet');
  }
  const root = rootFromSeed(material.seed);
  try {
    const campaignRoot = rootPublic(root);
    if (stored.records.some((record) => sameRoot(record.campaignRoot, campaignRoot))) {
      throw new RpcError('ERR_UNSAFE_TRANSACTION', 'Community Vault root is already used by another campaign');
    }
    const secret = await createVaultRecord({
      vaultId: `community:${input.campaignId}:${input.ownerId}`,
      name: `community-vault-${input.campaignId}`,
      password: input.password,
      payload: { version: 1, entropyHex, seedHex },
      kdfParams: await ctx.calibrateKdf(),
    }, ctx.vaultDeps);
    const record: CommunityVaultOwnerRecordV1 = {
      schemaVersion: 1,
      campaignId: input.campaignId,
      ownerId: input.ownerId,
      label: input.label,
      createdAt: ctx.vaultDeps.now(),
      campaignRoot,
      secret,
      recoveryConfirmedAt: null,
      policy: null,
    };
    await saveCommunityVaultOwner(ctx.local, record);
    return record;
  } finally {
    root.wipePrivateData();
  }
}

export async function communityVaultStatus(
  ctx: CommunityVaultContext,
  input: CommunityVaultStatusRequest,
): Promise<CommunityVaultStatusResult> {
  return ctx.runExclusive(async () => {
    const { session } = await ctx.activeRecord(input);
    const stored = await loadCommunityVaultOwners(ctx.local);
    await ctx.touchSessionLocked(session);
    return { owners: stored.records.map(summary), unusableCampaignIds: stored.unusableCampaignIds };
  });
}

export async function communityVaultCreate(
  ctx: CommunityVaultContext,
  input: CommunityVaultCreateRequest,
): Promise<CommunityVaultOwnerResult> {
  return ctx.runExclusive(async () => {
    const { record: spendingRecord, session } = await ctx.activeRecord(input);
    const spending = await unlockVault(spendingRecord, input.password);
    const generated = generateMnemonic((length) => ctx.vaultDeps.random(length));
    const seed = mnemonicToSeed(generated.mnemonic);
    try {
      const record = await establish(ctx, input, { entropy: generated.entropy, seed }, spending.payload);
      await ctx.touchSessionLocked(session);
      return { owner: summary(record), enrollment: enrollment(record) };
    } finally {
      zeroize(spending.dek);
      zeroize(generated.entropy);
      zeroize(seed);
    }
  });
}

export async function communityVaultRestore(
  ctx: CommunityVaultContext,
  input: CommunityVaultRestoreRequest,
): Promise<CommunityVaultOwnerResult> {
  return ctx.runExclusive(async () => {
    const { record: spendingRecord, session } = await ctx.activeRecord(input);
    const spending = await unlockVault(spendingRecord, input.password);
    const restored = restoreMnemonic(input.mnemonic);
    try {
      const record = await establish(ctx, input, restored, spending.payload);
      const recovered = { ...record, recoveryConfirmedAt: ctx.vaultDeps.now() };
      await saveCommunityVaultOwner(ctx.local, recovered);
      await ctx.touchSessionLocked(session);
      return { owner: summary(recovered), enrollment: enrollment(recovered) };
    } finally {
      zeroize(spending.dek);
      zeroize(restored.entropy);
      zeroize(restored.seed);
    }
  });
}

export async function communityVaultRevealRecovery(
  ctx: CommunityVaultContext,
  input: CommunityVaultPasswordCampaignRequest,
): Promise<{ mnemonic: string }> {
  return ctx.runExclusive(async () => {
    const { session } = await ctx.activeRecord(input);
    const record = await loadRecord(ctx, input.campaignId);
    const unlocked = await unlockVault(record.secret, input.password);
    const entropy = hexToBytes(unlocked.payload.entropyHex);
    try {
      await ctx.touchSessionLocked(session);
      return { mnemonic: entropyToMnemonic(entropy) };
    } finally {
      zeroize(entropy);
      zeroize(unlocked.dek);
    }
  });
}

export async function communityVaultConfirmRecovery(
  ctx: CommunityVaultContext,
  input: CommunityVaultConfirmRecoveryRequest,
): Promise<{ owner: CommunityVaultSummary }> {
  return ctx.runExclusive(async () => {
    const { session } = await ctx.activeRecord(input);
    const record = await loadRecord(ctx, input.campaignId);
    const unlocked = await unlockVault(record.secret, input.password);
    const restored = restoreMnemonic(input.mnemonic);
    try {
      if (bytesToHex(restored.entropy) !== unlocked.payload.entropyHex ||
          bytesToHex(restored.seed) !== unlocked.payload.seedHex) {
        throw new RpcError('ERR_COMMUNITY_VAULT_POLICY_MISMATCH', 'recovery words describe another root');
      }
      const confirmed = { ...record, recoveryConfirmedAt: ctx.vaultDeps.now() };
      await saveCommunityVaultOwner(ctx.local, confirmed);
      await ctx.touchSessionLocked(session);
      return { owner: summary(confirmed) };
    } finally {
      zeroize(unlocked.dek);
      zeroize(restored.entropy);
      zeroize(restored.seed);
    }
  });
}

export async function communityVaultAcceptPolicy(
  ctx: CommunityVaultContext,
  input: CommunityVaultAcceptPolicyRequest,
): Promise<{ owner: CommunityVaultSummary }> {
  return ctx.runExclusive(async () => {
    const { session } = await ctx.activeRecord(input);
    const record = await loadRecord(ctx, input.campaignId);
    assertCommunityVaultPolicy(input.policy);
    const owner = input.policy.owners.find((candidate) => candidate.ownerId === record.ownerId);
    if (input.policy.campaignId !== record.campaignId || !owner || !sameRoot(owner.campaignRoot, record.campaignRoot)) {
      throw new RpcError('ERR_COMMUNITY_VAULT_POLICY_MISMATCH', 'policy does not contain this exact owner root');
    }
    if (record.policy !== null && input.policy.capTableVersion < record.policy.capTableVersion) {
      throw new RpcError('ERR_COMMUNITY_VAULT_POLICY_MISMATCH', 'older cap-table versions cannot replace the accepted policy');
    }
    const accepted = { ...record, policy: input.policy };
    await saveCommunityVaultOwner(ctx.local, accepted);
    await ctx.touchSessionLocked(session);
    return { owner: summary(accepted) };
  });
}

export async function communityVaultSign(
  ctx: CommunityVaultContext,
  input: CommunityVaultSignRequest,
) {
  return ctx.runExclusive(async () => {
    const { session } = await ctx.activeRecord(input);
    const record = await loadRecord(ctx, input.campaignId);
    if (record.recoveryConfirmedAt === null) {
      throw new RpcError('ERR_COMMUNITY_VAULT_RECOVERY_REQUIRED', 'verify recovery before signing');
    }
    if (record.policy === null || record.policy.policyId !== input.policy.policyId ||
        record.policy.capTableHash !== input.policy.capTableHash ||
        bytesToHex(serializeCommunityVaultPolicy(record.policy)) !== bytesToHex(serializeCommunityVaultPolicy(input.policy))) {
      throw new RpcError('ERR_COMMUNITY_VAULT_POLICY_MISMATCH', 'transaction policy differs from the accepted cap table');
    }
    const unlocked = await unlockVault(record.secret, input.password);
    const seed = hexToBytes(unlocked.payload.seedHex);
    const root = rootFromSeed(seed);
    try {
      const approved = approveCommunityVaultSpend({
        policy: input.policy,
        plan: input.plan,
        psbtHex: input.psbtHex,
        ownerId: record.ownerId,
        signerRoot: root,
        nowMs: String(ctx.vaultDeps.now()),
        random: (length) => ctx.vaultDeps.random(length),
      });
      await ctx.touchSessionLocked(session);
      return approved;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError('ERR_UNSAFE_TRANSACTION', error instanceof Error ? error.message : 'Community Vault signing refused');
    } finally {
      root.wipePrivateData();
      zeroize(seed);
      zeroize(unlocked.dek);
    }
  });
}
