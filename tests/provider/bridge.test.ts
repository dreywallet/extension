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
import { PROVIDER_MAX_SIGN_INPUTS } from '@drey/core/provider/registry';
import { createDreyProvider, createWindowProviderTransport } from '../../src/provider/facade';

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
