import { describe, expect, it, vi } from 'vitest';
import {
  registerProviderDiscovery,
  DREY_PROVIDER_ICON,
  type ProviderDiscoveryWindow,
} from '../../src/provider/discovery';
import { createDreyProvider, type ProviderTransport } from '../../src/provider/facade';
import { PROVIDER_METHODS } from '@drey/core/provider/registry';

function provider() {
  const transport: ProviderTransport = {
    request: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    destroy: vi.fn(),
  };
  return createDreyProvider(transport);
}

describe('WBIP004 and de-facto provider discovery metadata', () => {
  it('registers exact static metadata in both registries without account data', () => {
    const target: ProviderDiscoveryWindow = {};
    const facade = provider();
    registerProviderDiscovery(target, facade);

    expect(target.btc_providers).toEqual([{
      id: 'drey',
      name: 'Drey',
      icon: DREY_PROVIDER_ICON,
      webUrl: 'https://squirrelsystems.net',
      chromeWebStoreUrl:
        'https://chromewebstore.google.com/detail/drey/kngidlmmbfmnoeimngkajdlbdenlhgof',
      methods: [...PROVIDER_METHODS],
    }]);
    expect(target.wbip_providers).toEqual([{
      id: 'drey',
      name: 'Drey',
      icon: DREY_PROVIDER_ICON,
      webUrl: 'https://squirrelsystems.net',
      chromeWebStoreUrl:
        'https://chromewebstore.google.com/detail/drey/kngidlmmbfmnoeimngkajdlbdenlhgof',
      methods: [...PROVIDER_METHODS],
    }]);
    expect(Object.keys((target.wbip_providers as Record<string, unknown>[])[0]!).sort())
      .toEqual(['chromeWebStoreUrl', 'icon', 'id', 'methods', 'name', 'webUrl']);
  });

  it('is idempotent and preserves other wallets', () => {
    const other = Object.freeze({ id: 'other', name: 'Other' });
    const target: ProviderDiscoveryWindow = {
      btc_providers: [other],
      wbip_providers: [other],
    };
    const facade = provider();
    registerProviderDiscovery(target, facade);
    registerProviderDiscovery(target, facade);

    expect(target.btc_providers).toHaveLength(2);
    expect(target.wbip_providers).toHaveLength(2);
    expect((target.btc_providers as unknown[])[0]).toBe(other);
    expect((target.wbip_providers as unknown[])[0]).toBe(other);
  });

  it('leaves cooperative registry properties writable for wallets that initialize later', () => {
    const target: ProviderDiscoveryWindow = {};
    registerProviderDiscovery(target, provider());
    const other = Object.freeze({ id: 'later-wallet', name: 'Later wallet' });
    const nextBtcRegistry = [...(target.btc_providers as unknown[]), other];
    const nextWbipRegistry = [...(target.wbip_providers as unknown[]), other];

    target.btc_providers = nextBtcRegistry;
    target.wbip_providers = nextWbipRegistry;

    expect(target.btc_providers).toBe(nextBtcRegistry);
    expect(target.wbip_providers).toBe(nextWbipRegistry);
    expect(Object.getOwnPropertyDescriptor(target, 'btc_providers')).toMatchObject({
      configurable: true,
      writable: true,
    });
  });

  it('does not throw or overwrite hostile page-owned registry values', () => {
    const frozen = Object.freeze([]) as readonly unknown[];
    const target: ProviderDiscoveryWindow = {
      btc_providers: 'page-owned',
      wbip_providers: frozen,
    };
    expect(() => registerProviderDiscovery(target, provider())).not.toThrow();
    expect(target.btc_providers).toBe('page-owned');
    expect(target.wbip_providers).toBe(frozen);
  });
});
