import { describe, expect, it } from 'vitest';
import {
  GALLERY_PREVIEW_CACHE_KEY,
  GALLERY_PREVIEW_CACHE_MAX_BYTES,
  clearCachedGallery,
  loadCachedGallery,
  saveCachedGallery,
  type GalleryCacheBinding,
} from '../../src/adapters/gateway/preview-cache';
import { putSession } from '../../src/adapters/session/session-store';
import type { GalleryCachedItem } from '@drey/core/messaging/ops';
import { makeFakeArea, type FakeArea } from './fake-area';

const binding: GalleryCacheBinding = {
  vaultId: 'vault-1',
  sessionId: '11111111-1111-4111-8111-111111111111',
  network: 'signet',
  accountId: `acct_signet_${'1'.repeat(64)}`,
};

function id(seed: string): string {
  return `${seed.repeat(64).slice(0, 64)}i0`;
}

/** Distinct, schema-valid inscription ids for bulk cases. */
function numberedId(index: number): string {
  return `${index.toString(16).padStart(8, '0')}${'0'.repeat(56)}i0`;
}

function raster(sizeBytes: number): NonNullable<GalleryCachedItem['preview']> {
  return {
    kind: 'raster',
    rasterBase64: 'A'.repeat(sizeBytes),
    pngSha256: 'b'.repeat(64),
    pngWidth: 64,
    pngHeight: 64,
  };
}

function item(seed: string, overrides: Partial<GalleryCachedItem> = {}): GalleryCachedItem {
  return {
    inscriptionId: id(seed),
    state: 'visible',
    number: 1,
    contentType: 'image/png',
    contentLength: 1024,
    satpoint: `${'c'.repeat(64)}:0:0`,
    outpoint: { txid: 'd'.repeat(64), vout: 0 },
    confirmations: 3,
    parent: null,
    delegate: null,
    reinscription: false,
    cursed: false,
    classificationRevision: 'rev-1',
    rareSats: [],
    display: { title: null, collections: [] },
    ...overrides,
  };
}

function serializedSize(area: FakeArea): number {
  return new TextEncoder()
    .encode(JSON.stringify(area.store.get(GALLERY_PREVIEW_CACHE_KEY)))
    .length;
}

describe('gallery preview cache round-trip', () => {
  it('returns what it stored for a matching binding', async () => {
    const area = makeFakeArea();
    await saveCachedGallery(area, binding, [item('a', { preview: raster(64) })], 1234);

    const loaded = await loadCachedGallery(area, binding);
    expect(loaded?.cachedAt).toBe(1234);
    expect(loaded?.items).toHaveLength(1);
    const loadedPreview = loaded?.items[0]?.preview;
    expect(loadedPreview?.kind).toBe('raster');
    if (loadedPreview?.kind !== 'raster') throw new Error('expected cached raster');
    expect(loadedPreview.rasterBase64).toBe('A'.repeat(64));
  });

  it('reports a miss with nothing stored', async () => {
    await expect(loadCachedGallery(makeFakeArea(), binding)).resolves.toBeNull();
  });

  it('drops everything on clear', async () => {
    const area = makeFakeArea();
    await saveCachedGallery(area, binding, [item('a', { preview: raster(64) })], 1);
    await clearCachedGallery(area);

    expect(area.store.has(GALLERY_PREVIEW_CACHE_KEY)).toBe(false);
    await expect(loadCachedGallery(area, binding)).resolves.toBeNull();
  });
});

describe('gallery preview cache self-repair', () => {
  it('drops a malformed record instead of serving it', async () => {
    const area = makeFakeArea();
    await area.set({ [GALLERY_PREVIEW_CACHE_KEY]: { vaultId: 'vault-1', items: 'nope' } });

    await expect(loadCachedGallery(area, binding)).resolves.toBeNull();
    expect(area.store.has(GALLERY_PREVIEW_CACHE_KEY)).toBe(false);
  });

  it('drops a record carrying an unexpected field', async () => {
    const area = makeFakeArea();
    await saveCachedGallery(area, binding, [item('a', { preview: raster(64) })], 1);
    const stored = area.store.get(GALLERY_PREVIEW_CACHE_KEY) as Record<string, unknown>;
    await area.set({ [GALLERY_PREVIEW_CACHE_KEY]: { ...stored, action: 'available' } });

    await expect(loadCachedGallery(area, binding)).resolves.toBeNull();
    expect(area.store.has(GALLERY_PREVIEW_CACHE_KEY)).toBe(false);
  });

  const mismatches: ReadonlyArray<[string, GalleryCacheBinding]> = [
    ['vault', { ...binding, vaultId: 'vault-2' }],
    ['session', { ...binding, sessionId: '22222222-2222-4222-8222-222222222222' }],
    ['network', { ...binding, network: 'bitcoin' }],
    ['account', { ...binding, accountId: `acct_signet_${'2'.repeat(64)}` }],
  ];
  for (const [label, other] of mismatches) {
    it(`drops a record written for a different ${label}`, async () => {
      const area = makeFakeArea();
      await saveCachedGallery(area, binding, [item('a', { preview: raster(64) })], 1);

      await expect(loadCachedGallery(area, other)).resolves.toBeNull();
      expect(area.store.has(GALLERY_PREVIEW_CACHE_KEY)).toBe(false);
    });
  }
});

describe('gallery preview cache budget', () => {
  it('keeps the serialized payload inside the budget', async () => {
    const area = makeFakeArea();
    // ~600 KiB of base64 each: eight rasters overrun the 4 MiB ceiling.
    const items = ['a', 'b', 'c', 'd', 'e', 'f', '0', '1']
      .map((seed) => item(seed, { preview: raster(600 * 1024) }));

    await saveCachedGallery(area, binding, items, 1);

    expect(serializedSize(area)).toBeLessThanOrEqual(GALLERY_PREVIEW_CACHE_MAX_BYTES);
    const loaded = await loadCachedGallery(area, binding);
    // Every card still has its metadata, so the cached grid does not reflow;
    // only the rasters that did not fit are missing.
    expect(loaded?.items).toHaveLength(items.length);
    const withRaster = loaded?.items.filter((entry) => entry.preview !== undefined) ?? [];
    expect(withRaster.length).toBeGreaterThan(0);
    expect(withRaster.length).toBeLessThan(items.length);
  });

  it('prioritizes visible recent rasters without changing metadata order', async () => {
    const area = makeFakeArea();
    const items = ['a', 'b', 'c', 'd', 'e', 'f', '0', '1']
      .map((seed, index) => item(seed, {
        confirmations: index + 1,
        preview: raster(600 * 1024),
      }));
    items[0] = { ...items[0]!, state: 'hidden', confirmations: 0 };
    items[7] = { ...items[7]!, confirmations: 0 };

    await saveCachedGallery(area, binding, items, 1);

    const loaded = await loadCachedGallery(area, binding);
    expect(loaded?.items.map((entry) => entry.inscriptionId))
      .toEqual(items.map((entry) => entry.inscriptionId));
    expect(loaded?.items[7]?.preview).toBeDefined();
    expect(loaded?.items[0]?.preview).toBeUndefined();
  });

  it('drops trailing cards when metadata alone overruns the budget', async () => {
    const area = makeFakeArea();
    // Schema-maximal metadata: ~5 KiB a card, so a full 4096-card wallet cannot
    // fit even before a single raster is attached.
    const items = Array.from({ length: 1200 }, (_unused, index) => item('a', {
      inscriptionId: numberedId(index),
      satpoint: 'f'.repeat(512),
      contentType: 'x'.repeat(256),
      classificationRevision: 'r'.repeat(256),
      rareSats: Array.from({ length: 64 }, () => 'y'.repeat(64)),
    }));
    items[0] = { ...items[0]!, preview: raster(64) };

    await saveCachedGallery(area, binding, items, 1);

    expect(serializedSize(area)).toBeLessThanOrEqual(GALLERY_PREVIEW_CACHE_MAX_BYTES);
    const loaded = await loadCachedGallery(area, binding);
    expect(loaded?.items.length).toBeGreaterThan(0);
    expect(loaded?.items.length).toBeLessThan(items.length);
  });

  it('leaves the session record writable with the cache at its ceiling', async () => {
    // chrome.storage.session is a 10 MiB TOTAL quota shared with the DEK. A
    // full preview cache must never be able to starve the unlock session.
    const area = quotaLimited(makeFakeArea(), 10 * 1024 * 1024);
    const items = Array.from({ length: 12 }, (_unused, index) =>
      item(String.fromCharCode(97 + index), { preview: raster(600 * 1024) }));

    await saveCachedGallery(area, binding, items, 1);

    await expect(putSession(area, {
      sessionId: binding.sessionId,
      vaultId: binding.vaultId,
      dekB64: 'A'.repeat(43) + '=',
      deadline: 9_999_999,
    })).resolves.toBeUndefined();
  });
});

describe('gallery preview cache accumulation', () => {
  it('carries a prior raster forward for an unchanged identity', async () => {
    const area = makeFakeArea();
    await saveCachedGallery(area, binding, [item('a', { preview: raster(64) })], 1);

    // A lazy follow-up batch reports everything off-screen without a raster.
    await saveCachedGallery(area, binding, [
      item('a'),
      item('b', { preview: raster(64) }),
    ], 2);

    const loaded = await loadCachedGallery(area, binding);
    expect(loaded?.items.find((entry) => entry.inscriptionId === id('a'))?.preview)
      .toBeDefined();
  });

  it('discards a prior raster once the inscription has moved', async () => {
    const area = makeFakeArea();
    await saveCachedGallery(area, binding, [item('a', { preview: raster(64) })], 1);

    await saveCachedGallery(area, binding, [
      item('a', { satpoint: `${'e'.repeat(64)}:0:0` }),
      item('b', { preview: raster(64) }),
    ], 2);

    const loaded = await loadCachedGallery(area, binding);
    expect(loaded?.items.find((entry) => entry.inscriptionId === id('a'))?.preview)
      .toBeUndefined();
  });

  // satpoint embeds txid:vout, so well-formed data cannot disagree with the
  // outpoint. These cover the guard that assumes it might anyway, matching
  // mergeRetainedPreviews in the popup hook.
  const movedOutpoints: ReadonlyArray<[string, Partial<GalleryCachedItem>]> = [
    ['txid', { outpoint: { txid: 'e'.repeat(64), vout: 0 } }],
    ['vout', { outpoint: { txid: 'd'.repeat(64), vout: 1 } }],
  ];
  for (const [label, moved] of movedOutpoints) {
    it(`discards a prior raster once the outpoint ${label} changes`, async () => {
      const area = makeFakeArea();
      await saveCachedGallery(area, binding, [item('a', { preview: raster(64) })], 1);

      await saveCachedGallery(area, binding, [
        item('a', moved),
        item('b', { preview: raster(64) }),
      ], 2);

      const loaded = await loadCachedGallery(area, binding);
      expect(loaded?.items.find((entry) => entry.inscriptionId === id('a'))?.preview)
        .toBeUndefined();
    });
  }

  it('discards a prior raster once the classification revision changes', async () => {
    const area = makeFakeArea();
    await saveCachedGallery(area, binding, [item('a', { preview: raster(64) })], 1);

    await saveCachedGallery(area, binding, [
      item('a', { classificationRevision: 'rev-2' }),
      item('b', { preview: raster(64) }),
    ], 2);

    const loaded = await loadCachedGallery(area, binding);
    expect(loaded?.items.find((entry) => entry.inscriptionId === id('a'))?.preview)
      .toBeUndefined();
  });

  it('leaves a warm cache alone when a batch carries no rasters', async () => {
    const area = makeFakeArea();
    await saveCachedGallery(area, binding, [item('a', { preview: raster(64) })], 1);

    // A revalidation of an off-screen grid must not destroy the paint-ahead it
    // exists to serve.
    await saveCachedGallery(area, binding, [item('z')], 2);

    const loaded = await loadCachedGallery(area, binding);
    expect(loaded?.cachedAt).toBe(1);
    expect(loaded?.items[0]?.inscriptionId).toBe(id('a'));
  });

  it('writes nothing at all when there has never been a raster', async () => {
    const area = makeFakeArea();
    await saveCachedGallery(area, binding, [item('a'), item('b')], 1);

    expect(area.store.has(GALLERY_PREVIEW_CACHE_KEY)).toBe(false);
  });

  it('writes nothing when the budget squeezes out every raster', async () => {
    const area = makeFakeArea();
    // Metadata-only is not worth a session write: there is nothing to paint
    // ahead, and the grid would render exactly as it does with no cache at all.
    await saveCachedGallery(area, binding, [
      item('a', { preview: raster(GALLERY_PREVIEW_CACHE_MAX_BYTES) }),
    ], 1);

    expect(area.store.has(GALLERY_PREVIEW_CACHE_KEY)).toBe(false);
  });
});

describe('gallery preview cache write failures', () => {
  it('swallows a rejected write and leaves nothing readable behind', async () => {
    const area = makeFakeArea();
    area.failOnSetKey = GALLERY_PREVIEW_CACHE_KEY;

    // Reported rather than thrown, so the caller can tell a stored batch from
    // one it must not mark as cached.
    await expect(
      saveCachedGallery(area, binding, [item('a', { preview: raster(64) })], 1),
    ).resolves.toBe(false);
    expect(area.store.has(GALLERY_PREVIEW_CACHE_KEY)).toBe(false);
  });

  it('reports whether a record was actually stored', async () => {
    const area = makeFakeArea();

    await expect(saveCachedGallery(area, binding, [item('a')], 1)).resolves.toBe(false);
    await expect(saveCachedGallery(area, binding, [item('a', { preview: raster(64) })], 1))
      .resolves.toBe(true);
  });

  it('removes a stale entry when a later write is rejected', async () => {
    const area = makeFakeArea();
    await saveCachedGallery(area, binding, [item('a', { preview: raster(64) })], 1);
    area.failOnSetKey = GALLERY_PREVIEW_CACHE_KEY;

    await saveCachedGallery(area, binding, [item('b', { preview: raster(64) })], 2);

    expect(area.store.has(GALLERY_PREVIEW_CACHE_KEY)).toBe(false);
  });
});

/** Wraps a fake area in the 10 MiB total ceiling chrome.storage.session has. */
function quotaLimited(area: FakeArea, quotaBytes: number): FakeArea {
  const inner = area.set.bind(area);
  area.set = async (items: Record<string, unknown>): Promise<void> => {
    const next = new Map(area.store);
    for (const [key, value] of Object.entries(items)) next.set(key, value);
    let total = 0;
    for (const [key, value] of next) {
      total += new TextEncoder().encode(`${key}${JSON.stringify(value)}`).length;
    }
    if (total > quotaBytes) throw new Error('QUOTA_BYTES quota exceeded');
    await inner(items);
  };
  return area;
}
