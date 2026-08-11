/**
 * L1 paint-only gallery preview cache in chrome.storage.session.
 *
 * A cold popup — first open, or after an MV3 worker restart — otherwise paints
 * nothing while a multi-MiB signed batch runs. This holds the previous batch's
 * verified rasters plus title/collection display metadata so the grid and its
 * grouping can appear immediately without a second layout. The stored
 * projection has no `action` and no `mediaAvailable`, so it cannot carry the
 * authority that gates Send, Rescue, or the media viewer. It is always
 * superseded by fresh worker authority, and `gallery.cached` is closed to
 * approval senders, which must refetch and reverify the signed contract.
 *
 * This fast tier is memory-backed, dropped with the browser session, and bound
 * to the exact vault/session/network/account it was written for. The separate
 * L2 cache stores only DEK-sealed settled previews in the encrypted wallet
 * cache and is never read through this authority-free RPC.
 */
import { z } from 'zod';
import { getJson, type StorageArea } from '../storage/area';
import { galleryCachedItemSchema, type GalleryCachedItem } from '@drey/core/messaging/ops';

export const GALLERY_PREVIEW_CACHE_KEY = 'squirrel:galleryPreviewCache';

/**
 * Hard ceiling on the SERIALIZED record, not on decoded PNG bytes: base64
 * inflates ~4/3 and chrome.storage counts the serialized form.
 *
 * chrome.storage.session is a 10 MiB TOTAL quota that already holds the DEK
 * (`squirrel:session`). 4 MiB leaves well over half of it free, which matters
 * because a full session area would make the idle-deadline `putSession` fail —
 * a lock-state write must never lose to a cosmetic one. Lazy loading keeps the
 * real working set to the handful of rasters actually on screen, so this
 * ceiling is generous rather than tight.
 */
export const GALLERY_PREVIEW_CACHE_MAX_BYTES = 4 * 1024 * 1024;

export interface GalleryCacheBinding {
  vaultId: string;
  sessionId: string;
  network: string;
  accountId: string;
}

export interface CachedGallery {
  items: GalleryCachedItem[];
  cachedAt: number;
}

const cachedGalleryRecordSchema = z
  .object({
    vaultId: z.string().min(1),
    sessionId: z.string().min(1),
    network: z.string().min(1),
    accountId: z.string().regex(/^acct_(?:mainnet|signet)_[0-9a-f]{64}$/u),
    cachedAt: z.number().int().nonnegative(),
    items: z.array(galleryCachedItemSchema).max(4096),
  })
  .strict();

type CachedGalleryRecord = z.infer<typeof cachedGalleryRecordSchema>;

function matchesBinding(record: CachedGalleryRecord, binding: GalleryCacheBinding): boolean {
  return record.vaultId === binding.vaultId &&
    record.sessionId === binding.sessionId &&
    record.network === binding.network &&
    record.accountId === binding.accountId;
}

/**
 * Read the cache for exactly this binding.
 *
 * Malformed, or written for a different vault, session, network, or account:
 * self-repair by dropping it, like `loadCachedStatus`. Presenting one account's
 * pixels under another's identity is precisely the confusion this cache must
 * not create, and a session change means the previous unlock is over.
 */
export async function loadCachedGallery(
  session: StorageArea,
  binding: GalleryCacheBinding,
): Promise<CachedGallery | null> {
  const raw = await getJson<unknown>(session, GALLERY_PREVIEW_CACHE_KEY);
  if (raw === undefined) return null;
  const parsed = cachedGalleryRecordSchema.safeParse(raw);
  if (!parsed.success || !matchesBinding(parsed.data, binding)) {
    await session.remove(GALLERY_PREVIEW_CACHE_KEY);
    return null;
  }
  return { items: parsed.data.items, cachedAt: parsed.data.cachedAt };
}

export async function clearCachedGallery(session: StorageArea): Promise<void> {
  await session.remove(GALLERY_PREVIEW_CACHE_KEY);
}

function withoutPreview(item: GalleryCachedItem): GalleryCachedItem {
  const rest = { ...item };
  delete rest.preview;
  return rest;
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * A raster is bound to an exact identity, so carrying one forward across a
 * satpoint, outpoint, or classification change could show the wrong image for
 * the wrong thing. Mirrors `mergeRetainedPreviews` in the popup hook.
 */
function sameIdentity(a: GalleryCachedItem, b: GalleryCachedItem): boolean {
  return a.satpoint === b.satpoint &&
    a.outpoint.txid === b.outpoint.txid &&
    a.outpoint.vout === b.outpoint.vout &&
    a.classificationRevision === b.classificationRevision;
}

/**
 * Fit the projection inside the byte budget.
 *
 * Metadata first, so the cached grid has the same card count as the live grid
 * and does not reflow when authority arrives; rasters are then attached
 * greedily in item order. An item that misses out keeps its metadata and simply
 * has no cached image, which renders as the ordinary lazy placeholder.
 *
 * Per-item sizes are measured once rather than re-serializing the whole record
 * per candidate. `TextEncoder` makes each measurement byte-exact, including
 * non-ASCII metadata, and the comma accounting rounds up, so the running total
 * can only ever overstate the payload — never let it overrun. A rejected write
 * is still handled by the caller, which removes the key rather than leaving a
 * partial record readable.
 */
function fitToBudget(
  binding: GalleryCacheBinding,
  cachedAt: number,
  items: readonly GalleryCachedItem[],
): CachedGalleryRecord {
  const envelope = serializedBytes({ ...binding, cachedAt, items: [] });
  const bare = items.map(withoutPreview);
  // +1 for the separating comma each item after the first contributes.
  const metaCost = bare.map((item) => serializedBytes(item) + 1);

  let used = envelope;
  let kept = 0;
  while (kept < bare.length && used + metaCost[kept]! <= GALLERY_PREVIEW_CACHE_MAX_BYTES) {
    used += metaCost[kept]!;
    kept += 1;
  }

  const chosen = bare.slice(0, kept);
  // Keep metadata in gallery order so paint-ahead does not reflow, but spend
  // the raster budget on Home's useful working set first: visible and most
  // recently acquired (pending, then least-confirmed) items.
  const previewIndexes = Array.from({ length: kept }, (_, index) => index)
    .sort((leftIndex, rightIndex) => {
      const left = items[leftIndex]!;
      const right = items[rightIndex]!;
      if (left.state !== right.state) return left.state === 'visible' ? -1 : 1;
      if (left.confirmations !== right.confirmations) {
        return left.confirmations - right.confirmations;
      }
      return left.inscriptionId.localeCompare(right.inscriptionId);
    });
  for (const index of previewIndexes) {
    // previewIndexes is constructed from the kept prefix above. Keep this
    // defensive guard if that selection strategy changes later.
    if (index >= chosen.length) continue;
    const full = items[index]!;
    if (full.preview === undefined) continue;
    // Exactly what adding the field costs, wherever it lands in key order:
    // the serialized value plus `"preview":` and its separating comma.
    const extra = serializedBytes(full.preview) + '"preview":,'.length;
    if (used + extra > GALLERY_PREVIEW_CACHE_MAX_BYTES) continue;
    used += extra;
    chosen[index] = full;
  }

  return { ...binding, cachedAt, items: chosen };
}

/**
 * Replace the cache with this batch's rasters. Never throws.
 *
 * Merges against the existing record first: `gallery.list` only returns rasters
 * it actually fetched, so a lazy follow-up batch reports everything off-screen
 * as `not_requested`. Writing that verbatim would shrink the cache on every
 * scroll instead of accumulating what the user has seen.
 *
 * A batch that yields no rasters at all leaves the previous entry alone rather
 * than evicting it — a background revalidation must not destroy the paint-ahead
 * it exists to serve.
 *
 * Best-effort by design: the caller has already written the session record, and
 * a quota rejection here is cosmetic. On failure the key is removed so a
 * partial or rejected write can never be read back as a cache hit.
 *
 * Returns whether a record was actually stored, so a caller deduplicating
 * repeat writes can avoid marking a batch as cached when it was not.
 */
export async function saveCachedGallery(
  session: StorageArea,
  binding: GalleryCacheBinding,
  items: readonly GalleryCachedItem[],
  cachedAt: number,
): Promise<boolean> {
  try {
    const existing = await loadCachedGallery(session, binding);
    const priorById = new Map((existing?.items ?? []).map((item) => [item.inscriptionId, item]));
    const merged = items.map((item) => {
      if (item.preview !== undefined) return item;
      const prior = priorById.get(item.inscriptionId);
      if (prior?.preview === undefined || !sameIdentity(prior, item)) return item;
      return { ...item, preview: prior.preview };
    });
    const record = fitToBudget(binding, cachedAt, merged);
    if (!record.items.some((item) => item.preview !== undefined)) return false;
    await session.set({ [GALLERY_PREVIEW_CACHE_KEY]: record });
    return true;
  } catch {
    try {
      await session.remove(GALLERY_PREVIEW_CACHE_KEY);
    } catch {
      // Nothing further to do: the cache is optional and the caller's session
      // record is already committed.
    }
    return false;
  }
}
