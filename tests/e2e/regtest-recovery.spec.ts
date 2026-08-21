import { expect, type Page } from '@playwright/test';
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english';
import { TEST_NETWORK, p2tr, p2wpkh } from '@scure/btc-signer';
import { test } from './fixtures';
import { fillPrivate } from './pages';
import {
  assertRegtestReady,
  assertTransactionIntent,
  createOrdinalFixture,
  freshExternalAddress,
  fundAndConfirm,
  fundWithoutConfirmation,
  mineBlock,
  popupWalletSummary,
  transactionInMempool,
  type FundingOutpoint,
} from './regtest';
import { terminateExtensionWorker, wakeExtensionWorker } from './worker';

const TEST_PASSWORD = ['public', 'regtest', 'recovery', 'only'].join('-');
const FUNDING_SATS = 200_000;
const SEND_SATS = 50_000;
type AddressKind = 'payment' | 'ordinals';
const REGTEST_NETWORK = { ...TEST_NETWORK, bech32: 'bcrt' };

function fixtureAddress(
  mnemonic: string,
  kind: AddressKind,
  account: number,
  options: { passphrase?: string; chain?: 0 | 1; index?: number } = {},
): string {
  const seed = mnemonicToSeedSync(mnemonic, options.passphrase);
  const root = HDKey.fromMasterSeed(seed);
  const purpose = kind === 'payment' ? 84 : 86;
  const node = root.derive(`m/${purpose}'/1'/${account}'`);
  try {
    const publicKey = node
      .deriveChild(options.chain ?? 0)
      .deriveChild(options.index ?? 0)
      .publicKey;
    if (publicKey === null) throw new Error('public test fixture did not derive a public key');
    const address = kind === 'payment'
      ? p2wpkh(publicKey, REGTEST_NETWORK).address
      : p2tr(publicKey.slice(1), undefined, REGTEST_NETWORK).address;
    if (address === undefined) throw new Error('public test fixture address encoding failed');
    return address;
  } finally {
    node.wipePrivateData();
    root.wipePrivateData();
    seed.fill(0);
  }
}

function coinSelectionName(coin: FundingOutpoint): string {
  const short = `${coin.txid.slice(0, 4)}…${coin.txid.slice(-4)}:${coin.vout}`;
  return `Select coin ${short}, ${coin.sats.toLocaleString('en-US')} sats`;
}

function coinDetailsName(coin: FundingOutpoint): string {
  const short = `${coin.txid.slice(0, 4)}…${coin.txid.slice(-4)}:${coin.vout}`;
  return `Details for coin ${short}`;
}

async function signPayment(
  page: Page,
  funding: FundingOutpoint,
  destination: string,
  sendSats: number,
): Promise<string> {
  await fillPrivate(page.getByLabel('Recipient address or BIP-321 URI'), destination);
  await page.getByLabel('Amount (BTC)').fill((sendSats / 100_000_000).toFixed(8));
  await page.getByRole('radio', { name: 'Custom' }).check();
  await page.getByLabel('Fee rate (sat/vB)').fill('1');
  await page.getByRole('button', { name: 'Review transaction' }).click();
  await expect(page.getByRole('heading', { name: 'Review transaction' })).toBeVisible({
    timeout: 45_000,
  });
  const review = page.getByRole('heading', { name: 'Review transaction' }).locator('..');
  await expect(review).toContainText(destination);
  await expect(review).toContainText(`${sendSats.toLocaleString('en-US')} sats`);
  await expect(review.locator('code').filter({
    hasText: `${funding.txid}:${funding.vout}`,
  })).toHaveCount(1);
  const password = page.getByLabel('Confirm app password');
  if (await password.count() > 0) await fillPrivate(password, TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign and broadcast' }).click();
  await expect(page.getByRole('heading', { name: 'Transaction sent' })).toBeVisible({
    timeout: 45_000,
  });
  const txid = checkedTxid(await page.locator('a[href*="/tx/"] code').textContent());
  await transactionInMempool(txid);
  await assertTransactionIntent(txid, funding, destination, sendSats);
  return txid;
}

function checkedTxid(value: string | null): string {
  if (value === null || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error('transaction result did not return a valid transaction id');
  }
  return value;
}

async function refreshGalleryUntilOne(page: Page): Promise<void> {
  const refresh = page.getByRole('button', { name: 'Refresh' });
  await expect(refresh).toBeEnabled({ timeout: 60_000 });
  await refresh.click();
  await expect(refresh).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByRole('tab', { name: 'All (1)' })).toBeVisible({ timeout: 60_000 });
}

test('@extended restores real multi-account history, survives worker restart, and spends', async ({
  onboarding,
  popup,
  extensionContext,
  extensionId,
}) => {
  test.slow();
  await assertRegtestReady();

  let mnemonic = generateMnemonic(english, 128);
  const paymentAddress = fixtureAddress(mnemonic, 'payment', 0);
  const laterOrdinalAddress = fixtureAddress(mnemonic, 'ordinals', 4);
  const funding = await fundAndConfirm(paymentAddress, FUNDING_SATS);
  const inscription = await createOrdinalFixture(laterOrdinalAddress);

  await onboarding.open();
  await onboarding.beginRestorePublicFixture({
    mnemonic,
    password: TEST_PASSWORD,
    name: 'Recovered regtest E2E',
  });
  mnemonic = '';
  await expect(onboarding.page.getByRole('status')).toContainText(/Scanning account/iu, {
    timeout: 30_000,
  });

  // Wake the replacement worker from a separate extension page so the restore
  // screen remains mounted and can present its durable Resume action in place.
  await terminateExtensionWorker(extensionContext, extensionId);
  const wakePage = await extensionContext.newPage();
  try {
    await wakeExtensionWorker(wakePage, extensionId);
  } finally {
    await wakePage.close().catch(() => undefined);
  }
  const scanOutcome = await Promise.race([
    onboarding.page.getByText('An account scan was interrupted.').waitFor({
      state: 'visible',
      timeout: 30_000,
    }).then(() => 'interrupted' as const),
    onboarding.page.getByText('Scan complete.').waitFor({
      state: 'visible',
      timeout: 30_000,
    }).then(() => 'completed' as const),
  ]);
  // A fast final unit may commit before Chrome finishes terminating the old
  // worker. Otherwise the durable checkpoint must surface a clear Resume path.
  if (scanOutcome === 'interrupted') {
    await onboarding.page.getByRole('button', { name: 'Resume scan' }).click();
  }
  await onboarding.finishRestoreScan(120_000);

  const fullpage = await extensionContext.newPage();
  try {
    await fullpage.goto(
      `chrome-extension://${extensionId}/fullpage.html#/settings/wallets-accounts`,
    );
    await expect(fullpage.getByRole('heading', { name: 'Wallets & accounts' })).toBeVisible();
    const activeAccount = fullpage.getByRole('button', { name: 'Active account' });
    await activeAccount.click();
    const accountMenu = fullpage.getByRole('menu', { name: 'Active account' });
    await expect(accountMenu.getByRole('menuitemradio')).toHaveCount(5, { timeout: 60_000 });
    for (let account = 1; account <= 5; account += 1) {
      await expect(accountMenu.getByRole('menuitemradio', { name: `Account ${account}` }))
        .toBeVisible();
    }
    await accountMenu.getByRole('menuitemradio', { name: 'Account 5' }).click();
    await expect(activeAccount).toContainText('Account 5');

    await popup.open();
    await expect(popup.page.getByRole('button', { name: 'Active account' }))
      .toContainText('Account 5');
    await popup.page.getByRole('button', { name: 'Ordinals', exact: true }).click();
    await refreshGalleryUntilOne(popup.page);
    const shelf = popup.page.locator('[data-gallery-collection]').first();
    await expect(shelf).toBeVisible();
    await shelf.click();
    const card = popup.page.locator('[data-gallery-inscription]');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Drey local regtest inscription fixture.');
    await card.getByText('Verified details').click();
    await expect(card).toContainText(inscription.inscriptionId);

    await popup.page.getByRole('button', { name: 'Active account' }).click();
    await popup.page.getByRole('menu', { name: 'Active account' })
      .getByRole('menuitemradio', { name: 'Account 1' }).click();
    await popup.page.getByRole('button', { name: 'Bitcoin', exact: true }).click();
    await expect(popup.page.getByTestId('balance-card')).toContainText('200,000 sats', {
      timeout: 60_000,
    });

    const destination = await freshExternalAddress();
    await fullpage.goto(`chrome-extension://${extensionId}/fullpage.html#/send`);
    await expect(fullpage.getByRole('heading', { name: 'Send Bitcoin' })).toBeVisible();
    await fillPrivate(fullpage.getByLabel('Recipient address or BIP-321 URI'), destination);
    await fullpage.getByLabel('Amount (BTC)').fill((SEND_SATS / 100_000_000).toFixed(8));
    await fullpage.getByRole('radio', { name: 'Custom' }).check();
    await fullpage.getByLabel('Fee rate (sat/vB)').fill('1');
    await fullpage.getByRole('button', { name: 'Review transaction' }).click();
    await expect(fullpage.getByRole('heading', { name: 'Review transaction' })).toBeVisible({
      timeout: 45_000,
    });
    const review = fullpage.getByRole('heading', { name: 'Review transaction' }).locator('..');
    await expect(review).toContainText(destination);
    await expect(review).toContainText('50,000 sats');
    const password = fullpage.getByLabel('Confirm app password');
    if (await password.count() > 0) await fillPrivate(password, TEST_PASSWORD);
    await fullpage.getByRole('button', { name: 'Sign and broadcast' }).click();
    await expect(fullpage.getByRole('heading', { name: 'Transaction sent' })).toBeVisible({
      timeout: 45_000,
    });
    const txid = checkedTxid(await fullpage.locator('a[href*="/tx/"] code').textContent());
    await transactionInMempool(txid);
    await assertTransactionIntent(txid, funding, destination, SEND_SATS);
  } finally {
    await fullpage.close().catch(() => undefined);
  }
});

test('@extended explains a wrong BIP39 passphrase, then restores and spends with the right one', async ({
  onboarding,
  popup,
  extensionContext,
  extensionId,
}) => {
  test.slow();
  await assertRegtestReady();

  let mnemonic = generateMnemonic(english, 128);
  let passphrase = ['correct', 'disposable', 'bip39', 'passphrase'].join('-');
  let wrongPassphrase = ['wrong', 'disposable', 'bip39', 'passphrase'].join('-');
  const paymentAddress = fixtureAddress(mnemonic, 'payment', 0, { passphrase });
  const funding = await fundAndConfirm(paymentAddress, 160_000);

  await onboarding.open();
  await onboarding.beginRestorePublicFixture({
    mnemonic,
    passphrase: wrongPassphrase,
    password: TEST_PASSWORD,
    name: 'Wrong passphrase regtest E2E',
  });
  wrongPassphrase = '';
  await expect(onboarding.page.getByText('Scan complete.')).toBeVisible({ timeout: 120_000 });
  await expect(onboarding.page.getByText('No wallet activity found yet')).toBeVisible();
  await expect(onboarding.page.getByText(/different optional passphrase/iu)).toBeVisible();
  await onboarding.finishRestoreScan(120_000);

  await onboarding.open();
  await onboarding.beginRestorePublicFixture({
    mnemonic,
    passphrase,
    password: TEST_PASSWORD,
    name: 'Passphrase recovery regtest E2E',
  });
  mnemonic = '';
  passphrase = '';
  await onboarding.finishRestoreScan(120_000);

  await popup.open();
  await expect(popup.page.getByTestId('balance-card')).toContainText('160,000 sats', {
    timeout: 60_000,
  });

  const fullpage = await extensionContext.newPage();
  try {
    await fullpage.goto(`chrome-extension://${extensionId}/fullpage.html#/settings/recovery`);
    await expect(fullpage.getByRole('heading', { name: 'Recovery center' })).toBeVisible();
    await expect(fullpage.getByText(
      'These words alone restore a different wallet. You also need the exact BIP39 passphrase.',
    )).toBeVisible();

    const destination = await freshExternalAddress();
    await fullpage.goto(`chrome-extension://${extensionId}/fullpage.html#/send`);
    await signPayment(fullpage, funding, destination, 50_000);
  } finally {
    await fullpage.close().catch(() => undefined);
  }
});

test('@extended continues a real boundary scan and spends a late receive address', async ({
  onboarding,
  popup,
  extensionContext,
  extensionId,
}) => {
  test.slow();
  await assertRegtestReady();

  let mnemonic = generateMnemonic(english, 128);
  const targets = [
    { chain: 0 as const, index: 19, sats: 70_000 },
    { chain: 0 as const, index: 39, sats: 80_000 },
    { chain: 0 as const, index: 59, sats: 95_000 },
    { chain: 1 as const, index: 19, sats: 60_000 },
    { chain: 1 as const, index: 39, sats: 65_000 },
  ];
  const fundings: FundingOutpoint[] = [];
  for (const target of targets) {
    const address = fixtureAddress(mnemonic, 'payment', 0, target);
    fundings.push(await fundWithoutConfirmation(address, target.sats));
  }
  await mineBlock();

  await onboarding.open();
  await onboarding.beginRestorePublicFixture({
    mnemonic,
    password: TEST_PASSWORD,
    name: 'Address gap recovery regtest E2E',
  });
  mnemonic = '';
  await expect(onboarding.page.getByText(
    'Activity was found near the scan boundary. Continue with an extended scan to look further?',
  )).toBeVisible({ timeout: 120_000 });
  await expect(onboarding.page.getByText('Scan complete.')).toHaveCount(0);
  await onboarding.page.getByRole('button', { name: 'Continue scanning' }).click();
  await onboarding.finishRestoreScan(120_000);

  const totalSats = targets.reduce((sum, target) => sum + target.sats, 0);
  await popup.open();
  await expect(popup.page.getByTestId('balance-card')).toContainText(
    `${totalSats.toLocaleString('en-US')} sats`,
    { timeout: 60_000 },
  );

  const selected = fundings[2]!;
  const fullpage = await extensionContext.newPage();
  try {
    await fullpage.goto(`chrome-extension://${extensionId}/fullpage.html#/send`);
    await fullpage.getByRole('button', { name: 'Manage coins' }).click();
    await fullpage.getByRole('checkbox', { name: coinSelectionName(selected) }).check();
    await expect(fullpage.getByText('1 selected · 95,000 sats')).toBeVisible();
    await fullpage.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(fullpage.getByText('1 manually selected inputs')).toBeVisible();
    const destination = await freshExternalAddress();
    await signPayment(fullpage, selected, destination, 40_000);
  } finally {
    await fullpage.close().catch(() => undefined);
  }
});

test('@extended deletes local coin metadata but restores the real on-chain funds', async ({
  onboarding,
  popup,
  extensionContext,
  extensionId,
}) => {
  test.slow();
  await assertRegtestReady();

  let mnemonic = generateMnemonic(english, 128);
  const paymentAddress = fixtureAddress(mnemonic, 'payment', 0);
  const funding = await fundAndConfirm(paymentAddress, 110_000);
  const walletName = 'Metadata recovery regtest E2E';

  await onboarding.open();
  await onboarding.restorePublicFixture({
    mnemonic,
    password: TEST_PASSWORD,
    name: walletName,
  });

  const fullpage = await extensionContext.newPage();
  try {
    await fullpage.goto(`chrome-extension://${extensionId}/fullpage.html#/send`);
    await fullpage.getByRole('button', { name: 'Manage coins' }).click();
    await fullpage.getByLabel(coinDetailsName(funding)).click();
    await fullpage.getByRole('button', { name: 'Add label' }).click();
    await fullpage.getByRole('radio', { name: 'Savings' }).click();
    await fullpage.getByLabel('Note (optional)').fill('Recovery-only note');
    await fullpage.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(fullpage.getByText('Recovery-only note')).toBeVisible();
    await fullpage.getByRole('button', { name: 'Freeze', exact: true }).click();
    const unavailable = fullpage.getByText('Unavailable', { exact: true });
    await expect(unavailable).toBeVisible({ timeout: 45_000 });
    await unavailable.click();
    await expect(fullpage.getByText(
      'Frozen by you — use Unfreeze to make it available',
      { exact: true },
    )).toBeVisible({ timeout: 45_000 });

    await fullpage.goto(
      `chrome-extension://${extensionId}/fullpage.html#/settings/wallets-accounts`,
    );
    await fullpage.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(fullpage.getByText(
      'This deletes only local wallet data. It cannot delete on-chain funds. The whole app will lock first.',
    )).toBeVisible();
    await fillPrivate(fullpage.getByLabel('App password'), TEST_PASSWORD);
    await fullpage.getByLabel("I have backed up this wallet’s recovery phrase.").check();
    await fullpage.getByRole('button', { name: `Remove ${walletName}` }).click();
    await expect(fullpage.getByRole('heading', { name: 'Welcome to Drey' })).toBeVisible({
      timeout: 30_000,
    });

    await onboarding.open();
    await onboarding.beginRestorePublicFixture({
      mnemonic,
      password: TEST_PASSWORD,
      name: walletName,
    });
    mnemonic = '';
    await onboarding.finishRestoreScan(120_000);

    await fullpage.goto(`chrome-extension://${extensionId}/fullpage.html#/send`);
    await fullpage.getByRole('button', { name: 'Manage coins' }).click();
    const restoredCoin = fullpage.getByRole('checkbox', { name: coinSelectionName(funding) });
    await expect(restoredCoin).toBeEnabled({ timeout: 60_000 });
    await fullpage.getByLabel(coinDetailsName(funding)).click();
    await expect(fullpage.getByRole('button', { name: 'Add label' })).toBeVisible();
    await expect(fullpage.getByRole('button', { name: 'Freeze', exact: true })).toBeVisible();
    await expect(fullpage.getByText('Recovery-only note')).toHaveCount(0);

    await popup.open();
    await expect.poll(async () => {
      const summary = await popupWalletSummary(popup.page);
      return {
        availableSats: summary.availableSats,
        userFrozenSats: summary.userFrozenSats,
      };
    }, { timeout: 60_000 }).toEqual({
      availableSats: '110000',
      userFrozenSats: '0',
    });
  } finally {
    await fullpage.close().catch(() => undefined);
  }
});
