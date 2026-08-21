import type { BrowserContext, Page } from '@playwright/test';
import { test, expect, type OnboardingPage, type PopupPage } from './fixtures';
import { fillPrivate } from './pages';
import {
  assertRegtestReady,
  assertTransactionIntent,
  assertTransactionReconfirmed,
  confirmTransaction,
  freshExternalAddress,
  fundAndConfirm,
  fundWithoutConfirmation,
  mineBlock,
  reorgLatestTransactionToMempool,
  transactionInMempool,
  transactionNotInMempool,
} from './regtest';

const TEST_PASSWORD = ['disposable', 'regtest', 'features', 'only'].join('-');

function checkedRegtestAddress(value: string | null): string {
  if (value === null || !/^bcrt1[ac-hj-np-z02-9]{8,87}$/u.test(value)) {
    throw new Error('receive surface did not return a valid regtest address');
  }
  return value;
}

function checkedTxid(value: string | null): string {
  if (value === null || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error('transaction result did not return a valid transaction id');
  }
  return value;
}

async function createFundableWallet(
  onboarding: OnboardingPage,
  popup: PopupPage,
  name: string,
): Promise<string> {
  await onboarding.open();
  await onboarding.createDisposable({ password: TEST_PASSWORD, name });
  await popup.open();
  await expect(popup.page.getByText('Regtest', { exact: true })).toBeVisible();
  await popup.page.getByRole('button', { name: 'Receive' }).click();
  const address = checkedRegtestAddress(
    await popup.page.getByTestId('receive-address').textContent(),
  );
  await popup.page.getByRole('button', { name: 'Close' }).click();
  return address;
}

async function openActivity(
  context: BrowserContext,
  extensionId: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/fullpage.html#/send/activity`);
  await expect(page.getByRole('heading', { name: 'Transaction activity' })).toBeVisible();
  return page;
}

async function expectActivityState(
  page: Page,
  amount: string,
  state: 'Pending' | 'Confirmed',
): Promise<void> {
  await expect.poll(async () => {
    const refresh = page.getByRole('button', { name: 'Refresh status' });
    if (await refresh.isEnabled().catch(() => false)) await refresh.click();
    await page.waitForTimeout(250);
    const matches = page.locator('details').filter({ hasText: amount });
    const count = await matches.count();
    const text = count === 0 ? null : await matches.first().textContent();
    return { exactlyOnce: count === 1, expectedState: text?.includes(state) === true };
  }, {
    timeout: 60_000,
    intervals: [500, 1_000, 2_000, 3_000],
  }).toEqual({ exactlyOnce: true, expectedState: true });
}

async function expectReplacementActivity(page: Page, amount: string): Promise<void> {
  await expect.poll(async () => {
    const refresh = page.getByRole('button', { name: 'Refresh status' });
    if (await refresh.isEnabled().catch(() => false)) await refresh.click();
    await page.waitForTimeout(250);
    const rows = page.locator('details').filter({ hasText: amount });
    const states: string[] = [];
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      if (!(await row.getAttribute('open'))) await row.locator('summary').click();
      const state = await row.getByText('Status', { exact: true })
        .locator('..').locator('dd').textContent();
      if (state !== null) states.push(state);
    }
    return states.sort();
  }, {
    timeout: 60_000,
    intervals: [500, 1_000, 2_000, 3_000],
  }).toEqual(['Confirmed', 'Replaced']);
}

async function refreshPopup(popup: PopupPage): Promise<void> {
  await popup.page.bringToFront();
  await popup.page.evaluate(() => window.dispatchEvent(new Event('focus')));
}

test('projects a real incoming payment from mempool pending to confirmed', async ({
  onboarding,
  popup,
  extensionContext,
  extensionId,
}) => {
  test.slow();
  await assertRegtestReady();
  const address = await createFundableWallet(onboarding, popup, 'Pending regtest E2E');
  const funding = await fundWithoutConfirmation(address, 80_000);
  await transactionInMempool(funding.txid);

  const fullpage = await openActivity(extensionContext, extensionId);
  try {
    await expectActivityState(fullpage, '+80,000 sats', 'Pending');
    await refreshPopup(popup);
    await expect(popup.page.getByTestId('balance-card')).toContainText('0 sats', {
      timeout: 60_000,
    });

    await confirmTransaction(funding.txid);
    await expectActivityState(fullpage, '+80,000 sats', 'Confirmed');
    await refreshPopup(popup);
    await expect(popup.page.getByTestId('balance-card')).toContainText('80,000 sats', {
      timeout: 60_000,
    });
  } finally {
    await fullpage.close().catch(() => undefined);
  }
});

test('selects and conserves two real UTXOs in one payment', async ({
  onboarding,
  popup,
  extensionContext,
  extensionId,
}) => {
  test.slow();
  await assertRegtestReady();
  const address = await createFundableWallet(onboarding, popup, 'Multi-input regtest E2E');
  const first = await fundWithoutConfirmation(address, 70_000);
  const second = await fundWithoutConfirmation(address, 80_000);
  await transactionInMempool(first.txid);
  await transactionInMempool(second.txid);
  await mineBlock();

  const fullpage = await openActivity(extensionContext, extensionId);
  try {
    await expectActivityState(fullpage, '+70,000 sats', 'Confirmed');
    await expectActivityState(fullpage, '+80,000 sats', 'Confirmed');
    await refreshPopup(popup);
    await expect(popup.page.getByTestId('balance-card')).toContainText('150,000 sats', {
      timeout: 60_000,
    });

    const destination = await freshExternalAddress();
    await fullpage.goto(`chrome-extension://${extensionId}/fullpage.html#/send`);
    await fillPrivate(fullpage.getByLabel('Recipient address or BIP-321 URI'), destination);
    await fullpage.getByLabel('Amount (BTC)').fill('0.00120000');
    await fullpage.getByRole('radio', { name: 'Custom' }).check();
    await fullpage.getByLabel('Fee rate (sat/vB)').fill('1');
    await fullpage.getByRole('button', { name: 'Review transaction' }).click();
    const review = fullpage.getByRole('heading', { name: 'Review transaction' }).locator('..');
    await expect(review.getByText('Inputs', { exact: true }).locator('..').locator('dd'))
      .toHaveText('2', { timeout: 45_000 });
    const password = fullpage.getByLabel('Confirm app password');
    if (await password.count() > 0) await fillPrivate(password, TEST_PASSWORD);
    await fullpage.getByRole('button', { name: 'Sign and broadcast' }).click();
    await expect(fullpage.getByRole('heading', { name: 'Transaction sent' })).toBeVisible({
      timeout: 45_000,
    });
    const txid = checkedTxid(await fullpage.locator('a[href*="/tx/"] code').textContent());
    await transactionInMempool(txid);
    const { feeSats } = await assertTransactionIntent(
      txid,
      [first, second],
      destination,
      120_000,
    );
    await confirmTransaction(txid);
    await fullpage.getByRole('button', { name: 'Activity' }).click();
    await expectActivityState(fullpage, '−120,000 sats', 'Confirmed');
    await refreshPopup(popup);
    await expect(popup.page.getByTestId('balance-card')).toContainText(
      `${(30_000 - feeSats).toLocaleString('en-US')} sats`,
      { timeout: 60_000 },
    );
  } finally {
    await fullpage.close().catch(() => undefined);
  }
});

test('speeds up a real pending payment without changing its recipient or amount', async ({
  onboarding,
  popup,
  extensionContext,
  extensionId,
}) => {
  test.slow();
  await assertRegtestReady();
  const address = await createFundableWallet(onboarding, popup, 'Speed-up regtest E2E');
  const funding = await fundAndConfirm(address, 200_000);
  const destination = await freshExternalAddress();

  const fullpage = await openActivity(extensionContext, extensionId);
  try {
    await expectActivityState(fullpage, '+200,000 sats', 'Confirmed');
    await fullpage.goto(`chrome-extension://${extensionId}/fullpage.html#/send`);
    await fillPrivate(fullpage.getByLabel('Recipient address or BIP-321 URI'), destination);
    await fullpage.getByLabel('Amount (BTC)').fill('0.00050000');
    await fullpage.getByRole('radio', { name: 'Custom' }).check();
    await fullpage.getByLabel('Fee rate (sat/vB)').fill('1');
    await fullpage.getByRole('button', { name: 'Review transaction' }).click();
    await expect(fullpage.getByRole('heading', { name: 'Review transaction' })).toBeVisible({
      timeout: 45_000,
    });
    const originalPassword = fullpage.getByLabel('Confirm app password');
    if (await originalPassword.count() > 0) await fillPrivate(originalPassword, TEST_PASSWORD);
    await fullpage.getByRole('button', { name: 'Sign and broadcast' }).click();
    await expect(fullpage.getByRole('heading', { name: 'Transaction sent' })).toBeVisible({
      timeout: 45_000,
    });
    const originalTxid = checkedTxid(
      await fullpage.locator('a[href*="/tx/"] code').textContent(),
    );
    await transactionInMempool(originalTxid);
    const original = await assertTransactionIntent(
      originalTxid,
      funding,
      destination,
      50_000,
    );

    await fullpage.getByRole('button', { name: 'Activity' }).click();
    await expectActivityState(fullpage, '−50,000 sats', 'Pending');
    const pending = fullpage.locator('details').filter({ hasText: '−50,000 sats' }).first();
    await expect.poll(async () => {
      const refresh = fullpage.getByRole('button', { name: 'Refresh status' });
      if (await refresh.isEnabled().catch(() => false)) await refresh.click();
      await fullpage.waitForTimeout(250);
      if (!(await pending.getAttribute('open'))) await pending.locator('summary').click();
      return pending.getByRole('button', { name: 'Speed up transaction' }).isVisible()
        .catch(() => false);
    }, {
      timeout: 60_000,
      intervals: [500, 1_000, 2_000, 3_000],
    }).toBe(true);
    await expect(pending.getByText('Want it confirmed sooner?', { exact: true })).toBeVisible();
    await expect(pending.getByText(
      'Your recipient and amount stay unchanged. You’ll review the new network fee before signing.',
      { exact: true },
    )).toBeVisible();
    await pending.getByRole('button', { name: 'Speed up transaction' }).click();

    const speedUpHeading = fullpage.getByRole('heading', { name: 'Review speed-up' });
    await expect(speedUpHeading).toBeVisible({ timeout: 45_000 });
    const speedUpReview = speedUpHeading.locator('..');
    await expect(speedUpReview.getByText(
      'The recipient and amount stay the same. Drey replaces the pending transaction with a higher-fee version.',
      { exact: true },
    )).toBeVisible();
    const recipientOutput = speedUpReview.getByText(destination, { exact: true }).locator('..');
    await expect(recipientOutput).toBeVisible();
    await expect(recipientOutput.getByText('50,000 sats', { exact: true })).toBeVisible();
    const replacementFeeText = await speedUpReview.getByText('Fee', { exact: true })
      .locator('..').locator('dd').textContent();
    const replacementFee = Number((replacementFeeText ?? '').replace(/[^0-9]/gu, ''));
    expect(replacementFee).toBeGreaterThan(original.feeSats);
    const speedUpPassword = fullpage.getByLabel('Confirm app password');
    if (await speedUpPassword.count() > 0) await fillPrivate(speedUpPassword, TEST_PASSWORD);
    await fullpage.getByRole('button', { name: 'Sign and speed up' }).click();
    await expect.poll(async () => ({
      sent: await fullpage.locator('h1').first().isVisible()
        .catch(() => false),
      error: await fullpage.getByRole('alert').textContent().catch(() => null),
      reviewVisible: await fullpage.getByRole('heading', { name: 'Review speed-up' }).isVisible()
        .catch(() => false),
      approveEnabled: await fullpage.getByRole('button', { name: 'Sign and speed up' }).isEnabled()
        .catch(() => false),
      title: await fullpage.locator('h1').first().textContent().catch(() => null),
    }), {
      timeout: 45_000,
      intervals: [250, 500, 1_000],
    }).toEqual({
      sent: true,
      error: null,
      reviewVisible: false,
      approveEnabled: false,
      title: 'Transaction sent',
    });
    const replacementTxid = checkedTxid(
      await fullpage.locator('a[href*="/tx/"] code').textContent(),
    );
    expect(replacementTxid).not.toBe(originalTxid);
    await transactionInMempool(replacementTxid);
    await transactionNotInMempool(originalTxid);
    const replacement = await assertTransactionIntent(
      replacementTxid,
      funding,
      destination,
      50_000,
      { min: 1 },
    );
    expect(replacement.feeSats).toBe(replacementFee);
    expect(replacement.feeSats).toBeGreaterThan(original.feeSats);
    await confirmTransaction(replacementTxid);
    await fullpage.getByRole('button', { name: 'Activity' }).click();
    await expectReplacementActivity(fullpage, '−50,000 sats');
    await refreshPopup(popup);
    await expect(popup.page.getByTestId('balance-card')).toContainText(
      `${(150_000 - replacement.feeSats).toLocaleString('en-US')} sats`,
      { timeout: 60_000 },
    );
  } finally {
    await fullpage.close().catch(() => undefined);
  }
});

test('imports and clearly reviews a real BIP-321 payment request', async ({
  onboarding,
  popup,
  extensionContext,
  extensionId,
}) => {
  test.slow();
  await assertRegtestReady();
  const address = await createFundableWallet(onboarding, popup, 'BIP-321 regtest E2E');
  const funding = await fundAndConfirm(address, 160_000);
  const destination = await freshExternalAddress();

  const fullpage = await openActivity(extensionContext, extensionId);
  try {
    await expectActivityState(fullpage, '+160,000 sats', 'Confirmed');
    await refreshPopup(popup);
    await expect(popup.page.getByTestId('balance-card')).toContainText('160,000 sats', {
      timeout: 60_000,
    });
    await fullpage.goto(`chrome-extension://${extensionId}/fullpage.html#/send`);
    const recipient = fullpage.getByLabel('Recipient address or BIP-321 URI');
    const paymentRequest = `bitcoin:${destination}?amount=0.0004` +
      '&label=Neighborhood%20Coffee&message=Order%2042';
    await recipient.evaluate((element, value) => {
      if (!(element instanceof HTMLInputElement)) throw new Error('recipient field is not an input');
      const transfer = new DataTransfer();
      transfer.setData('text', value);
      element.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }));
    }, paymentRequest);
    await expect.poll(async () => ({
      recipientResolved: await recipient.inputValue() === destination,
      amountResolved: await fullpage.getByLabel('Amount (BTC)').inputValue() === '0.0004',
    })).toEqual({ recipientResolved: true, amountResolved: true });
    await fullpage.getByRole('radio', { name: 'Custom' }).check();
    await fullpage.getByLabel('Fee rate (sat/vB)').fill('1');
    await fullpage.getByRole('button', { name: 'Review transaction' }).click();
    const reviewHeading = fullpage.getByRole('heading', { name: 'Review transaction' });
    await expect(reviewHeading).toBeVisible({
      timeout: 45_000,
    });
    const review = reviewHeading.locator('..');
    await expect.poll(async () => {
      const text = await review.textContent();
      return {
        intendedDestination: text?.includes(destination) === true,
        requestedAmount: text?.includes('40,000 sats') === true,
      };
    }).toEqual({ intendedDestination: true, requestedAmount: true });
    await expect(review.getByText('Payment request details', { exact: true })).toBeVisible();
    await expect(review.getByText('Neighborhood Coffee', { exact: true })).toBeVisible();
    await expect(review.getByText('Order 42', { exact: true })).toBeVisible();
    await expect(review.getByText(
      'Provided by the payment request to help you verify it. This information is not sent on-chain.',
      { exact: true },
    )).toBeVisible();
    const password = fullpage.getByLabel('Confirm app password');
    if (await password.count() > 0) await fillPrivate(password, TEST_PASSWORD);
    await fullpage.getByRole('button', { name: 'Sign and broadcast' }).click();
    await expect(fullpage.getByRole('heading', { name: 'Transaction sent' })).toBeVisible({
      timeout: 45_000,
    });
    const txid = checkedTxid(
      await fullpage.locator('a[href*="/tx/"] code').textContent(),
    );
    await transactionInMempool(txid);
    const { feeSats } = await assertTransactionIntent(
      txid,
      funding,
      destination,
      40_000,
    );
    await confirmTransaction(txid);

    await fullpage.getByRole('button', { name: 'Activity' }).click();
    await expectActivityState(fullpage, '−40,000 sats', 'Confirmed');
    await refreshPopup(popup);
    await expect(popup.page.getByTestId('balance-card')).toContainText(
      `${(120_000 - feeSats).toLocaleString('en-US')} sats`,
      { timeout: 60_000 },
    );
  } finally {
    await fullpage.close().catch(() => undefined);
  }
});

test('fails closed and reconciles one confirmed payment through a shallow reorg', async ({
  onboarding,
  popup,
  extensionContext,
  extensionId,
}) => {
  test.slow();
  await assertRegtestReady();
  const address = await createFundableWallet(onboarding, popup, 'Reorg regtest E2E');
  const funding = await fundAndConfirm(address, 90_000);

  const fullpage = await openActivity(extensionContext, extensionId);
  try {
    await expectActivityState(fullpage, '+90,000 sats', 'Confirmed');
    const displacedBlockHash = await reorgLatestTransactionToMempool(funding.txid);
    // The signed gateway is fail-closed while Core, Fulcrum, and ord describe
    // different tips. A failed refresh must retain the last coherent view
    // instead of projecting the now-mempool transaction from mixed sources.
    await expectActivityState(fullpage, '+90,000 sats', 'Confirmed');
    await refreshPopup(popup);
    await expect(popup.page.getByTestId('balance-card')).toContainText('90,000 sats');

    await assertTransactionReconfirmed(funding.txid, displacedBlockHash);
    await expectActivityState(fullpage, '+90,000 sats', 'Confirmed');
    await refreshPopup(popup);
    await expect(popup.page.getByLabel('Connected')).toBeVisible({ timeout: 20_000 });
    await expect(popup.page.getByTestId('balance-card')).toContainText('90,000 sats', {
      timeout: 60_000,
    });
  } finally {
    await fullpage.close().catch(() => undefined);
  }
});
