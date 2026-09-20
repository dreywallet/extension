import { z } from 'zod';
import { runeListSchema, RUNE_SNAPSHOT_KEY, type RuneListResult } from '../../messaging/rune-ops';
import { getJson, setJson, type StorageArea } from '../storage/area';
import type { HomeSnapshotBinding } from './home-snapshot';

// Session-only display data. Transaction preparation always obtains fresh evidence.
const schema = z.object({ vaultId: z.string(), sessionId: z.string().uuid(), accountId: z.string(), data: runeListSchema }).strict();
export async function loadRuneSnapshot(area: StorageArea, binding: HomeSnapshotBinding): Promise<RuneListResult | null> {
  const parsed = schema.safeParse(await getJson<unknown>(area, RUNE_SNAPSHOT_KEY));
  if (!parsed.success) return null;
  const record = parsed.data;
  return record.vaultId === binding.vaultId && record.sessionId === binding.sessionId && record.accountId === binding.accountId && record.data.status === 'ready' ? record.data : null;
}
export async function saveRuneSnapshot(area: StorageArea, binding: HomeSnapshotBinding, data: RuneListResult): Promise<void> {
  await setJson(area, RUNE_SNAPSHOT_KEY, schema.parse({ ...binding, data }));
}
export async function clearRuneSnapshot(area: StorageArea): Promise<void> { await area.remove(RUNE_SNAPSHOT_KEY); }
