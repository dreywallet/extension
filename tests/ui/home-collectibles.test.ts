import { describe, expect, it } from 'vitest';
import type { GalleryViewResult } from '../../src/ui/hooks/use-gallery-data';
import {
  HOME_COLLECTIBLE_LIMIT,
  orderHomeCollectibleCandidates,
  retainHomeCollectiblePaint,
  selectHomeCollectibles,
} from '../../src/entrypoints/popup/home-collectibles';
import type { WalletHomeResult } from '@drey/core/messaging/ops';

type Item = GalleryViewResult['items'][number];

function item(seed: string, overrides: Partial<Item> = {}): Item {
  const inscriptionId = `${seed.repeat(64)}i0`;
  return {
    inscriptionId,
    state: 'visible',
    number: 1,
    contentType: 'image/png',
    contentLength: 10,
    satpoint: `${seed.repeat(64)}:0:0`,
    outpoint: { txid: seed.repeat(64), vout: 0 },
    confirmations: 1,
    parent: null,
    delegate: null,
    reinscription: false,
    cursed: false,
    classificationRevision: 'revision-1',
    rareSats: [],
    display: { title: null, collections: [] },
    ownership: null,
    preview: {
      kind: 'raster', rasterBase64: 'AA==', pngSha256: 'f'.repeat(64),
      pngWidth: 1, pngHeight: 1,
    },
    mediaAvailable: false,
    action: { status: 'blocked', kind: 'send', reason: 'stale_classification' },
    ...overrides,
  };
}

describe('Home collectible selection', () => {
  it('orders pending and newly acquired visible items deterministically', () => {
    const activity = [{
      txid: 'b'.repeat(64), deltaSats: '546', feeSats: null,
      confirmationState: 'mempool' as const, timestamp: '2026-08-06T12:00:00.000Z', height: null,
    }] satisfies WalletHomeResult['activity'];
    const ordered = orderHomeCollectibleCandidates([
      item('a', { confirmations: 2 }),
      item('c', { confirmations: 1 }),
      item('b', { confirmations: 0 }),
      item('d', { confirmations: 0, state: 'hidden' }),
    ], activity);
    expect(ordered.map((entry) => entry.inscriptionId[0])).toEqual(['b', 'c', 'a']);
  });

  it('keeps fresh permanent placeholders in the fixed Home preview instead of an empty row', () => {
    const candidates = ['a', 'b', 'c', 'd', 'e', 'f', '1'].map((seed, index) =>
      item(seed, { confirmations: index + 1 }));
    candidates[0] = { ...candidates[0]!, state: 'hidden' };
    candidates[1] = {
      ...candidates[1]!, preview: { kind: 'placeholder', reason: 'active_content' },
    };
    const selected = selectHomeCollectibles(candidates, []);
    expect(selected).toHaveLength(HOME_COLLECTIBLE_LIMIT);
    expect(selected.map((entry) => entry.inscriptionId[0])).toEqual(['b', 'c', 'd']);
  });

  it('retains exact settled paint only for transient live preview misses', () => {
    const painted = item('a');
    const unavailable = {
      ...painted,
      ownership: { address: 'tb1plive', lane: 'ordinals' as const, role: 'primary' as const },
      preview: { kind: 'placeholder' as const, reason: 'preview_service_unavailable' },
      action: { status: 'available' as const, kind: 'send' as const },
    };
    const retained = retainHomeCollectiblePaint([unavailable], [painted])[0]!;
    expect(retained.preview).toEqual(painted.preview);
    expect(retained.ownership).toEqual(unavailable.ownership);
    expect(retained.action).toEqual(unavailable.action);

    expect(retainHomeCollectiblePaint([
      { ...unavailable, preview: { kind: 'placeholder', reason: 'render_pending' } },
    ], [painted])[0]?.preview).toEqual(painted.preview);

    expect(retainHomeCollectiblePaint([
      { ...unavailable, classificationRevision: 'revision-2' },
    ], [painted])[0]?.preview).toEqual(unavailable.preview);
    expect(retainHomeCollectiblePaint([
      { ...unavailable, preview: { kind: 'placeholder', reason: 'active_content' } },
    ], [painted])[0]?.preview).toEqual({ kind: 'placeholder', reason: 'active_content' });
  });
});
