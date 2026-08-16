import { useEffect, useState } from 'react';
import { INSCRIPTION_ACTIVITY_MAX_ITEMS } from '@drey/core/domain/gateway/contract';
import type { ActivityInscriptionPreviewResult } from '@drey/core/messaging/ops';
import type { ActiveSessionExpectation } from './use-session';
import { useRpc } from './use-rpc';

type ThumbnailRpc = ReturnType<typeof useRpc>;
export type InscriptionThumbnailPreview = ActivityInscriptionPreviewResult['preview'];
export type InscriptionThumbnailState = 'idle' | 'loading' | 'ready' | 'unavailable';

interface QueueEntry {
  key: string;
  scope: string;
  txid: string;
  inscriptionId: string;
  accountId: string;
  expectation: ActiveSessionExpectation;
  rpc: ThumbnailRpc;
}

export const INSCRIPTION_THUMBNAIL_CACHE_MAX = 64;
export const INSCRIPTION_THUMBNAIL_CACHE_BUDGET_BYTES = 16 * 1024 * 1024;
const RETRY_DELAYS_MS = [1_500, 3_000] as const;

const store = new Map<string, ActivityInscriptionPreviewResult>();
const queue = new Map<string, QueueEntry>();
const retries = new Map<string, number>();
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const unavailable = new Set<string>();
const mountedCounts = new Map<string, number>();
const inFlightKeys = new Set<string>();
const subscribers = new Set<() => void>();
let batchInFlight: Promise<void> | null = null;
let retainedBytes = 0;
let epoch = 0;
let activeScope = '';
let requestRevision = 0;

function keyOf(scope: string, txid: string, inscriptionId: string): string {
  return `${scope}:${txid}:${inscriptionId}`;
}

function previewBytes(preview: InscriptionThumbnailPreview): number {
  if (preview.kind === 'raster') return preview.rasterBase64.length * 2;
  if (preview.kind === 'text') return preview.excerpt.length * 2;
  return 64;
}

function notify(): void {
  for (const subscriber of subscribers) subscriber();
}

function cache(entry: QueueEntry, result: ActivityInscriptionPreviewResult): void {
  if (result.preview.kind === 'placeholder') return;
  const replaced = store.get(entry.key);
  if (replaced !== undefined) retainedBytes -= previewBytes(replaced.preview);
  store.delete(entry.key);
  store.set(entry.key, result);
  retainedBytes += previewBytes(result.preview);
  while (store.size > INSCRIPTION_THUMBNAIL_CACHE_MAX ||
      retainedBytes > INSCRIPTION_THUMBNAIL_CACHE_BUDGET_BYTES) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const evicted = store.get(oldest);
    if (evicted !== undefined) retainedBytes -= previewBytes(evicted.preview);
    store.delete(oldest);
  }
}

function scheduleRetry(entry: QueueEntry): void {
  if (store.has(entry.key) || retryTimers.has(entry.key) || unavailable.has(entry.key)) return;
  const attempt = retries.get(entry.key) ?? 0;
  const delay = RETRY_DELAYS_MS[attempt];
  if (delay === undefined) {
    unavailable.add(entry.key);
    return;
  }
  retries.set(entry.key, attempt + 1);
  retryTimers.set(entry.key, setTimeout(() => {
    retryTimers.delete(entry.key);
    if (!store.has(entry.key) && !inFlightKeys.has(entry.key) && !unavailable.has(entry.key)) {
      queue.set(entry.key, entry);
      drain();
    }
  }, delay));
}

function drain(): void {
  if (batchInFlight !== null || queue.size === 0) return;
  const first = queue.values().next().value as QueueEntry | undefined;
  if (first === undefined) return;
  const entries: QueueEntry[] = [];
  const ids = new Set<string>();
  for (const entry of queue.values()) {
    if (entry.scope !== first.scope || ids.has(entry.inscriptionId)) continue;
    entries.push(entry);
    ids.add(entry.inscriptionId);
    if (entries.length === INSCRIPTION_ACTIVITY_MAX_ITEMS) break;
  }
  for (const entry of entries) {
    queue.delete(entry.key);
    inFlightKeys.add(entry.key);
  }
  const requestEpoch = epoch;
  batchInFlight = first.rpc('activity.inscriptionPreviewBatch', {
    items: entries.map(({ txid, inscriptionId }) => ({ txid, inscriptionId })),
    accountId: first.accountId,
    ...first.expectation,
  }).then((response) => {
    if (requestEpoch !== epoch) return;
    if (!response.ok) {
      if (response.code === 'ERR_UNAUTHORIZED_CONTEXT') {
        for (const entry of entries) unavailable.add(entry.key);
      } else {
        for (const entry of entries) scheduleRetry(entry);
      }
      return;
    }
    const resolved = new Set<string>();
    for (const result of response.result.items) {
      const entry = entries.find((candidate) => candidate.inscriptionId === result.inscriptionId);
      if (entry === undefined) continue;
      resolved.add(entry.key);
      if (result.preview.kind === 'placeholder') {
        if (result.preview.reason === 'render_pending') scheduleRetry(entry);
        else unavailable.add(entry.key);
      } else {
        cache(entry, result);
        retries.delete(entry.key);
        unavailable.delete(entry.key);
      }
    }
    for (const entry of entries) {
      if (!resolved.has(entry.key)) scheduleRetry(entry);
    }
  }).catch(() => {
    if (requestEpoch !== epoch) return;
    for (const entry of entries) scheduleRetry(entry);
  }).finally(() => {
    for (const entry of entries) inFlightKeys.delete(entry.key);
    batchInFlight = null;
    notify();
    drain();
  });
}

function enqueue(entry: QueueEntry): void {
  if (store.has(entry.key) || queue.has(entry.key) || inFlightKeys.has(entry.key) ||
      unavailable.has(entry.key) || retryTimers.has(entry.key)) return;
  queue.set(entry.key, entry);
  queueMicrotask(drain);
}

export function clearInscriptionThumbnailStore(notifySubscribers = true): void {
  epoch += 1;
  requestRevision += 1;
  store.clear();
  queue.clear();
  inFlightKeys.clear();
  retries.clear();
  unavailable.clear();
  retainedBytes = 0;
  for (const timer of retryTimers.values()) clearTimeout(timer);
  retryTimers.clear();
  activeScope = '';
  if (notifySubscribers) notify();
}

export function alignInscriptionThumbnailScope(scope: string): void {
  if (scope === activeScope) return;
  clearInscriptionThumbnailStore(false);
  activeScope = scope;
}

export function retryFailedInscriptionThumbnails(scope: string): void {
  if (scope !== activeScope) return;
  retries.clear();
  unavailable.clear();
  requestRevision += 1;
  notify();
}

export function useInscriptionThumbnail(props: {
  scope: string;
  expectation: ActiveSessionExpectation;
  accountId: string;
  txid: string;
  inscriptionId: string;
  enabled?: boolean;
}): {
  preview: InscriptionThumbnailPreview | null;
  state: InscriptionThumbnailState;
  setNode: (node: Element | null) => void;
} {
  const rpc = useRpc();
  const [node, setNode] = useState<Element | null>(null);
  const [, setRevision] = useState(0);
  const key = keyOf(props.scope, props.txid, props.inscriptionId);
  const { expectedVaultId, expectedSessionId } = props.expectation;
  alignInscriptionThumbnailScope(props.scope);
  const requestGeneration = requestRevision;

  useEffect(() => {
    const subscriber = (): void => setRevision((current) => current + 1);
    subscribers.add(subscriber);
    return () => { subscribers.delete(subscriber); };
  }, []);

  useEffect(() => {
    mountedCounts.set(key, (mountedCounts.get(key) ?? 0) + 1);
    return () => {
      const remaining = (mountedCounts.get(key) ?? 1) - 1;
      if (remaining > 0) mountedCounts.set(key, remaining);
      else {
        mountedCounts.delete(key);
        // A terminal placeholder is not a cache entry. A later screen visit
        // may ask again after the renderer or gateway has recovered.
        unavailable.delete(key);
        retries.delete(key);
      }
    };
  }, [key]);

  useEffect(() => {
    if (props.enabled === false || node === null) return;
    const request = (): void => enqueue({
      key,
      scope: props.scope,
      txid: props.txid,
      inscriptionId: props.inscriptionId,
      accountId: props.accountId,
      expectation: { expectedVaultId, expectedSessionId },
      rpc,
    });
    if (typeof IntersectionObserver === 'undefined') {
      request();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) request();
    }, { rootMargin: '160px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [expectedSessionId, expectedVaultId, key, node, props.accountId, props.enabled,
    props.inscriptionId, props.scope, props.txid, requestGeneration, rpc]);

  const preview = store.get(key)?.preview ?? null;
  const state: InscriptionThumbnailState = preview !== null
    ? 'ready'
    : unavailable.has(key)
      ? 'unavailable'
      : props.enabled === false
        ? 'idle'
        : 'loading';
  return { preview, state, setNode };
}
