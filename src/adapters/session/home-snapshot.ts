/**
 * Last rendered Home projection for stale-while-revalidate popup hydration.
 *
 * The record lives only in chrome.storage.session, beside the unlock session,
 * and is bound to one exact vault/session/account tuple. It is display data,
 * never transaction authority: every popup mount still starts the ordinary
 * live wallet.home request, and signing paths derive their own current state.
 */
import { z } from 'zod';
import { OP_SCHEMAS, type WalletHomeResult } from '@drey/core/messaging/ops';
import { getJson, setJson, type StorageArea } from '../storage/area';

export const HOME_SNAPSHOT_KEY = 'drey:homeSnapshot';

export interface HomeSnapshotBinding {
  vaultId: string;
  sessionId: string;
  accountId: string;
}

const homeSnapshotSchema = z.object({
  vaultId: z.string().min(1),
  sessionId: z.string().uuid(),
  accountId: z.string().min(1),
  home: OP_SCHEMAS['wallet.home'].response,
}).strict();

function matchesBinding(
  record: z.infer<typeof homeSnapshotSchema>,
  binding: HomeSnapshotBinding,
): boolean {
  return record.vaultId === binding.vaultId &&
    record.sessionId === binding.sessionId &&
    record.accountId === binding.accountId &&
    record.home.accountId === binding.accountId;
}

export async function loadHomeSnapshot(
  session: StorageArea,
  binding: HomeSnapshotBinding,
): Promise<WalletHomeResult | null> {
  const raw = await getJson<unknown>(session, HOME_SNAPSHOT_KEY);
  if (raw === undefined) return null;
  const parsed = homeSnapshotSchema.safeParse(raw);
  if (!parsed.success || !matchesBinding(parsed.data, binding)) {
    await clearHomeSnapshot(session);
    return null;
  }
  return parsed.data.home;
}

export async function saveHomeSnapshot(
  session: StorageArea,
  binding: HomeSnapshotBinding,
  home: WalletHomeResult,
): Promise<void> {
  const record = homeSnapshotSchema.parse({ ...binding, home });
  if (!matchesBinding(record, binding)) throw new Error('Home snapshot account mismatch');
  await setJson(session, HOME_SNAPSHOT_KEY, record);
}

export async function clearHomeSnapshot(session: StorageArea): Promise<void> {
  await session.remove(HOME_SNAPSHOT_KEY);
}

/** Clear a failed live projection only if the retained record is the same identity. */
export async function clearBoundHomeSnapshot(
  session: StorageArea,
  binding: HomeSnapshotBinding,
): Promise<void> {
  const raw = await getJson<unknown>(session, HOME_SNAPSHOT_KEY);
  if (raw === undefined) return;
  const parsed = homeSnapshotSchema.safeParse(raw);
  if (!parsed.success || matchesBinding(parsed.data, binding)) {
    await clearHomeSnapshot(session);
  }
}
