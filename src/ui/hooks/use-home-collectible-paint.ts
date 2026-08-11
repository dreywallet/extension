import { useEffect, useState } from 'react';
import type { GalleryCachedItem } from '@drey/core/messaging/ops';
import type { ActiveSessionExpectation } from './use-session';
import { NOT_REQUESTED, type GalleryViewItem } from './use-gallery-data';
import { useRpc } from './use-rpc';

function paintItem(item: GalleryCachedItem): GalleryViewItem {
  return {
    ...item,
    ownership: null,
    preview: item.preview ?? { kind: 'placeholder', reason: NOT_REQUESTED },
    mediaAvailable: false,
    action: {
      status: 'blocked',
      kind: 'send',
      reason: 'stale_classification',
    },
  };
}

/**
 * Home-only, locally revalidated paint. The live gallery hook runs beside this
 * and supersedes it; request generation prevents a late account/session read
 * from painting into a newer surface.
 */
export function useHomeCollectiblePaint(
  expectation: ActiveSessionExpectation,
  accountId: string,
): GalleryViewItem[] {
  const rpc = useRpc();
  const { expectedVaultId, expectedSessionId } = expectation;
  const key = `${expectedVaultId}:${expectedSessionId}:${accountId}`;
  const [paint, setPaint] = useState<{ key: string; items: GalleryViewItem[] }>({
    key,
    items: [],
  });

  useEffect(() => {
    let active = true;
    void rpc('gallery.home.cached', {
      accountId,
      expectedVaultId,
      expectedSessionId,
    }).then((response) => {
      if (!active || !response.ok || !response.result.hit) return;
      setPaint({ key, items: response.result.items.map(paintItem) });
    });
    return () => {
      active = false;
    };
  }, [accountId, expectedSessionId, expectedVaultId, key, rpc]);

  return paint.key === key ? paint.items : [];
}
