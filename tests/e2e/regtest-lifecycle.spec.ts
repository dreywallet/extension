import { test, expect } from './fixtures';
import { fillPrivate } from './pages';
import {
  assertTransactionIntent,
  assertRegtestReady,
  confirmTransaction,
  freshExternalAddress,
  fundAndConfirm,
  mempoolTransactionIds,
  popupWalletSummary,
  transactionInMempool,
} from './regtest';
import { terminateExtensionWorker, wakeExtensionWorker } from './worker';

const TEST_PASSWORD = ['disposable', 'regtest', 'password', 'only'].join('-');
const FUNDING_SATS = 200_000;
const SEND_SATS = 50_000;
const SEND_BTC = (SEND_SATS / 100_000_000).toFixed(8);

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

test('creates, funds, spends, and confirms a disposable wallet on real regtest', async ({
  onboarding,
  popup,
  extensionContext,
  extensionId,
}) => {
  test.slow();
  await assertRegtestReady();

  await onboarding.open();
  await onboarding.createDisposable({ password: TEST_PASSWORD, name: 'Disposable regtest E2E' });

  await popup.open();
  await expect(popup.page.getByText('Available to send')).toBeVisible({ timeout: 45_000 });
  await expect(popup.page.getByText('Regtest', { exact: true })).toBeVisible();
  await popup.page.getByRole('button', { name: 'Receive' }).click();
  const receiveAddress = checkedRegtestAddress(
    await popup.page.getByTestId('receive-address').textContent(),
  );
  await popup.page.getByRole('button', { name: 'Close' }).click();

  const funding = await fundAndConfirm(receiveAddress, FUNDING_SATS);
  let expectedFinalBalance = 0;
  const fullpage = await extensionContext.newPage();
  try {
    await fullpage.goto(`chrome-extension://${extensionId}/fullpage.html#/send/activity`);
    await expect(fullpage.getByRole('heading', { name: 'Transaction activity' })).toBeVisible();
    await fullpage.getByRole('button', { name: 'Refresh status' }).click();
    await expect(fullpage.getByText('+200,000 sats').first()).toBeVisible({ timeout: 60_000 });
    await popup.page.bringToFront();
    await popup.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    try {
      await expect(popup.page.getByTestId('balance-card')).toContainText('200,000 sats', {
        timeout: 60_000,
      });
    } catch {
      throw new Error(`funded popup did not converge: ${JSON.stringify(
        await popupWalletSummary(popup.page),
      )}`);
    }

    const destination = await freshExternalAddress();
    await fullpage.goto(`chrome-extension://${extensionId}/fullpage.html#/send`);
    await expect(fullpage.getByRole('heading', { name: 'Send Bitcoin' })).toBeVisible();
    await fillPrivate(fullpage.getByLabel('Recipient address or BIP-321 URI'), destination);
    await fullpage.getByLabel('Amount (BTC)').fill(SEND_BTC);
    await fullpage.getByRole('radio', { name: 'Custom' }).check();
    await fullpage.getByLabel('Fee rate (sat/vB)').fill('1');
    await fullpage.getByRole('button', { name: 'Review transaction' }).click();
    await expect(fullpage.getByRole('heading', { name: 'Review transaction' })).toBeVisible({
      timeout: 45_000,
    });
    const review = fullpage.getByRole('heading', { name: 'Review transaction' }).locator('..');
    await expect.poll(async () => {
      const text = await review.textContent();
      return {
        intendedDestination: text?.includes(destination) === true,
        intendedAmount: text?.includes(`${SEND_SATS.toLocaleString('en-US')} sats`) === true,
      };
    }).toEqual({
      intendedDestination: true,
      intendedAmount: true,
    });
    await expect(review.getByText('Fee rate', { exact: true }).locator('..').locator('dd'))
      .toHaveText('1 sat/vB');
    await expect(review.getByText('Inputs', { exact: true }).locator('..').locator('dd'))
      .toHaveText('1');

    const password = fullpage.getByLabel('Confirm app password');
    if (await password.count() > 0) await fillPrivate(password, TEST_PASSWORD);
    await fullpage.getByRole('button', { name: 'Sign and broadcast' }).click();
    await expect(fullpage.getByRole('heading', { name: 'Transaction sent' })).toBeVisible({
      timeout: 45_000,
    });
    const txid = checkedTxid(await fullpage.locator('a[href*="/tx/"] code').textContent());
    await transactionInMempool(txid);
    const { feeSats } = await assertTransactionIntent(txid, funding, destination, SEND_SATS);
    expectedFinalBalance = FUNDING_SATS - SEND_SATS - feeSats;
    const result = fullpage.locator('section[data-status]');
    await expect.poll(async () => {
      const text = await result.textContent();
      return {
        intendedDestination: text?.includes(destination) === true,
        intendedAmount: text?.includes(`${SEND_SATS.toLocaleString('en-US')} sats`) === true,
        decodedFee: text?.includes(`${feeSats.toLocaleString('en-US')} sats`) === true,
      };
    }).toEqual({ intendedDestination: true, intendedAmount: true, decodedFee: true });

    const mempoolBeforeRestart = await mempoolTransactionIds();
    await terminateExtensionWorker(extensionContext, extensionId);
    await wakeExtensionWorker(fullpage, extensionId);
    await fullpage.goto(`chrome-extension://${extensionId}/fullpage.html#/send/activity`);
    const pending = fullpage.locator('details').filter({
      hasText: `−${SEND_SATS.toLocaleString('en-US')} sats`,
    });
    await expect(pending).toHaveCount(1, { timeout: 60_000 });
    await expect(pending).toContainText('Pending');
    expect(await mempoolTransactionIds()).toEqual(mempoolBeforeRestart);

    await confirmTransaction(txid);
    await terminateExtensionWorker(extensionContext, extensionId);
    await wakeExtensionWorker(fullpage, extensionId);
    await fullpage.goto(`chrome-extension://${extensionId}/fullpage.html#/send/activity`);
    await expect(fullpage.getByRole('heading', { name: 'Transaction activity' })).toBeVisible();
    await fullpage.getByRole('button', { name: 'Refresh status' }).click();
    const newest = fullpage.locator('details').first();
    await expect.poll(async () => {
      const text = await newest.textContent();
      return {
        confirmed: text?.includes('Confirmed') === true,
        expectedAmount: text?.includes(`−${SEND_SATS.toLocaleString('en-US')} sats`) === true,
      };
    }, { timeout: 60_000 }).toEqual({ confirmed: true, expectedAmount: true });
  } finally {
    await fullpage.close().catch(() => undefined);
  }

  await popup.page.bringToFront();
  await popup.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(popup.page.getByTestId('balance-card')).toContainText(
    `${expectedFinalBalance.toLocaleString('en-US')} sats`,
    {
      timeout: 60_000,
    },
  );
});
