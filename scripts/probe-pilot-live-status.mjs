import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const pilotOutputRoot = resolve(root, process.env.DREY_BUILD_OUTPUT_ROOT?.trim() || '.output');
const artifact = join(pilotOutputRoot, 'chrome-mv3');
const metadataPath = join(pilotOutputRoot, 'm8t-channel.json');

function integerOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

const samples = integerOption('--samples', 24);
const intervalMs = integerOption('--interval-ms', 2_000);
const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
if (metadata.channel !== 'pilot' || metadata.disposableMainnetPilot !== true ||
    metadata.network !== 'mainnet' || metadata.liveGatewayEnabled !== true) {
  throw new Error('refusing to probe an output that is not the disposable live mainnet pilot');
}

const profile = await mkdtemp(join(tmpdir(), 'drey-pilot-live-status-'));
let context;
let sawConnected = false;
let contradictoryFreshness = false;
let awaitingFreshRecovery = false;

try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${artifact}`,
      `--load-extension=${artifact}`,
    ],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', {
    predicate: (candidate) => candidate.url().startsWith('chrome-extension://'),
    timeout: 15_000,
  });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);

  for (let sample = 1; sample <= samples; sample += 1) {
    const response = await page.evaluate(() => globalThis.chrome.runtime.sendMessage({
      protocolVersion: 1,
      requestId: globalThis.crypto.randomUUID(),
      sender: 'popup',
      op: 'gateway.status',
      payload: { forceRefresh: true },
    }));
    if (response?.ok !== true) throw new Error(`gateway.status RPC failed at sample ${sample}`);
    const view = response.result;
    sawConnected ||= view.state === 'connected' || view.state === 'degraded';
    contradictoryFreshness ||= view.spendingReady === true && view.walletDataFresh !== true;
    if (view.walletDataFresh === false) awaitingFreshRecovery = true;
    else if (view.walletDataFresh === true) awaitingFreshRecovery = false;
    process.stdout.write(`${JSON.stringify({
      sample,
      state: view.state,
      walletDataFresh: view.walletDataFresh,
      spendingReady: view.spendingReady,
      classificationState: view.classificationState,
      tipHeight: view.tipHeight,
      lastReason: view.lastReason,
    })}\n`);
    if (sample < samples) {
      await new Promise((resolveDelay) => globalThis.setTimeout(resolveDelay, intervalMs));
    }
  }
} finally {
  await context?.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true });
}

if (contradictoryFreshness) {
  throw new Error('pilot reported stale local freshness while the signed gateway declared spending ready');
}
if (!sawConnected) throw new Error('pilot never reached a connected state during the live probe');
if (awaitingFreshRecovery) throw new Error('pilot did not recover fresh wallet data before the live probe ended');
process.stdout.write('live pilot status probe passed\n');
