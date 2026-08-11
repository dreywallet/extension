import { readFileSync } from 'node:fs';
import { test, expect } from './fixtures';
import { resetGateway } from './gateway';

// Read the repository's public vector at runtime so Playwright's HTML reporter
// never bundles even this non-secret mnemonic into report source.
const vectors = JSON.parse(readFileSync(
  new URL('../fixtures/bip39-trezor-vectors.json', import.meta.url), 'utf8',
)) as { english: string[][] };
const PUBLIC_SIGNET_MNEMONIC = vectors.english[0]?.[1] ?? '';
const TEST_PASSWORD = ['public', 'e2e', 'password', 'only'].join('-');

test.beforeEach(async () => {
  await resetGateway();
});

test('labels a UTXO through every editor state (§14.4)', async ({
  onboarding, extensionContext, extensionId,
}) => {
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
  });

  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/fullpage.html#/send/utxos`);
  await expect(page.getByRole('heading', { name: 'Manage coins' })).toBeVisible();

  // §8.1 wallet-wide note renders once, not per row.
  await expect(page.getByText(/uses one receive address for every payment/u))
    .toHaveCount(1);

  // Labels are opt-in detail, so the affordance lives behind the row
  // disclosure rather than costing every row a line of its own.
  const rowDisclosure = page.getByLabel(/^Details for coin/u).first();
  await expect(rowDisclosure).toBeVisible();
  const addLabel = page.getByRole('button', { name: 'Add label' }).first();
  await expect(addLabel).toBeHidden();
  await rowDisclosure.click();

  // Unlabeled state carries no chip at all — only the affordance.
  await expect(addLabel).toBeVisible();
  await expect(page.getByText('Exchange withdrawal · Kraken, January')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/e2e/label-01-unlabeled.png', fullPage: true });

  // Editing state: presets are a keyboard-navigable radiogroup.
  await addLabel.click();
  const group = page.getByRole('radiogroup', { name: 'Label' }).first();
  await expect(group).toBeVisible();
  const exchange = group.getByRole('radio', { name: 'Exchange withdrawal' });
  await expect(exchange).toHaveAttribute('aria-checked', 'false');
  // Save is unreachable until the label carries something.
  await expect(page.getByRole('button', { name: 'Save' }).first()).toBeDisabled();
  await exchange.click();
  await expect(exchange).toHaveAttribute('aria-checked', 'true');
  // The selected chip must stay legible, not invert into light-on-light.
  const chipPaint = await exchange.evaluate((node) => {
    const style = getComputedStyle(node);
    return { color: style.color, background: style.backgroundColor, border: style.borderTopColor };
  });
  const unselectedPaint = await group.getByRole('radio', { name: 'Savings' })
    .evaluate((node) => getComputedStyle(node).color);
  expect(chipPaint.color).not.toBe(unselectedPaint);
  await page.getByLabel('Note (optional)').first().fill('Kraken, January');
  await page.screenshot({ path: 'test-results/e2e/label-02-editing.png', fullPage: true });

  await page.getByRole('button', { name: 'Save' }).first().click();

  // Labeled state persists and renders as a chip.
  await expect(page.getByText('Exchange withdrawal · Kraken, January').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit label' }).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/e2e/label-03-labeled.png', fullPage: true });

  // Survives a reload — the label lives in its own encrypted cache record. The
  // chip stays on the collapsed row, so this needs no disclosure.
  await page.reload();
  await expect(page.getByText('Exchange withdrawal · Kraken, January').first()).toBeVisible();

  // A long note must not blow out the row.
  await page.getByLabel(/^Details for coin/u).first().click();
  await page.getByRole('button', { name: 'Edit label' }).first().click();
  await page.getByLabel('Note (optional)').first().fill('x'.repeat(64));
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText(new RegExp(`${'x'.repeat(40)}`, 'u')).first()).toBeVisible();
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth);
  expect(overflow).toBe(true);
  await page.screenshot({ path: 'test-results/e2e/label-04-long-note.png', fullPage: true });

  // Removing returns the row to the unlabeled state.
  await page.getByRole('button', { name: 'Edit label' }).first().click();
  await page.getByRole('button', { name: 'Remove label' }).first().click();
  await expect(page.getByText(new RegExp(`${'x'.repeat(40)}`, 'u'))).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add label' }).first()).toBeVisible();

  await page.close();
});

test('discloses the gateway relationship in onboarding and Settings (§18.5)', async ({
  onboarding, extensionContext, extensionId,
}) => {
  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic: PUBLIC_SIGNET_MNEMONIC,
    password: TEST_PASSWORD,
  });

  // One sentence at the finish line, not a wall of policy text.
  await expect(onboarding.page.getByText(/asks its gateway about your addresses/u))
    .toBeVisible();
  await onboarding.page.screenshot({
    path: 'test-results/e2e/label-05-onboarding-disclosure.png', fullPage: true,
  });

  const page = await extensionContext.newPage();
  await page.goto(`chrome-extension://${extensionId}/fullpage.html#/settings`);
  const privacyDisclosure = page.getByText('What the wallet service can see', { exact: true });
  await expect(privacyDisclosure).toBeVisible();
  await expect(page.getByText(/can tell your addresses belong to the same wallet/u))
    .toBeHidden();
  await privacyDisclosure.click();
  await expect(page.getByText(/can tell your addresses belong to the same wallet/u))
    .toBeVisible();
  await page.screenshot({
    path: 'test-results/e2e/label-06-settings-disclosure.png', fullPage: true,
  });
  await page.close();
});
