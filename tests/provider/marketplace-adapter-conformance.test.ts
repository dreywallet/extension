import {
  AddressPurpose,
  request as satsConnectRequest,
} from '@sats-connect/core';
import { afterEach, describe, expect, it } from 'vitest';
import { registerProviderDiscovery, type ProviderDiscoveryWindow } from '../../src/provider/discovery';
import { createDreyProvider, type ProviderTransport } from '../../src/provider/facade';
import { providerError, DreyProviderError } from '@drey/core/provider/errors';
import {
  PROVIDER_OPERATIONS,
  isProviderMethod,
  providerNetworkResult,
} from '@drey/core/provider/registry';

// Replays the exact call sequences the ord.net and Satflow production wallet
// adapters emit through @sats-connect/core, and — unlike the mocked-transport
// conformance test — parses every emitted params payload with the real strict
// registry schemas, so a marketplace-shaped request that Drey would reject at
// the worker fails here first.

const NETWORK = providerNetworkResult('Mainnet');

const PAYMENT_ADDRESS = 'bc1qmarketplacepayment0000000000000000000';
const ORDINALS_ADDRESS = 'bc1pmarketplaceordinals0000000000000000000000000000000000000000';

const ADDRESSES = [
  {
    address: PAYMENT_ADDRESS,
    publicKey: `02${'11'.repeat(32)}`,
    purpose: 'payment',
    addressType: 'p2wpkh',
    walletType: 'software',
  },
  {
    address: ORDINALS_ADDRESS,
    // x-only key, as the controller returns for taproot.
    publicKey: '22'.repeat(32),
    purpose: 'ordinals',
    addressType: 'p2tr',
    walletType: 'software',
  },
] as const;

const RESULTS: Record<string, unknown> = {
  getInfo: {
    version: '0.10.3',
    platform: 'web',
    methods: Object.keys(PROVIDER_OPERATIONS),
    supports: ['WBIP001', 'WBIP004'],
  },
  wallet_connect: {
    id: 'drey-account-0',
    addresses: ADDRESSES,
    walletType: 'software',
    network: NETWORK,
  },
  getAddresses: { addresses: ADDRESSES, network: NETWORK },
  signMessage: {
    signature: 'AkcwRAIgMarketplaceChallengeSignature=',
    messageHash: '33'.repeat(32),
    address: ORDINALS_ADDRESS,
    protocol: 'BIP322',
  },
  signPsbt: { psbt: 'cHNidP8=' },
};

function createRegistryValidatingTransport(): ProviderTransport & {
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  let requestIndex = 0;
  return {
    calls,
    async request(method, params) {
      calls.push({ method, params });
      requestIndex += 1;
      if (!isProviderMethod(method)) {
        throw new DreyProviderError(providerError('ERR_UNSUPPORTED_METHOD'));
      }
      const spec = PROVIDER_OPERATIONS[method];
      const parsedParams = spec.request.safeParse(params);
      if (!parsedParams.success) {
        throw new Error(
          `params emitted by the adapter sequence do not satisfy the strict ${method} schema: ` +
            parsedParams.error.message,
        );
      }
      const result = RESULTS[method];
      if (result === undefined) {
        throw new Error(`no canned result for ${method}`);
      }
      const parsedResult = spec.response.safeParse(result);
      if (!parsedResult.success) {
        throw new Error(`canned ${method} result violates the response schema: ${parsedResult.error.message}`);
      }
      return { id: `request-${requestIndex}`, result: parsedResult.data };
    },
    addListener: () => undefined,
    removeListener: () => undefined,
    destroy: () => undefined,
  };
}

function installProvider(transport: ProviderTransport): void {
  const drey = createDreyProvider(transport);
  const page = { drey } as ProviderDiscoveryWindow & { drey: typeof drey };
  registerProviderDiscovery(page, drey);
  Object.defineProperty(globalThis, 'window', {
    value: page,
    configurable: true,
    writable: true,
  });
}

const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    value: originalWindow,
    configurable: true,
    writable: true,
  });
});

describe('marketplace wallet-adapter replay conformance', () => {
  it('satisfies the ord.net connect gate: getInfo handshake then a dual-purpose wallet_connect', async () => {
    const transport = createRegistryValidatingTransport();
    installProvider(transport);

    const info = await satsConnectRequest('getInfo', undefined, 'drey');
    expect(info.status).toBe('success');
    if (info.status !== 'success') throw new Error('unreachable');
    // sats-connect-core sanitizes params for providers reporting web
    // versions <= 1.4; the reported version must parse as semver and the
    // modern shape must reach the transport unchanged below.
    expect((info.result as { version: string }).version).toMatch(/^\d+\.\d+\.\d+$/u);
    expect((info.result as { platform: string }).platform).toBe('web');

    const connect = await satsConnectRequest('wallet_connect', {
      addresses: [AddressPurpose.Ordinals, AddressPurpose.Payment],
      message: 'Connect to ord.net',
    }, 'drey');
    expect(connect.status).toBe('success');
    if (connect.status !== 'success') throw new Error('unreachable');
    const returned = (connect.result as { addresses: Array<{ purpose: string; addressType: string; publicKey: string }> }).addresses;
    // ord.net's adapter throws unless both purposes are present.
    const ordinals = returned.find((entry) => entry.purpose === 'ordinals');
    const payment = returned.find((entry) => entry.purpose === 'payment');
    expect(ordinals).toMatchObject({ addressType: 'p2tr' });
    expect(ordinals?.publicKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(payment).toMatchObject({ addressType: 'p2wpkh' });
    expect(payment?.publicKey).toMatch(/^[0-9a-f]{66}$/u);
    expect(transport.calls.map((call) => call.method)).toEqual(['getInfo', 'wallet_connect']);
  });

  it('satisfies the Satflow sequence: dual-purpose addresses, BIP322 challenge, unfinalized signPsbt', async () => {
    const transport = createRegistryValidatingTransport();
    installProvider(transport);

    const addresses = await satsConnectRequest('getAddresses', {
      purposes: [AddressPurpose.Ordinals, AddressPurpose.Payment],
      message: 'Connect to Satflow',
    }, 'drey');
    expect(addresses.status).toBe('success');

    const challenge = await satsConnectRequest('signMessage', {
      address: ORDINALS_ADDRESS,
      message: 'Satflow challenge: 7f3a1c',
      protocol: 'BIP322' as never,
    }, 'drey');
    expect(challenge.status).toBe('success');
    if (challenge.status !== 'success') throw new Error('unreachable');
    expect((challenge.result as { protocol: string }).protocol).toBe('BIP322');

    // Buyer purchase signing: address-keyed input selection, returned
    // unfinalized for server-side merge — no broadcast, no txid.
    const signed = await satsConnectRequest('signPsbt', {
      psbt: 'cHNidP8=',
      signInputs: { [PAYMENT_ADDRESS]: [1, 2] },
      broadcast: false,
    }, 'drey');
    expect(signed).toEqual({
      status: 'success',
      result: { psbt: 'cHNidP8=' },
    });
  });

  it('fails runes and other unimplemented marketplace methods with a clean JSON-RPC -32601', async () => {
    const transport = createRegistryValidatingTransport();
    installProvider(transport);

    // ord.net's embedded sats-connect-core defines runes methods; a stray
    // call must surface a parseable method-not-supported error envelope.
    await expect(satsConnectRequest('runes_getBalance', undefined, 'drey')).resolves.toEqual({
      status: 'error',
      error: {
        code: -32601,
        message: 'Method is not supported',
        data: { dreyCode: 'ERR_UNSUPPORTED_METHOD' },
      },
    });
  });

  it('rejects ECDSA message signing at the schema, keeping Drey BIP322-only', () => {
    const rejected = PROVIDER_OPERATIONS.signMessage.request.safeParse({
      address: PAYMENT_ADDRESS,
      message: 'Satflow challenge: 7f3a1c',
      protocol: 'ECDSA',
    });
    expect(rejected.success).toBe(false);
  });
});
