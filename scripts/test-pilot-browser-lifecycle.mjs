import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from '@playwright/test';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const workspace = resolve(root, '..');
const artifact = join(root, '.output', 'chrome-mv3');
const metadataPath = join(root, '.output', 'm8t-channel.json');
const manifestPath = join(artifact, 'manifest.json');
const packageVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const localMarkerKey = 'drey.lifecycle.local';
const sessionMarkerKey = 'drey.lifecycle.session';
const expectedPopupText = ['DREY', 'Welcome to Drey', 'SET UP YOUR WALLET'];
const requestedBrowsers = new Set(
  process.argv.slice(2).filter((value) => !value.startsWith('-')),
);
const browserDefinitions = [
  {
    id: 'chrome',
    label: 'Google Chrome',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  },
  {
    id: 'brave',
    label: 'Brave',
    executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  },
].filter((entry) => requestedBrowsers.size === 0 || requestedBrowsers.has(entry.id));

if (browserDefinitions.length === 0) {
  throw new Error('choose chrome, brave, or omit browser arguments to run both');
}

let nestedCommandId = 0;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else files.push(path);
  }
  return files.sort();
}

async function treeDigest(directory) {
  const hash = createHash('sha256');
  for (const file of await filesBelow(directory)) {
    hash.update(relative(directory, file).replaceAll('\\', '/')).update('\0');
    hash.update(await readFile(file)).update('\0');
  }
  return hash.digest('hex');
}

async function gitHead(directory) {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: directory });
  return stdout.trim();
}

async function verifyPilotArtifact() {
  assert.equal((await stat(artifact)).isDirectory(), true, `missing pilot artifact ${artifact}`);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  assert.equal(manifest.name, 'Drey PILOT');
  assert.equal(
    manifest.description,
    'DISPOSABLE MAINNET PILOT — MANUAL SMALL-VALUE SCENARIOS ONLY',
  );
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.deepEqual(manifest.permissions, ['storage', 'alarms', 'idle', 'sidePanel']);
  assert.deepEqual(manifest.side_panel, { default_path: 'sidepanel.html' });
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.deepEqual(manifest.host_permissions, ['https://wallet-api.squirrelsystems.net/*']);
  assert.equal(metadata.channel, 'pilot');
  assert.equal(metadata.name, 'Drey PILOT');
  assert.equal(metadata.network, 'mainnet');
  assert.equal(metadata.gatewayOrigin, 'https://wallet-api.squirrelsystems.net');
  assert.equal(metadata.disposableMainnetPilot, true);
  assert.equal(metadata.liveGatewayEnabled, true);
  assert.deepEqual(metadata.gatewayProtocolVersions, [2]);
  assert.equal(metadata.sourceBinding.extensionRevision, await gitHead(root));
  assert.equal(metadata.sourceBinding.gatewayRevision, await gitHead(join(workspace, 'gateway')));
  assert.equal(metadata.sourceBinding.buildOutputContentDigest, await treeDigest(artifact));
  return {
    contentDigest: metadata.sourceBinding.buildOutputContentDigest,
    extensionRevision: metadata.sourceBinding.extensionRevision,
    gatewayRevision: metadata.sourceBinding.gatewayRevision,
    manifestSha256: sha256(await readFile(manifestPath)),
  };
}

async function startDapp() {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end('<!doctype html><html><body><main>Drey lifecycle probe</main></body></html>');
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address !== null && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

async function launchProfile(profile, definition) {
  return chromium.launchPersistentContext(profile, {
    executablePath: definition.executablePath,
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--enable-unsafe-extension-debugging',
    ],
    viewport: { width: 1280, height: 900 },
  });
}

async function extensionInfo(session, extensionId = null) {
  const result = await session.send('Extensions.getExtensions');
  return extensionId === null
    ? result.extensions
    : result.extensions.find((entry) => entry.id === extensionId) ?? null;
}

async function waitFor(predicate, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => globalThis.setTimeout(resolveDelay, 100));
  }
  throw new Error(`${message}${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

async function installUnpacked(session) {
  const existing = (await extensionInfo(session))
    .find((entry) => resolve(entry.path) === artifact);
  const id = existing?.id ?? (await session.send('Extensions.loadUnpacked', { path: artifact })).id;
  const installed = await waitFor(
    async () => extensionInfo(session, id),
    'pilot did not appear in the unpacked extension inventory',
  );
  assert.match(id, /^[a-p]{32}$/u);
  assert.equal(installed.name, 'Drey PILOT');
  assert.equal(installed.version, packageVersion);
  assert.equal(resolve(installed.path), artifact);
  assert.equal(installed.enabled, true);
  return id;
}

async function nestedSend(session, sessionId, method, params = {}) {
  const id = ++nestedCommandId;
  const response = new Promise((resolveResponse, rejectResponse) => {
    const listener = (event) => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message);
      if (message.id !== id) return;
      session.off('Target.receivedMessageFromTarget', listener);
      if (message.error) rejectResponse(new Error(message.error.message));
      else resolveResponse(message.result);
    };
    session.on('Target.receivedMessageFromTarget', listener);
  });
  await session.send('Target.sendMessageToTarget', {
    sessionId,
    message: JSON.stringify({ id, method, params }),
  });
  return response;
}

async function tabTargetFor(session, url) {
  return waitFor(
    async () => {
      const next = await session.send('Target.getTargets', {
        filter: [{ type: 'tab', exclude: false }, { exclude: true }],
      });
      return next.targetInfos.find((entry) => entry.url === url) ?? null;
    },
    `no tab target found for ${url}`,
  );
}

async function openToolbarPopup(session, extensionId, hostPage) {
  const hostTarget = await tabTargetFor(session, hostPage.url());
  const before = await session.send('Target.getTargets');
  await session.send('Extensions.triggerAction', {
    id: extensionId,
    targetId: hostTarget.targetId,
  });
  const popup = await waitFor(async () => {
    const after = await session.send('Target.getTargets');
    return after.targetInfos.find((candidate) =>
      !before.targetInfos.some((entry) => entry.targetId === candidate.targetId) &&
      candidate.url === `chrome-extension://${extensionId}/popup.html`) ?? null;
  }, 'toolbar action did not open the Drey popup');
  const { sessionId } = await session.send('Target.attachToTarget', {
    targetId: popup.targetId,
    flatten: false,
  });
  await nestedSend(session, sessionId, 'Runtime.enable');
  const evaluated = await nestedSend(session, sessionId, 'Runtime.evaluate', {
    expression: `new Promise((resolve) => {
      const deadline = Date.now() + 10000;
      const finish = () => {
        const text = document.body.innerText;
        const ready = text.includes('SET UP YOUR WALLET') &&
          innerWidth >= 300 && document.body.scrollHeight >= 500;
        if (!ready && Date.now() < deadline) {
          setTimeout(finish, 100);
          return;
        }
        resolve({
          innerWidth,
          innerHeight,
          bodyWidth: document.body.scrollWidth,
          bodyHeight: document.body.scrollHeight,
          clientWidth: document.documentElement.clientWidth,
          clientHeight: document.documentElement.clientHeight,
          text,
        });
      };
      if (document.readyState === 'complete') setTimeout(finish, 100);
      else addEventListener('load', () => setTimeout(finish, 100), { once: true });
    })`,
    awaitPromise: true,
    returnByValue: true,
  });
  const metrics = evaluated.result.value;
  assert.deepEqual(
    {
      innerWidth: metrics.innerWidth,
      innerHeight: metrics.innerHeight,
      bodyWidth: metrics.bodyWidth,
      bodyHeight: metrics.bodyHeight,
      clientWidth: metrics.clientWidth,
      clientHeight: metrics.clientHeight,
    },
    {
      innerWidth: 392,
      innerHeight: 600,
      bodyWidth: 392,
      bodyHeight: 600,
      clientWidth: 392,
      clientHeight: 600,
    },
  );
  for (const text of expectedPopupText) assert.match(metrics.text, new RegExp(text, 'u'));
  await session.send('Target.activateTarget', { targetId: hostTarget.targetId });
  await hostPage.bringToFront();
  await hostPage.mouse.click(20, 20);
  const focusDeadline = Date.now() + 2_000;
  let dismissedByFocus = false;
  while (Date.now() < focusDeadline) {
    const targets = await session.send('Target.getTargets');
    if (!targets.targetInfos.some((entry) => entry.targetId === popup.targetId)) {
      dismissedByFocus = true;
      break;
    }
    await new Promise((resolveDelay) => globalThis.setTimeout(resolveDelay, 100));
  }
  if (!dismissedByFocus) {
    await session.send('Target.closeTarget', { targetId: popup.targetId });
  }
  return {
    width: metrics.innerWidth,
    height: metrics.innerHeight,
    noOverflow: metrics.bodyWidth === metrics.clientWidth && metrics.bodyHeight === metrics.clientHeight,
    dismissal: dismissedByFocus ? 'focus' : 'protocol-cleanup',
  };
}

async function providerState(page, expected) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  const observed = expected
    ? await waitFor(
        () => page.evaluate(() => {
          const candidate = globalThis;
          return Object.prototype.hasOwnProperty.call(candidate, 'drey') &&
            Array.isArray(candidate.btc_providers) &&
            candidate.btc_providers.some((entry) => entry?.id === 'drey');
        }),
        'Drey provider was not injected after installation',
      )
    : await page.evaluate(() => Object.prototype.hasOwnProperty.call(globalThis, 'drey'));
  assert.equal(Boolean(observed), expected);
}

async function openExtensionPage(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForSelector('body');
  const manifest = await page.evaluate(() => globalThis.chrome.runtime.getManifest());
  assert.equal(manifest.name, 'Drey PILOT');
  assert.equal(
    manifest.description,
    'DISPOSABLE MAINNET PILOT — MANUAL SMALL-VALUE SCENARIOS ONLY',
  );
  assert.equal(manifest.minimum_chrome_version, '116');
  assert.deepEqual(manifest.permissions, ['storage', 'alarms', 'idle', 'sidePanel']);
  assert.deepEqual(manifest.side_panel, { default_path: 'sidepanel.html' });
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.deepEqual(manifest.host_permissions, ['https://wallet-api.squirrelsystems.net/*']);
  return page;
}

async function sidePanelSupport(page) {
  return page.evaluate(() => typeof globalThis.chrome.sidePanel?.open === 'function');
}

async function gatewayStatus(page) {
  const response = await page.evaluate(() => globalThis.chrome.runtime.sendMessage({
    protocolVersion: 1,
    requestId: globalThis.crypto.randomUUID(),
    sender: 'popup',
    op: 'gateway.status',
    payload: { forceRefresh: true },
  }));
  assert.equal(response?.ok, true);
  assert.ok(['connected', 'degraded'].includes(response.result.state));
  assert.equal(response.result.network, 'mainnet');
  assert.equal(response.result.walletDataFresh, true);
  assert.equal(response.result.spendingReady, true);
  return {
    state: response.result.state,
    walletDataFresh: response.result.walletDataFresh,
    spendingReady: response.result.spendingReady,
    classificationState: response.result.classificationState,
    tipHeight: response.result.tipHeight,
  };
}

async function storageSet(page, area, key, value) {
  await page.evaluate(
    ({ storageArea, storageKey, storageValue }) =>
      globalThis.chrome.storage[storageArea].set({ [storageKey]: storageValue }),
    { storageArea: area, storageKey: key, storageValue: value },
  );
}

async function storageGet(page, area, key) {
  const result = await page.evaluate(
    ({ storageArea, storageKey }) => globalThis.chrome.storage[storageArea].get(storageKey),
    { storageArea: area, storageKey: key },
  );
  return result[key];
}

async function rebuildPilot() {
  const { stdout, stderr } = await execFileAsync('pnpm', ['build:pilot'], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (!stdout.includes('Built extension') && !stderr.includes('Built extension')) {
    throw new Error('pilot source update did not report a completed build');
  }
  return verifyPilotArtifact();
}

async function reloadExtension(context, session, extensionId) {
  const reloadedId = (await session.send('Extensions.loadUnpacked', { path: artifact })).id;
  assert.equal(reloadedId, extensionId);
  await waitFor(
    async () => (await extensionInfo(session, extensionId))?.enabled === true,
    'Drey was not enabled after source reload',
  );
  return openExtensionPage(context, extensionId);
}

async function runBrowser(definition, dappUrl) {
  await stat(definition.executablePath);
  const profile = await mkdtemp(join(tmpdir(), `drey-pilot-${definition.id}-`));
  const marker = `${definition.id}-${randomUUID()}`;
  let context = null;
  let session = null;
  try {
    context = await launchProfile(profile, definition);
    session = await context.browser().newBrowserCDPSession();
    const extensionId = await installUnpacked(session);
    const hostPage = await context.newPage();
    await hostPage.goto(`${dappUrl}?browser=${definition.id}`, { waitUntil: 'domcontentloaded' });
    await providerState(hostPage, true);
    const firstPopup = await openToolbarPopup(session, extensionId, hostPage);
    const reopenedPopup = await openToolbarPopup(session, extensionId, hostPage);
    const extensionPage = await openExtensionPage(context, extensionId);
    const supportsSidePanel = await sidePanelSupport(extensionPage);
    if (definition.id === 'chrome') {
      assert.equal(supportsSidePanel, true, 'Chrome 116+ must expose chrome.sidePanel.open');
    }
    const initialGateway = await gatewayStatus(extensionPage);
    await storageSet(extensionPage, 'local', localMarkerKey, marker);
    await storageSet(extensionPage, 'session', sessionMarkerKey, marker);
    assert.equal(await storageGet(extensionPage, 'local', localMarkerKey), marker);
    assert.equal(await storageGet(extensionPage, 'session', sessionMarkerKey), marker);
    const browserVersion = context.browser().version();

    await context.close();
    context = await launchProfile(profile, definition);
    session = await context.browser().newBrowserCDPSession();
    let persisted = await extensionInfo(session, extensionId);
    const protocolReloadedAfterRestart = persisted === null;
    if (protocolReloadedAfterRestart) {
      const restartedId = await installUnpacked(session);
      assert.equal(restartedId, extensionId);
      persisted = await extensionInfo(session, extensionId);
    }
    assert(persisted !== null);
    assert.equal(persisted.enabled, true);
    assert.equal(resolve(persisted.path), artifact);
    const restartedExtensionPage = await openExtensionPage(context, extensionId);
    assert.equal(await storageGet(restartedExtensionPage, 'local', localMarkerKey), marker);
    assert.equal(await storageGet(restartedExtensionPage, 'session', sessionMarkerKey), undefined);

    const restartedHost = await context.newPage();
    await restartedHost.goto(`${dappUrl}?browser=${definition.id}&phase=restart`, {
      waitUntil: 'domcontentloaded',
    });
    await providerState(restartedHost, true);
    const restartPopup = await openToolbarPopup(session, extensionId, restartedHost);
    const restartGateway = await gatewayStatus(restartedExtensionPage);

    await storageSet(restartedExtensionPage, 'session', sessionMarkerKey, marker);
    await Promise.all(
      context.pages()
        .filter((page) => page.url().startsWith(`chrome-extension://${extensionId}/`))
        .map((page) => page.close().catch(() => undefined)),
    );
    const updatedArtifact = await rebuildPilot();
    const reloadedExtensionPage = await reloadExtension(context, session, extensionId);
    assert.equal(await storageGet(reloadedExtensionPage, 'local', localMarkerKey), marker);
    assert.equal(await storageGet(reloadedExtensionPage, 'session', sessionMarkerKey), undefined);
    const reloadGateway = await gatewayStatus(reloadedExtensionPage);
    const reloadPopup = await openToolbarPopup(session, extensionId, restartedHost);

    await session.send('Extensions.uninstall', { id: extensionId });
    await waitFor(
      async () => (await extensionInfo(session, extensionId)) === null,
      'Drey remained installed after uninstall',
    );
    await providerState(restartedHost, false);

    const reinstalledId = await installUnpacked(session);
    assert.equal(reinstalledId, extensionId);
    await providerState(restartedHost, true);
    const reinstallPopup = await openToolbarPopup(session, extensionId, restartedHost);
    const reinstalledExtensionPage = await openExtensionPage(context, extensionId);
    assert.equal(await storageGet(reinstalledExtensionPage, 'local', localMarkerKey), undefined);
    assert.equal(await storageGet(reinstalledExtensionPage, 'session', sessionMarkerKey), undefined);
    const reinstallGateway = await gatewayStatus(reinstalledExtensionPage);
    await session.send('Extensions.uninstall', { id: extensionId });

    return {
      browser: definition.label,
      version: browserVersion,
      extensionId,
      artifactContentDigest: updatedArtifact.contentDigest,
      install: 'pass',
      toolbarPopup: {
        first: firstPopup,
        reopenedAfterFocus: reopenedPopup,
        afterRestart: restartPopup,
        afterReload: reloadPopup,
        afterReinstall: reinstallPopup,
      },
      sidePanel: supportsSidePanel
        ? 'supported; real launcher covered by headed packaged E2E'
        : 'unsupported; toolbar popup fallback passed',
      gateway: {
        initial: initialGateway,
        afterRestart: restartGateway,
        afterReload: reloadGateway,
        afterReinstall: reinstallGateway,
      },
      unpackedInstallAcrossRestart: protocolReloadedAfterRestart
        ? 'manual-only: the Chrome debugging loader is session scoped'
        : 'pass',
      localStorageAcrossRestartAndReload: 'pass',
      sessionStorageClearedOnRestartAndReload: 'pass',
      sourceUpdateReload: 'pass',
      providerRemovedOnUninstall: 'pass',
      cleanReinstall: 'pass',
      walletLifecycle: 'manual-only: no wallet was created or restored',
    };
  } finally {
    await context?.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
  }
}

const initialArtifact = await verifyPilotArtifact();
const dapp = await startDapp();
const results = [];
try {
  for (const definition of browserDefinitions) {
    try {
      results.push(await runBrowser(definition, dapp.url));
    } catch (error) {
      if (definition.id === 'brave' && error?.code === 'ENOENT') {
        results.push({
          browser: definition.label,
          install: 'skipped',
          reason: 'Brave is not installed; Chrome remains the required acceptance browser',
        });
        continue;
      }
      throw error;
    }
  }
} finally {
  await dapp.close();
}
const finalArtifact = await verifyPilotArtifact();
assert.equal(finalArtifact.contentDigest, initialArtifact.contentDigest);
process.stdout.write(`${JSON.stringify({
  artifact: {
    path: artifact,
    name: 'Drey PILOT',
    gateway: 'https://wallet-api.squirrelsystems.net',
    contentDigest: finalArtifact.contentDigest,
    manifestSha256: finalArtifact.manifestSha256,
    extensionRevision: finalArtifact.extensionRevision,
    gatewayRevision: finalArtifact.gatewayRevision,
  },
  results,
}, null, 2)}\n`);
