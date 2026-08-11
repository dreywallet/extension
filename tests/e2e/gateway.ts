const BASE_URL = 'http://127.0.0.1:18080';
const CONTROL_HEADER = { 'x-drey-e2e-control': 'drey-public-e2e-control' } as const;

export type GatewayMode =
  | 'healthy'
  | 'full'
  | 'converging'
  | 'stale'
  | 'wrong-network'
  | 'invalid-signature'
  | 'unavailable';
export type SnapshotScenario =
  | 'clean'
  | 'inscribed'
  | 'rare_sat'
  | 'mixed'
  | 'wrong_lane_inscription_at_payment'
  | 'wrong_lane_btc_at_ordinals'
  | 'incoming_mempool'
  | 'incoming_ordinal_mempool'
  | 'incoming_ordinal_confirmed'
  | 'incoming_confirmed'
  | 'stale';
export type BroadcastMode = 'accepted' | 'conflicted' | 'rejected' | 'recoverable';
export type PreviewMode =
  | 'exact'
  | 'identity-mismatch'
  | 'provenance-mismatch'
  | 'stale-revision'
  | 'failed-placeholder'
  | 'renderer-failure'
  | 'cache-substitution'
  | 'missing-item'
  | 'extra-item';

async function control(pathname: string, body?: unknown): Promise<Response> {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method: 'POST',
    headers: { ...CONTROL_HEADER, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }).catch((cause: unknown) => {
    throw new Error('Dedicated loopback E2E gateway is not available on 127.0.0.1:18080', { cause });
  });
  if (!response.ok) throw new Error(`Gateway E2E control ${pathname} failed with HTTP ${response.status}`);
  return response;
}

export async function resetGateway(): Promise<void> {
  await control('/__e2e/reset');
}

export async function setGatewayScenario(options: {
  gatewayMode?: GatewayMode;
  snapshotScenario?: SnapshotScenario;
  broadcastMode?: BroadcastMode;
  previewMode?: PreviewMode;
  statusDelayMs?: number;
  snapshotDelayMs?: number;
  galleryBatchDelayMs?: number;
}): Promise<void> {
  await control('/__e2e/control', options);
}

/** Signed gallery batches served since the last reset. */
export async function galleryBatchAttempts(): Promise<number> {
  const state = await gatewayState() as { galleryBatchAttempts?: unknown };
  return typeof state.galleryBatchAttempts === 'number' ? state.galleryBatchAttempts : -1;
}

/** Public fixture inscription IDs requested by each accepted signed gallery batch. */
export async function galleryBatchRequests(): Promise<string[][]> {
  const state = await gatewayState() as { galleryBatchRequests?: unknown };
  if (!Array.isArray(state.galleryBatchRequests)) return [];
  return state.galleryBatchRequests.filter(
    (batch): batch is string[] => Array.isArray(batch) && batch.every((id) => typeof id === 'string'),
  );
}

/** Signed status requests served since the last reset. */
export async function statusAttempts(): Promise<number> {
  const state = await gatewayState() as { statusAttempts?: unknown };
  return typeof state.statusAttempts === 'number' ? state.statusAttempts : -1;
}

export async function gatewayState(): Promise<unknown> {
  const response = await fetch(`${BASE_URL}/__e2e/state`, { headers: CONTROL_HEADER });
  if (!response.ok) throw new Error(`Gateway E2E state failed with HTTP ${response.status}`);
  const parsed = await response.json() as { state: unknown };
  return parsed.state;
}
