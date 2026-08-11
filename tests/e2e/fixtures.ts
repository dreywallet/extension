import { test as base, chromium, expect, type BrowserContext, type Worker } from '@playwright/test';
import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ApprovalPage, DappPage, ExtensionPage, OnboardingPage, PopupPage } from './pages';
import { writePublicUrCameraVideo } from './synthetic-camera';

const EXTENSION_PATH = process.env['DREY_E2E_EXTENSION_PATH']
  ? path.resolve(process.env['DREY_E2E_EXTENSION_PATH'])
  : path.resolve(import.meta.dirname, '../../.output/test/chrome-mv3');

type TestFixtures = {
  extensionContext: BrowserContext;
  extensionId: string;
  extensionWorker: Worker;
  extensionPage: ExtensionPage;
  popup: PopupPage;
  onboarding: OnboardingPage;
  dapp: DappPage;
};

async function findWorker(context: BrowserContext): Promise<Worker> {
  const existing = context.serviceWorkers().find((worker) => worker.url().startsWith('chrome-extension://'));
  return existing ?? context.waitForEvent('serviceworker', {
    predicate: (worker) => worker.url().startsWith('chrome-extension://'),
    timeout: 15_000,
  });
}

export const test = base.extend<TestFixtures>({
  extensionContext: async ({ browserName }, use, workerInfo) => {
    if (browserName !== 'chromium') throw new Error(`Extension E2E requires Chromium, received ${browserName}`);
    await access(path.join(EXTENSION_PATH, 'manifest.json')).catch(() => {
      throw new Error(
        `Missing ${path.join(EXTENSION_PATH, 'manifest.json')}. Run the test-channel build before Playwright.`,
      );
    });
    const profile = await mkdtemp(path.join(os.tmpdir(), 'drey-e2e-profile-'));
    const cameraVideo = path.join(profile, 'public-ur-camera.y4m');
    await writePublicUrCameraVideo(cameraVideo);
    let context: BrowserContext | null = null;
    try {
      context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium',
        headless: workerInfo.project.use.headless !== false,
        args: [
          `--disable-extensions-except=${EXTENSION_PATH}`,
          `--load-extension=${EXTENSION_PATH}`,
          '--use-fake-device-for-media-stream',
          '--use-fake-ui-for-media-stream',
          `--use-file-for-fake-video-capture=${cameraVideo}`,
        ],
        viewport: { width: 1280, height: 900 },
      });
      await findWorker(context);
      await use(context);
    } finally {
      await context?.close().catch(() => undefined);
      // Browser profiles can contain extension storage and must never become a
      // test artifact, even when a test or browser teardown fails.
      await rm(profile, { recursive: true, force: true });
    }
  },

  extensionId: async ({ extensionContext }, use) => {
    const worker = await findWorker(extensionContext);
    const id = new URL(worker.url()).host;
    if (!/^[a-p]{32}$/u.test(id)) throw new Error(`Unexpected extension ID: ${id}`);
    await use(id);
  },

  context: async ({ extensionContext }, use) => use(extensionContext),

  page: async ({ extensionContext }, use) => {
    const page = await extensionContext.newPage();
    try {
      await use(page);
    } finally {
      await page.close().catch(() => undefined);
    }
  },

  extensionWorker: async ({ extensionContext }, use) => use(await findWorker(extensionContext)),
  extensionPage: async ({ page, extensionContext, extensionId }, use) => {
    await use(new ExtensionPage(page, extensionContext, extensionId));
  },
  popup: async ({ extensionPage }, use) => use(new PopupPage(extensionPage)),
  onboarding: async ({ extensionPage }, use) => use(new OnboardingPage(extensionPage)),
  dapp: async ({ page, extensionContext }, use) => use(new DappPage(page, extensionContext)),
});

export { expect };
export type { ApprovalPage, DappPage, ExtensionPage, OnboardingPage, PopupPage };
