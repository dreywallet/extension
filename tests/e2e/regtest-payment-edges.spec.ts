import type { BrowserContext, Page } from '@playwright/test';
import { test, expect, type OnboardingPage, type PopupPage } from './fixtures';
import { fillPrivate } from './pages';
import { terminateExtensionWorker, wakeExtensionWorker } from './worker';
import {
  assertConsolidationTransaction,
  assertRegtestReady,
  assertSendMaxTransaction,
  assertTransactionIntent,
  confirmTransaction,
  freshExternalAddress,
  fundWithoutConfirmation,
  mempoolTransactionIds,
  mineBlock,
  popupWalletSummary,
  transactionInMempool,
  type FundingOutpoint,
} from './regtest';

const TEST_PASSWORD = ['disposable', 'regtest', 'payment', 'edges', 'only'].join('-');

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

function coinSelectionName(coin: FundingOutpoint): string {
  const short = `${coin.txid.slice(0, 4)}…${coin.txid.slice(-4)}:${coin.vout}`;
  return `Select coin ${short}, ${coin.sats.toLocaleString('en-US')} sats`;
}

function coinDetailsName(coin: FundingOutpoint): string {
  const short = `${coin.txid.slice(0, 4)}…${coin.txid.slice(-4)}:${coin.vout}`;
  return `Details for coin ${short}`;
}

function satsFromText(value: string | null, label: string): number {
  const digits = value?.replace(/[^0-9]/gu, '') ?? '';
  const sats = Number(digits);
  if (digits === '' || !Number.isSafeInteger(sats)) {
    throw new Error(`${label} did not contain an integer satoshi amount`);
  }
  return sats;
}

async function createFundedWallet(input: {
  onboarding: OnboardingPage;
  popup: PopupPage;
  context: BrowserContext;
  extensionId: string;
  name: string;
  amounts: readonly number[];
}): Promise<{ page: Page; fundings: FundingOutpoint[]; totalSats: number }> {
  await assertRegtestReady();
  await input.onboarding.open();
  await input.onboarding.createDisposable({ password: TEST_PASSWORD, name: input.name });
  await input.popup.open();
  await expect(input.popup.page.getByText('Regtest', { exact: true })).toBeVisible();
  await input.popup.page.getByRole('button', { name: 'Receive' }).click();
  const address = checkedRegtestAddress(
    await input.popup.page.getByTestId('receive-address').textContent(),
  );
  await input.popup.page.getByRole('button', { name: 'Close' }).click();

  const fundings: FundingOutpoint[] = [];
  for (const amount of input.amounts) fundings.push(await fundWithoutConfirmation(address, amount));
  await mineBlock();

  const page = await input.context.newPage();
  await page.goto(`chrome-extension://${input.extensionId}/fullpage.html#/send/activity`);
  await expect(page.getByRole('heading', { name: 'Transaction activity' })).toBeVisible();
  const refresh = page.getByRole('button', { name: 'Refresh status' });
  await expect(refresh).toBeEnabled({ timeout: 60_000 });
  await refresh.click();
  await expect(refresh).toBeEnabled({ timeout: 60_000 });
  for (const amount of input.amounts) {
    await expect(page.locator('details').filter({
      hasText: `+${amount.toLocaleString('en-US')} sats`,
    })).toHaveCount(1, { timeout: 60_000 });
  }
  const totalSats = input.amounts.reduce((sum, amount) => sum + amount, 0);
  await input.popup.page.bringToFront();
  await input.popup.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  try {
    await expect(input.popup.page.getByTestId('balance-card')).toContainText(
      `${totalSats.toLocaleString('en-US')} sats`,
      { timeout: 60_000 },
    );
  } catch {
    throw new Error(`funded popup did not converge: ${JSON.stringify(
      await popupWalletSummary(input.popup.page),
    )}`);
  }
  return { page, fundings, totalSats };
}

async function chooseCustomOneSat(page: Page): Promise<void> {
  await page.getByRole('radio', { name: 'Custom' }).check();
  await page.getByLabel('Fee rate (sat/vB)').fill('1');
}

async function signAndReadTxid(page: Page): Promise<string> {
  const password = page.getByLabel('Confirm app password');
  if (await password.count() > 0) await fillPrivate(password, TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign and broadcast' }).click();
  await expect(page.getByRole('heading', { name: 'Transaction sent' })).toBeVisible({
    timeout: 45_000,
  });
  return checkedTxid(await page.locator('a[href*="/tx/"] code').textContent());
}

async function expectPopupBalance(popup: PopupPage, sats: number): Promise<void> {
  await popup.page.bringToFront();
  await popup.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(popup.page.getByTestId('balance-card')).toContainText(
    `${sats.toLocaleString('en-US')} sats`,
    { timeout: 60_000 },
  );
}

test('@extended sends the exact maximum with no hidden change output', async ({
  onboarding,
  popup,
  extensionContext,
  extensionId,
}) => {
  test.slow();
  const wallet = await createFundedWallet({
    onboarding, popup, context: extensionContext, extensionId,
    name: 'Send Max regtest E2E', amounts: [125_000],
  });
  try {
    const destination = await freshExternalAddress();
    await wallet.page.getByRole('button', { name: 'Send', exact: true }).click();
    await fillPrivate(
      wallet.page.getByLabel('Recipient address or BIP-321 URI'),
      destination,
    );
    await wallet.page.getByLabel('Send maximum available').check();
    await chooseCustomOneSat(wallet.page);
    await wallet.page.getByRole('button', { name: 'Review transaction' }).click();

    const heading = wallet.page.getByRole('heading', { name: 'Review transaction' });
    await expect(heading).toBeVisible({ timeout: 45_000 });
    const review = heading.locator('..');
    const sending = satsFromText(
      await review.getByText('Sending', { exact: true }).locator('..').locator('dd').textContent(),
      'Send Max review amount',
    );
    const fee = satsFromText(
      await review.getByText('Fee', { exact: true }).locator('..').locator('dd').textContent(),
      'Send Max review fee',
    );
    const total = satsFromText(
      await review.getByText('Total', { exact: true }).locator('..').locator('dd').textContent(),
      'Send Max review total',
    );
    expect(total).toBe(wallet.totalSats);
    expect(sending + fee).toBe(wallet.totalSats);
    await expect(review.getByText(destination, { exact: true }).locator('..'))
      .toContainText(`${sending.toLocaleString('en-US')} sats`);

    const txid = await signAndReadTxid(wallet.page);
    await transactionInMempool(txid);
    const broadcast = await assertSendMaxTransaction(txid, wallet.fundings[0]!, destination);
    expect(broadcast.feeSats).toBe(fee);
    expect(broadcast.outputSats).toBe(sending);
    await confirmTransaction(txid);
    await expectPopupBalance(popup, 0);
  } finally {
    await wallet.page.close().catch(() => undefined);
  }
});

test('@extended spends only the coin the user selected', async ({
  onboarding,
  popup,
  extensionContext,
  extensionId,
}) => {
  test.slow();
  const wallet = await createFundedWallet({
    onboarding, popup, context: extensionContext, extensionId,
    name: 'Coin control regtest E2E', amounts: [75_000, 85_000, 95_000],
  });
  try {
    const selected = wallet.fundings[1]!;
    await wallet.page.getByRole('button', { name: 'Manage coins' }).click();
    await wallet.page.getByRole('checkbox', {
      name: coinSelectionName(selected),
    }).check();
    await expect(wallet.page.getByText('1 selected · 85,000 sats')).toBeVisible();
    await wallet.page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(wallet.page.getByText('1 manually selected inputs')).toBeVisible();

    const destination = await freshExternalAddress();
    await fillPrivate(
      wallet.page.getByLabel('Recipient address or BIP-321 URI'),
      destination,
    );
    await wallet.page.getByLabel('Amount (BTC)').fill('0.00040000');
    await chooseCustomOneSat(wallet.page);
    await wallet.page.getByRole('button', { name: 'Review transaction' }).click();
    const heading = wallet.page.getByRole('heading', { name: 'Review transaction' });
    await expect(heading).toBeVisible({ timeout: 45_000 });
    const review = heading.locator('..');
    await expect(review.getByText('Inputs', { exact: true }).locator('..').locator('dd'))
      .toHaveText('1');
    await expect(review.locator('code').filter({ hasText: `${selected.txid}:${selected.vout}` }))
      .toHaveCount(1);

    const txid = await signAndReadTxid(wallet.page);
    await transactionInMempool(txid);
    const broadcast = await assertTransactionIntent(txid, selected, destination, 40_000);
    await confirmTransaction(txid);
    await expectPopupBalance(popup, wallet.totalSats - 40_000 - broadcast.feeSats);
  } finally {
    await wallet.page.close().catch(() => undefined);
  }
});

test('@extended consolidates exactly two selected coins and leaves the third untouched', async ({
  onboarding,
  popup,
  extensionContext,
  extensionId,
}) => {
  test.slow();
  const wallet = await createFundedWallet({
    onboarding, popup, context: extensionContext, extensionId,
    name: 'Consolidation regtest E2E', amounts: [60_000, 70_000, 110_000],
  });
  try {
    const selected = wallet.fundings.slice(0, 2);
    const untouched = wallet.fundings[2]!;
    await wallet.page.getByRole('button', { name: 'Manage coins' }).click();
    await chooseCustomOneSat(wallet.page);
    for (const coin of selected) {
      await wallet.page.getByRole('checkbox', {
        name: coinSelectionName(coin),
      }).check();
    }
    await expect(wallet.page.getByText('2 selected · 130,000 sats')).toBeVisible();
    await wallet.page.getByRole('button', { name: 'Consolidate selected' }).click();

    const heading = wallet.page.getByRole('heading', { name: 'Review transaction' });
    await expect(heading).toBeVisible({ timeout: 45_000 });
    const review = heading.locator('..');
    await expect(review.getByText('Inputs', { exact: true }).locator('..').locator('dd'))
      .toHaveText('2');
    for (const coin of selected) {
      await expect(review.locator('code').filter({ hasText: `${coin.txid}:${coin.vout}` }))
        .toHaveCount(1);
    }
    await expect(review.locator('code').filter({ hasText: `${untouched.txid}:${untouched.vout}` }))
      .toHaveCount(0);

    const txid = await signAndReadTxid(wallet.page);
    await transactionInMempool(txid);
    const broadcast = await assertConsolidationTransaction(txid, selected);
    await confirmTransaction(txid);
    await expectPopupBalance(popup, wallet.totalSats - broadcast.feeSats);

    await wallet.page.getByRole('button', { name: 'Manage coins' }).click();
    await expect.poll(async () => {
      await wallet.page.getByRole('button', { name: 'Refresh' }).click();
      await wallet.page.waitForTimeout(250);
      return wallet.page.locator('input[type="checkbox"][aria-label^="Select coin"]').count();
    }, {
      timeout: 60_000,
      intervals: [500, 1_000, 2_000, 3_000],
    }).toBe(2);
    await expect(wallet.page.getByRole('checkbox', {
      name: coinSelectionName({ txid, vout: 0, sats: broadcast.outputSats }),
    })).toBeVisible();
    await expect(wallet.page.getByRole('checkbox', {
      name: coinSelectionName(untouched),
    })).toBeVisible();
  } finally {
    await wallet.page.close().catch(() => undefined);
  }
});

test('@extended freezes and unfreezes a real coin without letting automatic selection spend it', async ({
  onboarding,
  popup,
  extensionContext,
  extensionId,
}) => {
  test.slow();
  const wallet = await createFundedWallet({
    onboarding, popup, context: extensionContext, extensionId,
    name: 'Frozen coin regtest E2E', amounts: [45_000, 95_000],
  });
  try {
    const spendable = wallet.fundings[0]!;
    const frozen = wallet.fundings[1]!;
    await wallet.page.getByRole('button', { name: 'Manage coins' }).click();

    const frozenCheckbox = wallet.page.getByRole('checkbox', {
      name: coinSelectionName(frozen),
    });
    await wallet.page.getByLabel(coinDetailsName(frozen)).click();
    await wallet.page.getByRole('button', { name: 'Freeze', exact: true }).click();
    const unavailable = wallet.page.getByText('Unavailable', { exact: true });
    await expect(unavailable).toBeVisible({ timeout: 45_000 });
    await expect(unavailable.locator('xpath=ancestor::summary[1]'))
      .toContainText('1 coin · 95,000 sats');
    await unavailable.click();
    await expect(frozenCheckbox).toBeDisabled();
    await expect(wallet.page.getByText(
      'Frozen by you — use Unfreeze to make it available',
      { exact: true },
    )).toBeVisible();

    await wallet.page.getByLabel(coinDetailsName(frozen)).click();
    await wallet.page.getByRole('button', { name: 'Unfreeze', exact: true }).click();
    await expect(frozenCheckbox).toBeEnabled({ timeout: 45_000 });
    await wallet.page.getByLabel(coinDetailsName(frozen)).click();
    await wallet.page.getByRole('button', { name: 'Freeze', exact: true }).click();
    await expect(unavailable).toBeVisible({ timeout: 45_000 });
    await unavailable.click();
    await expect(frozenCheckbox).toBeDisabled();

    await popup.page.bringToFront();
    await popup.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(async () => {
      const summary = await popupWalletSummary(popup.page);
      return {
        availableSats: summary.availableSats,
        userFrozenSats: summary.userFrozenSats,
      };
    }, { timeout: 60_000 }).toEqual({
      availableSats: String(spendable.sats),
      userFrozenSats: String(frozen.sats),
    });

    await wallet.page.bringToFront();
    await wallet.page.getByRole('button', { name: 'Send', exact: true }).click();
    const destination = await freshExternalAddress();
    await fillPrivate(
      wallet.page.getByLabel('Recipient address or BIP-321 URI'),
      destination,
    );
    await wallet.page.getByLabel('Amount (BTC)').fill('0.00030000');
    await chooseCustomOneSat(wallet.page);
    await wallet.page.getByRole('button', { name: 'Review transaction' }).click();

    const heading = wallet.page.getByRole('heading', { name: 'Review transaction' });
    await expect(heading).toBeVisible({ timeout: 45_000 });
    const review = heading.locator('xpath=ancestor::section[1]');
    await expect(review.getByText('Inputs', { exact: true }).locator('..').locator('dd'))
      .toHaveText('1');
    await expect(review.locator('code').filter({
      hasText: `${spendable.txid}:${spendable.vout}`,
    })).toHaveCount(1);
    await expect(review.locator('code').filter({
      hasText: `${frozen.txid}:${frozen.vout}`,
    })).toHaveCount(0);

    const txid = await signAndReadTxid(wallet.page);
    await transactionInMempool(txid);
    const broadcast = await assertTransactionIntent(txid, spendable, destination, 30_000);
    await confirmTransaction(txid);
    await popup.page.bringToFront();
    await popup.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(async () => {
      const summary = await popupWalletSummary(popup.page);
      return {
        availableSats: summary.availableSats,
        userFrozenSats: summary.userFrozenSats,
      };
    }, { timeout: 60_000 }).toEqual({
      availableSats: String(spendable.sats - 30_000 - broadcast.feeSats),
      userFrozenSats: String(frozen.sats),
    });
  } finally {
    await wallet.page.close().catch(() => undefined);
  }
});

test('@extended preserves an unknown broadcast without retrying after a lost response', async ({
  onboarding,
  popup,
  extensionContext,
  extensionId,
}) => {
  test.slow();
  const wallet = await createFundedWallet({
    onboarding, popup, context: extensionContext, extensionId,
    name: 'Gateway retry regtest E2E', amounts: [110_000],
  });
  try {
    const funding = wallet.fundings[0]!;
    const destination = await freshExternalAddress();
    await wallet.page.getByRole('button', { name: 'Send', exact: true }).click();
    await fillPrivate(
      wallet.page.getByLabel('Recipient address or BIP-321 URI'),
      destination,
    );
    await wallet.page.getByLabel('Amount (BTC)').fill('0.00030000');
    await chooseCustomOneSat(wallet.page);
    await wallet.page.getByRole('button', { name: 'Review transaction' }).click();
    const reviewHeading = wallet.page.getByRole('heading', { name: 'Review transaction' });
    await expect(reviewHeading).toBeVisible({ timeout: 45_000 });
    const review = reviewHeading.locator('xpath=ancestor::section[1]');
    await expect(review.getByText(destination, { exact: true })).toBeVisible();
    await expect(review.getByRole('definition').filter({ hasText: '30,000 sats' })).toBeVisible();
    const password = wallet.page.getByLabel('Confirm app password');
    if (await password.count() > 0) await fillPrivate(password, TEST_PASSWORD);
    const before = await mempoolTransactionIds();
    let broadcastRequests = 0;
    const broadcastUrl = 'http://127.0.0.1:18480/v1/transactions/broadcast';

    await extensionContext.route(broadcastUrl, async (route) => {
      broadcastRequests += 1;
      // Let the real gateway and Core accept the transaction, then discard
      // only the response so the wallet must take its indeterminate path.
      await route.fetch();
      await route.abort('failed');
    });
    try {
      await review.getByRole('button', { name: 'Sign and broadcast' }).click();
      await expect(wallet.page.getByRole('heading', { name: 'Broadcast outcome unknown' }))
        .toBeVisible({ timeout: 45_000 });
      await expect(wallet.page.getByText(
        'Broadcast state is unknown. The signed transaction is saved and will not be resubmitted automatically.',
        { exact: true },
      )).toBeVisible();
      const result = wallet.page.getByRole('heading', {
        name: 'Broadcast outcome unknown',
      }).locator('xpath=ancestor::section[1]');
      await expect(result.getByRole('button', { name: 'Activity', exact: true })).toBeVisible();
      await expect(wallet.page.getByRole('button', { name: 'Send another' })).toHaveCount(0);
    } finally {
      await extensionContext.unroute(broadcastUrl);
    }
    expect(broadcastRequests).toBe(1);
    const txid = checkedTxid(await wallet.page.locator('a[href*="/tx/"] code').textContent());
    await transactionInMempool(txid);
    await assertTransactionIntent(txid, funding, destination, 30_000);
    expect(await mempoolTransactionIds()).toEqual([...before, txid].sort());

    const result = wallet.page.getByRole('heading', {
      name: 'Broadcast outcome unknown',
    }).locator('xpath=ancestor::section[1]');
    await result.getByRole('button', { name: 'Activity', exact: true }).click();
    await expect(wallet.page.getByRole('heading', { name: 'Transaction activity' })).toBeVisible();
    await expect(wallet.page.getByText(/manual reconciliation/iu).first()).toBeVisible({
      timeout: 45_000,
    });
    expect(await mempoolTransactionIds()).toEqual([...before, txid].sort());

    await terminateExtensionWorker(extensionContext, extensionId);
    await wakeExtensionWorker(wallet.page, extensionId);
    await wallet.page.goto(`chrome-extension://${extensionId}/fullpage.html#/send/activity`);
    await expect(wallet.page.getByText(/manual reconciliation/iu).first()).toBeVisible({
      timeout: 45_000,
    });
    expect(await mempoolTransactionIds()).toEqual([...before, txid].sort());
  } finally {
    await wallet.page.close().catch(() => undefined);
  }
});

test('@extended refuses an underfunded manual send without touching the mempool', async ({
  onboarding,
  popup,
  extensionContext,
  extensionId,
}) => {
  test.slow();
  const wallet = await createFundedWallet({
    onboarding, popup, context: extensionContext, extensionId,
    name: 'Insufficient funds regtest E2E', amounts: [20_000],
  });
  try {
    const selected = wallet.fundings[0]!;
    await wallet.page.getByRole('button', { name: 'Manage coins' }).click();
    await wallet.page.getByRole('checkbox', {
      name: coinSelectionName(selected),
    }).check();
    await wallet.page.getByRole('button', { name: 'Send', exact: true }).click();
    const destination = await freshExternalAddress();
    await fillPrivate(
      wallet.page.getByLabel('Recipient address or BIP-321 URI'),
      destination,
    );
    await wallet.page.getByLabel('Amount (BTC)').fill('0.00019999');
    await chooseCustomOneSat(wallet.page);
    const before = await mempoolTransactionIds();
    await wallet.page.getByRole('button', { name: 'Review transaction' }).click();
    await expect(wallet.page.getByText(
      'There is not enough eligible bitcoin for this transaction and fee.',
      { exact: true },
    )).toBeVisible({ timeout: 45_000 });
    await expect(wallet.page.getByRole('heading', { name: 'Review transaction' }))
      .toHaveCount(0);
    expect(await mempoolTransactionIds()).toEqual(before);
    await expectPopupBalance(popup, wallet.totalSats);
  } finally {
    await wallet.page.close().catch(() => undefined);
  }
});
