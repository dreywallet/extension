import { describe, expect, it, vi } from 'vitest';
import {
  attachIsolatedBridge,
  attachReconnectingIsolatedBridge,
  PROVIDER_BRIDGE_VERSION,
  type ProviderRuntimePort,
  type RuntimeProviderRequest,
  type WindowBridgeTarget,
} from '../../src/provider/bridge';
import { providerError } from '@drey/core/provider/errors';
import {
  PROVIDER_MAX_SIGN_INPUTS,
  signMultipleTransactionsParamsSchema,
} from '@drey/core/provider/registry';
import {
  BITCOIN_SIGN_PSBT_V2_METHOD,
  createDreyProvider,
  createWindowProviderTransport,
  parseSatsConnectTransactionToken,
} from '../../src/provider/facade';
import { bytesToBase64 } from '@drey/core/domain/vault/encoding';

class FakeWindow implements WindowBridgeTarget {
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  readonly origin = 'https://app.example';

  addEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.delete(listener);
  }

  postMessage(message: unknown, targetOrigin: string): void {
    if (targetOrigin !== '*' && targetOrigin !== this.origin) return;
    const event = { data: message, source: this, origin: this.origin } as unknown as MessageEvent<unknown>;
    for (const listener of [...this.listeners]) listener(event);
  }

  postForeign(message: unknown): void {
    const event = { data: message, source: {}, origin: 'https://evil.example' } as MessageEvent<unknown>;
    for (const listener of [...this.listeners]) listener(event);
  }

  postWrongOrigin(message: unknown): void {
    const event = {
      data: message, source: this, origin: 'https://evil.example',
    } as unknown as MessageEvent<unknown>;
    for (const listener of [...this.listeners]) listener(event);
  }
}

class FakePort implements ProviderRuntimePort {
  readonly sent: unknown[] = [];
  readonly messageListeners = new Set<(message: unknown) => void>();
  readonly disconnectListeners = new Set<() => void>();
  disconnected = false;

  readonly onMessage = {
    addListener: (listener: (message: unknown) => void) => this.messageListeners.add(listener),
    removeListener: (listener: (message: unknown) => void) => this.messageListeners.delete(listener),
  };

  readonly onDisconnect = {
    addListener: (listener: () => void) => this.disconnectListeners.add(listener),
    removeListener: (listener: () => void) => this.disconnectListeners.delete(listener),
  };

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  emit(message: unknown): void {
    for (const listener of [...this.messageListeners]) listener(message);
  }

  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const listener of [...this.disconnectListeners]) listener();
  }
}

const ids = (...values: string[]): (() => string) => {
  let index = 0;
  return () => values[index++] ?? '00000000-0000-4000-8000-999999999999';
};

const PAGE_ID = '00000000-0000-4000-8000-000000000001';
const WORKER_ID = '00000000-0000-4000-8000-000000000002';
const LEGACY_PSBT = 'cHNidP8BAFICAAAAAaqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqAAAAAAD/////ASgjAAAAAAAAFgAUIiIiIiIiIiIiIiIiIiIiIiIiIiIAAAAAAAEBHxAnAAAAAAAAFgAUEREREREREREREREREREREREREREAAA==';

function base64UrlJson(value: unknown): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(value)))
    .replace(/=/gu, '').replace(/\+/gu, '-').replace(/\//gu, '_');
}

function transactionToken(
  payload: unknown,
  header: unknown = { typ: 'JWT', alg: 'none' },
): string {
  return `${base64UrlJson(header)}.${base64UrlJson(payload)}.`;
}

const LEGACY_TRANSACTION = {
  network: { type: 'Signet' as const },
  message: 'Sign transaction',
  psbtBase64: LEGACY_PSBT,
  inputsToSign: [{
    address: 'tb1qpaymentaddress',
    signingIndexes: [0],
    sigHash: 1 as const,
  }],
  broadcast: false,
};

function setup() {
  const window = new FakeWindow();
  const port = new FakePort();
  const stop = attachIsolatedBridge({
    window, port, randomUUID: ids(WORKER_ID), targetOrigin: window.origin,
  });
  const transport = createWindowProviderTransport(window, window.origin, ids(PAGE_ID), 60_000);
  return { window, port, stop, transport, provider: createDreyProvider(transport) };
}

describe('MAIN/isolated provider bridge', () => {
  it('replaces the page request ID with an isolated-world nonce', async () => {
    const { port, provider } = setup();
    const promise = provider.request('getBalance', null);
    expect(port.sent).toEqual([
      {
        type: 'drey:provider:request',
        protocolVersion: 1,
        requestNonce: WORKER_ID,
        method: 'getBalance',
        params: null,
      },
    ]);
    port.emit({
      type: 'drey:provider:response',
      protocolVersion: PROVIDER_BRIDGE_VERSION,
      requestNonce: WORKER_ID,
      ok: true,
      result: { confirmed: '5', unconfirmed: '2', total: '7' },
    });
    await expect(promise).resolves.toEqual({
      jsonrpc: '2.0',
      id: PAGE_ID,
      result: { confirmed: '5', unconfirmed: '2', total: '7' },
    });
  });

  it('rejects malformed known params before they reach the runtime port', async () => {
    const { port, transport } = setup();
    await expect(
      transport.request('signMessage', { address: 'tb1q00000000', message: 'x', protocol: 'ECDSA' }),
    ).rejects.toMatchObject({ code: -32602 });
    expect(port.sent).toEqual([]);
  });

  it('rejects oversized signPsbt selections before they reach the runtime port', async () => {
    const { port, transport } = setup();
    const indexes = Array.from({ length: PROVIDER_MAX_SIGN_INPUTS }, (_, index) => index);

    await expect(transport.request('signPsbt', {
      psbt: 'cHNidP8=',
      signInputs: { tb1q00000000: [...indexes, PROVIDER_MAX_SIGN_INPUTS] },
    })).rejects.toMatchObject({ code: -32602 });
    expect(port.sent).toEqual([]);

    const accepted = transport.request('signPsbt', {
      psbt: 'cHNidP8=',
      signInputs: { tb1q00000000: indexes },
    });
    expect(port.sent).toHaveLength(1);
    const request = port.sent[0] as RuntimeProviderRequest;
    port.emit({
      type: 'drey:provider:response',
      protocolVersion: 1,
      requestNonce: request.requestNonce,
      ok: true,
      result: { psbt: 'cHNidP8=' },
    });
    await expect(accepted).resolves.toMatchObject({ result: { psbt: 'cHNidP8=' } });
  });

  it('rejects a 501-input transaction group at the Core schema boundary', () => {
    const params = {
      network: { type: 'Signet' as const },
      message: 'Criteria offers',
      psbts: Array.from({ length: 10 }, (_, itemIndex) => ({
        psbtBase64: 'cHNidP8=',
        inputsToSign: [{
          address: 'tb1qpaymentaddress',
          signingIndexes: Array.from(
            { length: itemIndex === 9 ? 51 : 50 },
            (_unused, inputIndex) => inputIndex,
          ),
          sigHash: 1 as const,
        }],
      })),
    };

    expect(signMultipleTransactionsParamsSchema.safeParse(params).success).toBe(false);
  });

  it('normalizes bitcoin_signPsbtV2 to the strict signPsbt worker method', async () => {
    const { port, provider } = setup();
    const promise = provider.request(BITCOIN_SIGN_PSBT_V2_METHOD, {
      psbt: 'cHNidP8=',
      signInputs: { tb1qpaymentaddress: [0] },
      broadcast: false,
    });
    expect(port.sent[0]).toMatchObject({ method: 'signPsbt' });
    port.emit({
      type: 'drey:provider:response', protocolVersion: 1,
      requestNonce: WORKER_ID, ok: true, result: { psbt: 'cHNidP8=' },
    });
    await expect(promise).resolves.toEqual({
      jsonrpc: '2.0', id: PAGE_ID, result: { psbt: 'cHNidP8=' },
    });
  });

  it('translates the canonical Sats Connect signTransaction callback to signPsbt', async () => {
    const { port, provider } = setup();
    const promise = provider.signTransaction(transactionToken(LEGACY_TRANSACTION));
    expect(port.sent[0]).toMatchObject({ method: 'wallet_getNetwork', params: null });
    port.emit({
      type: 'drey:provider:response', protocolVersion: 1,
      requestNonce: WORKER_ID, ok: true,
      result: {
        bitcoin: { name: 'Signet' }, stacks: { name: 'testnet' }, spark: { name: 'regtest' },
      },
    });
    await vi.waitFor(() => expect(port.sent).toHaveLength(2));
    const signRequest = port.sent[1] as RuntimeProviderRequest;
    expect(signRequest).toMatchObject({
      method: 'signPsbt',
      params: {
        psbt: LEGACY_PSBT,
        inputsToSign: [{
          address: 'tb1qpaymentaddress', signingIndexes: [0], sigHash: 1,
        }],
        broadcast: false,
      },
    });
    port.emit({
      type: 'drey:provider:response', protocolVersion: 1,
      requestNonce: signRequest.requestNonce, ok: true,
      result: { psbt: LEGACY_PSBT, txid: '11'.repeat(32) },
    });
    await expect(promise).resolves.toEqual({
      psbtBase64: LEGACY_PSBT, txId: '11'.repeat(32),
    });
  });

  it('rejects a legacy callback for the wrong active network before signing', async () => {
    const { port, provider } = setup();
    const promise = provider.signTransaction(transactionToken({
      ...LEGACY_TRANSACTION,
      network: { type: 'Mainnet' },
    }));
    port.emit({
      type: 'drey:provider:response', protocolVersion: 1,
      requestNonce: WORKER_ID, ok: true,
      result: {
        bitcoin: { name: 'Signet' }, stacks: { name: 'testnet' }, spark: { name: 'regtest' },
      },
    });
    await expect(promise).rejects.toMatchObject({
      code: -32001,
      data: { dreyCode: 'ERR_UNSUPPORTED_BY_ACCOUNT' },
    });
    expect(port.sent).toHaveLength(1);
  });

  it('parses only canonical, bounded legacy single-transaction tokens', () => {
    expect(parseSatsConnectTransactionToken(transactionToken(LEGACY_TRANSACTION)))
      .toEqual(LEGACY_TRANSACTION);
    const invalidPayloads = [
      { ...LEGACY_TRANSACTION, inputsToSign: [{
        address: 'tb1qpaymentaddress', signingIndexes: [-1], sigHash: 1,
      }] },
      { ...LEGACY_TRANSACTION, inputsToSign: [{
        address: 'tb1qpaymentaddress', signingIndexes: [PROVIDER_MAX_SIGN_INPUTS], sigHash: 1,
      }] },
      { ...LEGACY_TRANSACTION, inputsToSign: [{
        address: 'tb1qpaymentaddress', signingIndexes: [0], sigHash: 2,
      }] },
      { ...LEGACY_TRANSACTION, inputsToSign: [
        { address: 'tb1qpaymentaddress', signingIndexes: [0], sigHash: 1 },
        { address: 'tb1qordinaladdress', signingIndexes: [0], sigHash: 0 },
      ] },
    ];
    for (const payload of invalidPayloads) {
      expect(() => parseSatsConnectTransactionToken(transactionToken(payload)))
        .toThrow(expect.objectContaining({ code: -32602 }));
    }
    expect(parseSatsConnectTransactionToken(transactionToken({
      ...LEGACY_TRANSACTION, network: { type: 'Testnet' },
    })).network.type).toBe('Testnet');
    for (const token of [
      '',
      'a.b',
      `${base64UrlJson({ typ: 'JWT', alg: 'none' })}.${base64UrlJson(LEGACY_TRANSACTION)}.signature`,
      transactionToken(LEGACY_TRANSACTION, { typ: 'JWT', alg: 'HS256' }),
      transactionToken(LEGACY_TRANSACTION, { typ: 'JWT', alg: 'none', kid: 'extra' }),
      `=${transactionToken(LEGACY_TRANSACTION)}`,
      'x'.repeat(2_100_001),
    ]) {
      expect(() => parseSatsConnectTransactionToken(token))
        .toThrow(expect.objectContaining({ code: -32602 }));
    }
  });

  it('forwards unknown methods so the worker can return stable unsupported-method', async () => {
    const { port, transport } = setup();
    const promise = transport.request('stx_transferStx', {});
    const request = port.sent[0] as RuntimeProviderRequest;
    expect(request.method).toBe('stx_transferStx');
    port.emit({
      type: 'drey:provider:response',
      protocolVersion: 1,
      requestNonce: request.requestNonce,
      ok: false,
      error: providerError('ERR_UNSUPPORTED_METHOD'),
    });
    await expect(promise).rejects.toMatchObject({
      code: -32601,
      data: { dreyCode: 'ERR_UNSUPPORTED_METHOD' },
    });
  });

  it('rejects malformed worker successes through the response-schema backstop', async () => {
    const { port, provider } = setup();
    const promise = provider.request('getBalance', null);
    port.emit({
      type: 'drey:provider:response',
      protocolVersion: 1,
      requestNonce: WORKER_ID,
      ok: true,
      result: { confirmed: '5', unconfirmed: '2', total: '7', seed: 'leak' },
    });
    await expect(promise).resolves.toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32603, message: 'Internal error' },
    });
  });

  it('ignores cross-window messages and emits only authorized events', () => {
    const { window, port, provider } = setup();
    const accounts = vi.fn();
    const network = vi.fn();
    const disconnect = vi.fn();
    const removeAccounts = provider.addListener({ eventName: 'accountChange', cb: accounts });
    provider.addListener({ eventName: 'networkChange', cb: network });
    provider.addListener({ eventName: 'disconnect', cb: disconnect });

    window.postForeign({
      type: 'drey:provider:event',
      protocolVersion: 1,
      event: 'accountChange',
      data: {
        type: 'accountChange',
        addresses: [{
          address: 'tb1qforeign',
          publicKey: '02'.repeat(33),
          purpose: 'payment',
          addressType: 'p2wpkh',
          walletType: 'software',
        }],
      },
    });
    window.postWrongOrigin({
      type: 'drey:provider:event',
      protocolVersion: 1,
      event: 'disconnect',
      data: { type: 'disconnect' },
    });
    port.emit({
      type: 'drey:provider:event',
      protocolVersion: 1,
      event: 'accountChange',
      data: {
        type: 'accountChange',
        addresses: [{
          address: 'tb1qapproved',
          publicKey: '02'.repeat(33),
          purpose: 'payment',
          addressType: 'p2wpkh',
          walletType: 'software',
        }],
      },
    });
    port.emit({
      type: 'drey:provider:event',
      protocolVersion: 1,
      event: 'networkChange',
      data: {
        type: 'networkChange',
        bitcoin: { name: 'Signet' },
        stacks: { name: 'testnet' },
        spark: { name: 'regtest' },
      },
    });
    port.emit({
      type: 'drey:provider:event',
      protocolVersion: 1,
      event: 'runesChanged',
      data: [],
    });
    port.emit({
      type: 'drey:provider:event',
      protocolVersion: 1,
      event: 'disconnect',
      data: { type: 'disconnect' },
    });
    expect(accounts).toHaveBeenCalledOnce();
    expect(accounts).toHaveBeenCalledWith({
      type: 'accountChange',
      addresses: [{
        address: 'tb1qapproved',
        publicKey: '02'.repeat(33),
        purpose: 'payment',
        addressType: 'p2wpkh',
        walletType: 'software',
      }],
    });
    expect(network).toHaveBeenCalledWith({
      type: 'networkChange',
      bitcoin: { name: 'Signet' },
      stacks: { name: 'testnet' },
      spark: { name: 'regtest' },
    });
    expect(disconnect).toHaveBeenCalledWith({ type: 'disconnect' });

    removeAccounts();
    port.emit({
      type: 'drey:provider:event',
      protocolVersion: 1,
      event: 'accountChange',
      data: { type: 'accountChange' },
    });
    expect(accounts).toHaveBeenCalledOnce();
  });

  it('caps pending work on both sides of the page bridge', async () => {
    const isolatedWindow = new FakeWindow();
    const port = new FakePort();
    const stop = attachIsolatedBridge({
      window: isolatedWindow,
      port,
      targetOrigin: isolatedWindow.origin,
      randomUUID: () => crypto.randomUUID(),
    });
    for (let index = 0; index < 33; index += 1) {
      isolatedWindow.postMessage({
        type: 'drey:provider:request',
        protocolVersion: 1,
        requestId: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
        method: 'getInfo',
      }, isolatedWindow.origin);
    }
    expect(port.sent).toHaveLength(32);
    stop();

    const mainWindow = new FakeWindow();
    const transport = createWindowProviderTransport(
      mainWindow, mainWindow.origin, () => crypto.randomUUID(), 60_000,
    );
    const pending = Array.from({ length: 32 }, () => transport.request('getInfo').catch(() => undefined));
    await expect(transport.request('getInfo')).rejects.toMatchObject({
      data: { dreyCode: 'ERR_QUEUE_FULL' },
    });
    transport.destroy();
    await Promise.all(pending);
  });

  it('rejects all pending requests as stale when the port disconnects', async () => {
    const { port, provider } = setup();
    const first = provider.request('getBalance', null);
    const second = provider.request('wallet_getNetwork', null);
    port.disconnect();
    await expect(first).resolves.toMatchObject({
      error: { data: { dreyCode: 'ERR_STALE_CONTEXT' } },
    });
    await expect(second).resolves.toMatchObject({
      error: { data: { dreyCode: 'ERR_STALE_CONTEXT' } },
    });
  });

  it('reconnects the same document after an MV3 worker port restart', async () => {
    const window = new FakeWindow();
    const ports: FakePort[] = [];
    const scheduled: Array<() => void> = [];
    const stop = attachReconnectingIsolatedBridge({
      window,
      connectPort: () => {
        const port = new FakePort();
        ports.push(port);
        return port;
      },
      randomUUID: ids(
        '00000000-0000-4000-8000-000000000011',
        '00000000-0000-4000-8000-000000000012',
      ),
      targetOrigin: window.origin,
      scheduleReconnect: (reconnect) => scheduled.push(reconnect),
    });
    const transport = createWindowProviderTransport(window, window.origin, ids(
      '00000000-0000-4000-8000-000000000021',
      '00000000-0000-4000-8000-000000000022',
    ), 60_000);
    const provider = createDreyProvider(transport);

    const stale = provider.request('wallet_getNetwork', null);
    ports[0]!.disconnect();
    await expect(stale).resolves.toMatchObject({
      error: { data: { dreyCode: 'ERR_STALE_CONTEXT' } },
    });
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!();
    expect(ports).toHaveLength(2);

    const restored = provider.request('wallet_getNetwork', null);
    const request = ports[1]!.sent[0] as RuntimeProviderRequest;
    ports[1]!.emit({
      type: 'drey:provider:response', protocolVersion: 1,
      requestNonce: request.requestNonce, ok: true,
      result: {
        bitcoin: { name: 'Signet' },
        stacks: { name: 'testnet' },
        spark: { name: 'regtest' },
      },
    });
    await expect(restored).resolves.toEqual({
      jsonrpc: '2.0',
      id: '00000000-0000-4000-8000-000000000022',
      result: {
        bitcoin: { name: 'Signet' },
        stacks: { name: 'testnet' },
        spark: { name: 'regtest' },
      },
    });

    stop();
    transport.destroy();
    expect(scheduled).toHaveLength(0);
  });

  it('exposes only the approved facade and no account data at initialization', () => {
    const { provider } = setup();
    expect(Object.keys(provider).sort()).toEqual(
      [
        'addListener',
        'isDrey',
        'methods',
        'protocolVersion',
        'request',
        'signTransaction',
        'signMultipleTransactions',
      ].sort(),
    );
    expect(provider).not.toHaveProperty('address');
    expect(provider).not.toHaveProperty('account');
    expect(provider).not.toHaveProperty('balance');
    expect(provider).not.toHaveProperty('pushTx');
    expect(provider).not.toHaveProperty('pushPsbt');
  });

  it('surfaces stable errors as JSON-RPC error responses', async () => {
    const { port, provider } = setup();
    const promise = provider.request('wallet_getAccount', null);
    port.emit({
      type: 'drey:provider:response',
      protocolVersion: 1,
      requestNonce: WORKER_ID,
      ok: false,
      error: providerError('ERR_NOT_CONNECTED'),
    });
    await expect(promise).resolves.toEqual({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32002,
        message: 'Site is not connected',
        data: { dreyCode: 'ERR_NOT_CONNECTED' },
      },
    });
  });

  it('does not retain listeners or pending requests across repeated document teardown', async () => {
    for (let cycle = 0; cycle < 25; cycle += 1) {
      const { window, port, provider, transport, stop } = setup();
      const accountListener = vi.fn();
      provider.addListener({ eventName: 'accountChange', cb: accountListener });
      const pending = provider.request('wallet_getNetwork', null);

      transport.destroy();
      stop();

      await expect(pending).resolves.toMatchObject({
        error: { data: { dreyCode: 'ERR_STALE_CONTEXT' } },
      });
      expect(window.listeners.size).toBe(0);
      expect(port.messageListeners.size).toBe(0);
      expect(port.disconnectListeners.size).toBe(0);
    }
  });
});
