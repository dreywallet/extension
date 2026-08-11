import type { GalleryViewResult } from './hooks/use-gallery-data';

export type GalleryCollectionItem = GalleryViewResult['items'][number];

export type GalleryCollectionGroup = {
  key: string;
  kind: 'collection' | 'multiple' | 'other';
  collection: GalleryCollectionItem['display']['collections'][number] | null;
  items: GalleryCollectionItem[];
};

/**
 * Builds the gallery's stable, verified collection projection. Collection
 * metadata has already crossed the signed gallery boundary; this helper only
 * decides presentation and never grants authority or enables an action.
 */
export function groupGalleryItems(
  items: readonly GalleryCollectionItem[],
): GalleryCollectionGroup[] {
  const byKey = new Map<string, GalleryCollectionGroup>();
  for (const item of items) {
    const parents = item.display.collections.filter((collection) => collection.kind === 'parent');
    const galleries = item.display.collections.filter(
      (collection) => collection.kind === 'gallery',
    );
    const primary = parents.length === 1
      ? parents[0]!
      : parents.length === 0 && galleries.length === 1
        ? galleries[0]!
        : null;
    const kind = primary !== null
      ? 'collection' as const
      : item.display.collections.length > 1
        ? 'multiple' as const
        : 'other' as const;
    const key = primary === null ? kind : `${primary.kind}:${primary.slug}`;
    const group = byKey.get(key) ?? { key, kind, collection: primary, items: [] };
    group.items.push(item);
    byKey.set(key, group);
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.kind === 'collection' && b.kind === 'collection') {
      return a.collection!.name.localeCompare(b.collection!.name);
    }
    const rank = { collection: 0, multiple: 1, other: 2 };
    return rank[a.kind] - rank[b.kind];
  });
}
