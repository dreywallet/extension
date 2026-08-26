import type { CDPSession } from '@playwright/test';
import { test, expect } from './fixtures';
import { DAPP_ORIGIN } from './pages';
import { terminateExtensionWorker, wakeExtensionWorker } from './worker';

const TEST_EXTENSION_ID = 'lgcnmmbgabemdkgacjpcdebbjmmblbmn';
let targetCommandId = 0;

async function sendTargetCommand<T>(
  cdp: CDPSession,
  sessionId: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const requestId = ++targetCommandId;
  const response = new Promise<T>((resolve, reject) => {
    const onMessage = (event: { message: string; sessionId: string }) => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message) as {
        id?: number;
        error?: { message: string };
        result?: T;
      };
      if (message.id !== requestId) return;
      cdp.off('Target.receivedMessageFromTarget', onMessage);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result as T);
    };
    cdp.on('Target.receivedMessageFromTarget', onMessage);
  });
  await cdp.send('Target.sendMessageToTarget', {
    sessionId,
    message: JSON.stringify({ id: requestId, method, params }),
  });
  return response;
}

async function evaluateTarget<T>(
  cdp: CDPSession,
  sessionId: string,
  expression: string,
): Promise<T> {
  const result = await sendTargetCommand<{ result?: { value?: T } }>(
    cdp,
    sessionId,
    'Runtime.evaluate',
    { expression, returnByValue: true },
  );
  return result.result?.value as T;
}

test('loads the packaged MV3 extension and discovers its stable identity', async ({
  extensionId, extensionWorker, popup,
}) => {
  expect(extensionId).toBe(TEST_EXTENSION_ID);
  const manifest = await extensionWorker.evaluate(() => chrome.runtime.getManifest());
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.background).toMatchObject({ service_worker: 'background.js' });
  expect(manifest.permissions).toEqual(
    expect.arrayContaining(['storage', 'alarms', 'idle', 'sidePanel']),
  );
  expect(manifest.minimum_chrome_version).toBe('116');
  expect(manifest.side_panel).toEqual({ default_path: 'sidepanel.html' });
  expect(manifest.action).toMatchObject({ default_popup: 'popup.html' });

  await popup.open();
  await expect(popup.page.getByRole('heading', { name: 'Welcome to Drey' })).toBeVisible();
  const palette = await popup.page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      accent: style.getPropertyValue('--color-accent').trim(),
      selected: document.documentElement.dataset['accent'],
      warning: style.getPropertyValue('--color-warning').trim(),
    };
  });
  expect(palette).toEqual({ accent: '#f4f4ef', selected: 'white', warning: '#ff9818' });
});

test('opens at the intended size from the browser toolbar', async ({
  extensionContext, extensionId, extensionWorker,
}, testInfo) => {
  const controlPage = await extensionContext.newPage();
  const cdp = await extensionContext.newCDPSession(controlPage);
  let createdWindowId: number | undefined;
  let popupTargetId: string | undefined;
  try {
    const isHeadless = await controlPage.evaluate(() => navigator.userAgent.includes('HeadlessChrome'));
    testInfo.skip(isHeadless, 'Chromium does not create browser-action popups in headless mode');
    // A persistent headed context can start with no focused normal window even
    // though a service worker is live. Give chrome.action an explicit active
    // tab/window before asking it to create the toolbar popup.
    await controlPage.goto(`${DAPP_ORIGIN}/`);
    await controlPage.bringToFront();
    await expect(controlPage.getByRole('heading', { name: 'Drey local E2E dapp' })).toBeVisible();
    await cdp.send('Target.setDiscoverTargets', { discover: true });
    const toolbarWindow = await extensionWorker.evaluate(async (dappOrigin) => {
      const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
      const existing = windows.find((candidate) => candidate.focused) ?? windows[0];
      if (existing?.id === undefined) throw new Error('No normal browser window is available');
      let targetId = existing.id;
      let createdWindowId: number | undefined;
      await chrome.windows.update(targetId, { focused: true });
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (!(await chrome.windows.get(targetId)).focused) {
        const created = await chrome.windows.create({
          focused: true,
          type: 'normal',
          url: `${dappOrigin}/`,
        });
        if (created?.id === undefined) throw new Error('Focused browser window creation failed');
        targetId = created.id;
        createdWindowId = created.id;
        await new Promise((resolve) => setTimeout(resolve, 100));
        if (!(await chrome.windows.get(targetId)).focused) {
          return { createdWindowId, focused: false, targetWindowId: targetId };
        }
      }
      await chrome.action.openPopup({ windowId: targetId });
      return { createdWindowId, focused: true, targetWindowId: targetId };
    }, DAPP_ORIGIN);
    createdWindowId = toolbarWindow.createdWindowId;
    testInfo.skip(
      !toolbarWindow.focused,
      'Host desktop policy prevents Chromium from exposing a focused toolbar window',
    );
    let popupSessionId: string | undefined;
    await expect.poll(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      popupTargetId = targetInfos.find((target) =>
        target.url === `chrome-extension://${extensionId}/popup.html`,
      )?.targetId;
      if (!popupTargetId) {
        await extensionWorker.evaluate(async (windowId) => {
          await chrome.windows.update(windowId, { focused: true });
          await chrome.action.openPopup({ windowId });
        }, toolbarWindow.targetWindowId).catch(() => undefined);
        return undefined;
      }
      try {
        const attached = await cdp.send('Target.attachToTarget', {
          targetId: popupTargetId,
          flatten: false,
        });
        popupSessionId = attached.sessionId;
        return popupSessionId;
      } catch {
        // Browser-action popups close immediately when their window briefly
        // loses focus. The next poll refocuses the same window and opens a new
        // popup target instead of attaching to the now-stale target ID.
        popupTargetId = undefined;
        return undefined;
      }
    }).toBeTruthy();
    const sessionId = popupSessionId!;
    await expect.poll(() => evaluateTarget<string | undefined>(
      cdp,
      sessionId,
      `document.querySelector('h1')?.textContent`,
    )).toBe('Welcome to Drey');
    const dimensions = await evaluateTarget<{
      backgroundColor: string;
      bodyWidth: number;
      contentHeight: number;
      contentWidth: number;
      headingText: string | undefined;
      viewportHeight: number;
      viewportWidth: number;
    }>(cdp, sessionId, `(() => ({
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      bodyWidth: document.body.getBoundingClientRect().width,
      contentHeight: document.querySelector('#root')?.firstElementChild?.getBoundingClientRect().height,
      contentWidth: document.querySelector('#root')?.firstElementChild?.getBoundingClientRect().width,
      headingText: document.querySelector('h1')?.textContent,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    }))()`);
    expect(dimensions).toEqual({
      backgroundColor: 'rgb(8, 8, 8)',
      bodyWidth: 392,
      contentHeight: 600,
      contentWidth: 392,
      headingText: 'Welcome to Drey',
      viewportHeight: 600,
      viewportWidth: 392,
    });

    const launcher = await evaluateTarget<{ x: number; y: number } | null>(
      cdp,
      sessionId,
      `(() => {
        const element = document.querySelector('[aria-label="Open in side panel"]');
        if (!(element instanceof HTMLElement)) return null;
        const rect = element.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`,
    );
    expect(launcher).not.toBeNull();
    await sendTargetCommand(cdp, sessionId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: launcher!.x,
      y: launcher!.y,
      button: 'left',
      clickCount: 1,
    });
    await sendTargetCommand(cdp, sessionId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: launcher!.x,
      y: launcher!.y,
      button: 'left',
      clickCount: 1,
    });
    await expect.poll(() => extensionWorker.evaluate(async () => {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
      return contexts.map((context) => context.documentUrl);
    })).toContain(`chrome-extension://${extensionId}/sidepanel.html`);
  } finally {
    if (popupTargetId) await cdp.send('Target.closeTarget', { targetId: popupTargetId }).catch(() => undefined);
    if (createdWindowId !== undefined) {
      await extensionWorker.evaluate((windowId) => chrome.windows.remove(windowId), createdWindowId)
        .catch(() => undefined);
    }
    await cdp.detach().catch(() => undefined);
    await controlPage.close().catch(() => undefined);
  }
});

for (const viewport of [
  { width: 320, height: 500 },
  { width: 392, height: 600 },
  { width: 520, height: 900 },
]) {
  test(`side panel fits ${viewport.width}x${viewport.height} without horizontal overflow`, async ({
    extensionPage,
  }) => {
    await extensionPage.page.setViewportSize(viewport);
    await extensionPage.goto('sidepanel.html');
    await expect(extensionPage.page.getByRole('heading', { name: 'Welcome to Drey' })).toBeVisible();
    const layout = await extensionPage.page.evaluate(() => {
      const rootSurface = document.querySelector('#root')?.firstElementChild;
      const active = document.activeElement;
      return {
        bodyScrollWidth: document.body.scrollWidth,
        documentClientWidth: document.documentElement.clientWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        surfaceHeight: rootSurface?.getBoundingClientRect().height,
        surfaceWidth: rootSurface?.getBoundingClientRect().width,
        viewportHeight: innerHeight,
        viewportWidth: innerWidth,
        focusVisible: active instanceof HTMLElement ? active.matches(':focus-visible') : false,
      };
    });
    expect(layout).toMatchObject({
      bodyScrollWidth: viewport.width,
      documentClientWidth: viewport.width,
      documentScrollWidth: viewport.width,
      surfaceHeight: viewport.height,
      surfaceWidth: viewport.width,
      viewportHeight: viewport.height,
      viewportWidth: viewport.width,
    });
    await extensionPage.page.keyboard.press('Tab');
    await expect(extensionPage.page.getByRole('button', { name: 'Set up your wallet' }))
      .toBeFocused();
  });
}

test('injects the frozen provider facade into the top page and iframe', async ({ dapp }) => {
  await dapp.open();
  await expect(dapp.page.getByRole('status')).toContainText('Drey provider discovered');
  const frame = dapp.page.frameLocator('iframe[title="Provider iframe"]');
  await expect(frame.getByRole('status')).toHaveText('Drey provider available in iframe');

  const facade = await dapp.page.evaluate(() => {
    const candidate = (window as Window & {
      drey?: { isDrey: boolean; methods: readonly string[] };
      btc_providers?: Array<{ id: string; methods?: readonly string[] }>;
      wbip_providers?: Array<{ id: string; methods?: readonly string[] }>;
    });
    return {
      isDrey: candidate.drey?.isDrey,
      frozen: candidate.drey ? Object.isFrozen(candidate.drey) : false,
      discovered: candidate.btc_providers?.some((entry) =>
        entry.id === 'drey' && entry.methods?.includes('getInfo')),
      wbipDiscovered: candidate.wbip_providers?.some((entry) =>
        entry.id === 'drey' && entry.methods?.includes('wallet_connect')),
      avoidsLegacyNamespaceClaims:
        !Object.prototype.hasOwnProperty.call(candidate, 'BitcoinProvider') &&
        !Object.prototype.hasOwnProperty.call(candidate, 'XverseProviders'),
      methods: candidate.drey?.methods,
    };
  });
  expect(facade).toMatchObject({
    isDrey: true,
    frozen: true,
    discovered: true,
    wbipDiscovered: true,
    avoidsLegacyNamespaceClaims: true,
  });
  expect(facade.methods).toEqual(expect.arrayContaining([
    'drey_openCommunityVault', 'wallet_connect', 'wallet_disconnect', 'getAddresses', 'signMessage',
    'signMultipleMessages', 'wallet_getWalletType', 'sendTransfer',
  ]));

  await dapp.invoke('Permissions');
  await expect(dapp.output()).toHaveText('[]');
  await frame.getByRole('button', { name: 'Read permissions in iframe' }).click();
  await expect(frame.locator('#frame-output')).toHaveText('[]');
});

test('reconnects after same-document navigation and forced worker termination', async ({
  dapp, extensionContext, extensionId,
}) => {
  await dapp.open();
  await dapp.invoke('Same-document navigate');
  await expect(dapp.output()).toContainText('"providerAvailable": true');

  await terminateExtensionWorker(extensionContext, extensionId);
  const extensionPage = await extensionContext.newPage();
  try {
    await wakeExtensionWorker(extensionPage, extensionId);
    await expect(extensionPage.getByRole('heading', { name: 'Welcome to Drey' })).toBeVisible();
  } finally {
    await extensionPage.close();
  }

  await dapp.invoke('Permissions');
  await expect(dapp.output()).toHaveText('[]');
  const frame = dapp.page.frameLocator('iframe[title="Provider iframe"]');
  await frame.getByRole('button', { name: 'Read permissions in iframe' }).click();
  await expect(frame.locator('#frame-output')).toHaveText('[]');
});
