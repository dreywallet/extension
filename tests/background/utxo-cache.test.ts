import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { coreFixturesDir } from '../helpers/core-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GatewayClient } from '@drey/core/gateway-client';
import { getSession } from '../../src/adapters/session/session-store';
import { sealRecord } from '../../src/adapters/storage/wallet-cache';
import { MemoryWalletCache } from '../../src/adapters/storage/wallet-cache-idb';
import type { WalletUtxo } from '@drey/core/domain/classification/types';
import { feeQuoteResponseSchema, statusCapabilitiesSchema } from '@drey/core/domain/gateway/contract';
import { deriveAccountNode, deriveAddress } from '@drey/core/domain/keys/derivation';
import { xverseManifest } from '@drey/core/domain/keys/legacy-manifests';
import { mnemonicToSeed } from '@drey/core/domain/keys/mnemonic';
import { publicAccountFromSeed } from '@drey/core/domain/accounts/public-account';
import { scriptPubKeyHex } from '@drey/core/domain/keys/script-hash';
import { base64ToBytes } from '@drey/core/domain/vault/encoding';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { makeHarness } from './service-helpers';

const fixtures = join(coreFixturesDir, 'gateway');
const status = statusCapabilitiesSchema.parse(
  JSON.parse(readFileSync(join(fixtures, 'status.signed.json'), 'utf8')),
);
const fees = feeQuoteResponseSchema.parse(
  JSON.parse(readFileSync(join(fixtures, 'fees.signed.json'), 'utf8')),
);
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSWORD = 'correct horse battery staple';
const ACCOUNT_ID = publicAccountFromSeed(mnemonicToSeed(MNEMONIC), 'signet', 0).accountId;

beforeAll(async () => { await installTestCryptoProvider(); });

function utxo(txid: string, valueSats: bigint, chain: 0 | 1): WalletUtxo {
  return {
    accountId: ACCOUNT_ID,
    outpoint: { txid, vout: 0 },
    valueSats,
    scriptPubKey: `0014${'11'.repeat(20)}`,
    account: 0,
    lane: 'payment',
    chain,
    addressIndex: 0,
    height: 959_193,
    walletCreatedChange: chain === 1,
    facts: {
      primaryClass: 'cardinal_clean',
      inscriptions: [],
      satRanges: null,
      unsupportedAssetDetected: false,
      confidence: 'authoritative',
      classifiedTip: status.coreTip,
      classificationRevision: status.activeRevision,
    },
    flags: { userFrozen: false, dustQuarantined: false },
  };
}

describe('wallet-wide UTXO cache reads', () => {
  it('ignores a stale coinciding Xverse record once the standard unit exists', async () => {
    const cache = new MemoryWalletCache();
    const now = Date.parse(status.timestamp) + 15_000;
    const gateway = {
      endpoint: 'http://fixture-gateway',
      fetchStatus: async () => ({ ok: true as const, status, verifiedAtMs: now }),
    } as unknown as GatewayClient;
    const harness = makeHarness(now, { network: 'signet', gateway, walletCache: cache });
    const { vaultId } = await harness.service.restore({ name: 'shadow cache', password: PASSWORD, mnemonic: MNEMONIC });
    const unlocked = await harness.service.unlock({ vaultId, password: PASSWORD });
    const expectation = {
      expectedVaultId: vaultId,
      expectedSessionId: unlocked.sessionId,
      accountId: ACCOUNT_ID,
    };
    const session = await getSession(harness.session);
    if (!session) throw new Error('missing session');
    const dek = base64ToBytes(session.dekB64);
    const staleSpent = utxo('a'.repeat(64), 10_000n, 0);
    const liveChange = utxo('b'.repeat(64), 7_266n, 1);
    const distinctLegacy = utxo('c'.repeat(64), 5_000n, 0);
    const coinciding = xverseManifest('signet').entries.find(
      (entry) => entry.purpose === 84 && entry.lane === 'payment',
    );
    const distinct = xverseManifest('signet').entries.find(
      (entry) => entry.purpose === 49 && entry.lane === 'payment',
    );
    if (!coinciding) throw new Error('missing coinciding Xverse payment entry');
    if (!distinct) throw new Error('missing distinct Xverse payment entry');

    await cache.put(sealRecord(dek, [liveChange], {
      vaultId, network: 'signet', type: 'utxos', key: 'a0:payment',
    }, new Uint8Array(24).fill(1), now));
    await cache.put(sealRecord(dek, [staleSpent], {
      vaultId, network: 'signet', type: 'utxos', key: `xverse:${coinciding.id}`,
    }, new Uint8Array(24).fill(2), now));
    await cache.put(sealRecord(dek, [distinctLegacy], {
      vaultId, network: 'signet', type: 'utxos', key: `xverse:${distinct.id}`,
    }, new Uint8Array(24).fill(3), now));
    dek.fill(0);

    const listed = await harness.service.listUtxos({ feeRateSatPerKvB: 1000, ...expectation });
    expect(listed.utxos).toEqual(expect.arrayContaining([
      expect.objectContaining({ txid: liveChange.outpoint.txid, valueSats: '7266' }),
      expect.objectContaining({ txid: distinctLegacy.outpoint.txid, valueSats: '5000' }),
    ]));
    expect(listed.utxos).toHaveLength(2);
    expect(listed.utxos).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ txid: staleSpent.outpoint.txid }),
    ]));
    const home = await harness.service.homeView(expectation);
    expect(home.balances.availableSats).toBe('12266');
  });
});

describe('local UTXO labels (§14.4)', () => {
  async function labelHarness() {
    const cache = new MemoryWalletCache();
    const now = Date.parse(status.timestamp) + 15_000;
    const gateway = {
      endpoint: 'http://fixture-gateway',
      fetchStatus: async () => ({ ok: true as const, status, verifiedAtMs: now }),
      fetchFees: async () => ({ ok: true as const, value: fees, verifiedAtMs: now }),
    } as unknown as GatewayClient;
    const harness = makeHarness(now, { network: 'signet', gateway, walletCache: cache });
    const { vaultId } = await harness.service.restore({
      name: 'labels', password: PASSWORD, mnemonic: MNEMONIC,
    });
    const unlocked = await harness.service.unlock({ vaultId, password: PASSWORD });
    const expectation = {
      expectedVaultId: vaultId,
      expectedSessionId: unlocked.sessionId,
      accountId: ACCOUNT_ID,
    };
    // Re-derives the DEK per call and zeroizes it, so a test can simulate a
    // rescan rewriting the per-unit record more than once.
    const write = async (utxos: WalletUtxo[], fill: number): Promise<void> => {
      const session = await getSession(harness.session);
      if (!session) throw new Error('missing session');
      const dek = base64ToBytes(session.dekB64);
      try {
        await cache.put(sealRecord(dek, utxos, {
          vaultId, network: 'signet', type: 'utxos', key: 'a0:payment',
        }, new Uint8Array(24).fill(fill), now));
      } finally {
        dek.fill(0);
      }
    };
    /**
     * Corrupts the label record the way a version skew or a partial write
     * would: the box still decrypts under the session DEK, but the plaintext
     * no longer satisfies `labelsRecordSchema`.
     */
    const corruptLabels = async (): Promise<void> => {
      const session = await getSession(harness.session);
      if (!session) throw new Error('missing session');
      const dek = base64ToBytes(session.dekB64);
      try {
        await cache.put(sealRecord(dek, { version: 99, entries: 'not an array' }, {
          vaultId, network: 'signet', type: 'labels', key: ACCOUNT_ID,
        }, new Uint8Array(24).fill(77), now));
      } finally {
        dek.fill(0);
      }
    };
    return { harness, expectation, write, corruptLabels };
  }

  it('persists a label and returns it on the UTXO row', async () => {
    const { harness, expectation, write } = await labelHarness();
    const coin = utxo('a'.repeat(64), 10_000n, 0);
    await write([coin], 1);

    const result = await harness.service.setUtxoLabel({
      txid: coin.outpoint.txid, vout: 0,
      label: { preset: 'exchange_withdrawal', text: 'Kraken' },
      ...expectation,
    });
    expect(result.updated).toBe(true);

    const listed = await harness.service.listUtxos({ feeRateSatPerKvB: 1000, ...expectation });
    expect(listed.utxos[0]).toMatchObject({
      txid: coin.outpoint.txid,
      label: { preset: 'exchange_withdrawal', text: 'Kraken' },
    });
  });

  it('survives a rescan that rewrites the UTXO record wholesale', async () => {
    const { harness, expectation, write } = await labelHarness();
    const coin = utxo('a'.repeat(64), 10_000n, 0);
    await write([coin], 1);

    await harness.service.setUtxoLabel({
      txid: coin.outpoint.txid, vout: 0,
      label: { preset: 'savings', text: null },
      ...expectation,
    });

    // A rescan replaces the whole per-unit record. Labels live in their own
    // record precisely so this cannot erase them — no carry-forward needed.
    await write([utxo('a'.repeat(64), 10_000n, 0), utxo('b'.repeat(64), 4_000n, 0)], 9);

    const listed = await harness.service.listUtxos({ feeRateSatPerKvB: 1000, ...expectation });
    const labeled = listed.utxos.find((row) => row.txid === coin.outpoint.txid);
    expect(labeled?.label).toEqual({ preset: 'savings', text: null });
    const other = listed.utxos.find((row) => row.txid === 'b'.repeat(64));
    expect(other?.label).toBeNull();
  });

  it('clears a label and reports when there was nothing to clear', async () => {
    const { harness, expectation, write } = await labelHarness();
    const coin = utxo('a'.repeat(64), 10_000n, 0);
    await write([coin], 1);

    expect((await harness.service.setUtxoLabel({
      txid: coin.outpoint.txid, vout: 0, label: null, ...expectation,
    })).updated).toBe(false);

    await harness.service.setUtxoLabel({
      txid: coin.outpoint.txid, vout: 0, label: { preset: 'purchase', text: null }, ...expectation,
    });
    expect((await harness.service.setUtxoLabel({
      txid: coin.outpoint.txid, vout: 0, label: null, ...expectation,
    })).updated).toBe(true);

    const listed = await harness.service.listUtxos({ feeRateSatPerKvB: 1000, ...expectation });
    expect(listed.utxos[0]?.label).toBeNull();
  });

  it('labels a protected UTXO that could never be user-frozen', async () => {
    const { harness, expectation, write } = await labelHarness();
    const base = utxo('a'.repeat(64), 10_000n, 0);
    const inscribed: WalletUtxo = {
      ...base,
      facts: { ...base.facts!, primaryClass: 'inscribed' },
    };
    await write([inscribed], 1);

    await expect(harness.service.setUtxoFrozen({
      txid: base.outpoint.txid, vout: 0, frozen: true, ...expectation,
    })).rejects.toThrow();

    expect((await harness.service.setUtxoLabel({
      txid: base.outpoint.txid, vout: 0,
      label: { preset: null, text: 'gift from a friend' }, ...expectation,
    })).updated).toBe(true);

    const listed = await harness.service.listUtxos({ feeRateSatPerKvB: 1000, ...expectation });
    expect(listed.utxos[0]?.label).toEqual({ preset: null, text: 'gift from a friend' });
  });

  // Labels are pure annotation: they grant no §11.2 relief and only tie-break
  // under waste in selectCoins. An unreadable record therefore has to degrade,
  // because every one of these paths loads it — including the write that is the
  // only way back out.
  it('degrades an unreadable label record instead of blocking the UTXO manager', async () => {
    const { harness, expectation, write, corruptLabels } = await labelHarness();
    const coin = utxo('a'.repeat(64), 100_000n, 0);
    await write([coin], 1);
    await harness.service.setUtxoLabel({
      txid: coin.outpoint.txid, vout: 0,
      label: { preset: 'savings', text: null }, ...expectation,
    });
    await corruptLabels();

    const listed = await harness.service.listUtxos({ feeRateSatPerKvB: 1000, ...expectation });
    expect(listed.utxos).toHaveLength(1);
    expect(listed.utxos[0]?.label).toBeNull();
    // Advisory data must never move eligibility in either direction.
    expect(listed.utxos[0]?.eligible).toBe(true);
  });

  it('plans an ordinary send over an unreadable label record', async () => {
    const { harness, expectation, write, corruptLabels } = await labelHarness();
    // Planning re-derives the key behind every prevout, so this one coin needs
    // the wallet's real script rather than the placeholder the other cases use.
    const seed = mnemonicToSeed(MNEMONIC);
    const owned = deriveAddress(
      deriveAccountNode(seed, 'payment', 'signet', 0), 'payment', 'signet', 0, 0,
    );
    seed.fill(0);
    await write([{
      ...utxo('a'.repeat(64), 100_000n, 0),
      scriptPubKey: scriptPubKeyHex(owned.publicKeyHex, 'payment', 'signet'),
    }], 1);
    await corruptLabels();

    // No selectedOutpoints, so this is the automatic path that always loads
    // label groups for the §14.1 tie-break.
    const planned = await harness.service.createTransactionPlan({
      kind: 'native_send',
      account: 0,
      recipient: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
      amountSats: '20000',
      sendMax: false,
      fee: { type: 'automatic', tier: 'recommended' },
      ...expectation,
    });
    expect(planned.planId).toBeTruthy();
  });

  it('repairs an unreadable label record on the next label edit', async () => {
    const { harness, expectation, write, corruptLabels } = await labelHarness();
    const coin = utxo('a'.repeat(64), 100_000n, 0);
    await write([coin], 1);
    await corruptLabels();

    // setUtxoLabel seals a whole fresh record, so the write path is also the
    // recovery path — no explicit quarantine step is needed.
    expect((await harness.service.setUtxoLabel({
      txid: coin.outpoint.txid, vout: 0,
      label: { preset: 'purchase', text: null }, ...expectation,
    })).updated).toBe(true);

    const listed = await harness.service.listUtxos({ feeRateSatPerKvB: 1000, ...expectation });
    expect(listed.utxos[0]?.label).toEqual({ preset: 'purchase', text: null });
  });

  it('reports the §8.1 stable receive address as a wallet-wide note', async () => {
    const { harness, expectation, write } = await labelHarness();
    await write([utxo('a'.repeat(64), 10_000n, 0)], 1);

    const listed = await harness.service.listUtxos({ feeRateSatPerKvB: 1000, ...expectation });
    expect(listed.privacyNotes).toEqual(['stable_receive_address']);
  });
});
