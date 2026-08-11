/**
 * Storage port (spec §4, §5.1). A minimal `{ get, set, remove }` shape that
 * chrome.storage.local / .session satisfy and an in-memory fake can implement.
 * Adapters and the state machine depend only on this port, never on chrome.*
 * directly, so every path is unit-testable with a faked store (task M3 req 6).
 */
export interface StorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export async function getJson<T>(area: StorageArea, key: string): Promise<T | undefined> {
  const out = await area.get(key);
  return out[key] as T | undefined;
}

export async function setJson(area: StorageArea, key: string, value: unknown): Promise<void> {
  await area.set({ [key]: value });
}
