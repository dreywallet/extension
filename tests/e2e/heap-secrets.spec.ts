import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resetGateway } from './gateway';
import { ExtensionPage, OnboardingPage, PopupPage } from './pages';
import { launchInspectableExtensionContext, scanSessionHeap, type NamedSecret } from './heap';

// Read the repository's public vector at runtime so no reporter ever bundles
// even this non-secret mnemonic into report source.
const vectors = JSON.parse(
  readFileSync(new URL('../fixtures/bip39-trezor-vectors.json', import.meta.url), 'utf8'),
) as { english: string[][] };
const PUBLIC_SIGNET_MNEMONIC = vectors.english[0]?.[1] ?? '';
const TEST_PASSWORD = ['public', 'e2e', 'password', 'only'].join('-');

const EXTENSION_PATH = process.env['DREY_E2E_EXTENSION_PATH']
  ? path.resolve(process.env['DREY_E2E_EXTENSION_PATH'])
  : path.resolve(import.meta.dirname, '../../.output/test/chrome-mv3');

// A scanner that silently matches nothing would let this test pass forever.
// The sentinel is planted immediately before each snapshot and asserted to be
// found by the same scan that asserts the secrets are absent, so a broken
// pipeline fails loudly instead of reporting a clean heap.
const SENTINEL_LABEL = 'positive-control sentinel';
const SENTINEL_VALUE = 'drey-heap-scanner-positive-control-a4f1c8';

const SECRETS: readonly NamedSecret[] = [
  { label: SENTINEL_LABEL, value: SENTINEL_VALUE },
  { label: 'public signet fixture recovery phrase', value: PUBLIC_SIGNET_MNEMONIC },
  { label: 'disposable test password', value: TEST_PASSWORD },
];

test.describe('@heap locked-wallet heap hygiene', () => {
  // Restore performs a full account scan, and each heap snapshot adds a GC
  // pause, so this runs well past the default per-test budget.
  test.setTimeout(240_000);

  test('retains no recovery phrase or password in extension memory after lock', async () => {
    expect(PUBLIC_SIGNET_MNEMONIC, 'public BIP39 fixture vector must load').not.toBe('');
    await resetGateway();

    const inspectable = await launchInspectableExtensionContext(EXTENSION_PATH);
    try {
      const { context, extensionId } = inspectable;
      const page = await context.newPage();
      const extension = new ExtensionPage(page, context, extensionId);
      const onboarding = new OnboardingPage(extension);
      const popup = new PopupPage(extension);

      await onboarding.open();
      await onboarding.restorePublicFixture({
        mnemonic: PUBLIC_SIGNET_MNEMONIC,
        password: TEST_PASSWORD,
      });

      await popup.open();
      await popup.lock();
      await expect(page.getByRole('heading', { name: 'Unlock Drey' })).toBeVisible();

      // The MV3 worker is the sole software-wallet authority and holds the
      // unlocked DEK, so it is the heap that matters most. Playwright cannot
      // attach a CDP session to a service worker, hence the DevTools socket.
      const workerSocket = await inspectable.openServiceWorkerSocket();
      const worker = context.serviceWorkers()
        .find((candidate) => candidate.url().startsWith(`chrome-extension://${extensionId}/`));
      expect(worker, 'extension service worker must be live for the heap scan').toBeDefined();
      await worker!.evaluate((sentinel) => {
        (globalThis as Record<string, unknown>)['__dreyHeapScannerProbe'] = sentinel;
      }, SENTINEL_VALUE);
      const workerFindings = await workerSocket.scanHeap(SECRETS);
      expect(
        workerFindings,
        'service-worker heap must retain only the sentinel after lock',
      ).toEqual([SENTINEL_LABEL]);

      // The same renderer previously hosted the onboarding document where the
      // phrase and password were typed. A detached document must not keep them
      // reachable after navigation and lock.
      const pageSession = await context.newCDPSession(page);
      try {
        await page.evaluate((sentinel) => {
          (window as unknown as Record<string, unknown>)['__dreyHeapScannerProbe'] = sentinel;
        }, SENTINEL_VALUE);
        const pageFindings = await scanSessionHeap(pageSession, SECRETS);
        expect(
          pageFindings,
          'extension page heap must retain only the sentinel after lock',
        ).toEqual([SENTINEL_LABEL]);
      } finally {
        await pageSession.detach().catch(() => undefined);
      }
    } finally {
      await inspectable.dispose();
    }
  });
});
