import { chromium, type BrowserContext, type CDPSession } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSecretScanner, type NamedSecret } from './heap-scanner';

export type { NamedSecret } from './heap-scanner';

/** Collect garbage, then scan one heap snapshot of a Playwright-attachable target. */
export async function scanSessionHeap(
  session: CDPSession,
  secrets: readonly NamedSecret[],
): Promise<string[]> {
  const scanner = createSecretScanner(secrets);
  const onChunk = (event: { chunk: string }): void => scanner.push(event.chunk);
  session.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  try {
    await session.send('HeapProfiler.collectGarbage');
    await session.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  } finally {
    session.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  }
  return scanner.labels();
}

/**
 * Minimal DevTools client for targets Playwright will not attach to.
 * `browserContext.newCDPSession` accepts only a Page or Frame, so the MV3
 * service worker — the one heap that holds the unlocked DEK — is unreachable
 * through the normal API and needs a direct DevTools socket.
 */
class DevToolsSocket {
  private constructor(
    private readonly socket: WebSocket,
    private readonly pending: Map<number, (message: { id: number }) => void>,
  ) {}

  private nextId = 0;
  private onChunk: ((chunk: string) => void) | null = null;

  static async open(webSocketDebuggerUrl: string): Promise<DevToolsSocket> {
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('DevTools socket failed to open')), { once: true });
    });
    const pending = new Map<number, (message: { id: number }) => void>();
    const client = new DevToolsSocket(socket, pending);
    socket.addEventListener('message', (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: { chunk?: string };
      };
      if (message.method === 'HeapProfiler.addHeapSnapshotChunk') {
        if (typeof message.params?.chunk === 'string') client.onChunk?.(message.params.chunk);
        return;
      }
      if (typeof message.id !== 'number') return;
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve({ id: message.id });
      }
    });
    return client;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = (this.nextId += 1);
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async scanHeap(secrets: readonly NamedSecret[]): Promise<string[]> {
    const scanner = createSecretScanner(secrets);
    this.onChunk = (chunk) => scanner.push(chunk);
    try {
      await this.send('HeapProfiler.collectGarbage');
      await this.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    } finally {
      this.onChunk = null;
    }
    return scanner.labels();
  }

  close(): void {
    this.socket.close();
  }
}

export type InspectableContext = {
  readonly context: BrowserContext;
  readonly extensionId: string;
  /** Opens a DevTools socket onto the extension's MV3 service worker target. */
  openServiceWorkerSocket(): Promise<DevToolsSocket>;
  dispose(): Promise<void>;
};

async function readDevToolsPort(profile: string): Promise<string> {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = await readFile(portFile, 'utf8').then(
      (contents) => contents.split('\n')[0]?.trim() ?? '',
      () => '',
    );
    if (/^\d+$/u.test(port)) return port;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Chromium never published a DevTools port for the heap-inspection context');
}

/**
 * Launch a disposable extension context that also exposes a loopback DevTools
 * port. This is deliberately separate from the shared E2E fixture: no ordinary
 * test run opens a debugging port, and the profile — which holds extension
 * storage — is removed even when the browser or the test fails.
 */
export async function launchInspectableExtensionContext(
  extensionPath: string,
): Promise<InspectableContext> {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'drey-e2e-profile-'));
  let context: BrowserContext | null = null;
  const sockets: DevToolsSocket[] = [];
  const dispose = async (): Promise<void> => {
    for (const socket of sockets) socket.close();
    await context?.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
  };
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        // Loopback-only, ephemeral port, disposable signet fixture profile.
        '--remote-debugging-port=0',
        '--remote-allow-origins=*',
      ],
      viewport: { width: 1280, height: 900 },
    });
    const live = context;
    const worker = live.serviceWorkers().find((candidate) => candidate.url().startsWith('chrome-extension://')) ??
      await live.waitForEvent('serviceworker', {
        predicate: (candidate) => candidate.url().startsWith('chrome-extension://'),
        timeout: 15_000,
      });
    const extensionId = new URL(worker.url()).host;
    if (!/^[a-p]{32}$/u.test(extensionId)) throw new Error(`Unexpected extension ID: ${extensionId}`);
    const port = await readDevToolsPort(profile);

    return {
      context: live,
      extensionId,
      async openServiceWorkerSocket(): Promise<DevToolsSocket> {
        const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(
          (response) => response.json() as Promise<{ type: string; url: string; webSocketDebuggerUrl?: string }[]>,
        );
        const target = targets.find((candidate) =>
          candidate.type === 'service_worker' &&
          candidate.url.startsWith(`chrome-extension://${extensionId}/`),
        );
        if (!target?.webSocketDebuggerUrl) {
          throw new Error(`No DevTools service-worker target for extension ${extensionId}`);
        }
        const socket = await DevToolsSocket.open(target.webSocketDebuggerUrl);
        sockets.push(socket);
        return socket;
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
