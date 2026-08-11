/**
 * Ordinals gallery data (§13) for the popup.
 *
 * The popup unmounts the inactive tab, so component state alone makes every
 * tab switch re-issue the whole signed gallery batch — for a large wallet that
 * is several sequential multi-MiB round trips. The last result is therefore
 * held in a module-scoped store that outlives an unmount but dies with the
 * popup document, exactly like the component state it replaces. The worker
 * independently owns the bounded session and DEK-sealed durable paint caches;
 * neither is an authority source for this hook.
 *
 * Freshness is event-driven, not time-driven: a wallet-data or scan-progress
 * event drops the entry so `confirmations` and `action.status` can never go
 * stale while the popup stays open. GALLERY_FRESH_MS is only a backstop for a
 * missed event, and Refresh always forces a live batch.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isScanProgressEvent,
  isSessionStateChangedEvent,
  isWalletDataChangedEvent,
} from '@drey/core/messaging/events';
import type {
  GalleryCachedItem,
  GalleryListResult,
  GalleryOwnership,
} from '@drey/core/messaging/ops';
import { GALLERY_PREVIEW_UNAVAILABLE } from '@drey/core/messaging/ops';
import type { ActiveSessionExpectation } from './use-session';
import { useRpc } from './use-rpc';

export const SCAN_POLL_INTERVAL_MS = 500;
export const SCAN_WAIT_TIMEOUT_MS = 120_000;
/** Backstop only; invalidation events are the real freshness mechanism. */
export const GALLERY_FRESH_MS = 60_000;
/**
 * A running scan emits progress continuously, and each event can invalidate the
 * gallery. Refetching per event would issue a multi-MiB signed batch several
 * times a second, so bursts collapse into one trailing refetch.
 */
export const GALLERY_INVALIDATION_DEBOUNCE_MS = 1_000;
/** Locally synthesized by the worker for a raster the surface did not ask for. */
export const NOT_REQUESTED = 'not_requested';
/** Collapses a scroll burst into one targeted batch. */
export const GALLERY_RASTER_REQUEST_DEBOUNCE_MS = 150;
/** Recheck a visible pending inscription without requiring a manual Refresh. */
export const PENDING_GALLERY_SCAN_INTERVAL_MS = 60_000;

export type GalleryStatus = 'loading' | 'syncing' | 'ready' | 'error';

export type GalleryViewItem =
  Omit<GalleryListResult['items'][number], 'ownership'> & {
    /** Null only for the popup's non-authoritative paint-ahead hydration. */
    ownership: GalleryOwnership | null;
  };
export type GalleryViewResult =
  Omit<GalleryListResult, 'items'> & { items: GalleryViewItem[] };

interface StoreEntry {
  result: GalleryViewResult;
  fetchedAt: number;
}

/** Popup-document lifetime only. Cleared on lock, vault switch, and invalidation. */
const store = new Map<string, StoreEntry>();

/**
 * Auto-refetch state, deliberately OUTSIDE the component.
 *
 * Stale recovery starts a wallet scan, and that scan's progress invalidates the
 * gallery again. Held in a component ref this survived nothing: switching tabs
 * remounted the surface, reset the guard, and started yet another scan, so
 * hammering the tab bar could keep a wallet permanently mid-scan and stuck on
 * "Checking your wallet for Ordinals…". Keyed like the data it guards.
 */
const autoState = new Map<string, { parked: boolean }>();

/**
 * Gallery requests in flight, keyed like the cache.
 *
 * Held outside the component because a tab switch unmounts the surface: a
 * component-local guard let every remount start another full gallery
 * operation while the first was still running, so impatient switching could
 * queue several multi-MiB batch sequences before any of them populated the
 * cache. A remounting surface joins the running request instead.
 */
const inFlight = new Map<string, Promise<void>>();

/**
 * Bumped by clearGalleryDataStore. A request started before a lock must not
 * write its result into the store afterwards.
 */
let storeEpoch = 0;

/** Drop every cached gallery result (lock, session end, or explicit teardown). */
export function clearGalleryDataStore(): void {
  store.clear();
  autoState.clear();
  inFlight.clear();
  storeEpoch += 1;
}

/**
 * A failed load parks automatic refetching until the user asks again.
 * Remount-proof, so hammering the tab bar cannot restart the scan repeatedly.
 */
function autoRefetchParked(key: string): boolean {
  return autoState.get(key)?.parked === true;
}

/**
 * GALLERY_FRESH_MS already spaces out mount-driven refetches: a remount inside
 * that window paints from the store and issues nothing, and every fetch resets
 * the window. Rapid tab switching therefore cannot thrash through that path.
 * The one path that could was a FAILED load, which deletes the entry so every
 * remount refetched — hence the park above, which must outlive the component.
 */
function mountRefetchAllowed(key: string): boolean {
  return !autoRefetchParked(key);
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Carry forward rasters the caller deliberately did not re-request, but only
 * while the inscription has not moved or been reclassified. A raster is bound
 * to an exact identity, so reusing one across a satpoint, outpoint, or
 * revision change could show the wrong image for the wrong thing.
 */
export function retainExactSettledPreview(
  item: GalleryViewItem,
  before: GalleryViewItem | undefined,
): GalleryViewItem {
  if (
    item.preview.kind !== 'placeholder' ||
    (item.preview.reason !== NOT_REQUESTED &&
      item.preview.reason !== GALLERY_PREVIEW_UNAVAILABLE &&
      item.preview.reason !== 'render_pending')
  ) {
    return item;
  }
  if (
    before === undefined ||
    // Every settled kind is worth retaining — rasters, text excerpts, and
    // media badges all flash back to a placeholder otherwise whenever a
    // re-list marks the item outside the requested window.
    before.preview.kind === 'placeholder' ||
    before.satpoint !== item.satpoint ||
    before.outpoint.txid !== item.outpoint.txid ||
    before.outpoint.vout !== item.outpoint.vout ||
    before.classificationRevision !== item.classificationRevision
  ) return item;
  // Pixels only. `mediaAvailable` is derived from the content type by the
  // worker in every path, so the fresh item already has the right answer —
  // and carrying the prior's forward would pin a paint-ahead hydration's
  // deliberate `false` onto a verified item that never gets re-fetched,
  // silently killing the viewer affordance.
  return { ...item, preview: before.preview };
}

function mergeRetainedPreviews(
  next: GalleryListResult,
  prior: GalleryViewResult | null,
): GalleryViewResult {
  if (prior === null) return next;
  const priorById = new Map(prior.items.map((item) => [item.inscriptionId, item]));
  return {
    ...next,
    items: next.items.map((item) =>
      retainExactSettledPreview(item, priorById.get(item.inscriptionId))),
  };
}

/**
 * Turn the paint-only projection into something the grid can render.
 *
 * Every action becomes the schema's own blocked default and `mediaAvailable`
 * becomes false, so a surface that ignores `authority` still cannot offer Send,
 * Rescue, or the viewer on cached pixels. An item with no cached raster becomes
 * the same `not_requested` placeholder lazy loading produces, so `LazyCard`
 * asks for it through the ordinary path.
 */
function hydrateCachedGallery(
  accountId: string,
  items: readonly GalleryCachedItem[],
): GalleryViewResult {
  return {
    accountId,
    items: items.map(({ preview, ...rest }) => ({
      ...rest,
      ownership: null,
      preview: preview ?? { kind: 'placeholder' as const, reason: NOT_REQUESTED },
      mediaAvailable: false,
      action: {
        status: 'blocked' as const,
        kind: 'send' as const,
        reason: 'stale_classification' as const,
      },
    })),
    attentionItems: [],
    sweepCandidates: [],
    // Paint-ahead pixels say nothing about the live preview service; the
    // signed batch that replaces them reports the real answer.
    previewsUnavailable: false,
    collectionCatalog: null,
    recoveredAddressCount: 0,
    refreshedAt: 0,
  };
}

export interface GalleryData {
  result: GalleryViewResult | null;
  status: GalleryStatus;
  /**
   * Whether `result` came from a freshly verified signed batch. While
   * 'cached' the grid is pixels only: nothing in it may be acted on, and its
   * blocked reasons are placeholders for authority that has not arrived rather
   * than findings about the wallet.
   */
  authority: 'cached' | 'fresh';
  /**
   * True whenever a batch is in flight, including a background revalidation
   * behind an already-painted grid. Without this the Refresh button would look
   * enabled while `refreshInFlight` silently swallowed the click.
   */
  refreshing: boolean;
  /** `synchronize` runs a wallet scan first; `recoverStale` retries once on ERR_DATA_STALE. */
  refresh: (
    synchronize: boolean,
    recoverStale: boolean,
    rasterFor?: readonly string[],
  ) => Promise<void>;
  /** Reclassify the wallet against the current verified gateway revision. */
  synchronizeWallet: () => Promise<boolean>;
  /** Ask for rasters of inscriptions that have scrolled into view. */
  requestRasters: (inscriptionIds: readonly string[]) => void;
  /** Optimistic Hide/Unhide write-through so a tab switch keeps the new state. */
  applyItemState: (inscriptionId: string, state: 'visible' | 'hidden') => void;
}

export function useGalleryData(
  expectation: ActiveSessionExpectation,
  accountId: string,
  options: { continuous?: boolean } = {},
): GalleryData {
  const rpc = useRpc();
  const { expectedVaultId, expectedSessionId } = expectation;
  const key = `${expectedVaultId}:${expectedSessionId}:${accountId}`;
  const cached = store.get(key) ?? null;
  const [result, setResult] = useState<GalleryViewResult | null>(cached?.result ?? null);
  const [status, setStatus] = useState<GalleryStatus>(cached === null ? 'loading' : 'ready');
  const [refreshing, setRefreshing] = useState(false);
  const [authority, setAuthority] = useState<'cached' | 'fresh'>('fresh');
  // Mirrors `result` for the merge below. Invalidation deletes the store entry
  // before refetching, so the store cannot be the source of retained rasters.
  const resultRef = useRef<GalleryViewResult | null>(cached?.result ?? null);
  const generation = useRef(0);
  const refreshInFlight = useRef(false);
  // An invalidation that lands mid-batch must not be dropped; it is refetched
  // once the current batch settles.
  const invalidationQueued = useRef(false);
  const refreshRef = useRef<GalleryData['refresh']>(async () => undefined);
  // Inscriptions whose rasters this surface has asked for. Kept so a
  // revalidation re-requests exactly what is on screen instead of the whole
  // wallet, and so a scroll burst does not re-ask for what is already loading.
  const rasterWanted = useRef(new Set<string>());
  // Newly visible inscriptions awaiting a targeted request. This is separate
  // from rasterWanted so later scroll bursts do not resend every raster the
  // surface has ever requested.
  const rasterPendingIds = useRef(new Set<string>());
  const rasterPending = useRef<ReturnType<typeof setTimeout> | null>(null);
  // refresh() early-returns while a batch is in flight, and requestRasters
  // will not re-fire for an id already marked wanted — so without this a card
  // scrolled into view mid-batch would keep its placeholder forever.
  const rasterQueued = useRef(false);

  const synchronizeWalletForGeneration = useCallback(async (
    requestGeneration: number,
  ): Promise<boolean> => {
    const scanExpectation = { expectedVaultId, expectedSessionId };
    let scan = await rpc('scan.status', scanExpectation);
    if (!scan.ok || generation.current !== requestGeneration) return false;

    if (scan.result.kind === 'interrupted' || scan.result.kind === 'failed') {
      const resumed = await rpc('scan.start', { mode: 'resume', ...scanExpectation });
      if (!resumed.ok || generation.current !== requestGeneration) return false;
    } else if (
      scan.result.kind === 'idle' ||
      scan.result.kind === 'completed' ||
      scan.result.kind === 'cancelled'
    ) {
      const started = await rpc('scan.start', { mode: 'refresh', ...scanExpectation });
      if (!started.ok || generation.current !== requestGeneration) return false;
    } else if (scan.result.kind === 'awaiting_extend') {
      // A bounded scan has committed its authoritative results. Preserve its
      // explicit Extended-scan checkpoint instead of replacing it for gallery
      // presentation.
      return true;
    }

    const deadline = Date.now() + SCAN_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline && generation.current === requestGeneration) {
      scan = await rpc('scan.status', scanExpectation);
      if (!scan.ok) return false;
      if (scan.result.kind === 'completed' || scan.result.kind === 'awaiting_extend') return true;
      if (
        scan.result.kind === 'failed' ||
        scan.result.kind === 'cancelled' ||
        scan.result.kind === 'interrupted'
      ) return false;
      await pause(SCAN_POLL_INTERVAL_MS);
    }
    return false;
  }, [expectedSessionId, expectedVaultId, rpc]);

  const synchronizeWallet = useCallback((): Promise<boolean> =>
    synchronizeWalletForGeneration(generation.current), [synchronizeWalletForGeneration]);

  const refresh = useCallback(async (
    synchronize: boolean,
    recoverStale: boolean,
    rasterFor?: readonly string[],
  ) => {
    if (inFlight.has(key)) return;
    // An unfiltered or revalidation request already covers every wanted id.
    // Cancel a pending lazy burst so it cannot follow with duplicate work.
    if (rasterFor === undefined) {
      rasterPendingIds.current.clear();
      if (rasterPending.current !== null) clearTimeout(rasterPending.current);
      rasterPending.current = null;
    }
    // An explicit Refresh is the user asking again, so it always un-parks.
    if (synchronize) autoState.set(key, { parked: false });
    refreshInFlight.current = true;
    let settle!: () => void;
    inFlight.set(key, new Promise<void>((resolve) => { settle = resolve; }));
    setRefreshing(true);
    const requestGeneration = generation.current;
    const epoch = storeEpoch;
    /**
     * Fail closed. `action.status` gates Send/Rescue, so a grid we could not
     * revalidate must not stay tappable behind an error message, and automatic
     * retries must stop until the user asks again. Store and park are module
     * facts about the key and apply regardless of which surface asked; the
     * React updates belong to the surface that is still mounted.
     */
    const failClosed = (): void => {
      if (epoch === storeEpoch) {
        store.delete(key);
        autoState.set(key, { parked: true });
      }
      resultRef.current = null;
      if (generation.current !== requestGeneration) return;
      invalidationQueued.current = false;
      rasterQueued.current = false;
      setResult(null);
      setAuthority('fresh');
      setStatus('error');
    };
    // An explicit Refresh is the user asking to re-verify, so it omits the
    // filter and refetches every raster. Automatic loads pay only for what has
    // actually been on screen: the worker still fetches anything without
    // cached metadata, so a first load is unchanged, and off-screen rasters
    // survive through mergeRetainedPreviews rather than being refetched.
    const requested = rasterFor ?? (synchronize ? null : [...rasterWanted.current]);
    const list = () => rpc('gallery.list', {
      accountId,
      ...(requested === null ? {} : { rasterFor: [...requested] }),
      expectedVaultId,
      expectedSessionId,
    });
    try {
      // Keep a prior result on screen while revalidating; only a cold surface
      // shows the loading state.
      setStatus((current) =>
        synchronize ? 'syncing' : current === 'ready' ? 'ready' : 'loading');
      if (synchronize && !await synchronizeWalletForGeneration(requestGeneration)) {
        // A scan that was merely superseded by a newer surface is not a
        // failure; only park when this request is still the current one.
        if (generation.current === requestGeneration) failClosed();
        return;
      }
      let response = await list();
      if (
        !response.ok &&
        recoverStale &&
        response.code === 'ERR_DATA_STALE' &&
        generation.current === requestGeneration
      ) {
        setStatus('syncing');
        if (!await synchronizeWalletForGeneration(requestGeneration)) {
          if (generation.current === requestGeneration) failClosed();
          return;
        }
        response = await list();
      }
      if (!response.ok) {
        failClosed();
        return;
      }
      if (epoch !== storeEpoch) return;
      autoState.set(key, { parked: false });
      // Commit even if an invalidation landed mid-flight. The stale-recovery
      // path above *starts* the scan whose progress events invalidate us, so
      // discarding here livelocks: the result is thrown away, refetched, and
      // another scan begins. This response is freshly signed and verified, and
      // the queued refetch below still runs.
      //
      // Cache even when this component no longer wants the answer. Leaving the
      // Ordinals tab mid-batch is exactly when the store is most valuable: the
      // result is still correct for this key, and discarding it would make
      // every switch refetch forever.
      const merged = mergeRetainedPreviews(response.result, resultRef.current);
      store.set(key, { result: merged, fetchedAt: Date.now() });
      resultRef.current = merged;
      if (generation.current !== requestGeneration) return;
      setResult(merged);
      setAuthority('fresh');
      setStatus('ready');
    } finally {
      if (inFlight.get(key) !== undefined) inFlight.delete(key);
      settle();
      if (generation.current === requestGeneration) {
        refreshInFlight.current = false;
        if (invalidationQueued.current) {
          invalidationQueued.current = false;
          rasterQueued.current = false;
          void refreshRef.current(false, true);
        } else if (rasterQueued.current) {
          rasterQueued.current = false;
          const queued = [...rasterPendingIds.current];
          rasterPendingIds.current.clear();
          if (queued.length > 0) void refreshRef.current(false, false, queued);
          else setRefreshing(false);
        } else {
          setRefreshing(false);
        }
      }
    }
  }, [accountId, expectedSessionId, expectedVaultId, key, rpc, synchronizeWalletForGeneration]);
  refreshRef.current = refresh;

  const requestRasters = useCallback((inscriptionIds: readonly string[]): void => {
    let added = false;
    for (const id of inscriptionIds) {
      if (!rasterWanted.current.has(id)) {
        rasterWanted.current.add(id);
        rasterPendingIds.current.add(id);
        added = true;
      }
    }
    if (!added) return;
    if (rasterPending.current !== null) clearTimeout(rasterPending.current);
    rasterPending.current = setTimeout(() => {
      rasterPending.current = null;
      if (refreshInFlight.current) {
        rasterQueued.current = true;
        return;
      }
      const queued = [...rasterPendingIds.current];
      rasterPendingIds.current.clear();
      if (queued.length > 0) void refreshRef.current(false, false, queued);
    }, GALLERY_RASTER_REQUEST_DEBOUNCE_MS);
  }, []);

  const applyItemState = useCallback((
    inscriptionId: string,
    state: 'visible' | 'hidden',
  ): void => {
    setResult((current) => {
      if (current === null) return current;
      const next = {
        ...current,
        items: current.items.map((candidate) =>
          candidate.inscriptionId === inscriptionId ? { ...candidate, state } : candidate),
      };
      const entry = store.get(key);
      if (entry) store.set(key, { ...entry, result: next });
      resultRef.current = next;
      return next;
    });
  }, [key]);

  useEffect(() => {
    generation.current += 1;
    refreshInFlight.current = false;
    invalidationQueued.current = false;
    setRefreshing(false);
    // Deliberately empty: seeding from whatever happens to be cached would
    // re-request the entire wallet and make lazy loading a no-op.
    rasterWanted.current = new Set();
    rasterPendingIds.current = new Set();
    rasterQueued.current = false;
    const entry = store.get(key);
    resultRef.current = entry?.result ?? null;
    setResult(entry?.result ?? null);
    // The module store only ever holds freshly verified batches.
    setAuthority('fresh');
    // A request for this key may already be running from a previous mount.
    const joined = inFlight.get(key);
    const willFetch =
      joined === undefined &&
      (entry === undefined || Date.now() - entry.fetchedAt >= GALLERY_FRESH_MS) &&
      mountRefetchAllowed(key);
    // Parked with nothing cached must surface as an error, not a spinner:
    // 'loading' disables Refresh, which would strand the user with no request
    // in flight and no way to ask for one.
    setStatus(entry !== undefined
      ? 'ready'
      : (willFetch || joined !== undefined) ? 'loading' : 'error');
    // A live entry means a tab switch, not a cold open: render it and skip the
    // batch entirely. Events below drop the entry the moment anything changes.
    if (joined !== undefined) {
      const joinGeneration = generation.current;
      setRefreshing(true);
      // A joined request is this surface's in-flight work too. Without the ref,
      // a raster requested from a cached card would find refresh() early-return
      // on the inFlight guard, having already been marked wanted — so it would
      // never be re-asked and the card would stay a placeholder until Refresh.
      refreshInFlight.current = true;
      void joined.then(() => {
        if (generation.current !== joinGeneration) return;
        refreshInFlight.current = false;
        const settled = store.get(key);
        if (settled === undefined) {
          if (autoRefetchParked(key)) {
            setResult(null);
            setAuthority('fresh');
            setStatus('error');
            setRefreshing(false);
            return;
          }
          // Either the request we joined was abandoned by its own surface
          // without failing, or an invalidation dropped its entry. Both want
          // the same recovery, and it subsumes anything queued behind it.
          invalidationQueued.current = false;
          rasterQueued.current = false;
          void refresh(false, true);
          return;
        }
        resultRef.current = settled.result;
        setResult(settled.result);
        // The joined request is a verified batch, so this surface leaves the
        // paint-ahead window even though it never ran refresh() itself.
        setAuthority('fresh');
        setStatus('ready');
        if (invalidationQueued.current || rasterQueued.current) {
          const stale = invalidationQueued.current;
          invalidationQueued.current = false;
          rasterQueued.current = false;
          if (stale) {
            void refreshRef.current(false, true);
          } else {
            const queued = [...rasterPendingIds.current];
            rasterPendingIds.current.clear();
            if (queued.length > 0) void refreshRef.current(false, false, queued);
            else setRefreshing(false);
          }
          return;
        }
        setRefreshing(false);
      });
    } else if (willFetch) void refresh(false, true);

    /**
     * Paint-ahead. A cold surface — first popup open, or after an MV3 worker
     * restart — otherwise shows nothing at all while a multi-MiB signed batch
     * runs. Issued concurrently with that batch, never before it: this can only
     * ever lose the race, never delay it.
     *
     * The result deliberately does NOT enter the module store. That store holds
     * verified batches, and seeding it with a projection would let a later
     * remount serve pixels as though they were authority. `status` is left
     * alone for the same reason: the grid renders from `result` regardless, so
     * a cached paint under 'loading' shows the images with no empty-state and
     * no error, and Refresh correctly stays disabled while a batch really is
     * in flight.
     */
    if (entry === undefined) {
      const paintGeneration = generation.current;
      const paintEpoch = storeEpoch;
      void rpc('gallery.cached', { accountId, expectedVaultId, expectedSessionId })
        .then((response) => {
          if (!response.ok || !response.result.hit) return;
          if (generation.current !== paintGeneration || storeEpoch !== paintEpoch) return;
          // A verified batch already answered, or failed closed. Either way the
          // authoritative outcome wins; pixels never overwrite it.
          if (resultRef.current !== null || autoRefetchParked(key)) return;
          const painted = hydrateCachedGallery(accountId, response.result.items);
          resultRef.current = painted;
          setResult(painted);
          setAuthority('cached');
        });
    }

    // Marking stale is immediate so nothing can serve the old entry; only the
    // refetch is debounced.
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const invalidate = (): void => {
      store.delete(key);
      if (autoRefetchParked(key)) return;
      if (refreshInFlight.current) {
        invalidationQueued.current = true;
        return;
      }
      if (debounce !== null) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        void refresh(false, true);
      }, GALLERY_INVALIDATION_DEBOUNCE_MS);
    };
    const onMessage = (message: unknown): void => {
      if (isSessionStateChangedEvent(message)) {
        if (message.locked) clearGalleryDataStore();
        return;
      }
      if (isScanProgressEvent(message)) {
        invalidate();
        return;
      }
      if (!isWalletDataChangedEvent(message)) return;
      if (
        message.reason === 'transaction' ||
        message.reason === 'utxo' ||
        message.reason === 'account'
      ) invalidate();
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => {
      generation.current += 1;
      refreshInFlight.current = false;
      invalidationQueued.current = false;
      if (debounce !== null) clearTimeout(debounce);
      if (rasterPending.current !== null) clearTimeout(rasterPending.current);
      rasterPending.current = null;
      rasterPendingIds.current.clear();
      rasterQueued.current = false;
      chrome.runtime.onMessage.removeListener(onMessage);
    };
  }, [key, refresh]);

  const hasPendingItems =
    authority === 'fresh' &&
    result?.items.some((item) => item.confirmations === 0) === true;
  useEffect(() => {
    if (!hasPendingItems || options.continuous === false) return undefined;
    let active = true;
    let checkInFlight = false;
    let resumeScheduled = false;

    /**
     * Confirmation checks are scans, not gallery refreshes. Scan progress
     * already invalidates and revalidates the visible grid, so this can remain
     * quiet instead of replacing the card with the explicit Refresh spinner.
     */
    const checkConfirmation = (): void => {
      if (!active || checkInFlight || document.visibilityState === 'hidden') return;
      checkInFlight = true;
      void rpc('scan.status', { expectedVaultId, expectedSessionId })
        .then((response) => {
          if (!active || !response.ok) return undefined;
          if (
            response.result.kind === 'interrupted' ||
            response.result.kind === 'failed'
          ) {
            return rpc('scan.start', {
              mode: 'resume',
              expectedVaultId,
              expectedSessionId,
            });
          }
          // Respect a running scan, a user cancellation, and an explicit
          // extended-scan checkpoint. The next focus/timer tick can check
          // again; none of these states should be overwritten here.
          if (
            response.result.kind !== 'idle' &&
            response.result.kind !== 'completed'
          ) return undefined;
          return rpc('scan.start', {
            mode: 'refresh',
            expectedVaultId,
            expectedSessionId,
          });
        })
        .finally(() => {
          checkInFlight = false;
        });
    };
    const onResume = (): void => {
      if (!active || document.visibilityState === 'hidden' || resumeScheduled) return;
      // Chrome commonly emits visibilitychange and focus together.
      resumeScheduled = true;
      queueMicrotask(() => {
        resumeScheduled = false;
        checkConfirmation();
      });
    };
    const timer = window.setInterval(checkConfirmation, PENDING_GALLERY_SCAN_INTERVAL_MS);
    const onSessionMessage = (message: unknown): void => {
      if (isSessionStateChangedEvent(message) && message.locked) active = false;
    };
    window.addEventListener('focus', onResume);
    document.addEventListener('visibilitychange', onResume);
    chrome.runtime.onMessage.addListener(onSessionMessage);
    return () => {
      active = false;
      resumeScheduled = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', onResume);
      document.removeEventListener('visibilitychange', onResume);
      chrome.runtime.onMessage.removeListener(onSessionMessage);
    };
  }, [expectedSessionId, expectedVaultId, hasPendingItems, options.continuous, rpc]);

  return {
    result,
    status,
    authority,
    refreshing,
    refresh,
    synchronizeWallet,
    requestRasters,
    applyItemState,
  };
}
