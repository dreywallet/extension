import type { DreyProvider } from './facade';

export const DREY_PROVIDER_ICON =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22128%22 height=%22128%22 viewBox=%220 0 128 128%22%3E%3Crect width=%22128%22 height=%22128%22 rx=%2228%22 fill=%22%23050505%22/%3E%3Ccircle cx=%2264%22 cy=%2264%22 r=%2245%22 fill=%22none%22 stroke=%22%23fff%22 stroke-width=%228%22/%3E%3Cpath d=%22M18 55c4-19 20-33 39-35 22-2 42 12 49 32 5 15 2 32-7 44V62c0-7-6-13-13-13H57c-9 0-16 7-16 16v19c-7-8-9-20-5-30 3-7 9-12 4-15-5-4-14 0-22 16Z%22 fill=%22%23fff%22/%3E%3Crect x=%2254%22 y=%2260%22 width=%2218%22 height=%2218%22 rx=%224%22 fill=%22%23fff%22/%3E%3Crect x=%2277%22 y=%2260%22 width=%2218%22 height=%2218%22 rx=%224%22 fill=%22%23fff%22/%3E%3Crect x=%2254%22 y=%2283%22 width=%2218%22 height=%2218%22 rx=%224%22 fill=%22%23fff%22/%3E%3Crect x=%2277%22 y=%2283%22 width=%2218%22 height=%2218%22 rx=%224%22 fill=%22%23fff%22/%3E%3C/svg%3E';

interface ProviderMetadata {
  id: 'drey';
  name: 'Drey';
  icon: typeof DREY_PROVIDER_ICON;
  webUrl: 'https://squirrelsystems.net';
  chromeWebStoreUrl: 'https://chromewebstore.google.com/detail/drey/kngidlmmbfmnoeimngkajdlbdenlhgof';
  methods: readonly string[];
}

export type ProviderDiscoveryWindow = {
  btc_providers?: unknown;
  wbip_providers?: unknown;
};

function appendOnce<T extends { id: string }>(target: unknown, entry: T): void {
  if (!Array.isArray(target) || !Object.isExtensible(target)) return;
  if (target.some((candidate) =>
    candidate !== null && typeof candidate === 'object' &&
    'id' in candidate && candidate.id === entry.id)) return;
  try {
    target.push(Object.freeze(entry));
  } catch {
    // Discovery is optional metadata. A page-controlled proxy/frozen array must
    // never prevent the provider itself from initializing.
  }
}

function registry(
  target: ProviderDiscoveryWindow,
  key: 'btc_providers' | 'wbip_providers',
): unknown {
  try {
    if (target[key] === undefined) {
      // Discovery state is cooperative page-world state, not a security
      // boundary. Keep the ordinary writable property shape expected by other
      // wallets and provider libraries that may initialize after Drey.
      target[key] = [];
    }
    return target[key];
  } catch {
    return null;
  }
}

export function registerProviderDiscovery(
  target: ProviderDiscoveryWindow,
  provider: DreyProvider,
): void {
  const metadata: ProviderMetadata = {
    id: 'drey',
    name: 'Drey',
    icon: DREY_PROVIDER_ICON,
    webUrl: 'https://squirrelsystems.net',
    chromeWebStoreUrl:
      'https://chromewebstore.google.com/detail/drey/kngidlmmbfmnoeimngkajdlbdenlhgof',
    methods: Object.freeze([...provider.methods]),
  };

  appendOnce(registry(target, 'btc_providers'), metadata);

  // WBIP004 is still a draft and deployed wallets also use btc_providers.
  // Register both shapes without overwriting page or competing-wallet state.
  appendOnce(registry(target, 'wbip_providers'), metadata);
}
