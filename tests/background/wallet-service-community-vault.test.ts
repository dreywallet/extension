import { beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { HDKey } from '@scure/bip32';
import { NETWORK, p2wpkh } from '@scure/btc-signer';
import { PASSWORD } from '@drey/core/testing/vault-helpers';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { bytesToHex } from '@drey/core/domain/vault/encoding';
import { createCommunityVaultPolicy } from '@drey/core/domain/community-vault/policy';
import {
  constructCommunityVaultPsbt,
  createCommunityVaultSpendPlan,
  validateCommunityVaultPsbt,
} from '@drey/core/domain/community-vault/psbt';
import type {
  CommunityVaultCampaignRootV1,
  CommunityVaultOwnerInputV1,
} from '@drey/core/domain/community-vault/contracts';
import { loadCommunityVaultOwners } from '../../src/adapters/storage/community-vault-store';
import { loadVaults } from '../../src/adapters/storage/vault-store';
import { makeHarness } from './service-helpers';

beforeAll(installTestCryptoProvider);

function deterministicRoot(index: number): HDKey {
  return HDKey.fromMasterSeed(createHash('sha256').update(`community-owner-${index}`).digest());
}

function publicRoot(root: HDKey): CommunityVaultCampaignRootV1 {
  return {
    version: 1,
    masterFingerprintHex: root.fingerprint.toString(16).padStart(8, '0'),
    originPath: 'm',
    campaignXpub: root.publicExtendedKey,
  };
}

function fixturePolicy(firstRoot: CommunityVaultCampaignRootV1) {
  const owners: CommunityVaultOwnerInputV1[] = [];
  for (let index = 0; index < 5; index += 1) {
    const root = deterministicRoot(index + 20);
    const payoutKey = root.deriveChild(1_000);
    if (!payoutKey.publicKey) throw new Error('missing payout key');
    const payout = p2wpkh(payoutKey.publicKey, NETWORK);
    const campaignRoot = index === 0 ? firstRoot : publicRoot(root);
    owners.push({
      ownerId: `owner-${index}`,
      capTableOrder: index,
      identityCommitmentHex: createHash('sha256').update(`identity-${index}`).digest('hex'),
      payoutAddress: payout.address,
      payoutScriptPubKeyHex: bytesToHex(payout.script),
      campaignRoot,
      units: Array.from({ length: 20 }, (_, unit) => index * 20 + unit),
    });
    payoutKey.wipePrivateData();
    root.wipePrivateData();
  }
  return createCommunityVaultPolicy({
    version: 1,
    policyVersion: 1,
    network: 'mainnet',
    campaignId: 'omb-campaign-1',
    inscriptionId: `${'11'.repeat(32)}i0`,
    currentOutpoint: { txid: '11'.repeat(32), vout: 0 },
    mode: 'open',
    eligibility: 'anyone',
    creatorOwnerId: 'owner-0',
    termsVersion: 'terms-v1',
    capTableVersion: 1,
    owners,
  });
}

function fixturePlan(policy: ReturnType<typeof fixturePolicy>, now: number) {
  const destinationRoot = deterministicRoot(80);
  const feeRoot = deterministicRoot(81);
  const destinationKey = destinationRoot.deriveChild(0);
  const feeKey = feeRoot.deriveChild(0);
  if (!destinationKey.publicKey || !feeKey.publicKey) throw new Error('missing fixture key');
  const destination = p2wpkh(destinationKey.publicKey, NETWORK);
  const fee = p2wpkh(feeKey.publicKey, NETWORK);
  const plan = createCommunityVaultSpendPlan({
    version: 1,
    policyVersion: 1,
    network: 'mainnet',
    policyId: policy.policyId,
    capTableHash: policy.capTableHash,
    capTableVersion: policy.capTableVersion,
    planId: 'rotation-1',
    kind: 'rotation',
    createdAtMs: String(now - 1_000),
    expiresAtMs: String(now + 3_600_000),
    inputs: [
      { txid: policy.currentOutpoint.txid, vout: 0, valueSats: '10000', scriptPubKeyHex: policy.scriptPubKeyHex, sequence: 0xffff_fffd },
      { txid: '44'.repeat(32), vout: 1, valueSats: '2000', scriptPubKeyHex: bytesToHex(fee.script), sequence: 0xffff_fffd },
    ],
    vaultInputIndex: 0,
    outputs: [
      { valueSats: '10000', scriptPubKeyHex: bytesToHex(destination.script) },
      { valueSats: '1000', scriptPubKeyHex: bytesToHex(fee.script) },
    ],
    feeSats: '1000',
    ordinalRoute: {
      inscriptionId: policy.inscriptionId,
      inputIndex: 0,
      inputOffsetSats: '0',
      outputIndex: 0,
      outputOffsetSats: '0',
      postageSats: '546',
    },
  });
  destinationKey.wipePrivateData();
  feeKey.wipePrivateData();
  destinationRoot.wipePrivateData();
  feeRoot.wipePrivateData();
  return plan;
}

async function setup() {
  const h = makeHarness();
  const { vaultId } = await h.service.create({ name: 'Main', password: PASSWORD });
  const unlocked = await h.service.unlock({ vaultId, password: PASSWORD });
  return { h, expectation: { expectedVaultId: vaultId, expectedSessionId: unlocked.sessionId } };
}

describe('Community Vault owner coordination', () => {
  it('restores an owner root from its own phrase and treats that phrase as recovery proof', async () => {
    const { h, expectation } = await setup();
    const mnemonic = 'grace frog zone boss dawn market donate wagon amateur stadium puppy kind';
    const restored = await h.service.communityVaultRestore({
      campaignId: 'restored-campaign', ownerId: 'restored-owner', label: 'Recovered',
      password: PASSWORD, mnemonic, ...expectation,
    });
    expect(restored.owner.readiness).toBe('needs-policy');
    await expect(h.service.communityVaultRevealRecovery({
      campaignId: 'restored-campaign', password: PASSWORD, ...expectation,
    })).resolves.toEqual({ mnemonic });
  });

  it('creates an independent encrypted root and requires a recovery round trip', async () => {
    const { h, expectation } = await setup();
    const created = await h.service.communityVaultCreate({
      campaignId: 'omb-campaign-1', ownerId: 'owner-0', label: 'OMB together', password: PASSWORD, ...expectation,
    });
    expect(created.enrollment).toMatchObject({ network: 'mainnet', campaignId: 'omb-campaign-1', ownerId: 'owner-0' });
    expect(created.owner.readiness).toBe('needs-recovery');

    const vaults = await loadVaults(h.local);
    const community = await loadCommunityVaultOwners(h.local);
    expect(Object.keys(vaults)).toHaveLength(1);
    expect(community.records).toHaveLength(1);
    expect(community.records[0]!.secret.vaultId).toBe('community:omb-campaign-1:owner-0');

    const revealed = await h.service.communityVaultRevealRecovery({
      campaignId: 'omb-campaign-1', password: PASSWORD, ...expectation,
    });
    await expect(h.service.communityVaultConfirmRecovery({
      campaignId: 'omb-campaign-1',
      password: PASSWORD,
      mnemonic: 'grace frog zone boss dawn market donate wagon amateur stadium puppy kind',
      ...expectation,
    })).rejects.toMatchObject({ code: 'ERR_COMMUNITY_VAULT_POLICY_MISMATCH' });
    const confirmed = await h.service.communityVaultConfirmRecovery({
      campaignId: 'omb-campaign-1', password: PASSWORD, mnemonic: revealed.mnemonic, ...expectation,
    });
    expect(confirmed.owner.readiness).toBe('needs-policy');

    const nextPassword = 'a newer wallet password';
    await h.service.changePassword({ oldPassword: PASSWORD, newPassword: nextPassword });
    await expect(h.service.communityVaultRevealRecovery({
      campaignId: 'omb-campaign-1', password: PASSWORD, ...expectation,
    })).rejects.toMatchObject({ code: 'wrong-password' });
    await expect(h.service.communityVaultRevealRecovery({
      campaignId: 'omb-campaign-1', password: nextPassword, ...expectation,
    })).resolves.toEqual({ mnemonic: revealed.mnemonic });
  });

  it('accepts only the exact owner root and signs every owned unit with one approval', async () => {
    const { h, expectation } = await setup();
    const created = await h.service.communityVaultCreate({
      campaignId: 'omb-campaign-1', ownerId: 'owner-0', label: '', password: PASSWORD, ...expectation,
    });
    const words = await h.service.communityVaultRevealRecovery({ campaignId: 'omb-campaign-1', password: PASSWORD, ...expectation });
    await h.service.communityVaultConfirmRecovery({ campaignId: 'omb-campaign-1', password: PASSWORD, mnemonic: words.mnemonic, ...expectation });

    const policy = fixturePolicy(created.enrollment.campaignRoot);
    const accepted = await h.service.communityVaultAcceptPolicy({ campaignId: 'omb-campaign-1', policy, ...expectation });
    expect(accepted.owner).toMatchObject({ readiness: 'ready', units: Array.from({ length: 20 }, (_, unit) => unit) });

    const plan = fixturePlan(policy, h.clock.now);
    const psbtHex = constructCommunityVaultPsbt(policy, plan);
    const signed = await h.service.communityVaultSign({
      campaignId: 'omb-campaign-1', password: PASSWORD, policy, plan, psbtHex, ...expectation,
    });
    expect(signed.addedUnits).toEqual(Array.from({ length: 20 }, (_, unit) => unit));
    expect(validateCommunityVaultPsbt(policy, plan, signed.psbtHex).signedUnits).toEqual(signed.addedUnits);
  });
});
