import { describe, expect, it } from 'vitest';
import {
  groupGalleryItems,
  type GalleryCollectionItem,
} from '../../src/ui/gallery-collections';

function item(
  id: string,
  collections: GalleryCollectionItem['display']['collections'],
): GalleryCollectionItem {
  return {
    inscriptionId: id,
    display: { title: null, collections },
  } as GalleryCollectionItem;
}

describe('gallery collection presentation', () => {
  it('sorts named collections before stable multiple and other shelves', () => {
    const alpha = {
      slug: 'alpha', name: 'Alpha', kind: 'gallery' as const, rootInscriptionIds: ['root-a'],
    };
    const zeta = {
      slug: 'zeta', name: 'Zeta', kind: 'parent' as const, rootInscriptionIds: ['root-z'],
    };
    const beta = {
      slug: 'beta', name: 'Beta', kind: 'gallery' as const, rootInscriptionIds: ['root-b'],
    };
    const groups = groupGalleryItems([
      item('other', []),
      item('zeta', [zeta]),
      item('multiple', [alpha, beta]),
      item('alpha-1', [alpha]),
      item('alpha-2', [alpha]),
    ]);

    expect(groups.map(({ key, items }) => [key, items.map(({ inscriptionId }) => inscriptionId)]))
      .toEqual([
        ['gallery:alpha', ['alpha-1', 'alpha-2']],
        ['parent:zeta', ['zeta']],
        ['multiple', ['multiple']],
        ['other', ['other']],
      ]);
  });
});
