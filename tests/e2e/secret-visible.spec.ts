import { test, expect } from './fixtures';
import type { ConsoleMessage, Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import {
  galleryBatchAttempts,
  galleryBatchRequests,
  gatewayState,
  resetGateway,
  setGatewayScenario,
  statusAttempts,
} from './gateway';
import { ExtensionPage, fillPrivate, PopupPage } from './pages';
import { terminateExtensionWorker, wakeExtensionWorker } from './worker';

// Read the repository's public vector at runtime so Playwright's HTML reporter
// never bundles even this non-secret mnemonic into report source.
const vectors = JSON.parse(readFileSync(new URL('../fixtures/bip39-trezor-vectors.json', import.meta.url), 'utf8')) as {
  english: string[][];
};
const PUBLIC_SIGNET_MNEMONIC = vectors.english[0]?.[1] ?? '';
const TEST_PASSWORD = ['public', 'e2e', 'password', 'only'].join('-');
// Public, unfunded signet Mobile B origin from tests/fixtures/vault-peer-signers.ts.
const PUBLIC_MOBILE_B_ORIGIN_HEX =
  '5351564201010101de5b636e0000000e6d2f3438272f31272f30272f32270000006f' +
  '7470756244456b71425042416b574a613178515168576459793864624e4c474c5572' +
  '6f68456e476f666178516175556d35576d7a764a674a4364543472574d7035484852' +
  '646375366547794b6b677641446347727166337434766e7244695233367862653650' +
  '565a43476436635132';

/** Count opaque durable-preview slots without exposing their keys or contents. */
async function durablePreviewRecordCount(page: Page): Promise<number> {
  return page.evaluate(() => new Promise<number>((resolve, reject) => {
    const open = indexedDB.open('drey-wallet-cache', 1);
    open.onerror = () => reject(open.error ?? new Error('wallet cache open failed'));
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction('records', 'readonly').objectStore('records').getAllKeys();
      request.onerror = () => reject(request.error ?? new Error('wallet cache read failed'));
      request.onsuccess = () => {
        const count = request.result.filter((key) => {
          const parts = key as [string, string, string, string];
          return parts[2] === 'gallery' && parts[3].startsWith('preview-item:');
        }).length;
        db.close();
        resolve(count);
      };
    };
  }));
}

async function openFirstGalleryShelf(page: Page): Promise<void> {
  const shelf = page.locator('[data-gallery-collection]').first();
  await expect(shelf).toBeVisible({ timeout: 30_000 });
  await shelf.click();
  await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();
}

test.beforeEach(async () => {
  await resetGateway();
});

test('@m9x abandoned gallery work does not block a reopened Home', async ({
  onboarding, popup, extensionContext, extensionId,
}, testInfo) => {
  await setGatewayScenario({ snapshotScenario: 'mixed' });
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
  });
  await popup.open();
  await expect(popup.page.getByTestId('balance-card').getByText('60,000 sats'))
    .toBeVisible({ timeout: 30_000 });
  await expect(popup.page.getByText('20,000 sats')).toBeVisible();
  await expect(popup.page.getByTestId('home-collectibles')).toBeVisible();
  await popup.page.getByRole('button', { name: 'Ordinals', exact: true }).click();
  const refresh = popup.page.getByRole('button', { name: 'Refresh' });
  await expect(refresh).toBeEnabled({ timeout: 30_000 });
  const before = await galleryBatchAttempts();
  await setGatewayScenario({ galleryBatchDelayMs: 5_000, statusDelayMs: 5_000 });
  await refresh.click();
  await expect.poll(async () => galleryBatchAttempts(), { timeout: 30_000 })
    .toBeGreaterThan(before);
  const startedRequests = await galleryBatchAttempts();
  const statusesBeforeReopen = await statusAttempts();
  // Force the reopened shell and the live Home calculation to revalidate.
  // The session-bound Home snapshot must paint while that request is held.
  await popup.page.evaluate(() => chrome.storage.session.remove('squirrel:gatewayStatus'));
  await popup.page.close();

  const reopen = async (): Promise<number> => {
    const page = await extensionContext.newPage();
    const reopened = new PopupPage(new ExtensionPage(page, extensionContext, extensionId));
    const startedAt = performance.now();
    await reopened.open();
    await expect(reopened.page.getByTestId('balance-card').getByText('60,000 sats'))
      .toBeVisible({ timeout: 2_000 });
    await expect(reopened.page.getByText('20,000 sats')).toBeVisible();
    await expect(reopened.page.getByTestId('home-collectibles')).toBeVisible();
    await expect(
      reopened.page.getByTestId('home-collectibles-carousel').locator('iframe').first(),
    ).toBeVisible({ timeout: 2_000 });
    const elapsed = performance.now() - startedAt;
    await reopened.page.close();
    return elapsed;
  };
  const firstReopenMs = await reopen();
  const secondReopenMs = await reopen();
  const attemptsWhileDetached = await galleryBatchAttempts();
  const statusesWhileDetached = await statusAttempts();

  testInfo.annotations.push({
    type: 'measurement',
    description: JSON.stringify({ firstReopenMs, secondReopenMs, startedRequests,
      attemptsWhileDetached, statusesBeforeReopen, statusesWhileDetached }),
  });
  expect(firstReopenMs).toBeLessThan(2_000);
  expect(secondReopenMs).toBeLessThan(2_000);
  expect(attemptsWhileDetached).toBe(startedRequests);
  expect(statusesWhileDetached).toBeGreaterThan(statusesBeforeReopen);
});

test('@m9x keeps Home paint through an unavailable reopen and explicit recovery', async ({
  onboarding, popup, extensionContext, extensionId,
}) => {
  test.slow();
  await setGatewayScenario({ snapshotScenario: 'mixed' });
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
  });
  await popup.open();
  const homeRaster = popup.page.getByTestId('home-collectibles-carousel').locator('iframe').first();
  await expect(homeRaster).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => durablePreviewRecordCount(popup.page), { timeout: 30_000 })
    .toBeGreaterThan(0);
  await popup.page.close();

  await setGatewayScenario({ gatewayMode: 'unavailable' });
  const page = await extensionContext.newPage();
  const reopened = new PopupPage(new ExtensionPage(page, extensionContext, extensionId));
  await reopened.open();
  const reopenedCarousel = reopened.page.getByTestId('home-collectibles-carousel');
  const retainedRaster = reopenedCarousel.locator('iframe').first();
  await expect(retainedRaster).toBeVisible({ timeout: 2_000 });
  const retainedTitle = await retainedRaster.getAttribute('title');
  expect(retainedTitle).not.toBeNull();
  await reopened.page.waitForTimeout(1_500);
  await expect(reopenedCarousel.locator(`iframe[title="${retainedTitle!}"]`)).toBeVisible();

  // A failed automatic gallery load deliberately parks until the user's
  // existing explicit Refresh action. Recovery must not require another popup
  // reopen, and Home paint must stay intact throughout the unavailable window.
  await setGatewayScenario({ gatewayMode: 'healthy' });
  await reopened.page.getByRole('button', { name: /View all/u }).click();
  const refresh = reopened.page.getByRole('button', { name: 'Refresh' });
  await expect(refresh).toBeEnabled({ timeout: 10_000 });
  const beforeRecovery = await galleryBatchAttempts();
  await refresh.click();
  await expect.poll(() => galleryBatchAttempts(), { timeout: 30_000 })
    .toBeGreaterThan(beforeRecovery);
  await expect(refresh).toBeEnabled({ timeout: 30_000 });
  await reopened.page.getByRole('button', { name: 'Bitcoin', exact: true }).click();
  await expect(reopened.page.getByTestId('home-collectibles-carousel').locator('iframe').first())
    .toBeVisible({ timeout: 10_000 });
  await page.close();
});

test('@visual captures privacy-audited Drey 0.7.0 release surfaces', async ({
  onboarding,
  popup,
  extensionContext,
  extensionId,
}) => {
  await setGatewayScenario({ gatewayMode: 'full', snapshotScenario: 'mixed' });
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
    name: 'Drey test wallet',
  });

  const output = 'test-results/e2e/release-0.7.0';
  mkdirSync(output, { recursive: true });
  await popup.open();
  await expect(popup.page.getByText('Available to send')).toBeVisible();
  await expect(popup.page.getByText('60,000 sats').first()).toBeVisible();
  await expect(popup.page.getByText('20,000 sats')).toBeVisible();
  await expect(popup.page.getByText('Received', { exact: true })).toBeVisible();
  await expect(popup.page.getByRole('button', { name: 'Review protected sats' })).toHaveCount(0);
  await popup.page.locator('#root > *').screenshot({
    path: `${output}/ui-home-source.png`,
    animations: 'disabled',
  });

  await popup.page.getByRole('button', { name: /Bitcoin set aside from regular sends/u }).click();
  const review = popup.page.getByRole('button', { name: 'Review protected sats' });
  await expect(review).toBeVisible();
  const reviewPagePromise = extensionContext.waitForEvent('page');
  await review.click();
  const reviewPage = await reviewPagePromise;
  await reviewPage.waitForURL(`chrome-extension://${extensionId}/fullpage.html#/send/utxos`);
  await expect(reviewPage.getByRole('heading', { name: 'Manage coins' })).toBeVisible();
  await expect(reviewPage.getByText('Loading your coins…')).toHaveCount(0, { timeout: 15_000 });
  await expect(reviewPage.getByText('Protected', { exact: true })).toBeVisible();
  await reviewPage.getByText('Protected', { exact: true }).click();
  const inscriptionPreview = reviewPage.getByRole('button', { name: /^Enlarge .*inscription/iu }).first();
  await expect(inscriptionPreview).toBeVisible({ timeout: 15_000 });
  await reviewPage.screenshot({
    path: `${output}/ui-protected-sats-source.png`,
    animations: 'disabled',
    fullPage: true,
  });
  await inscriptionPreview.click();
  const previewDialog = reviewPage.getByRole('dialog', { name: /inscription/iu });
  await expect(previewDialog).toBeVisible();
  await expect(previewDialog.locator('iframe')).toBeVisible();
  await expect(reviewPage.frameLocator('section[role="dialog"] iframe').getByRole('img'))
    .toBeVisible();
  await reviewPage.screenshot({
    path: `${output}/ui-protected-sats-preview-source.png`,
    animations: 'disabled',
  });
  await reviewPage.close();
});

test('reassembles public animated UR frames through the real extension camera surface', async ({
  onboarding,
  extensionPage,
}) => {
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
  });
  await extensionPage.goto('fullpage.html#/settings/vault');
  await expect(extensionPage.page.getByRole('heading', { name: 'Drey Vault' }))
    .toBeVisible();

  await extensionPage.page.getByRole('button', { name: 'Create Desktop role' }).click();
  await fillPrivate(extensionPage.page.getByLabel('App password'), TEST_PASSWORD);
  await extensionPage.page.getByRole('button', { name: 'Create Desktop role' }).click();
  await expect(extensionPage.page.getByRole('heading', {
    name: 'Next: connect your other two roles',
  })).toBeVisible();

  await extensionPage.page.getByRole('button', { name: 'Start setup' }).click();
  await expect(extensionPage.page.getByRole('heading', { name: 'Connect Mobile B' })).toBeVisible();
  await extensionPage.page.getByText('Technical details and manual entry').click();
  await extensionPage.page.getByLabel('Signer record from the other device')
    .fill(PUBLIC_MOBILE_B_ORIGIN_HEX);
  await fillPrivate(extensionPage.page.getByLabel('App password'), TEST_PASSWORD);
  await extensionPage.page.getByRole('button', { name: 'Create pairing QR' }).click();
  await extensionPage.page.getByRole('button', { name: 'Scan Mobile B response 1 of 2' }).click();
  await extensionPage.page.getByRole('button', { name: 'Start camera' }).click();

  await expect(extensionPage.page.getByText(
    'Vault QR reconstructed and verified.',
  )).toBeVisible({ timeout: 20_000 });
  await expect(extensionPage.page.getByRole('progressbar')).toHaveAttribute('value', '5');
  await expect(extensionPage.page.getByRole('progressbar')).toHaveAttribute('max', '5');
  await expect(extensionPage.page.getByLabel('Signer record from the other device'))
    .toHaveValue(PUBLIC_MOBILE_B_ORIGIN_HEX);
  await expect(extensionPage.page.getByLabel('Proof of possession from the other device')).toHaveValue('');
});

async function expectPopupResultFitsViewport(page: Page, headingName: string): Promise<void> {
  const heading = page.getByRole('heading', { name: headingName });
  await expect(heading).toBeVisible();
  await expect.poll(() => heading.evaluate((element) => {
    const popup = document.querySelector('#root')?.firstElementChild;
    const main = document.querySelector('main');
    const result = element.closest('section');
    if (!(popup instanceof HTMLElement) || !(main instanceof HTMLElement) ||
        !(result instanceof HTMLElement)) return null;
    const popupRect = popup.getBoundingClientRect();
    const mainRect = main.getBoundingClientRect();
    const resultRect = result.getBoundingClientRect();
    return {
      popupWidth: Math.round(popupRect.width),
      popupHeight: Math.round(popupRect.height),
      noVerticalScroll: main.scrollHeight <= main.clientHeight,
      verticalOverflow: Math.max(0, main.scrollHeight - main.clientHeight),
      resultWithinMain: resultRect.bottom <= mainRect.bottom + 1,
      noHorizontalOverflow:
        document.documentElement.scrollWidth <= window.innerWidth &&
        document.body.scrollWidth <= window.innerWidth &&
        result.scrollWidth <= result.clientWidth,
    };
  })).toEqual({
    popupWidth: 392,
    popupHeight: 600,
    noVerticalScroll: true,
    verticalOverflow: 0,
    resultWithinMain: true,
    noHorizontalOverflow: true,
  });
}

test('@visual keeps inscription composer and accepted receipt compact at popup scale', async ({
  onboarding,
  popup,
}) => {
  await setGatewayScenario({ snapshotScenario: 'mixed' });
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
  });
  await popup.open();
  await popup.page.getByRole('button', { name: 'Ordinals', exact: true }).click();
  await openFirstGalleryShelf(popup.page);
  const target = popup.page.locator('article').filter({ hasText: '#1236' });
  await target.getByRole('button', { name: 'Send' }).click();
  await expect(popup.page.getByRole('heading', { name: 'Send inscription' })).toBeVisible();
  await expect(popup.page.getByText(
    'Choose the destination. Postage is set automatically and protected inscriptions stay separated.',
  )).toHaveCount(0);
  const recipient = popup.page.getByLabel('Recipient address');
  await recipient.fill('tb1q053ptqlv0ugz8fcc3njw355rdluk4tqnhf0g0j');
  await expect.poll(() => recipient.evaluate(() => ({
    popupWidth:
      Math.round(document.querySelector('#root')?.firstElementChild?.getBoundingClientRect().width ?? 0),
    popupHeight:
      Math.round(document.querySelector('#root')?.firstElementChild?.getBoundingClientRect().height ?? 0),
    noHorizontalOverflow:
      document.documentElement.scrollWidth <= window.innerWidth &&
      document.body.scrollWidth <= window.innerWidth,
  }))).toEqual({
    popupWidth: 392,
    popupHeight: 600,
    noHorizontalOverflow: true,
  });
  await popup.page.locator('#root > *').screenshot({
    path: 'test-results/e2e/ordinal-send-composer.masked.png',
    animations: 'disabled',
    mask: [recipient],
    maskColor: '#303030',
  });

  await popup.page.getByRole('button', { name: 'Review transaction' }).click();
  await expect(popup.page.getByRole('heading', { name: 'Send this inscription?' })).toBeVisible();
  await popup.page.getByLabel(/valid address on the correct network.*not a Taproot address/iu).check();
  await popup.page.getByLabel(/verified the inscription identifier and transaction effects/iu).check();
  await popup.page.getByRole('button', { name: 'Send inscription' }).click();

  await expectPopupResultFitsViewport(popup.page, 'Inscription sent');
  await expect(popup.page.getByText('Destination')).toBeVisible();
  await expect(popup.page.getByText('tb1q053ptqlv0ugz8fcc3njw355rdluk4tqnhf0g0j'))
    .toHaveAttribute('title', 'tb1q053ptqlv0ugz8fcc3njw355rdluk4tqnhf0g0j');
  await expect(popup.page.getByRole('link', {
    name: /View transaction on mempool\.space/u,
  })).toBeVisible();
  await expect(popup.page.getByRole('button', { name: 'Done' })).toBeVisible();
  const resultSection = popup.page.getByRole('heading', {
    name: 'Inscription sent',
  }).locator('xpath=ancestor::section[1]');
  await popup.page.locator('#root > *').screenshot({
    path: 'test-results/e2e/ordinal-transfer-result-compact.masked.png',
    animations: 'disabled',
    mask: [
      resultSection.locator('code'),
      resultSection.locator('[title]'),
    ],
    maskColor: '#303030',
  });
});

test('keeps password setup stable until the requirements are met', async ({ onboarding }) => {
  await onboarding.open();
  await onboarding.page.getByRole('button', { name: /Create a new wallet/u }).click();
  const password = onboarding.page.getByLabel('App password', { exact: true });
  const confirm = onboarding.page.getByLabel('Confirm app password');
  const continueButton = onboarding.page.getByRole('button', { name: 'Continue' });
  await expect(continueButton).toBeDisabled();
  await expect(onboarding.page.getByText(/at least 12 characters/iu)).toBeVisible();

  const actionPosition = async (): Promise<{ cardHeight: number; top: number }> =>
    continueButton.evaluate((button) => ({
      cardHeight: button.closest('div[class*="card"]')?.getBoundingClientRect().height ?? 0,
      top: button.parentElement?.getBoundingClientRect().top ?? 0,
    }));
  const initial = await actionPosition();

  await fillPrivate(password, 'a-long-password');
  await fillPrivate(confirm, 'a-different-password');
  await expect(onboarding.page.getByRole('status')).toHaveText('Passwords do not match.');
  await expect(continueButton).toBeDisabled();
  expect(await actionPosition()).toEqual(initial);

  await fillPrivate(password, 'password1234');
  await fillPrivate(confirm, 'password1234');
  await expect(onboarding.page.getByRole('status')).toContainText(/can continue/iu);
  await expect(continueButton).toBeEnabled();
  expect(await actionPosition()).toEqual(initial);
});

test('creates a disposable wallet and enforces backup verification', async ({
  onboarding, popup, extensionContext, extensionId,
}) => {
  await onboarding.open();
  await onboarding.createDisposable({ password: TEST_PASSWORD, reviewPhrase: true });

  await popup.open();
  const lockButton = popup.page.getByRole('button', { name: 'Lock' });
  await expect(lockButton).toBeVisible();
  await lockButton.focus();
  await expect.poll(async () => lockButton.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      hasInsetFocus: style.boxShadow.includes('inset'),
      outlineStyle: style.outlineStyle,
    };
  })).toEqual({ hasInsetFocus: true, outlineStyle: 'none' });
  await popup.lock();
  await expect(popup.page.getByText('Available to send')).toHaveCount(0);
  await expect(popup.page.getByRole('button', { name: 'Send' })).toHaveCount(0);
  await terminateExtensionWorker(extensionContext, extensionId);
  await wakeExtensionWorker(popup.page, extensionId);
  await expect(popup.page.getByRole('heading', { name: 'Unlock Drey' })).toBeVisible();
  await expect(popup.page.getByText('Available to send')).toHaveCount(0);
  const password = popup.page.getByLabel('App password');
  await password.click();
  await popup.page.keyboard.press('Tab');
  await popup.page.keyboard.press('Shift+Tab');
  await expect(password).toBeFocused();
  await expect.poll(async () => password.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderColor: style.borderColor,
      outlineStyle: style.outlineStyle,
    };
  })).toEqual({
    borderColor: 'rgb(244, 244, 239)',
    outlineStyle: 'none',
  });
  await popup.unlock(TEST_PASSWORD);
});

test('resumes a durable scan checkpoint after worker termination', async ({
  onboarding, extensionContext, extensionId,
}) => {
  await setGatewayScenario({ snapshotDelayMs: 250 });
  await onboarding.open();
  await onboarding.beginRestorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
    name: 'Public checkpoint fixture',
  });
  await expect(onboarding.page.getByRole('progressbar', { name: 'Account scan' })).toBeVisible();

  await terminateExtensionWorker(extensionContext, extensionId);
  await expect(onboarding.page.getByText('An account scan was interrupted.')).toBeVisible({ timeout: 15_000 });
  await setGatewayScenario({ snapshotDelayMs: 0 });
  await onboarding.page.getByRole('button', { name: 'Resume scan' }).click();
  await onboarding.finishRestoreScan();
});

test('renders the restored wallet home at compact popup scale', async ({
  onboarding,
  popup,
  extensionContext,
  extensionId,
}) => {
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
  });

  await popup.open();
  await expect(popup.page.getByText('Available to send')).toBeVisible();
  await popup.page.getByRole('button', { name: 'Receive' }).click();
  await expect(popup.page.getByRole('img', { name: 'QR code for your receive address' }))
    .toBeVisible();
  await popup.page.getByRole('button', { name: 'Close' }).click();
  await popup.page.getByRole('button', { name: 'Ordinals', exact: true }).click();
  await openFirstGalleryShelf(popup.page);
  await expect(popup.page.locator('article')).toHaveCount(1);
  expect(await popup.page.locator('article').evaluate((card) => {
    const grid = card.parentElement?.getBoundingClientRect();
    const bounds = card.getBoundingClientRect();
    return grid !== undefined &&
      Math.abs(bounds.left + bounds.width / 2 - (grid.left + grid.width / 2)) <= 1;
  })).toBe(true);
  await popup.page.getByRole('button', { name: 'Bitcoin', exact: true }).click();
  await popup.lock();
  await popup.page.evaluate(() => {
    document.body.dataset['sawTransientIndexLag'] = 'false';
    const recordIndexLag = (): void => {
      if (document.body.textContent?.includes('Syncing')) {
        document.body.dataset['sawTransientIndexLag'] = 'true';
      }
    };
    new MutationObserver(recordIndexLag).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  await popup.unlock(TEST_PASSWORD);
  await popup.page.waitForTimeout(2_500);
  expect(await popup.page.evaluate(
    () => document.body.dataset['sawTransientIndexLag'],
  )).toBe('false');
  await expect(popup.page.getByText(/Unavailable: rare-sat detection/u)).toBeVisible();
  const protectedDisclosure = popup.page.getByRole('button', { name: /Bitcoin set aside from regular sends/u });
  await expect(protectedDisclosure).toHaveAttribute('aria-expanded', 'false');
  await protectedDisclosure.click();
  await expect(popup.page.getByText(/outputs carrying protected assets or collectibles/u))
    .toBeVisible();
  const reviewProtectedSats = popup.page.getByRole('button', { name: 'Review protected sats' });
  await expect(reviewProtectedSats).toBeVisible();
  const reviewPagePromise = extensionContext.waitForEvent('page');
  await reviewProtectedSats.click();
  const reviewPage = await reviewPagePromise;
  await reviewPage.waitForURL(
    `chrome-extension://${extensionId}/fullpage.html#/send/utxos`,
  );
  await expect(reviewPage.getByRole('heading', { name: 'Manage coins' })).toBeVisible();
  await reviewPage.getByRole('button', { name: 'Activity' }).click();
  await reviewPage.waitForURL(
    `chrome-extension://${extensionId}/fullpage.html#/send/activity`,
  );
  await expect(reviewPage.getByRole('heading', { name: 'Transaction activity' })).toBeVisible();
  await expect(reviewPage.getByText('Your transaction history will appear here.')).toHaveCount(0);
  const firstActivity = reviewPage.locator('details').first();
  await expect(firstActivity.getByRole('link', { name: 'View transaction on mempool.space' }))
    .toBeHidden();
  await firstActivity.locator('summary').click();
  await expect(
    firstActivity.getByRole('link', { name: 'View transaction on mempool.space' }),
  ).toBeVisible();
  const blockTrail = firstActivity.getByRole('region', { name: 'Current transaction status' });
  await expect(blockTrail).toContainText('Detected in wallet');
  await expect(blockTrail).toContainText('Seen by network');
  await expect(blockTrail).toContainText('Confirmed');
  const trailGeometry = await blockTrail.locator('li').evaluateAll((steps) => steps.map((step) => {
    const marker = step.firstElementChild?.getBoundingClientRect();
    const copy = step.lastElementChild?.getBoundingClientRect();
    const bounds = step.getBoundingClientRect();
    return {
      copyBackground: step.lastElementChild === null
        ? null
        : getComputedStyle(step.lastElementChild).backgroundColor,
      copyBelowMarker: marker !== undefined && copy !== undefined && copy.top >= marker.bottom,
      noHorizontalOverflow: step.scrollWidth <= step.clientWidth,
      width: bounds.width,
      x: bounds.x,
      y: bounds.y,
    };
  }));
  expect(trailGeometry).toHaveLength(3);
  expect(trailGeometry.every(({ copyBackground }) => copyBackground === 'rgba(0, 0, 0, 0)'))
    .toBe(true);
  expect(trailGeometry.every(({ copyBelowMarker, noHorizontalOverflow, width }) =>
    copyBelowMarker && noHorizontalOverflow && width >= 160)).toBe(true);
  expect(trailGeometry[0]!.x).toBeLessThan(trailGeometry[1]!.x);
  expect(trailGeometry[1]!.x).toBeLessThan(trailGeometry[2]!.x);
  const trailY = trailGeometry.map(({ y }) => y);
  expect(Math.max(...trailY) - Math.min(...trailY)).toBeLessThanOrEqual(1);
  await reviewPage.goto(`chrome-extension://${extensionId}/fullpage.html#/settings`);
  await expect(reviewPage.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await reviewPage.goto(`chrome-extension://${extensionId}/fullpage.html#/settings/recovery`);
  await expect(reviewPage.getByRole('heading', { name: 'Recovery center' })).toBeVisible();
  await reviewPage.close();
  await expect(popup.page.getByRole('button', { name: 'Copy Bitcoin address' })).toBeVisible();
  await expect(popup.page.getByRole('button', { name: 'Copy Ordinals address' })).toBeVisible();
  await popup.page.getByRole('button', { name: 'Active account' }).click();
  const accountMenu = popup.page.getByRole('menu', { name: 'Active account' });
  await expect(accountMenu).toBeVisible();
  await expect(accountMenu.getByRole('menuitemradio')).toHaveCount(1);
  await expect(accountMenu.getByRole('menuitemradio', { name: 'Account 1' }))
    .toHaveAttribute('aria-checked', 'true');
  await expect(accountMenu.getByRole('menuitem', { name: 'Add account' })).toBeEnabled();
  await expect.poll(() => accountMenu.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderTopWidth: style.borderTopWidth,
      position: style.position,
    };
  })).toEqual({
    backgroundColor: 'rgb(16, 16, 16)',
    borderTopWidth: '2px',
    position: 'absolute',
  });
  await accountMenu.getByRole('menuitemradio', { name: 'Account 1' }).press('Escape');
  await expect(accountMenu).toHaveCount(0);
  const layout = await popup.page.evaluate(() => {
    const balanceLabel = [...document.querySelectorAll('span')]
      .find((element) => element.textContent === 'Available to send');
    const rectHeight = (element: Element | null | undefined) =>
      element?.getBoundingClientRect().height ?? null;
    const rectWidth = (element: Element | null | undefined) =>
      element?.getBoundingClientRect().width ?? null;
    const main = document.querySelector('main');
    const navigation = document.querySelector('nav');
    const navigationBefore = navigation?.getBoundingClientRect();
    if (main instanceof HTMLElement) main.scrollTop = main.scrollHeight;
    const navigationAfter = navigation?.getBoundingClientRect();
    const lastContent = main?.lastElementChild?.getBoundingClientRect();
    const mainRect = main?.getBoundingClientRect();
    const iconControls = [...document.querySelectorAll('header button, nav button')].map((control) => {
      const rect = control.getBoundingClientRect();
      return {
        height: rect.height,
        name: control.getAttribute('aria-label') ?? control.textContent?.trim(),
        width: rect.width,
      };
    });
    const header = document.querySelector('header')?.getBoundingClientRect();
    const account =
      document.querySelector('header button[aria-label="Active account"]')?.getBoundingClientRect();
    const serviceStatus =
      document.querySelector('header [data-header-control="gateway-status"]')?.getBoundingClientRect();
    const settings = document.querySelector('header button[aria-label="Settings"]')?.getBoundingClientRect();
    const lock = document.querySelector('header button[aria-label="Lock"]')?.getBoundingClientRect();
    return {
      balanceHeight: rectHeight(balanceLabel?.parentElement),
      balancePrivacyAlignment: (() => {
        const control = document.querySelector('button[aria-label="Hide balances"]')
          ?.getBoundingClientRect();
        const quickAddresses = document.querySelector('[aria-label="Receive addresses"]')
          ?.getBoundingClientRect();
        const labelRange = document.createRange();
        if (balanceLabel !== undefined) labelRange.selectNodeContents(balanceLabel);
        const label = balanceLabel === undefined ? undefined : labelRange.getBoundingClientRect();
        const card = balanceLabel?.parentElement?.getBoundingClientRect();
        return control !== undefined && label !== undefined && card !== undefined
          ? {
              contained:
                control.top >= card.top && control.right <= card.right &&
                control.bottom <= card.bottom,
              labelClearance: control.left - label.right,
              shortcutClearance:
                quickAddresses === undefined ? null : quickAddresses.left - control.right,
              borderColor: getComputedStyle(
                document.querySelector('button[aria-label="Hide balances"]')!,
              ).borderColor,
              topOffset: control.top - card.top,
            }
          : null;
      })(),
      displayFontLoaded: document.fonts.check('16px "Anton"'),
      documentFitsViewport: document.documentElement.scrollHeight <= window.innerHeight,
      headerHeight: rectHeight(document.querySelector('header')),
      headerAlignment:
        header !== undefined && account !== undefined && serviceStatus !== undefined
          ? {
              leftInset: account.left - header.left,
              middleGap: serviceStatus.left - account.right,
              rightInset: header.right - serviceStatus.right,
            }
          : null,
      headerControlGaps:
        settings !== undefined && lock !== undefined && serviceStatus !== undefined
          ? [
              lock.left + lock.width / 2 - (settings.left + settings.width / 2),
              serviceStatus.left + serviceStatus.width / 2 - (lock.left + lock.width / 2),
            ]
          : null,
      iconControls,
      lastContentReachable:
        lastContent !== undefined && mainRect !== undefined && lastContent.bottom <= mainRect.bottom + 1,
      mainOverflowY: main === null ? null : getComputedStyle(main).overflowY,
      navigationBottomStable:
        navigationBefore !== undefined && navigationAfter !== undefined &&
        navigationBefore.bottom === navigationAfter.bottom,
      navigationHeight: rectHeight(navigation),
      noHorizontalOverflow:
        document.documentElement.scrollWidth <= window.innerWidth &&
        document.body.scrollWidth <= window.innerWidth,
      popupWidth: rectWidth(document.querySelector('#root')?.firstElementChild),
      statusHeight: rectHeight(document.querySelector('main > [role="status"]')),
    };
  });
  expect(layout.popupWidth).toBe(392);
  expect(layout.displayFontLoaded).toBe(true);
  expect(layout.headerHeight).toBeLessThanOrEqual(108);
  expect(layout.headerAlignment).not.toBeNull();
  expect(layout.headerAlignment?.leftInset).toBeCloseTo(16, 0);
  expect(layout.headerAlignment?.rightInset).toBeCloseTo(16, 0);
  expect(layout.headerAlignment?.middleGap).toBeGreaterThan(0);
  expect(layout.headerControlGaps).not.toBeNull();
  expect(layout.headerControlGaps?.[0]).toBeCloseTo(layout.headerControlGaps?.[1] ?? 0, 0);
  expect(layout.statusHeight).toBeLessThanOrEqual(65);
  expect(layout.balanceHeight).toBeLessThanOrEqual(135);
  expect(layout.balancePrivacyAlignment).not.toBeNull();
  expect(layout.balancePrivacyAlignment?.contained).toBe(true);
  expect(layout.balancePrivacyAlignment?.borderColor).toBe('rgba(0, 0, 0, 0)');
  expect(layout.balancePrivacyAlignment?.labelClearance).toBeGreaterThanOrEqual(8);
  expect(layout.balancePrivacyAlignment?.shortcutClearance).toBeGreaterThanOrEqual(4);
  expect(layout.balancePrivacyAlignment?.topOffset).toBeGreaterThanOrEqual(12);
  expect(layout.balancePrivacyAlignment?.topOffset).toBeLessThanOrEqual(16);
  expect(layout.documentFitsViewport).toBe(true);
  expect(layout.mainOverflowY).toBe('auto');
  expect(layout.navigationHeight).toBe(56);
  expect(layout.navigationBottomStable).toBe(true);
  expect(layout.noHorizontalOverflow).toBe(true);
  expect(layout.lastContentReachable).toBe(true);
  expect(layout.iconControls.map(({ name }) => name)).toEqual([
    'Active account', 'Open in side panel', 'Settings', 'Lock',
    'Bitcoin', 'Ordinals', 'Activity',
  ]);
  expect(layout.iconControls.every(({ height, width }) => height >= 40 && width >= 40)).toBe(true);

  const hideBalances = popup.page.getByRole('button', { name: 'Hide balances' });
  const balanceHeightBeforePrivacy = await popup.page.getByText('Available to send')
    .locator('..')
    .evaluate((card) => card.getBoundingClientRect().height);
  await hideBalances.click();
  await expect(popup.page.getByRole('button', { name: 'Show balances' }))
    .toHaveAttribute('aria-pressed', 'true');
  const hiddenBalanceLayout = await popup.page.getByText('Available to send')
    .locator('..')
    .evaluate((card) => ({
      height: card.getBoundingClientRect().height,
      noHorizontalOverflow: card.scrollWidth <= card.clientWidth,
    }));
  expect(hiddenBalanceLayout).toEqual({
    height: balanceHeightBeforePrivacy,
    noHorizontalOverflow: true,
  });
  await popup.page.getByRole('button', { name: 'Show balances' }).click();
  await expect(popup.page.getByRole('button', { name: 'Hide balances' }))
    .toHaveAttribute('aria-pressed', 'false');

  await popup.page.locator('main').evaluate((main) => {
    main.scrollTop = 0;
  });
  const copyBitcoin = popup.page.getByRole('button', { name: 'Copy Bitcoin address' });
  await copyBitcoin.click();
  await expect(popup.page.getByText('Bitcoin address copied')).toBeVisible();
  expect(await copyBitcoin.evaluate((element) => getComputedStyle(element).outlineStyle))
    .toBe('none');

  const pageCount = extensionContext.pages().length;
  await popup.page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(popup.page.getByRole('heading', { name: 'Send Bitcoin' })).toBeVisible();
  await expect(popup.page.getByLabel('Amount (BTC)')).toBeVisible();
  await expect(popup.page.getByRole('button', { name: 'Open send in full page' })).toBeVisible();
  const feeGroup = popup.page.getByRole('group', { name: 'Network fee' });
  const quotedFeeRows = feeGroup.locator('label').filter({ hasText: 'sat/vB' });
  await expect(quotedFeeRows).toHaveCount(3);
  await expect(feeGroup).not.toContainText('best effort');
  await expect(feeGroup).not.toContainText('about');
  const feeLayout = await feeGroup.locator('label').evaluateAll((labels) =>
    labels.slice(0, 3).map((label) => {
      const rect = label.getBoundingClientRect();
      return {
        height: rect.height,
        noHorizontalOverflow: label.scrollWidth <= label.clientWidth,
        rateLines: label.lastElementChild?.getClientRects().length ?? 0,
      };
    }));
  expect(feeLayout).toHaveLength(3);
  expect(feeLayout.every(({ height }) => height <= 32)).toBe(true);
  expect(feeLayout.every(({ noHorizontalOverflow }) => noHorizontalOverflow)).toBe(true);
  expect(feeLayout.every(({ rateLines }) => rateLines === 1)).toBe(true);
  expect(extensionContext.pages()).toHaveLength(pageCount);
  await popup.page.getByRole('button', { name: 'Back' }).click();

  await popup.page.getByRole('button', { name: 'Activity' }).click();
  const activityLink = popup.page.getByRole('link').filter({ hasText: '+123,456 sats' });
  await expect(activityLink).toBeVisible();
  await expect(activityLink).toHaveAttribute(
    'href',
    /^https:\/\/mempool\.space\/signet\/tx\/[0-9a-f]{64}$/u,
  );
  await expect(popup.page.getByText('Your transaction history will appear here.')).toHaveCount(0);
});

test('resumes a failed visible-wallet refresh and replaces stale cached activity', async ({
  onboarding, popup,
}) => {
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
  });
  await popup.open();
  await expect(popup.page.getByText('205,556 sats')).toBeVisible();

  // Let the mount-triggered refresh settle, then force the next refresh to
  // fail after changing the signed wallet scenario. Healing plus another
  // focus must resume the checkpoint and replace the old cache.
  await popup.page.waitForTimeout(5_000);
  const snapshotAttempts = async (): Promise<number> => {
    const state = await gatewayState() as { snapshotAttempts?: unknown };
    return typeof state.snapshotAttempts === 'number' ? state.snapshotAttempts : -1;
  };
  const beforeFailure = await snapshotAttempts();
  await setGatewayScenario({
    gatewayMode: 'unavailable',
    snapshotScenario: 'wrong_lane_inscription_at_payment',
  });
  await popup.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(snapshotAttempts).toBeGreaterThan(beforeFailure);

  await setGatewayScenario({ gatewayMode: 'healthy' });
  await popup.page.waitForTimeout(250);
  const beforeRecovery = await snapshotAttempts();
  await popup.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(snapshotAttempts).toBeGreaterThan(beforeRecovery);
  await expect(popup.page.getByText('90,000 sats', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(popup.page.getByText(
    'Drey found 1 coin holding a collectible at a Bitcoin address.',
  )).toBeVisible();
});

test('updates one incoming payment from pending to confirmed after hide and resume', async ({
  onboarding, popup, extensionContext,
}) => {
  await setGatewayScenario({ snapshotScenario: 'incoming_mempool' });
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
  });
  await popup.open();
  await popup.page.getByRole('button', { name: 'Activity' }).click();

  const snapshotAttempts = async (): Promise<number> => {
    const state = await gatewayState() as { snapshotAttempts?: unknown };
    return typeof state.snapshotAttempts === 'number' ? state.snapshotAttempts : -1;
  };
  const payment = popup.page.getByRole('link').filter({ hasText: '+10,000 sats' });
  await expect(payment).toHaveCount(1);
  await expect(payment).toContainText('Pending');
  await popup.page.getByRole('button', { name: 'Bitcoin' }).click();
  await expect(popup.page.getByText('Pending confirmation').locator('../..'))
    .toContainText('10,000 sats');
  await expect(
    popup.page.getByText('Included in your balance; spendable after confirmation'),
  ).toBeVisible();
  await expect(popup.page.getByText('Bitcoin balance').locator('..'))
    .toContainText('10,000 sats');
  await expect(popup.page.getByText('Available now').locator('..')).toContainText('0 sats');
  await expect(popup.page.getByText('Set aside', { exact: true }))
    .toHaveCount(0);
  await popup.page.getByRole('button', { name: 'Activity' }).click();

  const away = await extensionContext.newPage();
  try {
    await away.goto('http://127.0.0.1:4173/');
    await away.bringToFront();
    await setGatewayScenario({ snapshotScenario: 'incoming_confirmed' });
    const beforeConfirmed = await snapshotAttempts();
    await away.close();
    await popup.page.bringToFront();
    await expect.poll(() => popup.page.evaluate(() => document.visibilityState)).toBe('visible');
    // Chromium's headless persistent context can become visible without
    // delivering the paired visibility/focus event. Emit that resume edge only
    // after the real extension page is visible.
    await popup.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(snapshotAttempts).toBeGreaterThan(beforeConfirmed);
    await expect(payment).toHaveCount(1);
    await expect(payment).not.toContainText('Pending');

    await popup.page.getByRole('button', { name: 'Bitcoin' }).click();
    const balanceCard = popup.page.getByText('Available to send').locator('..');
    await expect(balanceCard).toContainText('10,000 sats');
    const recentPayment = popup.page.getByRole('link').filter({ hasText: '+10,000 sats' });
    await expect(recentPayment).toHaveCount(1);
    await expect(recentPayment).not.toContainText('Pending');
  } finally {
    await away.close().catch(() => undefined);
  }
});

test('labels a signed sat-flow-verified mempool inscription as a pending Ordinal', async ({
  onboarding, popup, extensionContext,
}) => {
  await setGatewayScenario({ snapshotScenario: 'incoming_ordinal_mempool' });
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
  });
  await popup.open();

  const pendingOrdinal = popup.page.getByText('Pending Ordinal', { exact: true }).first().locator('../..');
  await expect(pendingOrdinal).toContainText('546 sats');
  await expect(popup.page.getByText('Verification completes after confirmation')).toBeVisible();
  await expect(popup.page.getByText('Pending confirmation')).toHaveCount(0);
  await expect(popup.page.getByText('Available to send').locator('..')).toContainText('0 sats');
  await expect(popup.page.getByText('Set aside', { exact: true }))
    .toHaveCount(0);
  await expect(popup.page.getByTestId('home-collectibles-count')).toHaveText('0');

  await popup.page.getByRole('button', { name: 'Ordinals', exact: true }).click();
  await openFirstGalleryShelf(popup.page);
  const pendingCard = popup.page.locator('article').filter({ hasText: '#1234' });
  await expect(pendingCard).toBeVisible();
  await expect(pendingCard).toContainText('Pending confirmation');
  await expect(pendingCard).toContainText('Preview pending confirmation');
  await expect(pendingCard.getByRole('button', { name: 'Send' })).toBeDisabled();
  await expect(pendingCard).not.toContainText('Asset verification is out of date');
  await pendingCard.getByText('Why unavailable?').click();
  await expect(pendingCard).toContainText(
    'This inscription is in an unconfirmed Bitcoin transaction. Drey will finish verification after the first confirmation. No action is needed.',
  );

  await popup.page.getByRole('button', { name: 'Activity' }).click();
  const activity = popup.page.getByRole('link').filter({ hasText: 'Inscription received' });
  await expect(activity).toHaveCount(1);
  await expect(activity).not.toContainText('Postage');
  await expect(activity).toContainText('Pending Ordinal');
  // Leave the pending card mounted. Returning focus should quietly start the
  // confirmation scan without requiring the gallery's Refresh button.
  await popup.page.getByRole('button', { name: 'Ordinals', exact: true }).click();
  await openFirstGalleryShelf(popup.page);
  await expect(pendingCard).toBeVisible();

  const snapshotAttempts = async (): Promise<number> => {
    const state = await gatewayState() as { snapshotAttempts?: unknown };
    return typeof state.snapshotAttempts === 'number' ? state.snapshotAttempts : -1;
  };
  const away = await extensionContext.newPage();
  try {
    await away.goto('http://127.0.0.1:4173/');
    await away.bringToFront();
    await setGatewayScenario({ snapshotScenario: 'incoming_ordinal_confirmed' });
    const beforeConfirmed = await snapshotAttempts();
    await away.close();
    await popup.page.bringToFront();
    await expect.poll(() => popup.page.evaluate(() => document.visibilityState)).toBe('visible');
    await popup.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(snapshotAttempts).toBeGreaterThan(beforeConfirmed);
    await expect(pendingCard).not.toContainText('Pending confirmation', { timeout: 30_000 });
    await expect(pendingCard.getByRole('button', { name: 'Send' })).toBeEnabled({
      timeout: 30_000,
    });
    await expect(pendingCard).not.toContainText('Preview pending confirmation');
    await popup.page.getByRole('button', { name: 'Bitcoin' }).click();
    await expect(popup.page.getByText('Pending Ordinal', { exact: true })).toHaveCount(0);
    await expect(popup.page.getByText('Set aside', { exact: true }).locator('..'))
      .toContainText('546 sats');
    await expect(popup.page.getByTestId('home-collectibles-count')).toHaveText('1');
  } finally {
    if (!away.isClosed()) await away.close();
  }
});

test('keeps refreshing after returning until stale gateway data becomes fresh', async ({
  onboarding, popup, extensionContext, extensionId,
}) => {
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
  });

  // Normal convergence uses the balance card's existing metadata row, so
  // publishing and clearing the status must not move the card or the row after it.
  await setGatewayScenario({ gatewayMode: 'full' });
  await popup.page.evaluate(() => chrome.storage.session.remove('squirrel:gatewayStatus'));
  await terminateExtensionWorker(extensionContext, extensionId);
  await popup.open();
  await expect(popup.page.getByLabel('Connected')).toBeVisible();
  const balanceCard = popup.page.getByTestId('balance-card');
  const readBalanceLayout = () => balanceCard.evaluate((card) => {
    const cardRect = card.getBoundingClientRect();
    const followingRect = card.nextElementSibling?.getBoundingClientRect();
    return {
      top: cardRect.top,
      height: cardRect.height,
      followingTop: followingRect === undefined ? null : followingRect.top,
    };
  });
  const healthyLayout = await readBalanceLayout();

  await setGatewayScenario({ gatewayMode: 'converging' });
  await popup.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(popup.page.getByText('Syncing', { exact: true }))
    .toBeVisible({ timeout: 15_000 });
  expect(await readBalanceLayout()).toEqual(healthyLayout);

  await setGatewayScenario({ gatewayMode: 'full' });
  await popup.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(popup.page.getByText('Syncing', { exact: true })).toHaveCount(0, {
    timeout: 6_000,
  });
  expect(await readBalanceLayout()).toEqual(healthyLayout);

  // A stale heartbeat is not normal index convergence, so it surfaces
  // immediately even if the backend recovers shortly afterward.
  await setGatewayScenario({ gatewayMode: 'stale' });
  await onboarding.page.evaluate(() => chrome.storage.session.remove('squirrel:gatewayStatus'));
  await terminateExtensionWorker(extensionContext, extensionId);
  await popup.open();
  await expect(popup.page.getByLabel('Out of date')).toBeVisible();
  await popup.page.waitForTimeout(1_500);
  await setGatewayScenario({ gatewayMode: 'healthy' });
  await expect(popup.page.getByLabel('Standard Ordinals Safety')).toBeVisible({ timeout: 6_000 });
  await expect(popup.page.getByLabel('Out of date')).toHaveCount(0);

  // A sustained stale condition is still surfaced after the bounded grace.
  await setGatewayScenario({ gatewayMode: 'stale' });
  await popup.page.evaluate(() => chrome.storage.session.remove('squirrel:gatewayStatus'));
  await terminateExtensionWorker(extensionContext, extensionId);
  await popup.open();
  await expect(popup.page.getByLabel('Out of date')).toBeVisible({ timeout: 10_000 });
  await expect(popup.page.getByText(/Wallet data is out of date/iu)).toBeVisible();

  const away = await extensionContext.newPage();
  try {
    await away.goto('http://127.0.0.1:4173/');
    await away.bringToFront();
    await popup.page.bringToFront();

    // Keep the gateway stale through the first quick retry. Recovery must not
    // then wait for the ordinary 15-second polling interval.
    await popup.page.waitForTimeout(2_500);
    await setGatewayScenario({ gatewayMode: 'healthy' });
    await expect(popup.page.getByLabel('Standard Ordinals Safety'))
      .toBeVisible({ timeout: 6_000 });
    await expect(popup.page.getByLabel('Out of date')).toHaveCount(0);
  } finally {
    await away.close().catch(() => undefined);
  }
});

test('restores the public fixture, persists privacy, and exercises provider approvals', async ({
  onboarding, popup, dapp, extensionContext, extensionId,
}) => {
  expect(await gatewayState()).toMatchObject({ gatewayMode: 'healthy' });
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
  });

  await popup.open();
  await expect(popup.page.getByRole('button', { name: 'Lock' })).toBeVisible();
  const visualConsoleErrors: string[] = [];
  const recordVisualConsoleError = (message: ConsoleMessage): void => {
    if (message.type() === 'error' && /Content Security Policy|Failed to load resource|Refused to load/iu.test(message.text())) {
      visualConsoleErrors.push(message.text());
    }
  };
  popup.page.on('console', recordVisualConsoleError);
  await popup.page.getByRole('button', { name: 'Receive' }).click();
  await expect(popup.page.getByText(/Signet/u)).toBeVisible();
  const bitcoinQr = popup.page.getByRole('img', { name: 'QR code for your receive address' });
  await expect(bitcoinQr).toBeVisible();
  const bitcoinQrVisual = await bitcoinQr.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const parentBounds = element.parentElement?.getBoundingClientRect();
    const path = element.querySelector('path')?.getAttribute('d') ?? '';
    const pathFingerprint = [...path].reduce(
      (fingerprint, character) => (fingerprint * 31 + character.charCodeAt(0)) >>> 0,
      0,
    );
    return {
      centered: parentBounds !== undefined &&
        Math.abs(bounds.left + bounds.width / 2 - (parentBounds.left + parentBounds.width / 2)) <= 1,
      height: bounds.height,
      pathFingerprint,
      pathLength: path.length,
      shapeRendering: element.getAttribute('shape-rendering'),
      tagName: element.tagName.toLowerCase(),
      width: bounds.width,
    };
  });
  expect(bitcoinQrVisual).toEqual({
    centered: true,
    height: 180,
    pathFingerprint: expect.any(Number),
    pathLength: expect.any(Number),
    shapeRendering: 'crispEdges',
    tagName: 'svg',
    width: 180,
  });
  expect(bitcoinQrVisual.pathLength).toBeGreaterThan(100);
  await popup.page.locator('#root > *').screenshot({
    path: 'test-results/e2e/receive-qr-first.png',
    animations: 'disabled',
  });

  await popup.page.getByLabel('Amount (sats, optional)').fill('250000');
  const paymentLinkFingerprint = await bitcoinQr.locator('path').getAttribute('d').then((path) =>
    [...(path ?? '')].reduce(
      (fingerprint, character) => (fingerprint * 31 + character.charCodeAt(0)) >>> 0,
      0,
    ));
  expect(paymentLinkFingerprint).not.toBe(bitcoinQrVisual.pathFingerprint);

  await popup.page.getByRole('radio', { name: 'Ordinals' }).click();
  await expect(popup.page.getByText(/inscriptions and protected sats/u)).toBeVisible();
  await expect(bitcoinQr).toBeVisible();
  const ordinalsFingerprint = await bitcoinQr.locator('path').getAttribute('d').then((path) =>
    [...(path ?? '')].reduce(
      (fingerprint, character) => (fingerprint * 31 + character.charCodeAt(0)) >>> 0,
      0,
    ));
  expect(ordinalsFingerprint).not.toBe(paymentLinkFingerprint);
  const receiveVisualHealth = await popup.page.evaluate(() => {
    const main = document.querySelector('main');
    const brokenImages = [...document.images]
      .filter((image) => image.complete && image.naturalWidth === 0)
      .map((image) => image.alt || 'unnamed image');
    const clippedButtons = [...document.querySelectorAll('button')]
      .filter((button) => button.getClientRects().length > 0 && button.scrollWidth > button.clientWidth + 1)
      .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? 'unnamed button');
    const lastContent = main?.lastElementChild?.getBoundingClientRect();
    const mainRect = main?.getBoundingClientRect();
    if (main instanceof HTMLElement) main.scrollTop = main.scrollHeight;
    const lastContentAfterScroll = main?.lastElementChild?.getBoundingClientRect();
    return {
      brokenImages,
      clippedButtons,
      dataOrBlobImages: document.querySelectorAll('img[src^="data:"], img[src^="blob:"]').length,
      lastContentInitiallyKnown: lastContent !== undefined && mainRect !== undefined,
      lastContentReachable:
        lastContentAfterScroll !== undefined && mainRect !== undefined &&
        lastContentAfterScroll.bottom <= mainRect.bottom + 1,
      noHorizontalOverflow:
        document.documentElement.scrollWidth <= window.innerWidth &&
        document.body.scrollWidth <= window.innerWidth &&
        (main === null || main.scrollWidth <= main.clientWidth),
    };
  });
  popup.page.off('console', recordVisualConsoleError);
  expect(visualConsoleErrors).toEqual([]);
  expect(receiveVisualHealth).toEqual({
    brokenImages: [],
    clippedButtons: [],
    dataOrBlobImages: 0,
    lastContentInitiallyKnown: true,
    lastContentReachable: true,
    noHorizontalOverflow: true,
  });
  await popup.page.getByRole('button', { name: 'Close' }).click();

  await terminateExtensionWorker(extensionContext, extensionId);
  await wakeExtensionWorker(popup.page, extensionId);
  await expect(popup.page.getByRole('button', { name: 'Lock' })).toBeVisible();

  await dapp.open();
  const denied = await dapp.invokeWithApproval('Connect');
  await denied.expectMethod('wallet_connect');
  await denied.reject();
  await expect(dapp.output()).toContainText('User rejected');

  const approved = await dapp.invokeWithApproval('Connect');
  await approved.expectMethod('wallet_connect');
  await approved.approve();
  await expect(dapp.output()).toContainText('"network"');

  await dapp.invoke('Account');
  await expect(dapp.output()).toContainText('"walletType": "software"');
  await dapp.invoke('Network');
  await expect(dapp.output()).toContainText('Signet');
  await dapp.invoke('Addresses');
  await expect(dapp.output()).toContainText('"purpose": "payment"');
  await dapp.invoke('Balance');
  await expect(dapp.output()).toContainText('"confirmed"');
  await dapp.invoke('Unknown flexible marketplace');
  // Since the §21.1 generic listing, an unknown flexible request is no longer
  // refused by origin: it proceeds to core analysis and fails closed there —
  // this fixture's inputs cannot be classified, so wallet data cannot be made
  // current. A
  // flexible PSBT never reaches approval without proven listing invariants.
  await expect(dapp.output()).toContainText('Wallet data is not current');
  await expect(dapp.output()).toContainText('-32009');
  await dapp.invoke('Same-document navigate');
  await expect(dapp.output()).toContainText('"providerAvailable": true');
  await dapp.invoke('Permissions');
  await expect(dapp.output()).toContainText('account');

  const signed = await dapp.invokeWithApproval('Sign BIP322');
  await signed.expectMethod('signMessage');
  await signed.approve({ password: TEST_PASSWORD });
  await expect(dapp.output()).toContainText('"protocol": "BIP322"');

  const sent = await dapp.invokeWithApproval('Send transfer');
  await sent.expectMethod('sendTransfer');
  await sent.approve({ password: TEST_PASSWORD });
  await expect(dapp.output()).toContainText('txid', { timeout: 20_000 });

  await terminateExtensionWorker(extensionContext, extensionId);
  await dapp.invoke('Permissions');
  await expect(dapp.output()).toContainText('account');

  // A full navigation creates a new Chrome document ID and must not inherit
  // the prior document's connection, even though the origin grant remains.
  await dapp.page.reload();
  await expect.poll(() => dapp.page.evaluate(() => Boolean((window as Window & { drey?: unknown }).drey)))
    .toBe(true);
  await dapp.invoke('Permissions');
  await expect(dapp.output()).toHaveText('[]');

  // The exact data grant survives, but approved address purposes are bound to
  // one browser document. A full navigation therefore requires a new purpose
  // review even when the signed security list allows the origin.
  const reconnected = await dapp.invokeWithApproval('Connect');
  await reconnected.expectMethod('wallet_connect');
  await reconnected.approve();
  await expect(dapp.output()).toContainText('"walletType": "software"');

  await dapp.invoke('Disconnect');
  await expect(dapp.output()).toHaveText('null');
  await dapp.invoke('Permissions');
  await expect(dapp.output()).toHaveText('[]');

  const fullpage = await extensionContext.newPage();
  try {
    await fullpage.goto(`chrome-extension://${extensionId}/fullpage.html#/send`);
    await expect(fullpage.getByRole('heading', { name: 'Send Bitcoin' })).toBeVisible();

    const planNativeSend = async (): Promise<void> => {
      await fullpage.getByLabel('Recipient address or BIP-321 URI')
        .fill('tb1q053ptqlv0ugz8fcc3njw355rdluk4tqnhf0g0j');
      await fullpage.getByLabel('Amount (BTC)').fill('0.00001');
      await fullpage.getByRole('button', { name: 'Review transaction' }).click();
      await expect(fullpage.getByRole('heading', { name: 'Review transaction' })).toBeVisible();
    };

    await planNativeSend();
    await fullpage.getByRole('button', { name: 'Cancel' }).click();
    await expect(fullpage.getByRole('heading', { name: 'Send Bitcoin' })).toBeVisible();
    await planNativeSend();

    await setGatewayScenario({ broadcastMode: 'recoverable' });
    await terminateExtensionWorker(extensionContext, extensionId);
    await fillPrivate(fullpage.getByLabel('Confirm app password'), TEST_PASSWORD);
    await fullpage.getByRole('button', { name: 'Sign and broadcast' }).click();
    await expect(fullpage.getByRole('heading', { name: 'Broadcast outcome unknown' })).toBeVisible();
    await expect(fullpage.getByText(
      'Broadcast state is unknown. The signed transaction is saved and will not be resubmitted automatically.',
    )).toBeVisible();

    await terminateExtensionWorker(extensionContext, extensionId);
    await fullpage.getByLabel('Wallet navigation')
      .getByRole('button', { name: 'Activity' })
      .click();
    const collapsedRecoveryWarning = fullpage.locator('summary').getByText(
      'Broadcast outcome needs manual reconciliation. Refreshing does not resubmit.',
    );
    await expect(collapsedRecoveryWarning).toBeVisible();
    await fullpage.getByRole('button', { name: 'Refresh status' }).click();
    await expect(collapsedRecoveryWarning).toBeVisible();

    await setGatewayScenario({ broadcastMode: 'accepted' });
    await fullpage.getByRole('button', { name: 'Send' }).click();
    await expect(fullpage.getByRole('heading', { name: 'Broadcast outcome unknown' }))
      .toBeVisible();
    await fullpage.goto(`chrome-extension://${extensionId}/fullpage.html#/settings`);
    await expect(fullpage.getByRole('radio', { name: 'White' })).toHaveAttribute('aria-checked', 'true');
    await fullpage.getByRole('radio', { name: 'Green' }).click();
    await expect(fullpage.getByRole('radio', { name: 'Green' })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => fullpage.evaluate(() => ({
      accent: getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim(),
      warning: getComputedStyle(document.documentElement).getPropertyValue('--color-warning').trim(),
    }))).toEqual({ accent: '#d6f962', warning: '#ff9818' });
    await fullpage.getByRole('radio', { name: 'Español' }).click();
    await expect(fullpage.getByRole('heading', { name: 'Ajustes' })).toBeVisible();
    await popup.open();
    await expect(popup.page.getByRole('button', { name: 'Actividad' })).toBeVisible();
    const spanishNavigationFits = await popup.page.locator('nav button').evaluateAll((buttons) =>
      buttons.every((button) => button.scrollWidth <= button.clientWidth),
    );
    expect(spanishNavigationFits).toBe(true);
    await fullpage.getByRole('radio', { name: 'English' }).click();
    await expect(fullpage.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await fullpage.goto(
      `chrome-extension://${extensionId}/fullpage.html#/settings/wallets-accounts`,
    );
    await expect(fullpage.getByRole('heading', { name: 'Wallets & accounts' })).toBeVisible();
    const activeAccount = fullpage.getByRole('button', { name: 'Active account' });
    await expect(activeAccount).toContainText('Account 1');
    await activeAccount.click();
    const settingsAccountMenu = fullpage.getByRole('menu', { name: 'Active account' });
    await expect(settingsAccountMenu.getByRole('menuitemradio', { name: 'Account 1' }))
      .toHaveAttribute('aria-checked', 'true');
    await settingsAccountMenu.getByRole('menuitem', { name: 'Add account' }).click();
    await expect(fullpage.getByRole('button', { name: 'Active account' }))
      .toContainText('Account 2');
    await activeAccount.click();
    const reopenedAccountMenu = fullpage.getByRole('menu', { name: 'Active account' });
    await reopenedAccountMenu.getByRole('menuitem', { name: 'Add account' }).click();
    await expect(reopenedAccountMenu.getByText('Create another empty account?')).toBeVisible();
    await expect(reopenedAccountMenu.getByText(/Some other wallets may stop at the first empty account/iu))
      .toBeVisible();
    await reopenedAccountMenu.getByRole('button', { name: 'Cancel' }).click();
    await expect(reopenedAccountMenu.getByText('Create another empty account?')).toHaveCount(0);
    await reopenedAccountMenu.getByRole('menuitem', { name: 'Add account' }).click();
    await reopenedAccountMenu.getByRole('button', { name: 'Create account' }).click();
    await expect(fullpage.getByRole('button', { name: 'Active account' }))
      .toContainText('Account 3');
  } finally {
    await fullpage.close();
  }

  await popup.open();
  await expect.poll(() => popup.page.evaluate(() => ({
    accent: getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim(),
    selected: document.documentElement.dataset['accent'],
    warning: getComputedStyle(document.documentElement).getPropertyValue('--color-warning').trim(),
  }))).toEqual({ accent: '#d6f962', selected: 'green', warning: '#ff9818' });

  async function expectGatewayFailure(mode: 'wrong-network' | 'invalid-signature'): Promise<void> {
    await setGatewayScenario({ gatewayMode: mode });
    await popup.open();
    await popup.page.evaluate(() => chrome.storage.session.remove('squirrel:gatewayStatus'));
    await terminateExtensionWorker(extensionContext, extensionId);
    await popup.open();
    await expect(popup.page.getByLabel('Unreachable')).toBeVisible();
  }

  await setGatewayScenario({ gatewayMode: 'stale' });
  await popup.open();
  await popup.page.evaluate(() => chrome.storage.session.remove('squirrel:gatewayStatus'));
  await terminateExtensionWorker(extensionContext, extensionId);
  await popup.open();
  await expect(popup.page.getByLabel('Out of date')).toBeVisible({ timeout: 10_000 });
  await expect(popup.page.getByText(/Wallet data is out of date/iu)).toBeVisible();
  await expectGatewayFailure('wrong-network');
  await expectGatewayFailure('invalid-signature');
  await setGatewayScenario({ gatewayMode: 'unavailable' });
  await popup.open();
  await popup.page.evaluate(() => chrome.storage.session.remove('squirrel:gatewayStatus'));
  await terminateExtensionWorker(extensionContext, extensionId);
  await popup.open();
  await expect(popup.page.getByText(/Unreachable|Cannot reach/u).first()).toBeVisible();
});

test('invalidates an approval that outlives its worker', async ({
  onboarding, dapp, extensionContext, extensionId,
}) => {
  await onboarding.open();
  await onboarding.restorePublicFixture({ mnemonic: PUBLIC_SIGNET_MNEMONIC, password: TEST_PASSWORD });
  await dapp.open();
  const approval = await dapp.invokeWithApproval('Connect');
  await approval.expectMethod('wallet_connect');

  await terminateExtensionWorker(extensionContext, extensionId);
  await expect.poll(() => approval.page.isClosed()).toBe(true);
  await dapp.page.reload();
  await expect.poll(() => dapp.page.evaluate(() => Boolean((window as Window & { drey?: unknown }).drey)))
    .toBe(true);
  await expect(dapp.output()).not.toContainText('addresses');
});

test('@m9p reviews signed inert inscription previews and fails closed across mismatch and worker restart', async ({
  onboarding, popup, dapp, extensionContext, extensionId,
}) => {
  await setGatewayScenario({ snapshotScenario: 'mixed' });
  await onboarding.open();
  await onboarding.restorePublicFixture({ mnemonic: PUBLIC_SIGNET_MNEMONIC, password: TEST_PASSWORD });
  const rasterId = '06fc3a9a3ed60a75c7ded7a1c8370be2d95d2faaa921d1fea6c361819dd3a12bi0';
  const placeholderId = 'a3dda701aba3c35f2660886f1b5db9349117e99cdd44d33a78fc9883583a2b43i0';
  const distinctRasterId = 'aa7f08676c67bb5cab1871bb34abb66440d7d99db81aadf2c38f9220f82ca5d1i0';

  await popup.open();
  await popup.page.getByRole('button', { name: 'Ordinals', exact: true }).click();
  await expect(popup.page.getByRole('tab', { name: 'All (3)' })).toBeVisible();
  await expect(popup.page.getByRole('tab', { name: 'Hidden (0)' })).toBeVisible();
  await openFirstGalleryShelf(popup.page);
  const firstGalleryCard = popup.page.locator('article').filter({ hasText: '#1234' });
  await expect(firstGalleryCard).toBeVisible();
  const cardTopBeforeRefresh = await firstGalleryCard.evaluate(
    (card) => Math.round(card.getBoundingClientRect().top),
  );
  await setGatewayScenario({ snapshotScenario: 'mixed', snapshotDelayMs: 250 });
  const galleryRefresh = popup.page.getByRole('button', { name: 'Refresh' });
  await galleryRefresh.click();
  await expect(galleryRefresh).toHaveText('Checking…');
  await expect(popup.page.getByText('Checking your wallet for Ordinals…')).toHaveCount(0);
  await expect.poll(() => firstGalleryCard.evaluate(
    (card) => Math.round(card.getBoundingClientRect().top),
  )).toBe(cardTopBeforeRefresh);
  await expect(galleryRefresh).toBeEnabled({ timeout: 15_000 });
  await expect(popup.page.getByRole('button', { name: 'Back' })).toBeVisible();
  const galleryRaster = popup.page.frameLocator(`iframe[title="Inert preview for inscription ${rasterId}"]`);
  await expect(galleryRaster.getByRole('img', { name: `Inert preview for inscription ${rasterId}` })).toBeVisible();
  const fullpage = await extensionContext.newPage();
  try {
    await fullpage.goto(`chrome-extension://${extensionId}/fullpage.html#/send/activity`);
    const activityRaster = fullpage.frameLocator(
      `iframe[title="Inert preview for inscription ${rasterId}"]`,
    );
    await expect(activityRaster.getByRole('img', {
      name: `Inert preview for inscription ${rasterId}`,
    })).toBeVisible();
  } finally {
    await fullpage.close();
  }
  const rasterCard = popup.page.locator('article').filter({ hasText: '#1234' });
  const placeholderCard = popup.page.locator('article').filter({ hasText: '#1235' });
  const distinctCard = popup.page.locator('article').filter({ hasText: '#1236' });
  await expect(rasterCard.getByRole('button', { name: 'Send' })).toBeDisabled();
  await expect(placeholderCard.getByRole('button', { name: 'Send' })).toBeDisabled();
  await expect(distinctCard.getByRole('button', { name: 'Send' })).toBeEnabled();
  // The placeholder has no raster, so it never offers a viewer to open. Its
  // identifiers must therefore be readable from the card itself, or they are
  // unreachable from the popup entirely.
  await expect(placeholderCard.getByRole('button', { name: 'Open media' })).toHaveCount(0);
  await expect(placeholderCard.getByText(placeholderId)).toBeHidden();
  await placeholderCard.getByText('Why unavailable?').click();
  await expect(placeholderCard.getByText(placeholderId)).toBeVisible();
  await expect(placeholderCard.getByText('Satpoint')).toBeVisible();
  await expect(placeholderCard.getByText('Current outpoint')).toBeVisible();
  await placeholderCard.getByText('Why unavailable?').click();
  await distinctCard.getByRole('button', { name: 'Send' }).click();
  await expect(popup.page.getByRole('heading', { name: 'Send inscription' })).toBeVisible();
  await expect(popup.page.getByText(
    'Choose the destination. Postage is set automatically and protected inscriptions stay separated.',
  )).toHaveCount(0);
  await expect(popup.page.getByText("You're sending")).toBeVisible();
  await expect(popup.page.getByText(distinctRasterId)).toBeHidden();
  await popup.page.getByText('Technical details').click();
  await expect(popup.page.getByText(distinctRasterId)).toBeVisible();
  await expect(popup.page.getByLabel('Recipient address')).toBeVisible();
  await popup.page.getByRole('button', { name: 'Back' }).click();
  await expect(popup.page.getByRole('tab', { name: 'All (3)' })).toBeVisible();
  await openFirstGalleryShelf(popup.page);
  await rasterCard.getByRole('button', { name: 'Open media' }).click();
  await expect(popup.page.getByRole('dialog', { name: 'Sandboxed inscription media' })).toBeVisible();
  const galleryMedia = popup.page.frameLocator('iframe[title="Sandboxed inscription media"]');
  await expect(galleryMedia.getByRole('img', {
    name: `Verified media for inscription ${rasterId}`,
  })).toBeVisible();
  // The identifiers sit below the image and outside the sandbox frame: the
  // popup renders them, the opaque-origin frame above never receives them.
  const viewer = popup.page.getByRole('dialog', { name: 'Sandboxed inscription media' });
  await expect(viewer.getByText(rasterId)).toBeVisible();
  await expect(viewer.getByText('Inscription ID')).toBeVisible();
  await popup.page.getByRole('button', { name: 'Close' }).click();
  await expect(popup.page.getByRole('dialog', { name: 'Sandboxed inscription media' })).toHaveCount(0);
  await popup.page.getByRole('button', { name: 'Hide' }).first().click();
  // Hide and Unhide return to the shelves so the new filter counts and the
  // item's removal from the current view are immediately clear.
  await expect(popup.page.getByRole('tab', { name: 'All (2)' })).toBeVisible();
  await expect(popup.page.getByRole('tab', { name: 'Hidden (1)' })).toBeVisible();

  await terminateExtensionWorker(extensionContext, extensionId);
  await popup.open();
  await popup.page.getByRole('button', { name: 'Ordinals', exact: true }).click();
  await expect(popup.page.getByRole('tab', { name: 'Hidden (1)' })).toBeVisible();
  await popup.page.getByRole('tab', { name: 'Hidden (1)' }).click();
  await openFirstGalleryShelf(popup.page);
  await popup.page.getByRole('button', { name: 'Unhide' }).click();
  await expect(popup.page.getByRole('tab', { name: 'Hidden (0)' })).toBeVisible();
  await expect(popup.page.getByRole('tab', { name: 'All (3)' })).toBeVisible();

  const settings = await extensionContext.newPage();
  try {
    await settings.goto(
      `chrome-extension://${extensionId}/fullpage.html#/settings/wallets-accounts`,
    );
    await expect(settings.getByLabel('Active account')).toBeEnabled();
    const advancedEnabled = await settings.evaluate(async () => {
      const raw = (await chrome.storage.session.get('squirrel:session'))['squirrel:session'] as
        { vaultId?: unknown; sessionId?: unknown } | undefined;
      if (typeof raw?.vaultId !== 'string' || typeof raw.sessionId !== 'string') return false;
      const response = await chrome.runtime.sendMessage({
        protocolVersion: 1,
        requestId: crypto.randomUUID(),
        sender: 'fullpage',
        op: 'config.set',
        payload: {
          advancedPsbtSigning: true,
          expectedVaultId: raw.vaultId,
          expectedSessionId: raw.sessionId,
        },
      }) as { ok?: unknown; result?: { advancedPsbtSigning?: unknown } };
      return response.ok === true && response.result?.advancedPsbtSigning === true;
    });
    expect(advancedEnabled).toBe(true);
  } finally {
    await settings.close();
  }
  await dapp.open();
  const connected = await dapp.invokeWithApproval('Connect');
  await connected.approve();
  await expect(dapp.output()).toContainText('"walletType": "software"');

  const externalRequests: string[] = [];
  const inspectRequest = (request: { url(): string }): void => {
    const url = request.url();
    if (url.startsWith('http://127.0.0.1:4173/') || url.startsWith('http://127.0.0.1:18080/') ||
        url.startsWith(`chrome-extension://${extensionId}/`) || url.startsWith('data:image/png')) return;
    externalRequests.push(url);
  };
  extensionContext.on('request', inspectRequest);
  try {
    const transfer = await dapp.invokeWithApproval('M9P safe inscription transfer');
    await transfer.expectMethod('ord_sendInscriptions');
    await expect(transfer.page.getByRole('heading', { name: '2 co-located inscriptions' })).toBeVisible();
    await expect(transfer.page.getByText(rasterId)).toBeVisible();
    await expect(transfer.page.getByText(placeholderId)).toBeVisible();
    await expect(transfer.page.getByText(distinctRasterId)).toBeVisible();
    await expect(transfer.page.getByText('Retained').first()).toBeVisible();
    await expect(transfer.page.getByText('Sent').first()).toBeVisible();
    await expect(transfer.page.getByRole('status')).toContainText('Preview unavailable');
    const rasterFrame = transfer.page.frameLocator(`iframe[title="Inert preview for inscription ${rasterId}"]`);
    await expect(rasterFrame.getByRole('img', { name: `Inert preview for inscription ${rasterId}` })).toBeVisible();
    const passwordField = transfer.page.getByLabel('App password');
    if (await passwordField.count() > 0) await fillPrivate(passwordField, TEST_PASSWORD);
    const confirmationField = transfer.page.getByLabel(/SIGN PSBT/u);
    if (await confirmationField.count() > 0) await confirmationField.fill('SIGN PSBT');
    await expect(transfer.page.getByTestId('approval-approve')).toBeDisabled();
    await transfer.page.getByLabel(/verified the inscription identifier and transaction effects/iu).check();
    await expect(transfer.page.getByTestId('approval-approve')).toBeEnabled();
    await transfer.approve();
    await expect(dapp.output()).toContainText('txid');

    const receivedId = '763ceae5c904f9043e206d5a5c83a0153ed6ba861afae7e2a2e2c2a26a7f0b96i0';
    const received = await dapp.invokeWithApproval('M9P received inscription');
    await received.expectMethod('signPsbt');
    await expect(received.page.getByText(receivedId)).toBeVisible();
    // Movement is stated in two independent places: the inscription card badge
    // and the sat-flow diagram. Assert both rather than a page-wide match, which
    // is now ambiguous by design.
    await expect(
      received.page.locator('article').filter({ hasText: receivedId }).getByText('Received'),
    ).toBeVisible();
    const receivedFlow = received.page.getByLabel('Sat flow');
    await expect(receivedFlow.getByText('Received')).toBeVisible();
    await expect(receivedFlow.getByText(/Arriving in your wallet: 1/u)).toBeVisible();
    const receivedFrame = received.page.frameLocator(`iframe[title="Inert preview for inscription ${receivedId}"]`);
    await expect(receivedFrame.getByRole('img', { name: `Inert preview for inscription ${receivedId}` })).toBeVisible();
    await received.reject();
    await expect(dapp.output()).toContainText('User rejected');

    await setGatewayScenario({
      gatewayMode: 'healthy', snapshotScenario: 'mixed', previewMode: 'identity-mismatch',
    });
    await dapp.invoke('M9P safe inscription transfer');
    await expect(dapp.output()).toContainText(/stale|changed|not supported|unsupported|internal/iu);

    await setGatewayScenario({ gatewayMode: 'healthy', snapshotScenario: 'mixed', previewMode: 'exact' });
    const restarted = await dapp.invokeWithApproval('M9P safe inscription transfer');
    await expect(restarted.page.getByText(rasterId)).toBeVisible();
    await terminateExtensionWorker(extensionContext, extensionId);
    await expect.poll(() => restarted.page.isClosed()).toBe(true);
    expect(externalRequests).toEqual([]);
  } finally {
    extensionContext.off('request', inspectRequest);
  }
});

test('@m9x @recovered-addresses exposes recovered-address context, wrong-lane rescue, and economic sweep', async ({
  onboarding, popup,
}) => {
  await setGatewayScenario({ snapshotScenario: 'wrong_lane_inscription_at_payment' });
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
  });
  await popup.open();
  await popup.page.getByRole('button', { name: 'Ordinals', exact: true }).click();
  const recoveredNotice = popup.page.getByText('Recovered addresses included').locator('..');
  await expect(recoveredNotice).toBeVisible();
  await expect(recoveredNotice).toContainText(
    'Some collectibles were found at additional addresses controlled by this recovery phrase.',
  );
  await expect.poll(() => recoveredNotice.evaluate((element) => ({
    popupWidth:
      document.querySelector('#root')?.firstElementChild?.getBoundingClientRect().width ?? null,
    noHorizontalOverflow:
      document.documentElement.scrollWidth <= window.innerWidth &&
      document.body.scrollWidth <= window.innerWidth,
    noticeContained:
      element.getBoundingClientRect().left >=
        (document.querySelector('main')?.getBoundingClientRect().left ?? 0) &&
      element.getBoundingClientRect().right <=
        (document.querySelector('main')?.getBoundingClientRect().right ?? 0),
  }))).toEqual({
    popupWidth: 392,
    noHorizontalOverflow: true,
    noticeContained: true,
  });

  await popup.page.evaluate(async () => {
    const key = 'squirrel:uiPrefs';
    const stored = (await chrome.storage.local.get(key))[key] as Record<string, unknown> | undefined;
    await chrome.storage.local.set({
      [key]: {
        accent: 'white',
        activityUnit: 'sats',
        hidePortfolioAmounts: false,
        ...stored,
        language: 'es',
      },
    });
  });
  await popup.page.reload();
  await popup.page.getByRole('button', { name: 'Ordinals', exact: true }).click();
  const spanishNotice = popup.page.getByText(
    'Se incluyeron direcciones recuperadas',
  ).locator('..');
  await expect(spanishNotice).toBeVisible();
  await expect(spanishNotice).toContainText(
    'Algunos coleccionables se encontraron en direcciones adicionales',
  );
  await expect(popup.page.getByRole('button', { name: 'Entendido' })).toBeVisible();
  await expect.poll(() => spanishNotice.evaluate((element) =>
    element.scrollWidth <= element.clientWidth &&
    document.documentElement.scrollWidth <= window.innerWidth,
  )).toBe(true);

  await popup.page.evaluate(async () => {
    const key = 'squirrel:uiPrefs';
    const stored = (await chrome.storage.local.get(key))[key] as Record<string, unknown>;
    await chrome.storage.local.set({ [key]: { ...stored, language: 'en' } });
  });
  await popup.page.reload();
  await popup.page.getByRole('button', { name: 'Ordinals', exact: true }).click();
  await expect(recoveredNotice).toBeVisible();
  await popup.page.getByRole('button', { name: 'Active account' }).click();
  const accountMenu = popup.page.getByRole('menu', { name: 'Active account' });
  await expect(accountMenu.getByText(/recovered address/u)).toHaveCount(0);
  await accountMenu.press('Escape');
  await expect(popup.page.getByRole('button', { name: 'Active account' })).toBeFocused();

  const dismissRecovered = popup.page.getByRole('button', { name: 'Got it' });
  await dismissRecovered.focus();
  await dismissRecovered.press('Enter');
  await expect(recoveredNotice).toHaveCount(0);
  await expect(popup.page.getByRole('tab', { name: /All/u })).toBeFocused();
  const rescue = popup.page.getByRole('button', { name: 'Rescue' }).first();
  await expect(rescue).toBeEnabled();
  await rescue.click();
  await expect(popup.page.getByRole('heading', { name: 'Rescue inscription' })).toBeVisible();
  await expect(popup.page.getByLabel('Recipient address')).toHaveCount(0);
  await popup.page.getByRole('button', { name: 'Back' }).click();

  await setGatewayScenario({ snapshotScenario: 'wrong_lane_btc_at_ordinals' });
  await popup.page.getByRole('button', { name: 'Refresh' }).click();
  const sweep = popup.page.getByRole('button', { name: 'Sweep' }).first();
  await expect(sweep).toBeEnabled({ timeout: 15_000 });
  await sweep.click();
  await expect(popup.page.getByRole('heading', { name: 'Sweep excess bitcoin' })).toBeVisible();
  await expect(popup.page.getByLabel('Recipient address')).toHaveCount(0);
  await popup.page.getByRole('button', { name: 'Review transaction' }).click();
  await expect(popup.page.getByRole('heading', {
    name: 'Sweep excess bitcoin?',
  })).toBeVisible();
  await expect(popup.page.getByText(
    'No inscription is present. Fixed postage remains reserved at your Ordinals address.',
  )).toBeVisible();
  await expect(popup.page.getByText('Bitcoin returned')).toBeVisible();
  const sweepPassword = popup.page.getByLabel('Confirm app password');
  await expect(sweepPassword).toHaveCount(0);
  await popup.page.getByRole('button', { name: 'Sweep excess bitcoin' }).click();
  await expectPopupResultFitsViewport(popup.page, 'Excess bitcoin swept');
  await expect(popup.page.getByRole('link', {
    name: /View transaction on mempool\.space/u,
  })).toBeVisible();
  await expect(popup.page.getByRole('button', { name: 'Done' })).toBeVisible();
  const resultSection = popup.page.getByRole('heading', {
    name: 'Excess bitcoin swept',
  }).locator('xpath=ancestor::section[1]');
  await popup.page.locator('#root > *').screenshot({
    path: 'test-results/e2e/ordinal-result-compact.masked.png',
    animations: 'disabled',
    mask: [
      resultSection.locator('code'),
      resultSection.locator('[title]'),
    ],
    maskColor: '#303030',
  });
  await popup.page.getByRole('button', { name: 'Back' }).click();
  await popup.page.getByRole('button', { name: 'Activity' }).click();
  await expect(popup.page.getByText(/Excess bitcoin swept/u)).toBeVisible();
});

test('pastes a BIP-321 on-chain fallback into Send and reviews request metadata', async ({
  onboarding, popup, extensionContext, extensionId,
}) => {
  await setGatewayScenario({ snapshotScenario: 'mixed' });
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
  });
  await popup.open();
  await expect(popup.page.getByText('Available to send')).toBeVisible();

  const fullpage = await extensionContext.newPage();
  try {
    await fullpage.goto(`chrome-extension://${extensionId}/fullpage.html#/send`);
    const recipient = fullpage.getByLabel('Recipient address or BIP-321 URI');
    await expect(recipient).toBeVisible();
    const uri = 'BITCOIN:tb1q053ptqlv0ugz8fcc3njw355rdluk4tqnhf0g0j' +
      '?AmOuNt=0.00001&LaBeL=Signet%20merchant&MeSsAgE=Invoice%207';
    await recipient.evaluate((element, paymentUri) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', paymentUri);
      element.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData,
      }));
    }, uri);
    await expect(recipient).toHaveValue('tb1q053ptqlv0ugz8fcc3njw355rdluk4tqnhf0g0j');
    await expect(fullpage.getByLabel('Amount (BTC)')).toHaveValue('0.00001');
    await expect(fullpage.getByRole('textbox', { name: 'Recipient name' })).toHaveCount(0);
    await expect(fullpage.getByRole('textbox', { name: 'Payment purpose' })).toHaveCount(0);
    await expect(fullpage.getByText('Payment request details')).toBeVisible();
    await expect(fullpage.getByText('Signet merchant')).toBeVisible();
    await expect(fullpage.getByText('Invoice 7')).toBeVisible();
    await expect(fullpage.getByText(/not sent on-chain/iu)).toBeVisible();
    await fullpage.getByRole('button', { name: 'Review transaction' }).click();
    await expect(fullpage.getByRole('heading', { name: 'Review transaction' })).toBeVisible();
    await expect(fullpage.getByText('1,000 sats').first()).toBeVisible();
    await expect(fullpage.getByText('Payment request details')).toBeVisible();
    await expect(fullpage.getByText('Signet merchant')).toBeVisible();
    await expect(fullpage.getByText('Invoice 7')).toBeVisible();
  } finally {
    await fullpage.close();
  }
});

test('@m9x sends one complete three-inscription output as an atomic batch', async ({
  onboarding, popup,
}) => {
  const recipientAddress = 'tb1q053ptqlv0ugz8fcc3njw355rdluk4tqnhf0g0j';
  await setGatewayScenario({ snapshotScenario: 'mixed' });
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
  });
  await popup.open();
  await popup.page.getByRole('button', { name: 'Ordinals', exact: true }).click();
  await openFirstGalleryShelf(popup.page);
  await popup.page.getByRole('button', { name: 'Select', exact: true }).click();

  await popup.page.getByRole('button', { name: 'Select #1234' }).click();
  const coLocated = popup.page.getByRole('dialog', {
    name: 'These inscriptions travel together',
  });
  await expect(coLocated).toBeVisible();
  await expect(coLocated.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await coLocated.getByRole('button', { name: 'Include all 2' }).click();
  const selectionFooter = popup.page.locator('[data-gallery-selection-footer]');
  const bottomNavigation = popup.page.getByRole('navigation', { name: 'Drey' });
  const [selectionFooterBox, bottomNavigationBox] = await Promise.all([
    selectionFooter.boundingBox(),
    bottomNavigation.boundingBox(),
  ]);
  expect(selectionFooterBox).not.toBeNull();
  expect(bottomNavigationBox).not.toBeNull();
  expect(Math.abs(
    selectionFooterBox!.y + selectionFooterBox!.height - bottomNavigationBox!.y,
  )).toBeLessThanOrEqual(1);
  await expect(popup.page.getByRole('button', { name: 'Continue with 2' })).toBeDisabled();
  await expect(popup.page.getByText(/1 more inscription\(s\).*must also be selected/u))
    .toBeVisible();
  await popup.page.getByRole('button', { name: 'Select all from this output' }).click();
  await expect(popup.page.getByRole('button', { name: 'Continue with 3' })).toBeEnabled();
  await popup.page.getByRole('button', { name: 'Continue with 3' }).click();

  await expect(popup.page.getByRole('heading', { name: 'Send 3 inscriptions' })).toBeVisible();
  await expect(popup.page.getByText('3 inscriptions to one address')).toBeVisible();
  await popup.page.getByLabel('Recipient address')
    .fill(recipientAddress);
  await popup.page.getByRole('button', { name: 'Review transaction' }).click();
  await expect(popup.page.getByRole('heading', {
    name: 'Send 3 inscriptions to one address?',
  })).toBeVisible();
  await expect(popup.page.getByText('Postage reserved')).toBeVisible();
  await expect(popup.page.getByText('Bitcoin returned')).toBeVisible();
  await popup.page.getByText('Atomic inscription groups').click();
  await expect(popup.page.getByText('2 inscriptions share this sat and travel together.'))
    .toBeVisible();
  await expect(popup.page.getByText('Postage output 0')).toBeVisible();
  await expect(popup.page.getByText('Postage output 1')).toBeVisible();
  await popup.page.getByLabel(
    /valid address on the correct network.*not a Taproot address/iu,
  ).check();
  await popup.page.getByLabel(/verified the inscription identifier and transaction effects/iu)
    .check();
  await popup.page.getByRole('button', { name: 'Send 3 inscriptions' }).click();

  await expectPopupResultFitsViewport(popup.page, '3 Ordinals sent');
  await expect(popup.page.getByText(recipientAddress, { exact: true })).toHaveCount(1);
  await expect(popup.page.getByRole('link', {
    name: /View transaction on mempool\.space/u,
  })).toBeVisible();
});

test('@m9x preserves native transfer review across restart and records indeterminate activity', async ({
  onboarding, popup, extensionContext, extensionId,
}) => {
  await setGatewayScenario({ snapshotScenario: 'mixed' });
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
  });
  await popup.open();
  await expect(popup.page.getByText('Inscriptions received')).toBeVisible();
  await expect(popup.page.getByText('Inscription #1,234 · +2 more')).toBeVisible();
  await expect(popup.page.getByText(/Postage ·/u)).toHaveCount(0);
  await popup.page.getByRole('button', { name: 'Ordinals', exact: true }).click();
  await openFirstGalleryShelf(popup.page);
  const targetId = 'aa7f08676c67bb5cab1871bb34abb66440d7d99db81aadf2c38f9220f82ca5d1i0';
  const retainedId = '06fc3a9a3ed60a75c7ded7a1c8370be2d95d2faaa921d1fea6c361819dd3a12bi0';
  // Filter cards by number: the id is present but collapsed in the disclosure,
  // and the number is what the card face carries.
  const target = popup.page.locator('article').filter({ hasText: '#1236' });
  await target.getByRole('button', { name: 'Send' }).click();
  await popup.page.getByLabel('Recipient address')
    .fill('tb1q053ptqlv0ugz8fcc3njw355rdluk4tqnhf0g0j');
  await popup.page.getByRole('button', { name: 'Review transaction' }).click();
  await expect(popup.page.getByRole('heading', {
    name: 'Send this inscription?',
  })).toBeVisible();
  await expect(popup.page.getByText(targetId).first()).toBeHidden();
  await expect(popup.page.getByText('Clean fee funding inputs')).toBeHidden();
  await popup.page.getByText('Technical details').click();
  await expect(popup.page.getByText(targetId).first()).toBeVisible();
  await expect(popup.page.getByText(retainedId).first()).toBeVisible();
  await expect(popup.page.getByText('Clean fee funding inputs')).toBeVisible();
  await expect(popup.page.getByText('Bitcoin returned')).toBeVisible();
  await popup.page.getByLabel(
    /valid address on the correct network.*not a Taproot address/iu,
  ).check();
  await popup.page.getByLabel(/verified the inscription identifier and transaction effects/iu).check();

  await terminateExtensionWorker(extensionContext, extensionId);
  await setGatewayScenario({ snapshotScenario: 'mixed', broadcastMode: 'recoverable' });
  const transferPassword = popup.page.getByLabel('Confirm app password');
  await expect(transferPassword).toHaveCount(0);
  await popup.page.getByRole('button', { name: 'Send inscription' }).click();
  await expect(popup.page.getByRole('heading', {
    name: 'Ordinals broadcast outcome unknown',
  })).toBeVisible();
  await expect(popup.page.getByText(
    'The broadcast outcome is unknown. The exact signed transaction is saved and will not be resubmitted automatically.',
  )).toBeVisible();
  await popup.page.getByRole('button', { name: 'Back' }).click();
  await popup.page.getByRole('button', { name: 'Activity' }).click();
  await expect(popup.page.getByText('Inscription sent')).toBeVisible();
  await expect(popup.page.getByText('Inscription #1,236')).toBeVisible();
  await expect(popup.page.getByText(/Postage ·/u)).toHaveCount(0);
  await expect(popup.page.getByText(targetId, { exact: true })).toHaveCount(0);
  await expect(popup.page.getByText('Broadcast outcome unknown')).toBeVisible();
});

test('@m9x serves Ordinals tab switches from memory without refetching or logging errors', async ({
  onboarding, popup,
}) => {
  await setGatewayScenario({ snapshotScenario: 'mixed' });
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
  });

  // Watch from the popup onward: onboarding has its own coverage, and the
  // regression this guards is a popup-navigation one.
  const problems: string[] = [];
  const onConsole = (message: ConsoleMessage): void => {
    if (message.text().includes('DREYDIAG')) { console.log('>>', message.text()); return; }
    if (message.type() === 'error' || message.type() === 'warning') {
      problems.push(`${message.type()}: ${message.text()}`);
    }
  };
  const onPageError = (error: Error): void => { problems.push(`pageerror: ${error.message}`); };
  popup.page.on('console', onConsole);
  popup.page.on('pageerror', onPageError);

  await popup.open();
  await popup.page.evaluate(() => {
    const observed = window as unknown as {
      __dreyGalleryEmptyFlashes: number;
      __dreyGalleryObserver: MutationObserver;
    };
    observed.__dreyGalleryEmptyFlashes = 0;
    observed.__dreyGalleryObserver = new MutationObserver(() => {
      const text = document.body.textContent ?? '';
      if (text.includes('No Ordinals in this wallet.')) {
        observed.__dreyGalleryEmptyFlashes += 1;
      }
    });
    observed.__dreyGalleryObserver.observe(document.body, { childList: true, subtree: true });
  });
  // exact: the quick-copy row offers "Copy Bitcoin address" and "Copy Ordinals
  // address", which a substring match resolves to alongside the nav item.
  const ordinals = popup.page.getByRole('button', { name: 'Ordinals', exact: true });
  const activity = popup.page.getByRole('button', { name: 'Activity', exact: true });
  const bitcoin = popup.page.getByRole('button', { name: 'Bitcoin', exact: true });
  const allTab = popup.page.getByRole('tab', { name: /^All \(/u });
  const refresh = popup.page.getByRole('button', { name: 'Refresh' });
  // Real content, not just the always-rendered tab strip.
  const card = popup.page.locator('article').filter({ hasText: '#1234' });

  await ordinals.click();
  await expect(popup.page.locator('[data-gallery-collection]')).toBeVisible({ timeout: 30_000 });
  await expect(card).toHaveCount(0);
  const painted = await allTab.textContent();
  await openFirstGalleryShelf(popup.page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(refresh).toBeEnabled({ timeout: 30_000 });
  const geometry = async () => popup.page.locator('article').evaluateAll((articles) =>
    articles.map((article) => {
      const card = article.getBoundingClientRect();
      // The shell owns the square aspect ratio; the sandboxed iframe is its
      // child and may report a content-box height that excludes its framing.
      const preview = article.querySelector('iframe[title^="Inert preview for inscription"]')
        ?.parentElement?.getBoundingClientRect() ?? null;
      return {
        x: Math.round(card.x * 10) / 10,
        y: Math.round(card.y * 10) / 10,
        width: Math.round(card.width * 10) / 10,
        height: Math.round(card.height * 10) / 10,
        previewWidth: preview === null ? null : Math.round(preview.width * 10) / 10,
        previewHeight: preview === null ? null : Math.round(preview.height * 10) / 10,
      };
    }));
  expect(await popup.page.evaluate(() => {
    const observed = window as unknown as { __dreyGalleryEmptyFlashes: number };
    return observed.__dreyGalleryEmptyFlashes;
  })).toBe(0);
  // Let debounced scan-progress invalidations drain before sampling.
  await popup.page.waitForTimeout(3_000);
  const settled = await galleryBatchAttempts();
  expect(settled).toBeGreaterThan(0);
  const initialGeometry = await geometry();
  expect(initialGeometry.length).toBeGreaterThan(0);
  for (const box of initialGeometry) {
    if (box.previewWidth === null || box.previewHeight === null) continue;
    expect(
      Math.abs(box.previewWidth - box.previewHeight),
      JSON.stringify(initialGeometry),
    ).toBeLessThanOrEqual(0.1);
  }

  // Home now shares gallery data for its carousel. Its first mount may need
  // one targeted raster batch for a newest acquisition that the gallery's
  // viewport never requested. Give that debounce time to drain, then prove
  // every later Home/Ordinals remount joins the warmed store without another
  // request. The upper bound distinguishes the intended carousel hydration
  // from the former per-remount full-list refetch loop.
  await activity.click();
  await expect(allTab).toHaveCount(0);
  await bitcoin.click();
  await expect(popup.page.getByText('Available to send')).toBeVisible();
  const homeCarousel = popup.page.getByTestId('home-collectibles-carousel');
  await expect(homeCarousel).toBeVisible({ timeout: 30_000 });
  expect(await homeCarousel.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      columns: style.gridTemplateColumns.split(' ').filter(Boolean).length,
      noHorizontalOverflow: element.scrollWidth <= element.clientWidth,
      overflowX: style.overflowX,
      slots: element.childElementCount,
    };
  })).toEqual({ columns: 3, noHorizontalOverflow: true, overflowX: 'visible', slots: 3 });
  await popup.page.waitForTimeout(300);
  const homeWarmed = await galleryBatchAttempts();
  expect(homeWarmed).toBeGreaterThanOrEqual(settled);
  expect(homeWarmed).toBeLessThanOrEqual(settled + 1);
  await ordinals.click();
  await expect(allTab).toHaveText(painted ?? '');
  await openFirstGalleryShelf(popup.page);
  await expect(card).toBeVisible();
  expect(await geometry()).toEqual(initialGeometry);
  // Returning from Home can start the one permitted full-group hydration only
  // after the shelf is opened. Let that first drill-in settle before proving
  // that subsequent tab remounts stay entirely in memory.
  await popup.page.waitForTimeout(300);
  const drillInWarmed = await galleryBatchAttempts();
  expect(drillInWarmed).toBeGreaterThanOrEqual(homeWarmed);
  expect(drillInWarmed).toBeLessThanOrEqual(homeWarmed + 1);

  for (let round = 0; round < 2; round += 1) {
    await activity.click();
    await expect(allTab).toHaveCount(0);
    await bitcoin.click();
    await expect(popup.page.getByText('Available to send')).toBeVisible();
    await ordinals.click();
    await expect(allTab).toHaveText(painted ?? '');
    await openFirstGalleryShelf(popup.page);
    await expect(card).toBeVisible();
    // Remounting the tab may recreate nodes, but it must not move or resize the
    // settled grid.
    expect(await geometry()).toEqual(initialGeometry);
  }
  expect(await galleryBatchAttempts()).toBe(drillInWarmed);

  // Refresh must still reach the gateway, so the cache is never a trap.
  await expect(refresh).toBeEnabled({ timeout: 30_000 });
  await refresh.click();
  await expect(card).toBeVisible();
  expect((await geometry()).map(({ width, height, previewWidth, previewHeight }) => ({
    width, height, previewWidth, previewHeight,
  }))).toEqual(initialGeometry.map(({ width, height, previewWidth, previewHeight }) => ({
    width, height, previewWidth, previewHeight,
  })));
  await expect.poll(async () => galleryBatchAttempts(), { timeout: 30_000 })
    .toBeGreaterThan(homeWarmed);
  await popup.page.getByRole('button', { name: 'Back' }).click();
  await expect(allTab).toBeVisible();

  await popup.page.evaluate(() => {
    const observed = window as unknown as { __dreyGalleryObserver: MutationObserver };
    observed.__dreyGalleryObserver.disconnect();
  });
  popup.page.off('console', onConsole);
  popup.page.off('pageerror', onPageError);
  expect(problems).toEqual([]);
});

test('@m9x settles the Ordinals gallery after rapid tab switching', async ({
  onboarding, popup,
}) => {
  // Real gateways answer in hundreds of milliseconds; an instant fixture almost
  // closes the race this test is about.
  await setGatewayScenario({ snapshotScenario: 'mixed', snapshotDelayMs: 250 });
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
  });

  const problems: string[] = [];
  popup.page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') problems.push(message.text());
  });

  await popup.open();
  // exact, for the same quick-copy collision as the tab-switch test above.
  const ordinals = popup.page.getByRole('button', { name: 'Ordinals', exact: true });
  const bitcoin = popup.page.getByRole('button', { name: 'Bitcoin', exact: true });

  await ordinals.click();
  await openFirstGalleryShelf(popup.page);
  await expect(popup.page.locator('article').filter({ hasText: '#1234' }))
    .toBeVisible({ timeout: 30_000 });

  // Hammer the tab switch the way a user impatiently would.
  for (let i = 0; i < 8; i += 1) {
    await bitcoin.click();
    await ordinals.click();
    await openFirstGalleryShelf(popup.page);
  }

  // It must settle: a real preview, an unblocked action, and no permanent
  // "Checking your wallet for Ordinals…" or stale-verification banner.
  await expect(popup.page.locator('article').filter({ hasText: '#1234' }))
    .toBeVisible({ timeout: 30_000 });
  await expect(popup.page.getByText('Checking your wallet for Ordinals…'))
    .toHaveCount(0, { timeout: 30_000 });
  await expect(popup.page.getByText('Asset verification is out of date. Refresh before spending.'))
    .toHaveCount(0, { timeout: 30_000 });
  // The mixed fixture has two genuinely unpreviewable items (active content),
  // so only the raster item is asserted to recover its image.
  expect(problems).toEqual([]);
});

test('@m9x paints a reopened popup from cached rasters without a new signed batch', async ({
  onboarding, popup,
}) => {
  await setGatewayScenario({ snapshotScenario: 'mixed' });
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
  });

  await popup.open();
  const ordinals = popup.page.getByRole('button', { name: 'Ordinals', exact: true });
  const rasterId = '06fc3a9a3ed60a75c7ded7a1c8370be2d95d2faaa921d1fea6c361819dd3a12bi0';
  const card = popup.page.locator('article').filter({ hasText: '#1234' });
  const preview = popup.page.getByTitle(`Inert preview for inscription ${rasterId}`);
  const refresh = popup.page.getByRole('button', { name: 'Refresh' });

  await ordinals.click();
  await openFirstGalleryShelf(popup.page);
  await expect(card).toBeVisible({ timeout: 60_000 });
  // The image itself, not just the card: this is what the cache exists to keep.
  await expect(preview).toBeVisible({ timeout: 60_000 });
  await expect(refresh).toBeEnabled({ timeout: 60_000 });
  // Let debounced scan-progress invalidations drain before sampling.
  await popup.page.waitForTimeout(4_000);
  const settled = await galleryBatchAttempts();
  expect(settled).toBeGreaterThan(0);
  // Reopening destroys the popup document, so the in-memory store is gone.
  // The worker's exact-session L1 still has the pixels and paints before live
  // authority replaces its blocked projection.
  await popup.open();
  await ordinals.click();
  await openFirstGalleryShelf(popup.page);

  await expect(preview).toBeVisible({ timeout: 30_000 });
  expect(await galleryBatchAttempts()).toBe(settled);
  // Serving the raster from cache is what stops this item ever being
  // re-requested, so the batch that skipped it is the last word on whether its
  // media can be opened. The affordance has to survive that.
  await expect(card.getByRole('button', { name: 'Open media' }))
    .toBeVisible({ timeout: 30_000 });
  await expect(popup.page.getByText('Asset verification is out of date. Refresh before spending.'))
    .toHaveCount(0);

  // Authority still arrives, and Refresh still reaches the gateway, so the
  // cache is never a trap.
  await expect(refresh).toBeEnabled({ timeout: 30_000 });
  await refresh.click();
  await expect.poll(async () => galleryBatchAttempts(), { timeout: 60_000 })
    .toBeGreaterThan(settled);
  await expect(preview).toBeVisible({ timeout: 30_000 });
});

test('@m9x reuses an exact durable preview after session loss and a worker restart', async ({
  onboarding, popup, extensionContext, extensionId,
}) => {
  await setGatewayScenario({ snapshotScenario: 'mixed' });
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
  });

  await popup.open();
  const ordinals = popup.page.getByRole('button', { name: 'Ordinals', exact: true });
  const rasterId = '06fc3a9a3ed60a75c7ded7a1c8370be2d95d2faaa921d1fea6c361819dd3a12bi0';
  const preview = popup.page.getByTitle(`Inert preview for inscription ${rasterId}`);
  await ordinals.click();
  await openFirstGalleryShelf(popup.page);
  await expect(preview).toBeVisible({ timeout: 60_000 });
  // Let the verified L2 write and debounced invalidations finish before the
  // extension process is replaced.
  await popup.page.waitForTimeout(4_000);
  const settled = await galleryBatchAttempts();
  const settledRequests = (await galleryBatchRequests()).length;
  expect(settled).toBeGreaterThan(0);
  const durableRecords = await durablePreviewRecordCount(popup.page);
  expect(durableRecords).toBeGreaterThan(0);

  // chrome.runtime.reload() closes Playwright's entire persistent context, so
  // reproduce its two relevant storage/process effects directly: Chrome clears
  // storage.session on reload, while IndexedDB survives, and the old MV3 worker
  // is gone before the next extension event.
  await popup.page.evaluate(() => chrome.storage.session.clear());
  await terminateExtensionWorker(extensionContext, extensionId);
  await wakeExtensionWorker(popup.page, extensionId);
  expect(await durablePreviewRecordCount(popup.page)).toBe(durableRecords);
  await expect(popup.page.getByRole('heading', { name: 'Unlock Drey' })).toBeVisible();
  await popup.unlock(TEST_PASSWORD);

  await popup.page.getByRole('button', { name: 'Ordinals', exact: true }).click();
  await expect(preview).toBeVisible({ timeout: 30_000 });
  // Current ownership/status were revalidated under the new session, but the
  // exact preview was decrypted from IndexedDB and repopulated the L1 cache.
  // A genuinely pending placeholder may be retried in another batch; the
  // settled durable raster itself must never be among those requests.
  const afterRequests = await galleryBatchRequests();
  expect(await galleryBatchAttempts()).toBe(afterRequests.length);
  expect(afterRequests.slice(settledRequests).flat()).not.toContain(rasterId);
});
