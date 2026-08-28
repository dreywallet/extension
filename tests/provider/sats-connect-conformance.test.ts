import {
  AddressPurpose,
  BitcoinNetworkType,
  MessageSigningProtocols,
  addListener as addSatsConnectListener,
  getProviderById,
  getProviders,
  request as satsConnectRequest,
  signMultipleTransactions as satsConnectSignMultipleTransactions,
  signTransaction as satsConnectSignTransaction,
} from '@sats-connect/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerProviderDiscovery, type ProviderDiscoveryWindow } from '../../src/provider/discovery';
import {
  createDreyProvider,
  type ProviderTransport,
} from '../../src/provider/facade';
import { providerError, DreyProviderError } from '@drey/core/provider/errors';

const INFO = {
  version: '0.3.0',
  platform: 'web',
  methods: ['getInfo', 'getBalance'],
  supports: ['WBIP001', 'WBIP004'],
} as const;

const NETWORK = {
  bitcoin: { name: 'Signet' },
  stacks: { name: 'testnet' },
  spark: { name: 'regtest' },
} as const;

const ACCOUNT = {
  id: 'drey-account-0',
  addresses: [{
    address: 'tb1qpaymentaddress',
    publicKey: `02${'11'.repeat(32)}`,
    purpose: 'payment',
    addressType: 'p2wpkh',
    walletType: 'software',
  }],
  walletType: 'software',
  network: NETWORK,
} as const;

const LEGACY_PSBT = 'cHNidP8BAFICAAAAAaqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqAAAAAAD/////ASgjAAAAAAAAFgAUIiIiIiIiIiIiIiIiIiIiIiIiIiIAAAAAAAEBHxAnAAAAAAAAFgAUEREREREREREREREREREREREREREAAA==';

const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    value: originalWindow,
    configurable: true,
    writable: true,
  });
});

describe('Sats Connect Core 0.16.0 conformance', () => {
  it('discovers Drey by its global path and parses success and error envelopes', async () => {
    let requestIndex = 0;
    const transport: ProviderTransport = {
      request: vi.fn(async (method) => {
        requestIndex += 1;
        if (method === 'getInfo') {
          return { id: `request-${requestIndex}`, result: INFO };
        }
        if (method === 'getBalance') {
          return {
            id: `request-${requestIndex}`,
            result: { confirmed: '7', unconfirmed: '2', total: '9' },
          };
        }
        if (method === 'wallet_connect') {
          return { id: `request-${requestIndex}`, result: ACCOUNT };
        }
        if (method === 'wallet_getNetwork') {
          return { id: `request-${requestIndex}`, result: NETWORK };
        }
        if (method === 'signPsbt') {
          return {
            id: `request-${requestIndex}`,
            result: { psbt: 'cHNidP8=', txid: '11'.repeat(32) },
          };
        }
        if (method === 'signMultipleTransactions') {
          return {
            id: `request-${requestIndex}`,
            result: [{ psbtBase64: 'cHNidP8=' }, { psbtBase64: 'cHNidP8=' }],
          };
        }
        if (method === 'signMultipleMessages') {
          return {
            id: `request-${requestIndex}`,
            result: [{
              signature: 'bip322-signature',
              message: 'Authenticate',
              messageHash: '11'.repeat(32),
              address: 'tb1qpaymentaddress',
              protocol: 'BIP322',
            }],
          };
        }
        if (method === 'wallet_getWalletType') {
          return { id: `request-${requestIndex}`, result: 'software' };
        }
        if (method === 'wallet_renouncePermissions') {
          return { id: `request-${requestIndex}`, result: null };
        }
        throw new DreyProviderError(providerError('ERR_UNSUPPORTED_METHOD'));
      }),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      destroy: vi.fn(),
    };
    const drey = createDreyProvider(transport);
    const page = { drey } as ProviderDiscoveryWindow & { drey: typeof drey };
    registerProviderDiscovery(page, drey);
    Object.defineProperty(globalThis, 'window', {
      value: page,
      configurable: true,
      writable: true,
    });

    expect(getProviders()).toEqual([
      expect.objectContaining({
        id: 'drey',
        name: 'Drey',
        methods: expect.arrayContaining(['getInfo', 'getBalance']),
      }),
    ]);
    expect(getProviderById('drey')).toBe(drey);

    await expect(satsConnectRequest('getBalance', undefined, 'drey')).resolves.toEqual({
      status: 'success',
      result: { confirmed: '7', unconfirmed: '2', total: '9' },
    });
    await expect(satsConnectRequest('wallet_connect', {
      addresses: [AddressPurpose.Payment],
      network: BitcoinNetworkType.Signet,
    }, 'drey')).resolves.toEqual({
      status: 'success',
      result: ACCOUNT,
    });
    await expect(satsConnectRequest('wallet_getNetwork', undefined, 'drey')).resolves.toEqual({
      status: 'success',
      result: NETWORK,
    });
    await expect(satsConnectRequest('wallet_getWalletType', undefined, 'drey')).resolves.toEqual({
      status: 'success',
      result: 'software',
    });
    await expect(satsConnectRequest('signMultipleMessages', [{
      address: 'tb1qpaymentaddress',
      message: 'Authenticate',
      protocol: MessageSigningProtocols.BIP322,
    }], 'drey')).resolves.toEqual({
      status: 'success',
      result: [{
        signature: 'bip322-signature',
        message: 'Authenticate',
        messageHash: '11'.repeat(32),
        address: 'tb1qpaymentaddress',
        protocol: 'BIP322',
      }],
    });
    await expect(satsConnectRequest('signPsbt', {
      psbt: 'cHNidP8=',
      broadcast: true,
    }, 'drey')).resolves.toEqual({
      status: 'success',
      result: { psbt: 'cHNidP8=', txid: '11'.repeat(32) },
    });
    const singleOnFinish = vi.fn();
    const singleOnCancel = vi.fn();
    await satsConnectSignTransaction({
      payload: {
        network: { type: BitcoinNetworkType.Signet },
        message: 'Sign transaction',
        psbtBase64: LEGACY_PSBT,
        inputsToSign: [{
          address: 'tb1qpaymentaddress',
          signingIndexes: [0],
          sigHash: 1,
        }],
        broadcast: true,
      },
      onFinish: singleOnFinish,
      onCancel: singleOnCancel,
      getProvider: async () => drey as never,
    });
    expect(singleOnCancel).not.toHaveBeenCalled();
    expect(singleOnFinish).toHaveBeenCalledWith({
      psbtBase64: 'cHNidP8=', txId: '11'.repeat(32),
    });
    const onFinish = vi.fn();
    await satsConnectSignMultipleTransactions({
      payload: {
        network: { type: BitcoinNetworkType.Signet },
        message: 'Sign transactions',
        psbts: [{ psbtBase64: 'cHNidP8=' }, { psbtBase64: 'cHNidP8=' }],
      },
      onFinish,
      onCancel: vi.fn(),
      getProvider: async () => drey as never,
    });
    expect(onFinish).toHaveBeenCalledWith([
      { psbtBase64: 'cHNidP8=' }, { psbtBase64: 'cHNidP8=' },
    ]);
    await expect(satsConnectRequest(
      'wallet_renouncePermissions',
      undefined,
      'drey',
    )).resolves.toEqual({
      status: 'success',
      result: null,
    });
    await expect(satsConnectRequest('stx_transferStx', {} as never, 'drey')).resolves.toEqual({
      status: 'error',
      error: {
        code: -32601,
        message: 'Method is not supported',
        data: { dreyCode: 'ERR_UNSUPPORTED_METHOD' },
      },
    });
  });

  it('uses the standard listener object and returned unsubscribe callback', () => {
    let accountListener: ((event: {
      type: 'accountChange';
      addresses?: never[];
    }) => void) | undefined;
    const transport: ProviderTransport = {
      request: vi.fn(),
      addListener: vi.fn((event, listener) => {
        if (event === 'accountChange') accountListener = listener as typeof accountListener;
      }),
      removeListener: vi.fn(),
      destroy: vi.fn(),
    };
    const drey = createDreyProvider(transport);
    Object.defineProperty(globalThis, 'window', {
      value: { drey },
      configurable: true,
      writable: true,
    });
    const callback = vi.fn();

    const unsubscribe = addSatsConnectListener({
      eventName: 'accountChange',
      cb: callback,
    }, 'drey');
    accountListener?.({ type: 'accountChange' });
    unsubscribe();

    expect(callback).toHaveBeenCalledWith({ type: 'accountChange' });
    expect(transport.removeListener).toHaveBeenCalledWith(
      'accountChange',
      expect.any(Function),
    );
  });
});
