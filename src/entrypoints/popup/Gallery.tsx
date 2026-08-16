import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from 'react';
import { useRpc } from '../../ui/hooks/use-rpc';
import { useI18n } from '../../ui/i18n';
import {
  NOT_REQUESTED,
  useGalleryData,
  type GalleryViewResult,
} from '../../ui/hooks/use-gallery-data';
import type { ActiveSessionExpectation } from '../../ui/hooks/use-session';
import { Button } from '../../ui/components/Button';
import {
  dismissRecoveredAddressNotice,
  recoveredAddressNoticeDismissed,
} from '../../ui/recovered-address-notice';
import { PopupIcon } from './PopupIcon';
import type { OrdinalActionDraft } from '../../ui/ordinal-action';
import { MediaBadgeTile, TextExcerptTile } from '../../ui/components/PreviewTile';
import {
  groupGalleryItems,
  type GalleryCollectionGroup,
} from '../../ui/gallery-collections';
import styles from './Gallery.module.css';

type GalleryItem = GalleryViewResult['items'][number];
type Filter = 'visible' | 'hidden';

function batchSelectable(item: GalleryItem): boolean {
  return item.action.kind === 'send' && (
    item.action.status === 'available' ||
    (item.action.status === 'blocked' && item.action.reason === 'co_located')
  );
}

function sandboxUrl(page: 'inscription-preview.html' | 'inscription-media.html'): string {
  return chrome.runtime.getURL(page);
}

function Raster(props: Extract<GalleryItem['preview'], { kind: 'raster' }> & {
  inscriptionId: string;
  onOpen?: (() => void) | undefined;
}): ReactNode {
  const { t } = useI18n();
  const message = useMemo(() => ({
    type: 'drey:inert-inscription-preview',
    protocolVersion: 1,
    inscriptionId: props.inscriptionId,
    rasterBase64: props.rasterBase64,
    pngSha256: props.pngSha256,
    pngWidth: props.pngWidth,
    pngHeight: props.pngHeight,
    // Browse grid: fill the square tile rather than float in empty space. The
    // sandbox falls back to letterboxing when the crop would be severe, and the
    // media viewer always shows the whole image.
    fit: 'cover',
  }), [
    props.inscriptionId,
    props.pngHeight,
    props.pngSha256,
    props.pngWidth,
    props.rasterBase64,
  ]);
  return (
    <div className={styles['previewShell']}>
      <iframe
        aria-hidden={props.onOpen === undefined ? undefined : true}
        className={styles['preview']}
        onLoad={(event: SyntheticEvent<HTMLIFrameElement>) =>
          event.currentTarget.contentWindow?.postMessage(message, '*')}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts"
        src={sandboxUrl('inscription-preview.html')}
        tabIndex={-1}
        title={t('inscription.preview.iframe', { inscriptionId: props.inscriptionId })}
      />
      {props.onOpen === undefined ? null : (
        <button
          aria-label={t('gallery.openMedia')}
          className={styles['previewTrigger']}
          onClick={props.onOpen}
          title={t('gallery.openMedia')}
          type="button"
        />
      )}
    </div>
  );
}

/**
 * Requests an inscription's raster once its card approaches the viewport, so a
 * large wallet does not pay for every image on open. Fails open: without an
 * IntersectionObserver the raster is requested immediately, which is the
 * pre-lazy behaviour rather than a permanently blank card.
 */
function LazyCard(props: {
  inscriptionId: string;
  needsRaster: boolean;
  onNeedRaster: (inscriptionId: string) => void;
  selected?: boolean | undefined;
  children: ReactNode;
}): ReactNode {
  const ref = useRef<HTMLElement | null>(null);
  const { inscriptionId, needsRaster, onNeedRaster } = props;
  useEffect(() => {
    if (!needsRaster) return;
    const node = ref.current;
    if (node === null || typeof IntersectionObserver === 'undefined') {
      onNeedRaster(inscriptionId);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      onNeedRaster(inscriptionId);
    }, { rootMargin: '200px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [inscriptionId, needsRaster, onNeedRaster]);
  return <article
    className={styles['card']}
    data-gallery-inscription={props.inscriptionId}
    data-selected={props.selected === true ? 'true' : undefined}
    ref={ref}
  >{props.children}</article>;
}

function CollectionShelf(props: {
  group: GalleryCollectionGroup;
  title: string;
  onOpen: () => void;
  onNeedRasters: (inscriptionIds: readonly string[]) => void;
}): ReactNode {
  const { t } = useI18n();
  const ref = useRef<HTMLButtonElement | null>(null);
  const previewItems = useMemo(() => props.group.items.slice(0, 3), [props.group.items]);
  const missingRasters = useMemo(() => previewItems
    .filter((item) => item.preview.kind === 'placeholder' && item.preview.reason === NOT_REQUESTED)
    .map((item) => item.inscriptionId), [previewItems]);
  const { onNeedRasters } = props;
  useEffect(() => {
    if (missingRasters.length === 0) return;
    const node = ref.current;
    const request = () => onNeedRasters(missingRasters);
    if (node === null || typeof IntersectionObserver === 'undefined') {
      request();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      request();
    }, { rootMargin: '200px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [missingRasters, onNeedRasters]);

  return (
    <div className={styles['collectionShelf']}>
      <span className={styles['shelfHeading']}>
        <span>
          <strong>{props.title}</strong>
          <small>{props.group.items.length}</small>
        </span>
        <span aria-hidden="true" className={styles['shelfChevron']}>›</span>
      </span>
      <span aria-hidden="true" className={styles['shelfPreviews']}>
        {previewItems.map((item) => {
          const pending =
            item.confirmations === 0 &&
            item.action.status === 'blocked' &&
            item.action.reason === 'unconfirmed';
          const loading =
            item.preview.kind === 'placeholder' &&
            (item.preview.reason === NOT_REQUESTED || item.preview.reason === 'render_pending');
          return <span className={styles['shelfPreview']} key={item.inscriptionId}>
            {item.preview.kind === 'raster'
              ? <Raster inscriptionId={item.inscriptionId} {...item.preview} />
              : item.preview.kind === 'text'
                ? <TextExcerptTile excerpt={item.preview.excerpt} truncated={item.preview.truncated} />
                : item.preview.kind === 'mediaBadge'
                  ? <MediaBadgeTile
                      mediaKind={item.preview.mediaKind}
                      contentLength={item.preview.contentLength}
                    />
                  : <span className={styles['placeholder']}>
                      {t(pending
                        ? 'gallery.previewPending'
                        : loading
                          ? 'gallery.previewRendering'
                          : 'gallery.previewUnavailable')}
                    </span>}
          </span>;
        })}
      </span>
      <button
        aria-label={`${props.title} (${props.group.items.length})`}
        className={styles['shelfButton']}
        data-gallery-collection={props.group.key}
        onClick={props.onOpen}
        ref={ref}
        type="button"
      />
    </div>
  );
}

/**
 * Everything verified about an inscription, including the id the card face no
 * longer shows. Rendered inside the card's disclosure, and again in the media
 * viewer where there is room to show it open rather than behind a toggle.
 */
function DetailList(props: { item: GalleryItem; catalogRevision?: string | undefined }): ReactNode {
  const { t } = useI18n();
  const { item } = props;
  const addressType = item.ownership === null
    ? null
    : t(
        item.ownership.lane === 'payment'
          ? item.ownership.role === 'primary'
            ? 'gallery.addressType.payment.primary'
            : item.ownership.role === 'recovered'
              ? 'gallery.addressType.payment.recovered'
              : 'gallery.addressType.payment.change'
          : item.ownership.role === 'primary'
            ? 'gallery.addressType.ordinals.primary'
            : item.ownership.role === 'recovered'
              ? 'gallery.addressType.ordinals.recovered'
              : 'gallery.addressType.ordinals.change',
      );
  return (
    <dl className={styles['detailList']}>
      {item.ownership === null ? null : (
        <>
          <dt>{t('gallery.heldAt')}</dt><dd>{item.ownership.address}</dd>
          <dt>{t('gallery.addressType')}</dt><dd>{addressType}</dd>
        </>
      )}
      <dt>{t('gallery.inscriptionId')}</dt><dd>{item.inscriptionId}</dd>
      {item.display.title === null ? null : (
        <>
          <dt>{t('gallery.onChainTitle')}</dt><dd>{item.display.title.text}</dd>
        </>
      )}
      {item.display.collections.map((collection) => (
        <div className={styles['collectionDetail']} key={`${collection.kind}:${collection.slug}`}>
          <dt>{t(collection.kind === 'parent'
            ? 'gallery.collection.parent'
            : 'gallery.collection.gallery')}</dt>
          <dd>
            <strong>{collection.name}</strong>
            <span>{collection.rootInscriptionIds.join(', ')}</span>
          </dd>
        </div>
      ))}
      {item.display.collections.length === 0 || props.catalogRevision === undefined ? null : (
        <>
          <dt>{t('gallery.collection.registry')}</dt><dd>{props.catalogRevision}</dd>
        </>
      )}
      <dt>{t('gallery.contentType')}</dt><dd>{item.contentType ?? '—'}</dd>
      <dt>{t('gallery.size')}</dt><dd>{item.contentLength ?? '—'}</dd>
      <dt>{t('gallery.satpoint')}</dt><dd>{item.satpoint}</dd>
      <dt>{t('gallery.confirmations')}</dt><dd>{item.confirmations}</dd>
      <dt>{t('gallery.outpoint')}</dt><dd>{item.outpoint.txid}:{item.outpoint.vout}</dd>
      <dt>{t('gallery.parent')}</dt><dd>{item.parent ?? '—'}</dd>
      <dt>{t('gallery.delegate')}</dt><dd>{item.delegate ?? '—'}</dd>
      <dt>{t('gallery.flags')}</dt>
      <dd>{[item.reinscription ? 'reinscription' : null, item.cursed ? 'cursed' : null,
        ...item.rareSats].filter(Boolean).join(', ') || '—'}</dd>
    </dl>
  );
}

export function Gallery(props: {
  expectation: ActiveSessionExpectation;
  account: number;
  accountId: string;
  onReceive: () => void;
  onOrdinalAction?: ((draft: OrdinalActionDraft) => void) | undefined;
  continuous?: boolean;
  initialInscriptionId?: string | null | undefined;
  onInitialInscriptionHandled?: (() => void) | undefined;
}): ReactNode {
  const rpc = useRpc();
  const { t, lang } = useI18n();
  const recoveredNoticeTitleId = useId();
  const sameSatDialogTitleId = useId();
  const firstGalleryTabRef = useRef<HTMLButtonElement>(null);
  const sameSatDialogRef = useRef<HTMLDialogElement>(null);
  const sameSatCancelRef = useRef<HTMLButtonElement>(null);
  const sameSatOpenerRef = useRef<HTMLElement | null>(null);
  const sameSatWasOpenRef = useRef(false);
  const viewerDialogRef = useRef<HTMLDialogElement>(null);
  const viewerCloseRef = useRef<HTMLButtonElement>(null);
  const viewerOpenerRef = useRef<HTMLElement | null>(null);
  const viewerWasOpenRef = useRef(false);
  const viewerSessionRef = useRef<ActiveSessionExpectation | null>(null);
  const mediaRequestGenerationRef = useRef(0);
  const { expectedVaultId, expectedSessionId } = props.expectation;
  const {
    result,
    status,
    authority,
    refreshing,
    refresh,
    synchronizeWallet,
    requestRasters,
    applyItemState,
  } =
    useGalleryData(props.expectation, props.accountId, { continuous: props.continuous ?? true });
  /**
   * The paint-ahead window: pixels from the previous session are on screen but
   * no verified batch has landed yet. Nothing here may be acted on — not Send,
   * not Rescue, not the viewer, and not Hide/Unhide, whose optimistic write the
   * arriving batch would silently discard. Routine verification stays silent,
   * and the per-card blocked reasons stay hidden, because they would otherwise
   * report "Asset verification is out of date" on every card of a perfectly
   * healthy wallet.
   */
  const unverified = authority === 'cached';
  const countsKnown = result !== null;
  const [filter, setFilter] = useState<Filter>('visible');
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedInscriptionIds, setSelectedInscriptionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [selectedBindings, setSelectedBindings] = useState<Map<string, {
    outpoint: { txid: string; vout: number };
    satpoint: string;
    classificationRevision: string;
  }>>(() => new Map());
  const [pendingSameSat, setPendingSameSat] = useState<GalleryItem[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recoveredNotice, setRecoveredNotice] = useState<{
    vaultId: string;
    status: 'loading' | 'visible' | 'dismissed';
  } | null>(null);
  const [media, setMedia] = useState<{
    leaseId: string;
    expiresAt: number;
    inscriptionId: string;
    contentType: string;
    contentSha256: string;
    contentByteLength: number;
    bytesBase64: string;
  } | null>(null);

  const closeViewer = useCallback((nextNotice: string | null = null): void => {
    mediaRequestGenerationRef.current += 1;
    setMedia(null);
    setNotice(nextNotice);
  }, []);

  useEffect(() => {
    if (media !== null) {
      viewerWasOpenRef.current = true;
      const dialog = viewerDialogRef.current;
      if (dialog && !dialog.open) {
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
      }
      viewerCloseRef.current?.focus();
      return;
    }
    if (!viewerWasOpenRef.current) return;
    viewerWasOpenRef.current = false;
    viewerSessionRef.current = null;
    const opener = viewerOpenerRef.current;
    viewerOpenerRef.current = null;
    queueMicrotask(() => {
      if (opener?.isConnected) opener.focus();
      else firstGalleryTabRef.current?.focus();
    });
  }, [media]);

  useEffect(() => {
    mediaRequestGenerationRef.current += 1;
  }, [expectedSessionId, expectedVaultId]);

  useEffect(() => {
    const openedUnder = viewerSessionRef.current;
    if (
      media !== null && openedUnder !== null &&
      (openedUnder.expectedVaultId !== expectedVaultId ||
        openedUnder.expectedSessionId !== expectedSessionId)
    ) {
      closeViewer(t('gallery.viewerEnded'));
    }
  }, [closeViewer, expectedSessionId, expectedVaultId, media, t]);

  useEffect(() => {
    if (media === null) return;
    const timer = window.setInterval(() => {
      void rpc('gallery.media.lease', {
        leaseId: media.leaseId,
        expectedVaultId,
        expectedSessionId,
      }).then((response) => {
        if (!response.ok || !response.result.valid) {
          closeViewer(t('gallery.viewerEnded'));
        }
      });
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [closeViewer, expectedSessionId, expectedVaultId, media, rpc, t]);

  const hasVerifiedRecoveredAddresses =
    authority === 'fresh' && (result?.recoveredAddressCount ?? 0) > 0;
  useEffect(() => {
    if (!hasVerifiedRecoveredAddresses) return undefined;
    let active = true;
    setRecoveredNotice({ vaultId: expectedVaultId, status: 'loading' });
    void recoveredAddressNoticeDismissed(expectedVaultId).then((dismissed) => {
      if (!active) return;
      setRecoveredNotice({
        vaultId: expectedVaultId,
        status: dismissed ? 'dismissed' : 'visible',
      });
    });
    return () => {
      active = false;
    };
  }, [expectedVaultId, hasVerifiedRecoveredAddresses]);

  const view = useMemo(() => {
    const counts = { visible: 0, hidden: 0 };
    const items: GalleryItem[] = [];
    for (const item of result?.items ?? []) {
      counts[item.state] += 1;
      if (item.state === filter) items.push(item);
    }
    const groups = groupGalleryItems(items);
    return {
      counts,
      items,
      groups,
    };
  }, [filter, result]);

  const selectedGroup = selectedGroupKey === null
    ? null
    : view.groups.find((group) => group.key === selectedGroupKey) ?? null;
  const groupTitle = useCallback((group: GalleryCollectionGroup): string =>
    group.collection?.name ?? t(group.kind === 'multiple'
      ? 'gallery.collection.multiple'
      : 'gallery.collection.other'), [t]);

  useEffect(() => {
    setSelectedGroupKey(null);
    setSelectionMode(false);
    setSelectedInscriptionIds(new Set());
    setSelectedBindings(new Map());
    setPendingSameSat(null);
  }, [expectedSessionId, expectedVaultId, props.accountId]);

  useEffect(() => {
    if (pendingSameSat !== null) {
      sameSatWasOpenRef.current = true;
      const dialog = sameSatDialogRef.current;
      if (dialog && !dialog.open) {
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
      }
      sameSatCancelRef.current?.focus();
      return;
    }
    if (!sameSatWasOpenRef.current) return;
    sameSatWasOpenRef.current = false;
    const opener = sameSatOpenerRef.current;
    sameSatOpenerRef.current = null;
    queueMicrotask(() => {
      if (opener?.isConnected) opener.focus();
      else firstGalleryTabRef.current?.focus();
    });
  }, [pendingSameSat]);

  useEffect(() => {
    if (selectedGroupKey !== null && selectedGroup === null) setSelectedGroupKey(null);
  }, [selectedGroup, selectedGroupKey]);

  useEffect(() => {
    const target = props.initialInscriptionId;
    if (target == null || authority !== 'fresh' || result === null) return;
    const item = result.items.find((candidate) =>
      candidate.inscriptionId === target && candidate.state === 'visible');
    if (item !== undefined) {
      setFilter('visible');
      const targetGroup = groupGalleryItems([item])[0];
      setSelectedGroupKey(targetGroup?.key ?? null);
      requestAnimationFrame(() => {
        const card = document.querySelector<HTMLElement>(`[data-gallery-inscription="${target}"]`);
        card?.scrollIntoView?.({ block: 'nearest' });
        const details = card?.querySelector('details');
        if (details) details.open = true;
        card?.querySelector<HTMLElement>('summary')?.focus();
      });
    }
    props.onInitialInscriptionHandled?.();
  }, [authority, props.initialInscriptionId, props.onInitialInscriptionHandled, result]);

  const update = async (item: GalleryItem, state: 'visible' | 'hidden') => {
    const response = await rpc('gallery.update', {
      inscriptionId: item.inscriptionId,
      accountId: props.accountId,
      state,
      expectedVaultId,
      expectedSessionId,
    });
    if (!response.ok) {
      setNotice(t('gallery.updateFailed'));
      return;
    }
    setNotice(null);
    applyItemState(item.inscriptionId, state);
  };

  const openMedia = async (item: GalleryItem) => {
    const requestGeneration = ++mediaRequestGenerationRef.current;
    setNotice(null);
    const opener = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const request = () => rpc('gallery.media.open', {
      inscriptionId: item.inscriptionId,
      accountId: props.accountId,
      expectedVaultId,
      expectedSessionId,
    });
    let response = await request();
    if (requestGeneration !== mediaRequestGenerationRef.current) return;
    if (!response.ok && response.code === 'ERR_DATA_STALE') {
      setNotice(t('gallery.mediaRefreshing'));
      const synchronized = await synchronizeWallet();
      if (requestGeneration !== mediaRequestGenerationRef.current) return;
      if (!synchronized) {
        setNotice(t('gallery.mediaServiceUnavailable'));
        return;
      }
      // The refreshed scan replaced the wallet authority. Re-run the complete
      // worker open path exactly once so identity, location, bytes, MIME,
      // digest, policy revision, and gateway signature are all reverified.
      response = await request();
      if (requestGeneration !== mediaRequestGenerationRef.current) return;
    }
    if (!response.ok) {
      setNotice(t('gallery.mediaServiceUnavailable'));
      return;
    }
    if (response.result.disposition !== 'media') {
      setNotice(t(response.result.reason === 'service_unavailable'
        ? 'gallery.mediaServiceUnavailable'
        : 'gallery.mediaUnsafe'));
      return;
    }
    viewerOpenerRef.current = opener;
    viewerSessionRef.current = { expectedVaultId, expectedSessionId };
    setMedia(response.result);
  };

  const mediaMessage = media === null ? null : {
    type: 'drey:verified-inscription-media',
    protocolVersion: 1,
    inscriptionId: media.inscriptionId,
    contentType: media.contentType,
    contentSha256: media.contentSha256,
    contentByteLength: media.contentByteLength,
    bytesBase64: media.bytesBase64,
  };
  const actionReason = (reason: Extract<GalleryItem['action'], { status: 'blocked' }>['reason']) => {
    if (reason === 'stale_classification') return t('gallery.action.reason.stale');
    if (reason === 'unconfirmed') return t('gallery.action.reason.unconfirmed');
    if (reason === 'frozen') return t('gallery.action.reason.frozen');
    if (reason === 'unsupported_assets') return t('gallery.action.reason.unsupported');
    if (reason === 'rare_sats') return t('gallery.action.reason.rare');
    if (reason === 'locked_by_plan') return t('gallery.action.reason.locked');
    if (reason === 'co_located') return t('gallery.action.reason.coLocated');
    if (reason === 'unverifiable_location') return t('gallery.action.reason.unverifiableLocation');
    return t('gallery.action.reason.lane');
  };
  const itemsById = useMemo(
    () => new Map((result?.items ?? []).map((item) => [item.inscriptionId, item])),
    [result],
  );
  const itemsBySatpoint = useMemo(() => {
    const grouped = new Map<string, GalleryItem[]>();
    for (const item of result?.items ?? []) {
      const existing = grouped.get(item.satpoint);
      if (existing) existing.push(item);
      else grouped.set(item.satpoint, [item]);
    }
    return grouped;
  }, [result]);
  const itemsByOutpoint = useMemo(() => {
    const grouped = new Map<string, GalleryItem[]>();
    for (const item of result?.items ?? []) {
      const key = `${item.outpoint.txid}:${item.outpoint.vout}`;
      const existing = grouped.get(key);
      if (existing) existing.push(item);
      else grouped.set(key, [item]);
    }
    return grouped;
  }, [result]);
  const selectedItems = useMemo(() => [...selectedInscriptionIds]
    .map((inscriptionId) => itemsById.get(inscriptionId))
    .filter((item): item is GalleryItem => item !== undefined),
  [itemsById, selectedInscriptionIds]);
  const selectionBindingChanged = useMemo(() =>
    selectedInscriptionIds.size !== selectedItems.length || selectedItems.some((item) => {
      const bound = selectedBindings.get(item.inscriptionId);
      return bound === undefined || bound.satpoint !== item.satpoint ||
        bound.outpoint.txid !== item.outpoint.txid || bound.outpoint.vout !== item.outpoint.vout ||
        bound.classificationRevision !== item.classificationRevision;
    }), [selectedBindings, selectedInscriptionIds, selectedItems]);
  const missingSourceCompanions = useMemo(() => {
    const missing = new Map<string, GalleryItem>();
    for (const selectedItem of selectedItems) {
      const key = `${selectedItem.outpoint.txid}:${selectedItem.outpoint.vout}`;
      for (const companion of itemsByOutpoint.get(key) ?? []) {
        if (!selectedInscriptionIds.has(companion.inscriptionId)) {
          missing.set(companion.inscriptionId, companion);
        }
      }
    }
    return [...missing.values()];
  }, [itemsByOutpoint, selectedInscriptionIds, selectedItems]);
  const cancelSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedInscriptionIds(new Set());
    setSelectedBindings(new Map());
    setPendingSameSat(null);
    setNotice(null);
  }, []);
  const addToSelection = useCallback((items: readonly GalleryItem[]): void => {
    const additions = items.filter((item) =>
      !selectedInscriptionIds.has(item.inscriptionId));
    if (selectedInscriptionIds.size + additions.length > 16) {
      setPendingSameSat(null);
      setNotice(t('gallery.selection.limit'));
      return;
    }
    setSelectedInscriptionIds((current) => {
      const next = new Set(current);
      for (const entry of items) next.add(entry.inscriptionId);
      return next;
    });
    setSelectedBindings((current) => {
      const next = new Map(current);
      for (const item of items) next.set(item.inscriptionId, {
        outpoint: { ...item.outpoint },
        satpoint: item.satpoint,
        classificationRevision: item.classificationRevision,
      });
      return next;
    });
    setPendingSameSat(null);
    setNotice(null);
  }, [selectedInscriptionIds, t]);
  const toggleSelection = useCallback((item: GalleryItem, opener: HTMLElement): void => {
    if (unverified || !batchSelectable(item)) return;
    if (selectedInscriptionIds.has(item.inscriptionId)) {
      const sameSatIds = new Set(
        (itemsBySatpoint.get(item.satpoint) ?? [item]).map((entry) => entry.inscriptionId),
      );
      setSelectedInscriptionIds((current) => {
        const next = new Set(current);
        for (const inscriptionId of sameSatIds) next.delete(inscriptionId);
        return next;
      });
      setSelectedBindings((current) => {
        const next = new Map(current);
        for (const inscriptionId of sameSatIds) next.delete(inscriptionId);
        return next;
      });
      setNotice(null);
      return;
    }
    const sameSat = itemsBySatpoint.get(item.satpoint) ?? [item];
    if (sameSat.some((entry) => !batchSelectable(entry))) {
      setNotice(t('gallery.selection.coLocatedBlocked'));
      return;
    }
    const additions = sameSat.filter((entry) => !selectedInscriptionIds.has(entry.inscriptionId));
    if (selectedInscriptionIds.size + additions.length > 16) {
      setNotice(t('gallery.selection.limit'));
      return;
    }
    if (sameSat.length > 1) {
      sameSatOpenerRef.current = opener;
      setPendingSameSat(sameSat);
      return;
    }
    addToSelection(sameSat);
  }, [addToSelection, itemsBySatpoint, selectedInscriptionIds, t, unverified]);
  const selectMissingSourceCompanions = useCallback((): void => {
    if (selectedInscriptionIds.size + missingSourceCompanions.length > 16) {
      setNotice(t('gallery.selection.limit'));
      return;
    }
    if (missingSourceCompanions.some((item) => !batchSelectable(item))) {
      setNotice(t('gallery.selection.sourceBlocked'));
      return;
    }
    setSelectedInscriptionIds((current) => {
      const next = new Set(current);
      for (const item of missingSourceCompanions) next.add(item.inscriptionId);
      return next;
    });
    setSelectedBindings((current) => {
      const next = new Map(current);
      for (const item of missingSourceCompanions) next.set(item.inscriptionId, {
        outpoint: { ...item.outpoint },
        satpoint: item.satpoint,
        classificationRevision: item.classificationRevision,
      });
      return next;
    });
    setNotice(null);
  }, [missingSourceCompanions, selectedInscriptionIds.size, t]);
  const continueBatch = useCallback((): void => {
    if (selectedItems.length === 0 || selectedItems.length > 16 ||
        selectedInscriptionIds.size > 16 || missingSourceCompanions.length > 0 ||
        selectionBindingChanged) return;
    props.onOrdinalAction?.({
      kind: 'ordinal_batch_transfer',
      account: props.account,
      selections: selectedItems.map((item) => ({
        inscriptionId: item.inscriptionId,
        ...selectedBindings.get(item.inscriptionId)!,
        presentation: {
          number: item.number,
          preview: item.preview.kind === 'placeholder'
            ? { kind: 'placeholder' as const }
            : { ...item.preview },
        },
      })),
    });
  }, [missingSourceCompanions.length, props.account, props.onOrdinalAction, selectedBindings,
    selectedInscriptionIds.size, selectedItems, selectionBindingChanged]);
  const startItemAction = (item: GalleryItem): void => {
    if (item.action.status !== 'available') return;
    const presentation = {
      number: item.number,
      preview: item.preview.kind === 'placeholder'
        ? { kind: 'placeholder' as const }
        : { ...item.preview },
    };
    props.onOrdinalAction?.(item.action.kind === 'send'
      ? {
          kind: 'ordinal_transfer',
          account: props.account,
          inscriptionId: item.inscriptionId,
          outpoint: { ...item.outpoint },
          presentation,
        }
      : { kind: 'rescue', outpoint: { ...item.outpoint }, presentation });
  };
  const manageItemPostage = (item: GalleryItem): void => {
    if (item.action.status !== 'available' || item.action.kind !== 'send') return;
    props.onOrdinalAction?.({
      kind: 'ordinal_postage_manage',
      account: props.account,
      selection: {
        inscriptionId: item.inscriptionId,
        outpoint: { ...item.outpoint },
        satpoint: item.satpoint,
        classificationRevision: item.classificationRevision,
        presentation: {
          number: item.number,
          preview: item.preview.kind === 'placeholder'
            ? { kind: 'placeholder' as const }
            : { ...item.preview },
        },
      },
    });
  };
  const needRaster = useMemo(
    () => (inscriptionId: string) => requestRasters([inscriptionId]),
    [requestRasters],
  );
  const needRasters = useCallback(
    (inscriptionIds: readonly string[]) => requestRasters(inscriptionIds),
    [requestRasters],
  );
  const attentionItems = result?.attentionItems ?? [];
  const sweepCandidates = result?.sweepCandidates ?? [];
  /**
   * `no_economic_excess` is permanent for a given output: a UTXO's value never
   * changes and the worker already tests it at the floor fee rate. Listing it
   * under "Needs attention" behind a permanently disabled button is a nag that
   * can never clear, so it becomes a calm note instead. Every other blocked
   * reason is transient or user-reversible, and stays actionable.
   */
  const restingPostage = sweepCandidates.filter(
    (candidate) => candidate.reason === 'no_economic_excess');
  const liveSweeps = sweepCandidates.filter(
    (candidate) => candidate.reason !== 'no_economic_excess');
  const restingPostageSats = restingPostage.reduce(
    (sum, candidate) => sum + BigInt(candidate.valueSats), 0n);
  const mediaItem = media === null
    ? null
    : result?.items.find((entry) => entry.inscriptionId === media.inscriptionId) ?? null;

  return <>
    <div className={styles['heading']}>
      <h1>{t('gallery.title')}</h1>
      {selectionMode ? <button type="button" onClick={cancelSelection}>
        {t('common.cancel')}
      </button> : <div className={styles['headingActions']}>
        <button
          className={styles['selectionModeButton']}
          disabled={unverified || (result?.items.length ?? 0) === 0}
          type="button"
          onClick={() => {
            setSelectionMode(true);
            setNotice(null);
          }}
        >{t('gallery.selection.select')}</button>
        <button
          aria-label={t('gallery.refresh')}
          disabled={refreshing || status === 'loading' || status === 'syncing'}
          type="button"
          onClick={() => void refresh(true, false)}
        >{t(status === 'syncing' ? 'gateway.state.checking' : 'gallery.refresh')}</button>
      </div>}
    </div>
    {selectedGroup === null ? <div className={styles['filters']} role="tablist" aria-label={t('gallery.title')}>
      {(['visible', 'hidden'] as const).map((entry) => (
        <button
          aria-selected={filter === entry}
          key={entry}
          onClick={() => {
            setFilter(entry);
            setSelectedGroupKey(null);
          }}
          ref={entry === 'visible' ? firstGalleryTabRef : undefined}
          role="tab"
          type="button"
        >{t(`gallery.filter.${entry}`)} ({countsKnown ? view.counts[entry] : '—'})</button>
      ))}
    </div> : null}
    {hasVerifiedRecoveredAddresses &&
    recoveredNotice?.vaultId === expectedVaultId &&
    recoveredNotice.status === 'visible' ? (
      <section
        aria-labelledby={recoveredNoticeTitleId}
        className={styles['recoveredNotice']}
      >
        <strong id={recoveredNoticeTitleId}>{t('gallery.recoveredNotice.title')}</strong>
        <p>{t('gallery.recoveredNotice.body')}</p>
        <Button
          variant="secondary"
          onClick={() => {
            setRecoveredNotice({ vaultId: expectedVaultId, status: 'dismissed' });
            void dismissRecoveredAddressNotice(expectedVaultId).catch(() => undefined);
            requestAnimationFrame(() => firstGalleryTabRef.current?.focus());
          }}
        >
          {t('gallery.recoveredNotice.dismiss')}
        </Button>
      </section>
    ) : null}
    {notice !== null ? <p className={styles['notice']} role="status">{notice}</p> : null}
    {status === 'loading' && !unverified ? <p role="status">{t('common.loading')}</p> : null}
    {status === 'syncing' && view.items.length === 0
      ? <p role="status">{t('gallery.syncing')}</p>
      : null}
    {status === 'error' ? <p role="alert">{t('gallery.error')}</p> : null}
    {/* Images only. Ownership, confirmations, and Send/Rescue eligibility are
        derived locally, so the grid below is fully usable without them. */}
    {status !== 'error' && result?.previewsUnavailable === true
      ? <p className={styles['notice']} role="status">{t('gallery.previewsUnavailable')}</p>
      : null}
    {status === 'ready' && view.items.length === 0
      ? <p className={styles['empty']}>{t(`gallery.empty.${filter}`)}</p>
      : null}
    {(status === 'error' || (status === 'ready' && view.items.length === 0 && filter === 'visible'))
      ? <p className={styles['notice']}>{t('gallery.missingSafety')}</p>
      : null}
    <div className={styles['sections']}>
      {selectedGroup === null ? view.groups.map((group) => <CollectionShelf
        group={group}
        key={group.key}
        onNeedRasters={needRasters}
        onOpen={() => setSelectedGroupKey(group.key)}
        title={groupTitle(group)}
      />) : <section className={styles['collectionSection']}>
        <header className={styles['collectionDetailHeader']}>
          <button
            onClick={() => {
              const returningKey = selectedGroup.key;
              setSelectedGroupKey(null);
              requestAnimationFrame(() => {
                const shelf = [...document.querySelectorAll<HTMLElement>(
                  '[data-gallery-collection]',
                )].find((candidate) => candidate.dataset['galleryCollection'] === returningKey);
                shelf?.focus();
              });
            }}
            type="button"
          >
            <span aria-hidden="true">‹</span>
            {t('common.back')}
          </button>
          <div>
            <h2>{groupTitle(selectedGroup)}</h2>
            <span>{selectedGroup.items.length}</span>
          </div>
        </header>
        <div className={styles['grid']}>
      {selectedGroup.items.map((item) => {
        const hidden = item.state === 'hidden';
        const hideLabel = hidden ? 'gallery.unhide' as const : 'gallery.hide' as const;
        const pending =
          item.confirmations === 0 &&
          item.action.status === 'blocked' &&
          item.action.reason === 'unconfirmed';
        const previewLoading =
          item.preview.kind === 'placeholder' &&
          (item.preview.reason === NOT_REQUESTED || item.preview.reason === 'render_pending');
        const selectedForBatch = selectedInscriptionIds.has(item.inscriptionId);
        return <LazyCard
        key={item.inscriptionId}
        inscriptionId={item.inscriptionId}
        needsRaster={item.preview.kind === 'placeholder' && item.preview.reason === NOT_REQUESTED}
        onNeedRaster={needRaster}
        selected={selectedForBatch}
      >
        {selectionMode ? (
          <button
            aria-pressed={selectedForBatch}
            aria-label={t(selectedForBatch
              ? 'gallery.selection.remove'
              : 'gallery.selection.add', {
              ordinal: item.number === null ? item.inscriptionId : `#${item.number}`,
            })}
            className={styles['selectionToggle']}
            disabled={unverified || !batchSelectable(item)}
            onClick={(event) => toggleSelection(item, event.currentTarget)}
            type="button"
          >
            <span aria-hidden="true">{selectedForBatch ? '✓' : ''}</span>
          </button>
        ) : null}
        {item.preview.kind === 'raster'
          ? <Raster
              inscriptionId={item.inscriptionId}
              {...item.preview}
              {...(item.mediaAvailable && !unverified
                ? { onOpen: () => void openMedia(item) }
                : {})}
            />
          : item.preview.kind === 'text'
            ? <TextExcerptTile
                excerpt={item.preview.excerpt}
                truncated={item.preview.truncated}
                onOpen={item.mediaAvailable && !unverified
                  ? () => void openMedia(item)
                  : undefined}
              />
            : item.preview.kind === 'mediaBadge'
              ? <MediaBadgeTile
                  mediaKind={item.preview.mediaKind}
                  contentLength={item.preview.contentLength}
                  onOpen={item.mediaAvailable && !unverified
                    ? () => void openMedia(item)
                    : undefined}
                />
              : <div className={styles['placeholder']}>
                  {t(pending
                    ? 'gallery.previewPending'
                    : previewLoading
                      ? 'gallery.previewRendering'
                      : 'gallery.previewUnavailable')}
                </div>}
        <strong className={styles['itemTitle']}>
          {item.display.title?.text ??
            (item.number === null
              ? t(pending ? 'gallery.pendingInscription' : 'gallery.unnumbered')
              : `#${item.number}`)}
        </strong>
        {item.display.title === null ? null : (
          <small className={styles['itemNumber']}>
            {item.number === null
              ? t(pending ? 'gallery.pendingInscription' : 'gallery.unnumbered')
              : `#${item.number}`}
          </small>
        )}
        {pending ? (
          <small className={styles['pendingStatus']}>{t('gallery.pendingConfirmation')}</small>
        ) : null}
        {/*
          * The viewer cannot be the only route to a satpoint or outpoint. It
          * needs a media lease, and a card only offers one when its preview is
          * a raster and its content type is openable: active content, recursive
          * and unsupported types, and stale classifications all fail those
         * gates, and those are exactly the items whose identifiers are most
         * worth reading. Cached items are the one exception — a paint-ahead
         * grid is unverified, and this disclosure says "verified". The stable
         * wrapper reserves the closed disclosure's height while it is absent,
         * so fresh verification does not shift the card actions downward.
          */}
        <div className={styles['detailsSlot']} data-details-slot="">
          {unverified ? null : <details>
            <summary>{t(item.action.status === 'blocked'
              ? 'gallery.action.unavailableDetails'
              : 'gallery.details')}</summary>
            {item.action.status === 'blocked'
              ? <p className={styles['notice']}>
                  {pending
                    ? t('gallery.pendingExplanation')
                    : actionReason(item.action.reason)}
                </p>
              : null}
            <DetailList
              catalogRevision={result?.collectionCatalog?.revision}
              item={item}
            />
            {item.action.status === 'available' && item.action.kind === 'send' ? (
              <Button
                aria-label={t('gallery.action.managePostage')}
                title={t('gallery.action.managePostage')}
                variant="secondary"
                onClick={() => manageItemPostage(item)}
              >
                {t('gallery.action.managePostageCompact')}
              </Button>
            ) : null}
          </details>}
        </div>
        {selectionMode && item.action.status === 'blocked' &&
        item.action.reason !== 'co_located' ? (
          <small className={styles['selectionBlocked']}>{actionReason(item.action.reason)}</small>
        ) : null}
        {!selectionMode ? <div className={styles['actions']}>
          <Button
            disabled={unverified || item.action.status !== 'available'}
            onClick={() => startItemAction(item)}
          >
            {item.action.kind === 'send'
              ? t('gallery.action.send')
              : t('gallery.action.rescue')}
          </Button>
          {/*
            * Icon-only so the row stays one line in a half-width card. Hiding is
            * a shelving preference, not something to weigh against Send, and a
            * full-width button gave it equal billing. The accessible name is
            * still the same word, and matches the balance privacy toggle: the
            * icon shows the action, not the current state.
            */}
          <Button
            aria-label={t(hideLabel)}
            aria-pressed={hidden}
            className={styles['hideToggle']}
            disabled={unverified}
            onClick={() => void update(item, hidden ? 'visible' : 'hidden')}
            title={t(hideLabel)}
            variant="secondary"
          >
            <PopupIcon name={hidden ? 'eye' : 'eyeOff'} />
          </Button>
        </div> : null}
      </LazyCard>;
      })}
        </div>
      </section>}
    </div>
    {selectionMode ? (
      <section
        aria-label={t('gallery.selection.summary')}
        className={styles['selectionFooter']}
        data-gallery-selection-footer
      >
        {selectionBindingChanged ? <p role="alert">{t('gallery.selection.changed')}</p> : null}
        {missingSourceCompanions.length > 0 ? (
          <>
            <p role="alert">{t('gallery.selection.missingSource', {
              count: missingSourceCompanions.length,
            })}</p>
            <Button
              variant="secondary"
              onClick={selectMissingSourceCompanions}
            >{t('gallery.selection.selectSource')}</Button>
          </>
        ) : null}
        <Button
          disabled={selectedItems.length === 0 || missingSourceCompanions.length > 0 ||
            selectedItems.length > 16 || selectedInscriptionIds.size > 16 ||
            selectionBindingChanged}
          onClick={continueBatch}
        >{t('gallery.selection.continue', { count: selectedItems.length })}</Button>
      </section>
    ) : null}
    {pendingSameSat !== null ? (
      <dialog
        aria-labelledby={sameSatDialogTitleId}
        className={styles['selectionDialog']}
        onCancel={(event) => {
          event.preventDefault();
          setPendingSameSat(null);
        }}
        onClose={() => setPendingSameSat(null)}
        ref={sameSatDialogRef}
      >
        <strong id={sameSatDialogTitleId}>{t('gallery.selection.coLocatedTitle')}</strong>
        <p>{t('gallery.selection.coLocatedPrompt', { count: pendingSameSat.length })}</p>
        <div className={styles['actions']}>
          <Button
            ref={sameSatCancelRef}
            variant="secondary"
            onClick={() => setPendingSameSat(null)}
          >
            {t('common.cancel')}
          </Button>
          <Button onClick={() => addToSelection(pendingSameSat)}>
            {t('gallery.selection.includeTogether', { count: pendingSameSat.length })}
          </Button>
        </div>
      </dialog>
    ) : null}
    {!selectionMode && (attentionItems.length > 0 || liveSweeps.length > 0) ? (
      <section>
        <h2>{t('gallery.attention.title')}</h2>
        <p>{t('gallery.attention.body')}</p>
        {attentionItems.map((item) => (
          <div className={styles['actions']} key={`rescue:${item.inscriptionId}`}>
            <code>{item.inscriptionId}</code>
            <Button
              disabled={item.action.status !== 'available'}
              onClick={() => {
                if (item.action.status !== 'available') return;
                props.onOrdinalAction?.({
                  kind: 'rescue',
                  outpoint: { ...item.outpoint },
                });
              }}
            >{t('gallery.action.rescue')}</Button>
            {item.action.status === 'blocked'
              ? <small>{actionReason(item.action.reason)}</small>
              : null}
          </div>
        ))}
        {liveSweeps.map((candidate) => (
          <div className={styles['actions']} key={`sweep:${candidate.outpoint.txid}:${candidate.outpoint.vout}`}>
            <span>{t('gallery.sweep.value', {
              sats: BigInt(candidate.valueSats).toLocaleString(lang),
            })}</span>
            <Button
              disabled={candidate.status !== 'available'}
              onClick={() => props.onOrdinalAction?.({
                kind: 'ordinal_sweep',
                outpoint: { ...candidate.outpoint },
              })}
            >{t('gallery.action.sweep')}</Button>
            {candidate.reason === 'stale_classification'
              ? <small>{t('gallery.action.reason.stale')}</small>
              : candidate.reason === 'unconfirmed'
                ? <small>{t('gallery.action.reason.unconfirmed')}</small>
                : candidate.reason === 'frozen'
                  ? <small>{t('gallery.action.reason.frozen')}</small>
                  : candidate.reason === 'locked_by_plan'
                    ? <small>{t('gallery.action.reason.locked')}</small>
                    : null}
          </div>
        ))}
      </section>
    ) : null}
    {/* Outside the attention section on purpose: this is the resting state of
        plain bitcoin in the Ordinals lane, not a task. Aggregated because a
        wallet can accumulate several such outputs and one line per output
        would read like a list of problems. */}
    {!selectionMode && restingPostage.length > 0 ? (
      <p className={styles['notice']}>
        {t('gallery.postage.resting', {
          sats: restingPostageSats.toLocaleString(lang),
        })}
      </p>
    ) : null}
    {!selectionMode ? <button type="button" className={styles['receive']} onClick={props.onReceive}>
      {t('home.receive')}
    </button> : null}
    {media !== null && mediaMessage !== null ? <dialog
      aria-label={t('gallery.viewerTitle')}
      className={styles['viewer']}
      onCancel={(event) => {
        event.preventDefault();
        closeViewer();
      }}
      onClose={() => closeViewer()}
      ref={viewerDialogRef}
    >
      <div className={styles['viewerHeader']}>
        <strong>{t('gallery.viewerTitle')}</strong>
        <button ref={viewerCloseRef} type="button" onClick={() => closeViewer()}>
          {t('common.close')}
        </button>
      </div>
      <iframe
        key={media.leaseId}
        onLoad={(event) => event.currentTarget.contentWindow?.postMessage(mediaMessage, '*')}
        referrerPolicy="no-referrer"
        sandbox="allow-scripts"
        src={sandboxUrl('inscription-media.html')}
        title={t('gallery.viewerTitle')}
      />
      {/*
        * Below the image, and outside the sandbox. The frame above has no
        * extension APIs, storage, or network by design, and wallet identifiers
        * have no business being posted into it — this is ordinary popup markup
        * wrapping it, which is why the viewer can show them at all.
        */}
      {mediaItem !== null ? (
        <div className={styles['viewerDetails']}>
          {mediaItem.action.status === 'available' && mediaItem.action.kind === 'send' ? (
            <Button
              className={styles['viewerPostageAction']}
              variant="secondary"
              onClick={() => {
                closeViewer();
                manageItemPostage(mediaItem);
              }}
            >
              {t('gallery.action.managePostage')}
            </Button>
          ) : null}
          <DetailList
            catalogRevision={result?.collectionCatalog?.revision}
            item={mediaItem}
          />
        </div>
      ) : null}
    </dialog> : null}
  </>;
}
