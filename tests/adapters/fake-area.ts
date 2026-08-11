/**
 * In-memory fake of the chrome.storage StorageArea/SessionArea ports. This is
 * the "faked chrome.storage" the M3 tests run against — no extension loading.
 * Values are structured-cloned on write and read so tests catch accidental
 * reference sharing, mirroring the serialize-on-store behavior of chrome.storage.
 */
import type { SessionAccessLevel, SessionArea } from '../../src/adapters/session/session-store';

export interface FakeArea extends SessionArea {
  readonly store: Map<string, unknown>;
  accessLevel: SessionAccessLevel | null;
  accessLevelCalls: number;
  /** When set, area.set throws if the write touches this key (crash simulation). */
  failOnSetKey: string | null;
}

export function makeFakeArea(): FakeArea {
  const store = new Map<string, unknown>();
  const area: FakeArea = {
    store,
    accessLevel: null,
    accessLevelCalls: 0,
    failOnSetKey: null,

    async get(keys: string | string[]): Promise<Record<string, unknown>> {
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) {
        if (store.has(key)) out[key] = structuredClone(store.get(key));
      }
      return out;
    },

    async set(items: Record<string, unknown>): Promise<void> {
      if (area.failOnSetKey !== null && area.failOnSetKey in items) {
        throw new Error(`fake storage: simulated crash writing ${area.failOnSetKey}`);
      }
      for (const [key, value] of Object.entries(items)) {
        store.set(key, structuredClone(value));
      }
    },

    async remove(keys: string | string[]): Promise<void> {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) store.delete(key);
    },

    async setAccessLevel(options: { accessLevel: SessionAccessLevel }): Promise<void> {
      area.accessLevel = options.accessLevel;
      area.accessLevelCalls += 1;
    },
  };
  return area;
}
