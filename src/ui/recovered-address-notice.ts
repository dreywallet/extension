/**
 * Non-secret, presentation-only dismissal state for the recovered-address
 * explanation. It is deliberately separate from wallet config and UI prefs:
 * a failed write may repeat an informational notice, but must never affect
 * wallet state or unrelated preference-save errors.
 */
import { z } from 'zod';
import { RECOVERED_ADDRESS_NOTICE_KEY } from '../adapters/storage/keys';

const MAX_DISMISSED_VAULTS = 100;

const recoveredAddressNoticesSchema = z.object({
  version: z.literal(1),
  dismissedVaultIds: z.array(z.string().min(1).max(512)).max(MAX_DISMISSED_VAULTS),
}).strict();

type RecoveredAddressNotices = z.infer<typeof recoveredAddressNoticesSchema>;

async function loadRecord(): Promise<RecoveredAddressNotices> {
  const raw = (await chrome.storage.local.get(
    RECOVERED_ADDRESS_NOTICE_KEY,
  ))[RECOVERED_ADDRESS_NOTICE_KEY];
  const parsed = recoveredAddressNoticesSchema.safeParse(raw);
  return parsed.success ? parsed.data : { version: 1, dismissedVaultIds: [] };
}

export async function recoveredAddressNoticeDismissed(vaultId: string): Promise<boolean> {
  try {
    return (await loadRecord()).dismissedVaultIds.includes(vaultId);
  } catch {
    // Cosmetic storage is never allowed to disturb the wallet surface. Treat a
    // failed read as dismissed for this popup; a later popup may retry.
    return true;
  }
}

export async function dismissRecoveredAddressNotice(vaultId: string): Promise<void> {
  const record = await loadRecord();
  const dismissedVaultIds = [
    ...record.dismissedVaultIds.filter((candidate) => candidate !== vaultId),
    vaultId,
  ].slice(-MAX_DISMISSED_VAULTS);
  await chrome.storage.local.set({
    [RECOVERED_ADDRESS_NOTICE_KEY]: { version: 1, dismissedVaultIds },
  });
}
