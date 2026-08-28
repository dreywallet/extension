import { beforeAll, describe, expect, it } from 'vitest';
import { indexedDB as fakeIndexedDB, IDBKeyRange as fakeIDBKeyRange } from 'fake-indexeddb';
import { z } from 'zod';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { VaultError } from '@drey/core/domain/vault/errors';
import {
  decodeCachePlaintext,
  encodeCachePlaintext,
  openRecord,
  sealRecord,
  type WalletCacheKey,
  type WalletCachePort,
} from '../../src/adapters/storage/wallet-cache';
import { IdbWalletCache, MemoryWalletCache } from '../../src/adapters/storage/wallet-cache-idb';
import { galleryRecordSchema, storedUtxoSchema } from '@drey/core/scan/cache-schemas';

const DEK = new Uint8Array(32).fill(7);
const OTHER_DEK = new Uint8Array(32).fill(8);
const NONCE = new Uint8Array(24).fill(3);

const KEY: WalletCacheKey = { vaultId: 'v1', network: 'signet', type: 'utxos', key: 'a0:payment' };

const utxoSchema = z.object({ valueSats: z.bigint(), label: z.string() });

beforeAll(async () => {
  await installTestCryptoProvider();
});

describe('cache codec', () => {
  it('round-trips bigints as tagged decimal strings', () => {
    const value = { valueSats: 123_456_789_012_345n, label: 'x' };
    expect(decodeCachePlaintext(encodeCachePlaintext(value))).toEqual(value);
  });

  it('rejects contradictory clean facts and out-of-range cached outpoints', () => {
    const stored = {
      accountId: `acct_mainnet_${'1'.repeat(64)}`,
      outpoint: { txid: 'a'.repeat(64), vout: 0 },
      valueSats: 10_000n,
      scriptPubKey: `0014${'b'.repeat(40)}`,
      account: 0,
      lane: 'payment',
      chain: 0,
      addressIndex: 0,
      height: 1,
      walletCreatedChange: false,
      facts: {
        primaryClass: 'cardinal_clean',
        inscriptions: [],
        satRanges: null,
        unsupportedAssetDetected: false,
        confidence: 'authoritative',
        classifiedTip: { height: 1, hash: 'c'.repeat(64) },
        classificationRevision: 'rev-1',
      },
      flags: { userFrozen: false, dustQuarantined: false },
    } as const;
    expect(storedUtxoSchema.safeParse(stored).success).toBe(true);
    expect(
      storedUtxoSchema.safeParse({
        ...stored,
        facts: { ...stored.facts, unsupportedAssetDetected: true },
      }).success,
    ).toBe(false);
    expect(
      storedUtxoSchema.safeParse({
        ...stored,
        outpoint: { ...stored.outpoint, vout: 0x100000000 },
      }).success,
    ).toBe(false);
  });

  it('migrates legacy gallery organization to visible/hidden only', () => {
    const legacy = {
      version: 1,
      items: (['received', 'kept', 'hidden', 'previous'] as const).map((state, index) => ({
        inscriptionId: `${String(index + 1).repeat(64)}i0`,
        account: 0,
        state,
        firstSeenAt: 1,
        lastSeenAt: 2,
        metadata: null,
      })),
    };
    expect(galleryRecordSchema.parse(legacy)).toEqual({
      version: 2,
      items: legacy.items.map((item) => ({
        ...item,
        state: item.state === 'hidden' ? 'hidden' : 'visible',
      })),
    });
  });
});

describe('sealed records', () => {
  it('seal/open round-trips through the schema', () => {
    const record = sealRecord(DEK, { valueSats: 42n, label: 'u' }, KEY, NONCE, 1000);
    expect(record.v).toBe(1);
    expect(openRecord(DEK, record, utxoSchema)).toEqual({ valueSats: 42n, label: 'u' });
  });

  it('fails authentication under a different DEK', () => {
    const record = sealRecord(DEK, { valueSats: 42n, label: 'u' }, KEY, NONCE, 1000);
    expect(() => openRecord(OTHER_DEK, record, utxoSchema)).toThrow(VaultError);
  });

  it('AAD binds vaultId, network, type, and key — any move fails closed', () => {
    const record = sealRecord(DEK, { valueSats: 42n, label: 'u' }, KEY, NONCE, 1000);
    const moves: Partial<WalletCacheKey>[] = [
      { vaultId: 'v2' },
      { network: 'mainnet' },
      { type: 'history' },
      { key: 'a1:payment' },
    ];
    for (const move of moves) {
      const moved = { ...record, ...move };
      expect(() => openRecord(DEK, moved, utxoSchema), JSON.stringify(move)).toThrow(VaultError);
    }
  });

  it('rejects stale plaintext shapes after decrypt', () => {
    const record = sealRecord(DEK, { legacyField: true }, KEY, NONCE, 1000);
    expect(() => openRecord(DEK, record, utxoSchema)).toThrow();
  });
});

function portConformance(name: string, makePort: () => WalletCachePort) {
  describe(`${name} port conformance`, () => {
    it('get/put/listKeys/clearVault behave per the port contract', async () => {
      const port = makePort();
      const r1 = sealRecord(DEK, { valueSats: 1n, label: 'a' }, KEY, NONCE, 1);
      const r2 = sealRecord(
        DEK,
        { valueSats: 2n, label: 'b' },
        { ...KEY, key: 'a1:ordinals' },
        NONCE,
        2,
      );
      const otherVault = sealRecord(
        DEK,
        { valueSats: 3n, label: 'c' },
        { ...KEY, vaultId: 'v2' },
        NONCE,
        3,
      );
      await port.put(r1);
      await port.putMany([r2, otherVault]);

      expect(await port.get(KEY)).toEqual(r1);
      expect(await port.get({ ...KEY, key: 'missing' })).toBeUndefined();
      expect(await port.listKeys('v1', 'signet', 'utxos')).toEqual(['a0:payment', 'a1:ordinals']);
      expect(await port.listKeys('v1', 'mainnet', 'utxos')).toEqual([]);

      // Overwrite updates in place.
      const r1b = { ...r1, updatedAt: 99 };
      await port.put(r1b);
      expect((await port.get(KEY))?.updatedAt).toBe(99);

      await port.clearVault('v1');
      expect(await port.get(KEY)).toBeUndefined();
      expect(await port.listKeys('v1', 'signet', 'utxos')).toEqual([]);
      expect(await port.get({ ...KEY, vaultId: 'v2' })).toEqual(otherVault);
    });
  });
}

portConformance('MemoryWalletCache', () => new MemoryWalletCache());
portConformance('IdbWalletCache', () => new IdbWalletCache(fakeIndexedDB, fakeIDBKeyRange));

function abortSuccessfulPutTransactions(afterSuccessfulPuts = 1): IDBFactory {
  return new Proxy(fakeIndexedDB, {
    get(target, property) {
      if (property !== 'open') {
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (name: string, version?: number): IDBOpenDBRequest => {
        const request = version === undefined ? target.open(name) : target.open(name, version);
        request.addEventListener('success', () => {
          const db = request.result;
          const transaction = db.transaction.bind(db);
          db.transaction = ((
            storeNames: string | Iterable<string>,
            mode?: IDBTransactionMode,
            options?: IDBTransactionOptions,
          ): IDBTransaction => {
            const tx = transaction(storeNames, mode, options);
            if (mode !== 'readwrite') return tx;
            const store = tx.objectStore('records');
            const put = store.put.bind(store);
            let successfulPuts = 0;
            store.put = ((value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> => {
              const putRequest = key === undefined ? put(value) : put(value, key);
              putRequest.addEventListener('success', () => {
                successfulPuts += 1;
                if (successfulPuts === afterSuccessfulPuts) tx.abort();
              }, { once: true });
              return putRequest;
            }) as typeof store.put;
            return tx;
          }) as typeof db.transaction;
        }, { once: true });
        return request;
      };
    },
  });
}

describe('IdbWalletCache transaction durability', () => {
  it('rejects when a transaction aborts after put.onsuccess and leaves no record', async () => {
    const key = { ...KEY, vaultId: 'commit-abort' };
    const record = sealRecord(DEK, { valueSats: 4n, label: 'abort' }, key, NONCE, 4);
    const cache = new IdbWalletCache(abortSuccessfulPutTransactions(), fakeIDBKeyRange);

    await expect(cache.put(record)).rejects.toThrow('IndexedDB transaction aborted');

    const committedCache = new IdbWalletCache(fakeIndexedDB, fakeIDBKeyRange);
    await expect(committedCache.get(key)).resolves.toBeUndefined();
  });

  it('commits a record group atomically when a later request aborts the transaction', async () => {
    const firstKey = { ...KEY, vaultId: 'group-abort', key: 'first' };
    const secondKey = { ...KEY, vaultId: 'group-abort', key: 'second' };
    const first = sealRecord(DEK, { valueSats: 5n, label: 'first' }, firstKey, NONCE, 5);
    const second = sealRecord(DEK, { valueSats: 6n, label: 'second' }, secondKey, NONCE, 6);
    const cache = new IdbWalletCache(abortSuccessfulPutTransactions(2), fakeIDBKeyRange);

    await expect(cache.putMany([first, second])).rejects.toThrow();

    const committedCache = new IdbWalletCache(fakeIndexedDB, fakeIDBKeyRange);
    await expect(committedCache.get(firstKey)).resolves.toBeUndefined();
    await expect(committedCache.get(secondKey)).resolves.toBeUndefined();
  });
});
