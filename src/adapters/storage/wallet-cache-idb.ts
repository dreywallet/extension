/**
 * IndexedDB implementation of WalletCachePort — the ONLY module that touches
 * IndexedDB (spec §5.1). Stores sealed records only (see wallet-cache.ts);
 * nothing here can read cache content. IndexedDB is available in MV3 service
 * workers and survives worker restarts; vault removal clears via the vaultId
 * index.
 */
import type {
  WalletCacheKey,
  WalletCachePort,
  WalletCacheRecord,
  WalletCacheRecordType,
} from './wallet-cache';
import type { Network } from '@drey/core/domain/keys/derivation';

const DB_NAME = 'drey-wallet-cache';
const DB_VERSION = 1;
const STORE = 'records';
const VAULT_INDEX = 'byVault';

function idbKey(key: WalletCacheKey): [string, string, string, string] {
  return [key.vaultId, key.network, key.type, key.key];
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(
      transaction.error ?? new Error('IndexedDB transaction aborted'),
    );
  });
}

export class IdbWalletCache implements WalletCachePort {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly factory: IDBFactory = indexedDB,
    // Injected alongside the factory so tests can run without IDB globals.
    private readonly keyRange: typeof IDBKeyRange = IDBKeyRange,
  ) {}

  private open(): Promise<IDBDatabase> {
    this.dbPromise ??= new Promise((resolve, reject) => {
      const request = this.factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, {
            keyPath: ['vaultId', 'network', 'type', 'key'],
          });
          store.createIndex(VAULT_INDEX, 'vaultId', { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // A concurrent upgrade (future version) closes us; drop the handle so
        // the next call reopens instead of using a closing connection.
        db.onversionchange = () => {
          db.close();
          this.dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
    return this.dbPromise;
  }

  private async transaction(mode: IDBTransactionMode): Promise<IDBTransaction> {
    const db = await this.open();
    return db.transaction(STORE, mode);
  }

  async get(key: WalletCacheKey): Promise<WalletCacheRecord | undefined> {
    const store = (await this.transaction('readonly')).objectStore(STORE);
    return requestToPromise(store.get(idbKey(key))) as Promise<WalletCacheRecord | undefined>;
  }

  async put(record: WalletCacheRecord): Promise<void> {
    const transaction = await this.transaction('readwrite');
    await Promise.all([
      requestToPromise(transaction.objectStore(STORE).put(record)),
      transactionToPromise(transaction),
    ]);
  }

  async delete(key: WalletCacheKey): Promise<void> {
    const transaction = await this.transaction('readwrite');
    await Promise.all([
      requestToPromise(transaction.objectStore(STORE).delete(idbKey(key))),
      transactionToPromise(transaction),
    ]);
  }

  async listKeys(
    vaultId: string,
    network: Network,
    type: WalletCacheRecordType,
  ): Promise<string[]> {
    const store = (await this.transaction('readonly')).objectStore(STORE);
    const range = this.keyRange.bound([vaultId, network, type, ''], [vaultId, network, type, '￿']);
    const keys = await requestToPromise(store.getAllKeys(range));
    return keys.map((k) => String((k as [string, string, string, string])[3]));
  }

  async clearVault(vaultId: string): Promise<void> {
    const transaction = await this.transaction('readwrite');
    const operations = async () => {
      const store = transaction.objectStore(STORE);
      const keys = await requestToPromise(store.index(VAULT_INDEX).getAllKeys(vaultId));
      for (const key of keys) await requestToPromise(store.delete(key));
    };
    await Promise.all([operations(), transactionToPromise(transaction)]);
  }
}

/** In-memory fake for tests and non-IDB environments. */
export class MemoryWalletCache implements WalletCachePort {
  private records = new Map<string, WalletCacheRecord>();

  private static mapKey(key: WalletCacheKey): string {
    return `${key.vaultId}\0${key.network}\0${key.type}\0${key.key}`;
  }

  get(key: WalletCacheKey): Promise<WalletCacheRecord | undefined> {
    return Promise.resolve(this.records.get(MemoryWalletCache.mapKey(key)));
  }

  put(record: WalletCacheRecord): Promise<void> {
    this.records.set(MemoryWalletCache.mapKey(record), { ...record });
    return Promise.resolve();
  }


  delete(key: WalletCacheKey): Promise<void> {
    this.records.delete(MemoryWalletCache.mapKey(key));
    return Promise.resolve();
  }

  listKeys(vaultId: string, network: Network, type: WalletCacheRecordType): Promise<string[]> {
    const out: string[] = [];
    for (const record of this.records.values()) {
      if (record.vaultId === vaultId && record.network === network && record.type === type) {
        out.push(record.key);
      }
    }
    return Promise.resolve(out.sort());
  }

  clearVault(vaultId: string): Promise<void> {
    for (const [mapKey, record] of this.records) {
      if (record.vaultId === vaultId) this.records.delete(mapKey);
    }
    return Promise.resolve();
  }
}
