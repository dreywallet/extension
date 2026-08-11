/**
 * Durable, paint-only gallery preview cache.
 *
 * Settled previews are sealed under the vault DEK in the ordinary IndexedDB
 * wallet cache. They can therefore survive an extension reload, browser
 * restart, and a later unlock without becoming readable while the wallet is
 * locked. The caller must still prove current ownership and exact inscription
 * identity before loading a record; this cache carries no action, media, or
 * classification authority.
 */
import { z } from 'zod';
import {
  inscriptionPreviewPayloadSchema,
  type InscriptionPreviewPayload,
} from '@drey/core/domain/gateway/contract';
import type { Network } from '@drey/core/domain/keys/derivation';
import { bytesToHex } from '@drey/core/domain/vault/encoding';
import type { WalletCacheKey, WalletCachePort } from './wallet-cache';
import { openRecord, sealRecord } from './wallet-cache';

/** Budget counts the encrypted base64 payloads actually retained by IndexedDB. */
export const GALLERY_DURABLE_PREVIEW_BUDGET_BYTES = 32 * 1024 * 1024;
export const GALLERY_DURABLE_PREVIEW_MAX_ITEMS = 256;
/** Warm enough for Home's three tiles and the first native gallery viewport. */
export const GALLERY_DURABLE_PREVIEW_PAINT_AHEAD_ITEMS = 16;

const outpointSchema = z.object({
  txid: z.string().regex(/^[0-9a-f]{64}$/u),
  vout: z.number().int().nonnegative(),
}).strict();

/** Pending and unavailable placeholders must never mask a later real preview. */
const SETTLED_PREVIEW_DISPOSITIONS: ReadonlySet<string> =
  new Set(['raster', 'text', 'mediaBadge']);

const previewRecordSchema = z.object({
  version: z.literal(1),
  accountId: z.string().min(1),
  inscriptionId: z.string().min(1),
  satpoint: z.string().min(1),
  outpoint: outpointSchema,
  classificationRevision: z.string().min(1),
  preview: inscriptionPreviewPayloadSchema,
}).strict();

const previewIndexSchema = z.object({
  version: z.literal(1),
  items: z.array(z.object({
    inscriptionId: z.string().min(1),
    /** Random opaque IndexedDB slot; the cleartext key never names an inscription. */
    storageId: z.string().regex(/^[0-9a-f]{32}$/u),
    storedBytes: z.number().int().positive(),
    lastAccessedAt: z.number().int().nonnegative(),
  }).strict()).max(GALLERY_DURABLE_PREVIEW_MAX_ITEMS),
}).strict();

type PreviewRecord = z.infer<typeof previewRecordSchema>;
type PreviewIndex = z.infer<typeof previewIndexSchema>;

export interface DurableGalleryPreviewIdentity {
  inscriptionId: string;
  satpoint: string;
  outpoint: { txid: string; vout: number };
  classificationRevision: string;
}

export interface DurableGalleryPreviewInput extends DurableGalleryPreviewIdentity {
  preview: InscriptionPreviewPayload;
}

export interface DurableGalleryPreviewCacheDeps {
  cache: WalletCachePort;
  network: Network;
  random(length: number): Uint8Array;
  now(): number;
  budgetBytes?: number;
}

export interface DurableGalleryPreviewCache {
  load(
    dek: Uint8Array,
    vaultId: string,
    accountId: string,
    wanted: readonly DurableGalleryPreviewIdentity[],
  ): Promise<Map<string, InscriptionPreviewPayload>>;
  merge(
    dek: Uint8Array,
    vaultId: string,
    accountId: string,
    items: readonly DurableGalleryPreviewInput[],
  ): Promise<void>;
  clearAccount(vaultId: string, accountId: string): Promise<void>;
}

export function createDurableGalleryPreviewCache(
  deps: DurableGalleryPreviewCacheDeps,
): DurableGalleryPreviewCache {
  const budget = deps.budgetBytes ?? GALLERY_DURABLE_PREVIEW_BUDGET_BYTES;
  if (!Number.isInteger(budget) || budget < 1) {
    throw new RangeError('invalid durable gallery preview budget');
  }

  const indexKey = (vaultId: string, accountId: string): WalletCacheKey => ({
    vaultId,
    network: deps.network,
    type: 'gallery',
    key: `preview-index:${accountId}`,
  });
  const itemKey = (
    vaultId: string,
    accountId: string,
    storageId: string,
  ): WalletCacheKey => ({
    vaultId,
    network: deps.network,
    type: 'gallery',
    key: `preview-item:${accountId}:${storageId}`,
  });

  async function clearItems(vaultId: string, accountId: string): Promise<void> {
    const prefix = `preview-item:${accountId}:`;
    const keys = await deps.cache.listKeys(vaultId, deps.network, 'gallery');
    for (const key of keys) {
      if (key.startsWith(prefix)) {
        await deps.cache.delete({ vaultId, network: deps.network, type: 'gallery', key });
      }
    }
  }

  async function readIndex(
    dek: Uint8Array,
    vaultId: string,
    accountId: string,
  ): Promise<PreviewIndex> {
    const key = indexKey(vaultId, accountId);
    const record = await deps.cache.get(key);
    if (record === undefined) return { version: 1, items: [] };
    try {
      return openRecord(dek, record, previewIndexSchema);
    } catch {
      // An unreadable index cannot safely name its member records. Delete the
      // whole account partition and rebuild it from later verified responses.
      await deps.cache.delete(key);
      await clearItems(vaultId, accountId);
      return { version: 1, items: [] };
    }
  }

  async function writeIndex(
    dek: Uint8Array,
    vaultId: string,
    accountId: string,
    index: PreviewIndex,
  ): Promise<void> {
    const key = indexKey(vaultId, accountId);
    await deps.cache.put(sealRecord(
      dek,
      previewIndexSchema.parse(index),
      key,
      deps.random(24),
      deps.now(),
    ));
  }

  return {
    async load(dek, vaultId, accountId, wanted) {
      const index = await readIndex(dek, vaultId, accountId);
      const byId = new Map(index.items.map((item) => [item.inscriptionId, item]));
      const output = new Map<string, InscriptionPreviewPayload>();
      let changed = false;
      const now = deps.now();
      for (const candidate of wanted) {
        const indexed = byId.get(candidate.inscriptionId);
        if (indexed === undefined) continue;
        const key = itemKey(vaultId, accountId, indexed.storageId);
        const sealed = await deps.cache.get(key);
        if (sealed === undefined) {
          byId.delete(candidate.inscriptionId);
          changed = true;
          continue;
        }
        try {
          const record = openRecord(dek, sealed, previewRecordSchema);
          const matches = record.accountId === accountId &&
            record.inscriptionId === candidate.inscriptionId &&
            record.satpoint === candidate.satpoint &&
            record.outpoint.txid === candidate.outpoint.txid &&
            record.outpoint.vout === candidate.outpoint.vout &&
            record.classificationRevision === candidate.classificationRevision &&
            SETTLED_PREVIEW_DISPOSITIONS.has(record.preview.disposition);
          if (!matches) {
            await deps.cache.delete(key);
            byId.delete(candidate.inscriptionId);
          } else {
            output.set(candidate.inscriptionId, record.preview);
            byId.set(candidate.inscriptionId, { ...indexed, lastAccessedAt: now });
          }
          changed = true;
        } catch {
          await deps.cache.delete(key);
          byId.delete(candidate.inscriptionId);
          changed = true;
        }
      }
      if (changed) {
        await writeIndex(dek, vaultId, accountId, {
          version: 1,
          items: [...byId.values()],
        });
      }
      return output;
    },

    async merge(dek, vaultId, accountId, inputs) {
      const settled = inputs.filter(
        (item) => SETTLED_PREVIEW_DISPOSITIONS.has(item.preview.disposition),
      );
      if (settled.length === 0) return;
      const index = await readIndex(dek, vaultId, accountId);
      const byId = new Map(index.items.map((item) => [item.inscriptionId, item]));
      const usedStorageIds = new Set(index.items.map((item) => item.storageId));
      const now = deps.now();
      for (const input of settled) {
        const prior = byId.get(input.inscriptionId);
        let storageId = prior?.storageId;
        if (storageId === undefined) {
          // A random opaque slot avoids leaking inscription IDs through the
          // cleartext IndexedDB primary key. Retry the astronomically unlikely
          // collision rather than overwriting another encrypted item.
          for (let attempt = 0; attempt < 4 && storageId === undefined; attempt += 1) {
            const candidate = bytesToHex(deps.random(16));
            if (!usedStorageIds.has(candidate)) storageId = candidate;
          }
          if (storageId === undefined) throw new Error('durable preview slot collision');
          usedStorageIds.add(storageId);
        }
        const key = itemKey(vaultId, accountId, storageId);
        const value: PreviewRecord = {
          version: 1,
          accountId,
          inscriptionId: input.inscriptionId,
          satpoint: input.satpoint,
          outpoint: input.outpoint,
          classificationRevision: input.classificationRevision,
          preview: input.preview,
        };
        const sealed = sealRecord(dek, value, key, deps.random(24), now);
        const storedBytes = sealed.box.ciphertextB64.length;
        if (storedBytes > budget) {
          await deps.cache.delete(key);
          byId.delete(input.inscriptionId);
        } else {
          await deps.cache.put(sealed);
          byId.set(input.inscriptionId, {
            inscriptionId: input.inscriptionId,
            storageId,
            storedBytes,
            lastAccessedAt: now,
          });
        }
      }
      let total = [...byId.values()].reduce((sum, item) => sum + item.storedBytes, 0);
      const oldestFirst = [...byId.values()].sort((left, right) =>
        left.lastAccessedAt - right.lastAccessedAt ||
        left.inscriptionId.localeCompare(right.inscriptionId));
      for (const item of oldestFirst) {
        if (total <= budget && byId.size <= GALLERY_DURABLE_PREVIEW_MAX_ITEMS) break;
        await deps.cache.delete(itemKey(vaultId, accountId, item.storageId));
        byId.delete(item.inscriptionId);
        total -= item.storedBytes;
      }
      await writeIndex(dek, vaultId, accountId, {
        version: 1,
        items: [...byId.values()],
      });
    },

    async clearAccount(vaultId, accountId) {
      await deps.cache.delete(indexKey(vaultId, accountId));
      await clearItems(vaultId, accountId);
    },
  };
}
