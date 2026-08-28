import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProviderPsbtPlanV3 } from '@drey/core/domain/transactions/provider-psbt';
import type { ProviderPsbtGroupPlanV1 } from
  '@drey/core/domain/transactions/provider-psbt-group-plan';
import { derivePublicAccountCapabilities } from '@drey/core/domain/accounts/capabilities';
import { base64ToBytes } from '@drey/core/domain/vault/encoding';
import { PASSWORD } from '@drey/core/testing/vault-helpers';
import { getSession } from '../../src/adapters/session/session-store';
import { MemoryWalletCache } from '../../src/adapters/storage/wallet-cache-idb';
import {
  assertMarketplaceCapability,
} from '../../src/background/wallet-service';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { makeHarness } from './service-helpers';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

beforeAll(async () => installTestCryptoProvider());

function marketplacePlan(input: {
  vaultId: string;
  sessionId: string;
  accountId: string;
  origin: string;
}): ProviderPsbtPlanV3 {
  return {
    accountId: input.accountId,
    account: 0,
    network: 'mainnet',
    vaultId: input.vaultId,
    sessionId: input.sessionId,
    expiresAt: 2_000_000_000_000,
    provider: {
      origin: input.origin,
      tabId: 7,
      frameId: 0,
      documentId: '123e4567-e89b-42d3-a456-426614174000',
      requestNonce: '123e4567-e89b-42d3-a456-426614174001',
      providerMethod: 'signPsbt',
    },
    psbtHash: '1'.repeat(64),
    analysisHash: '2'.repeat(64),
    planHash: '3'.repeat(64),
    inputs: [],
    marketplace: {
      context: {
        version: 1,
        marketplaceId: 'satflow',
        templateVersion: 'v1',
        action: 'list',
        role: 'seller',
        assetKind: 'inscription',
        workflowId: 'shared-workflow',
        step: 1,
        stepCount: 2,
        broadcaster: 'site',
      },
      resolution: {
        status: 'recognized',
        marketplaceId: 'satflow',
        displayName: 'Satflow',
        templateId: 'satflow-list',
        templateVersion: 'v1',
        flexible: false,
      },
      selectedInputIndexes: [],
    },
  } as unknown as ProviderPsbtPlanV3;
}

type MarketplaceJournalWriter = {
  persistMarketplacePreparedLocked(dek: Uint8Array, plan: ProviderPsbtPlanV3): Promise<void>;
  persistMarketplaceGroupPreparedLocked(
    dek: Uint8Array,
    plan: ProviderPsbtGroupPlanV1,
  ): Promise<void>;
  persistMarketplaceSignedLocked(
    dek: Uint8Array,
    plan: ProviderPsbtPlanV3,
    signedPsbtBase64: string,
  ): Promise<void>;
  persistMarketplaceGroupSignedLocked(
    dek: Uint8Array,
    plan: ProviderPsbtGroupPlanV1,
    results: readonly { nodeId: string; psbtBase64: string }[],
  ): Promise<void>;
};

function marketplaceGroup(
  plans: readonly ProviderPsbtPlanV3[],
  groupHash = 'd'.repeat(64),
): ProviderPsbtGroupPlanV1 {
  return {
    groupHash,
    vaultId: plans[0]!.vaultId,
    sessionId: plans[0]!.sessionId,
    network: plans[0]!.network,
    accountId: plans[0]!.accountId,
    account: plans[0]!.account,
    items: plans.map((plan, index) => ({ nodeId: `transaction-${index + 1}`, plan })),
  } as unknown as ProviderPsbtGroupPlanV1;
}

describe('marketplace stable-account and authority binding', () => {
  it.each([
    {
      label: 'stable account',
      mutate: (plan: ProviderPsbtPlanV3) => ({
        ...plan,
        accountId: `acct_mainnet_${'9'.repeat(64)}`,
      }),
    },
    {
      label: 'origin authority',
      mutate: (plan: ProviderPsbtPlanV3) => ({
        ...plan,
        provider: { ...plan.provider, origin: 'https://other.example' },
      }),
    },
  ])('does not collide when the same workflow/step changes $label', async ({ mutate }) => {
    const cache = new MemoryWalletCache();
    const harness = makeHarness(undefined, { walletCache: cache });
    const { vaultId } = await harness.service.restore({
      name: 'Main', password: PASSWORD, mnemonic: MNEMONIC,
    });
    const { sessionId } = await harness.service.unlock({ vaultId, password: PASSWORD });
    const session = await getSession(harness.session);
    if (!session) throw new Error('missing session');
    const dek = base64ToBytes(session.dekB64);
    const writer = harness.service as unknown as MarketplaceJournalWriter;
    const first = marketplacePlan({
      vaultId,
      sessionId,
      accountId: `acct_mainnet_${'1'.repeat(64)}`,
      origin: 'https://market.example',
    });
    await writer.persistMarketplacePreparedLocked(dek, first);
    await expect(writer.persistMarketplacePreparedLocked(
      dek,
      mutate(first) as ProviderPsbtPlanV3,
    )).resolves.toBeUndefined();
    dek.fill(0);
    expect(await cache.listKeys(vaultId, 'mainnet', 'marketplaceWorkflows')).toHaveLength(2);
  });

  it('rejects marketplace use when provider exposure is allowed but marketplace capability is denied', () => {
    const capabilities = {
      ...derivePublicAccountCapabilities({
        unlocked: true,
        network: 'mainnet',
        signingSource: { kind: 'software' },
      }),
      canExposeToProviders: true,
      canUseMarketplaces: false,
    };
    expect(() => assertMarketplaceCapability(capabilities)).toThrow(expect.objectContaining({
      code: 'ERR_UNAUTHORIZED_CONTEXT',
    }));
  });

  it.each([
    {
      label: 'another stable account',
      mutate: (plan: ProviderPsbtPlanV3) => ({
        ...plan,
        accountId: `acct_mainnet_${'8'.repeat(64)}`,
      }),
    },
    {
      label: 'another origin',
      mutate: (plan: ProviderPsbtPlanV3) => ({
        ...plan,
        provider: { ...plan.provider, origin: 'https://collision.example' },
      }),
    },
  ])('does not accept prior-step continuity from $label', async ({ mutate }) => {
    const cache = new MemoryWalletCache();
    const harness = makeHarness(undefined, { walletCache: cache });
    const { vaultId } = await harness.service.restore({
      name: 'Main', password: PASSWORD, mnemonic: MNEMONIC,
    });
    const { sessionId } = await harness.service.unlock({ vaultId, password: PASSWORD });
    const session = await getSession(harness.session);
    if (!session) throw new Error('missing session');
    const dek = base64ToBytes(session.dekB64);
    const writer = harness.service as unknown as MarketplaceJournalWriter;
    const first = marketplacePlan({
      vaultId,
      sessionId,
      accountId: `acct_mainnet_${'1'.repeat(64)}`,
      origin: 'https://market.example',
    });
    await writer.persistMarketplacePreparedLocked(dek, first);
    await writer.persistMarketplaceSignedLocked(dek, first, 'cHNidP8=');
    const second = mutate({
      ...first,
      provider: {
        ...first.provider,
        requestNonce: '123e4567-e89b-42d3-a456-426614174002',
      },
      marketplace: {
        ...first.marketplace!,
        context: { ...first.marketplace!.context, step: 2 },
      },
    } as ProviderPsbtPlanV3) as ProviderPsbtPlanV3;
    await expect(writer.persistMarketplacePreparedLocked(dek, second)).rejects.toMatchObject({
      code: 'ERR_PLAN_CHANGED',
    });
    dek.fill(0);
  });

  it('journals a same-workflow same-step group once and rejects cross-method replay', async () => {
    const cache = new MemoryWalletCache();
    const harness = makeHarness(undefined, { walletCache: cache });
    const { vaultId } = await harness.service.restore({
      name: 'Main', password: PASSWORD, mnemonic: MNEMONIC,
    });
    const { sessionId } = await harness.service.unlock({ vaultId, password: PASSWORD });
    const session = await getSession(harness.session);
    if (!session) throw new Error('missing session');
    const dek = base64ToBytes(session.dekB64);
    const writer = harness.service as unknown as MarketplaceJournalWriter;
    const base = marketplacePlan({
      vaultId,
      sessionId,
      accountId: `acct_mainnet_${'1'.repeat(64)}`,
      origin: 'https://market.example',
    });
    const groupedBase = {
      ...base,
      provider: {
        ...base.provider,
        requestNonce: '123e4567-e89b-42d3-a456-426614174003',
        providerMethod: 'signMultipleTransactions',
      },
    } as ProviderPsbtPlanV3;
    const sameStep = {
      ...groupedBase,
      psbtHash: '4'.repeat(64),
      analysisHash: '5'.repeat(64),
      planHash: '6'.repeat(64),
    } as ProviderPsbtPlanV3;
    const grouped = marketplaceGroup([groupedBase, sameStep]);
    await expect(writer.persistMarketplaceGroupPreparedLocked(dek, grouped)).resolves.toBeUndefined();
    await expect(writer.persistMarketplaceGroupPreparedLocked(dek, grouped)).resolves.toBeUndefined();
    expect(await cache.listKeys(vaultId, 'mainnet', 'marketplaceWorkflows')).toHaveLength(1);
    await expect(writer.persistMarketplacePreparedLocked(dek, base))
      .rejects.toMatchObject({ code: 'ERR_PLAN_CHANGED' });

    const sequentialFirst = {
      ...base,
      marketplace: {
        ...base.marketplace!,
        context: { ...base.marketplace!.context, workflowId: 'bundled-sequential' },
      },
    } as ProviderPsbtPlanV3;
    const sequentialSecond = {
      ...sequentialFirst,
      provider: {
        ...sequentialFirst.provider,
        requestNonce: '123e4567-e89b-42d3-a456-426614174002',
      },
      psbtHash: '7'.repeat(64),
      analysisHash: '8'.repeat(64),
      planHash: '9'.repeat(64),
      marketplace: {
        ...sequentialFirst.marketplace!,
        context: { ...sequentialFirst.marketplace!.context, step: 2 },
      },
    } as ProviderPsbtPlanV3;
    await expect(writer.persistMarketplaceGroupPreparedLocked(
      dek,
      marketplaceGroup([sequentialSecond, sequentialFirst], 'e'.repeat(64)),
    )).rejects.toMatchObject({ code: 'ERR_PLAN_CHANGED' });
    expect(await cache.listKeys(vaultId, 'mainnet', 'marketplaceWorkflows')).toHaveLength(1);

    const changedExisting = {
      ...sameStep,
      psbtHash: 'a'.repeat(64),
      analysisHash: 'b'.repeat(64),
      planHash: 'c'.repeat(64),
    } as ProviderPsbtPlanV3;
    await expect(writer.persistMarketplaceGroupPreparedLocked(
      dek,
      marketplaceGroup([groupedBase, changedExisting]),
    )).rejects.toMatchObject({ code: 'ERR_PLAN_CHANGED' });
    const keys = await cache.listKeys(vaultId, 'mainnet', 'marketplaceWorkflows');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain('group:shared-workflow');
    dek.fill(0);
  });

  it('commits every grouped signed-workflow transition in one cache transaction', async () => {
    const cache = new MemoryWalletCache();
    const harness = makeHarness(undefined, { walletCache: cache });
    const { vaultId } = await harness.service.restore({
      name: 'Main', password: PASSWORD, mnemonic: MNEMONIC,
    });
    const { sessionId } = await harness.service.unlock({ vaultId, password: PASSWORD });
    const activeAccount = (await harness.service.listAccounts({
      expectedVaultId: vaultId,
      expectedSessionId: sessionId,
    })).accounts.find((account) => account.active);
    if (!activeAccount) throw new Error('missing active account');
    const session = await getSession(harness.session);
    if (!session) throw new Error('missing session');
    const dek = base64ToBytes(session.dekB64);
    const writer = harness.service as unknown as MarketplaceJournalWriter;
    const base = marketplacePlan({
      vaultId,
      sessionId,
      accountId: activeAccount.accountId,
      origin: 'https://market.example',
    });
    const sharedOutpoint = `${'a'.repeat(64)}:0`;
    const plans = [0, 1].map((index) => ({
      ...base,
      psbtHash: String(index + 4).repeat(64),
      analysisHash: String(index + 6).repeat(64),
      planHash: String(index + 8).repeat(64),
      inputs: [{ txid: 'a'.repeat(64), vout: 0, ownership: 'wallet' }],
      marketplace: {
        ...base.marketplace!,
        context: { ...base.marketplace!.context, workflowId: 'aggregate-workflow' },
        selectedInputIndexes: [0],
      },
    } as ProviderPsbtPlanV3));
    const grouped = marketplaceGroup(plans, 'f'.repeat(64));
    await writer.persistMarketplaceGroupPreparedLocked(dek, grouped);
    const keys = await cache.listKeys(vaultId, 'mainnet', 'marketplaceWorkflows');
    const before = await Promise.all(keys.map((key) => cache.get({
      vaultId, network: 'mainnet', type: 'marketplaceWorkflows', key,
    })));
    const putMany = vi.spyOn(cache, 'putMany');

    await writer.persistMarketplaceGroupSignedLocked(dek, grouped, [
      { nodeId: 'transaction-2', psbtBase64: 'cHNidP9=' },
      { nodeId: 'transaction-1', psbtBase64: 'cHNidP8=' },
    ]);

    expect(putMany).toHaveBeenCalledTimes(1);
    expect(putMany.mock.calls[0]![0]).toHaveLength(2);
    expect(await cache.listKeys(vaultId, 'mainnet', 'marketplaceReservations'))
      .toEqual([sharedOutpoint]);
    const after = await Promise.all(keys.map((key) => cache.get({
      vaultId, network: 'mainnet', type: 'marketplaceWorkflows', key,
    })));
    expect(after.map((record) => record?.box.ciphertextB64)).not.toEqual(
      before.map((record) => record?.box.ciphertextB64),
    );
    await harness.service.providerMarkMarketplaceGroupDelivered(grouped);
    const delivered = await Promise.all(keys.map((key) => cache.get({
      vaultId, network: 'mainnet', type: 'marketplaceWorkflows', key,
    })));
    expect(delivered.map((record) => record?.box.ciphertextB64)).not.toEqual(
      after.map((record) => record?.box.ciphertextB64),
    );
    await expect(writer.persistMarketplaceGroupSignedLocked(dek, grouped, [
      { nodeId: 'transaction-1', psbtBase64: 'cHNidP8=' },
      { nodeId: 'transaction-2', psbtBase64: 'cHNidP9=' },
    ])).rejects.toMatchObject({ code: 'ERR_PLAN_CHANGED' });
    dek.fill(0);
  });

  it('requires a fully signed aggregate prior step before a later grouped approval', async () => {
    const cache = new MemoryWalletCache();
    const harness = makeHarness(undefined, { walletCache: cache });
    const { vaultId } = await harness.service.restore({
      name: 'Main', password: PASSWORD, mnemonic: MNEMONIC,
    });
    const { sessionId } = await harness.service.unlock({ vaultId, password: PASSWORD });
    const session = await getSession(harness.session);
    if (!session) throw new Error('missing session');
    const dek = base64ToBytes(session.dekB64);
    const writer = harness.service as unknown as MarketplaceJournalWriter;
    const base = marketplacePlan({
      vaultId,
      sessionId,
      accountId: `acct_mainnet_${'1'.repeat(64)}`,
      origin: 'https://market.example',
    });
    const stepPlans = (step: number) => [0, 1].map((index) => ({
      ...base,
      psbtHash: `${step + index + 1}`.repeat(64),
      analysisHash: `${step + index + 3}`.repeat(64),
      planHash: `${step + index + 5}`.repeat(64),
      provider: {
        ...base.provider,
        requestNonce: `123e4567-e89b-42d3-a456-42661417400${step}`,
      },
      marketplace: {
        ...base.marketplace!,
        context: {
          ...base.marketplace!.context,
          workflowId: 'sequential-aggregate',
          step,
          stepCount: 2,
        },
      },
    } as ProviderPsbtPlanV3));
    const first = marketplaceGroup(stepPlans(1), '1'.repeat(64));
    const second = marketplaceGroup(stepPlans(2), '2'.repeat(64));

    await expect(writer.persistMarketplaceGroupPreparedLocked(dek, second))
      .rejects.toMatchObject({ code: 'ERR_PLAN_CHANGED' });
    await writer.persistMarketplaceGroupPreparedLocked(dek, first);
    await expect(writer.persistMarketplaceGroupPreparedLocked(dek, second))
      .rejects.toMatchObject({ code: 'ERR_PLAN_CHANGED' });
    await writer.persistMarketplaceGroupSignedLocked(dek, first, [
      { nodeId: 'transaction-1', psbtBase64: 'cHNidP8=' },
      { nodeId: 'transaction-2', psbtBase64: 'cHNidP9=' },
    ]);
    await expect(writer.persistMarketplaceGroupPreparedLocked(dek, second)).resolves.toBeUndefined();
    expect(await cache.listKeys(vaultId, 'mainnet', 'marketplaceWorkflows')).toHaveLength(2);
    dek.fill(0);
  });
});
