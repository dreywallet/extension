/**
 * Verified gateway-status cache in chrome.storage.session so the popup badge
 * survives MV3 worker restarts without refetching. Session storage only: the
 * cache is a read view, dropped with the browser session like the unlock
 * session itself. Contains no wallet data (§7.5-compatible).
 */
import { z } from 'zod';
import { getJson, setJson, type StorageArea } from '../storage/area';
import { statusCapabilitiesSchema, type GatewayProtocolVersion } from '@drey/core/domain/gateway/contract';
import type { CachedGatewayStatus } from '@drey/core/domain/gateway/status-view';

export const GATEWAY_STATUS_KEY = 'squirrel:gatewayStatus';

const cachedGatewayStatusSchema = z
  .object({
    status: statusCapabilitiesSchema,
    verifiedAtMs: z.number().int().nonnegative(),
    endpoint: z.string().min(1),
  })
  .strict();

export async function loadCachedStatus(
  session: StorageArea,
  expectedEndpoint: string,
  allowedProtocolVersions: readonly GatewayProtocolVersion[] = [1, 2],
): Promise<CachedGatewayStatus | null> {
  const raw = await getJson<unknown>(session, GATEWAY_STATUS_KEY);
  if (raw === undefined) return null;
  const parsed = cachedGatewayStatusSchema.safeParse(raw);
  // Malformed cache or a cache written for a different endpoint: self-repair
  // by dropping it rather than presenting cross-endpoint state.
  if (!parsed.success || parsed.data.endpoint !== expectedEndpoint || !allowedProtocolVersions.includes(parsed.data.status.protocolVersion)) {
    await session.remove(GATEWAY_STATUS_KEY);
    return null;
  }
  return parsed.data;
}

export async function saveCachedStatus(
  session: StorageArea,
  cached: CachedGatewayStatus,
): Promise<void> {
  await setJson(session, GATEWAY_STATUS_KEY, cached);
}
