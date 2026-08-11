import type { WalletHomeResult } from '@drey/core/messaging/ops';
import {
  retainExactSettledPreview,
  type GalleryViewResult,
} from '../../ui/hooks/use-gallery-data';

export const HOME_COLLECTIBLE_LIMIT = 3;
export const HOME_COLLECTIBLE_RASTER_WINDOW = 16;

export type HomeCollectible = GalleryViewResult['items'][number];

/**
 * Keep locally revalidated Home paint across a cosmetic live-preview miss.
 * Every authority-bearing field still comes from `live`; only an exact-bound,
 * settled preview is retained. A definitive signed placeholder replaces it.
 */
export function retainHomeCollectiblePaint(
  live: readonly HomeCollectible[],
  painted: readonly HomeCollectible[],
): HomeCollectible[] {
  const paintedById = new Map(painted.map((item) => [item.inscriptionId, item]));
  return live.map((item) =>
    retainExactSettledPreview(item, paintedById.get(item.inscriptionId)));
}

function activityTimeByTxid(activity: WalletHomeResult['activity']): Map<string, number> {
  const times = new Map<string, number>();
  for (const item of activity) {
    if (item.timestamp === null) continue;
    const parsed = new Date(item.timestamp).getTime();
    if (Number.isFinite(parsed)) times.set(item.txid, parsed);
  }
  return times;
}

/** Most recently acquired first: mempool, then the least-confirmed current UTXO. */
export function orderHomeCollectibleCandidates(
  items: readonly HomeCollectible[],
  activity: WalletHomeResult['activity'],
): HomeCollectible[] {
  const times = activityTimeByTxid(activity);
  return items
    .filter((item) => item.state === 'visible')
    .toSorted((left, right) => {
      const leftPending = left.confirmations === 0;
      const rightPending = right.confirmations === 0;
      if (leftPending !== rightPending) return leftPending ? -1 : 1;
      if (left.confirmations !== right.confirmations) {
        return left.confirmations - right.confirmations;
      }
      const timeDifference = (times.get(right.outpoint.txid) ?? 0) -
        (times.get(left.outpoint.txid) ?? 0);
      if (timeDifference !== 0) return timeDifference;
      const outpointDifference = `${left.outpoint.txid}:${left.outpoint.vout}`
        .localeCompare(`${right.outpoint.txid}:${right.outpoint.vout}`);
      return outpointDifference === 0
        ? left.inscriptionId.localeCompare(right.inscriptionId)
        : outpointDifference;
    });
}

export function selectHomeCollectibles(
  items: readonly HomeCollectible[],
  activity: WalletHomeResult['activity'],
): HomeCollectible[] {
  return orderHomeCollectibleCandidates(items, activity)
    .slice(0, HOME_COLLECTIBLE_LIMIT);
}
