import { beforeAll, describe, expect, it } from 'vitest';
import type { ProviderPsbtPlanV3 } from '@drey/core/domain/transactions/provider-psbt';
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
  persistMarketplaceSignedLocked(
    dek: Uint8Array,
    plan: ProviderPsbtPlanV3,
    signedPsbtBase64: string,
  ): Promise<void>;
};

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
});
