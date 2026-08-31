import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { fillPrivate } from './pages';
import {
  assertOrdinalBatchTransferTransaction,
  assertOrdinalMoved,
  assertOrdinalPostageTransaction,
  assertOrdinalRescueTransaction,
  assertOrdinalSweepTransaction,
  assertOrdinalTransferTransaction,
  assertRegtestReady,
  confirmTransaction,
  createOrdinalFixture,
  freshExternalOrdinalAddress,
  fundWithoutConfirmation,
  mineBlock,
  transactionInMempool,
} from './regtest';

const TEST_PASSWORD = ['disposable', 'regtest', 'ordinals', 'only'].join('-');

async function receiveAddress(page: Page, kind: 'Bitcoin' | 'Ordinals'): Promise<string> {
  const pattern = kind === 'Ordinals'
    ? /^bcrt1p[ac-hj-np-z02-9]{8,87}$/u
    : /^bcrt1q[ac-hj-np-z02-9]{8,87}$/u;
  let address = '';
  await expect.poll(async () => {
    address = await page.getByTestId('receive-address').textContent() ?? '';
    return pattern.test(address);
  }).toBe(true);
  return address;
}

function checkedTxid(value: string | null): string {
  if (value === null || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error('ordinal result did not return a valid transaction id');
  }
  return value;
}

async function refreshUntilCount(page: Page, count: number): Promise<void> {
  const refresh = page.getByRole('button', { name: 'Refresh' });
  await expect(refresh).toBeEnabled({ timeout: 60_000 });
  await refresh.click();
  await expect(refresh).toBeEnabled({ timeout: 60_000 });
  await expect(page.getByRole('tab', { name: `All (${count})` })).toBeVisible({
    timeout: 60_000,
  });
}

test('@ordinals receives, verifies, displays, and transfers a real inscription', async ({
  onboarding,
  popup,
}) => {
  test.slow();
  await assertRegtestReady();
  await onboarding.open();
  await onboarding.createDisposable({
    password: TEST_PASSWORD,
    name: 'Ordinals regtest E2E',
  });
  await popup.open();
  await expect(popup.page.getByText('Regtest', { exact: true })).toBeVisible();

  await popup.page.getByRole('button', { name: 'Receive' }).click();
  const paymentAddress = await receiveAddress(popup.page, 'Bitcoin');
  await popup.page.getByRole('radio', { name: 'Ordinals' }).click();
  const ordinalAddress = await receiveAddress(popup.page, 'Ordinals');
  expect(ordinalAddress).not.toBe(paymentAddress);
  await popup.page.getByRole('button', { name: 'Close' }).click();

  const feeFunding = await fundWithoutConfirmation(paymentAddress, 80_000);
  const fixture = await createOrdinalFixture(ordinalAddress);

  await popup.page.bringToFront();
  await popup.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(popup.page.getByTestId('balance-card')).toContainText('80,000 sats', {
    timeout: 60_000,
  });
  await popup.page.getByRole('button', { name: 'Ordinals', exact: true }).click();
  await refreshUntilCount(popup.page, 1);

  const shelf = popup.page.locator('[data-gallery-collection]').first();
  await expect(shelf).toBeVisible();
  await shelf.click();
  const card = popup.page.locator('[data-gallery-inscription]');
  await expect(card).toHaveCount(1);
  await expect(card).toBeVisible();
  await expect(card).toContainText('Drey local regtest inscription fixture.');
  const details = card.getByText('Verified details');
  await expect(details).toBeVisible({ timeout: 60_000 });
  await details.click();
  const verifiedDetails = await card.textContent() ?? '';
  if (!verifiedDetails.includes(fixture.inscriptionId) ||
      !verifiedDetails.includes(fixture.satpoint)) {
    throw new Error('gallery verified details did not expose the exact inscription identity');
  }
  await expect(card.getByText('Confirmations', { exact: true })).toBeVisible();

  const send = card.getByRole('button', { name: 'Send', exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(popup.page.getByRole('heading', { name: 'Send inscription' })).toBeVisible();
  await expect(popup.page.getByText("You're sending")).toBeVisible();
  const destination = await freshExternalOrdinalAddress();
  await fillPrivate(popup.page.getByLabel('Recipient address'), destination);
  await popup.page.getByRole('radio', { name: 'Custom' }).check();
  await popup.page.getByLabel('Fee rate (sat/vB)').fill('1');
  await popup.page.getByRole('button', { name: 'Review transaction' }).click();

  const reviewHeading = popup.page.getByRole('heading', { name: 'Send this inscription?' });
  await expect(reviewHeading).toBeVisible({ timeout: 45_000 });
  const review = reviewHeading.locator('..');
  if (!(await review.textContent() ?? '').includes(destination)) {
    throw new Error('ordinal review did not show the exact destination');
  }
  await expect(review.getByText('10,000 sats', { exact: true })).toBeVisible();
  await expect(review.getByText('External address', { exact: true })).toBeVisible();
  const technicalDetails = review.locator('details').filter({ hasText: 'Fee rate' });
  await technicalDetails.locator('summary').click();
  await expect(review.getByText('1 sat/vB', { exact: true })).toBeVisible();
  await expect(review.getByLabel(
    /valid address on the correct network.*not a Taproot address/iu,
  )).toHaveCount(0);
  const acknowledgement = review.getByLabel(
    /verified the inscription identifier and transaction effects/iu,
  );
  if (await acknowledgement.count() > 0) await acknowledgement.check();
  const approve = review.getByRole('button', { name: 'Send inscription' });
  await expect(approve).toBeEnabled();
  await approve.click();

  await expect(popup.page.getByRole('heading', { name: 'Inscription sent' })).toBeVisible({
    timeout: 45_000,
  });
  const resultSection = popup.page.getByRole('heading', {
    name: 'Inscription sent',
  }).locator('xpath=ancestor::section[1]');
  if (!(await resultSection.textContent() ?? '').includes(destination)) {
    throw new Error('ordinal result did not show the exact destination');
  }
  const txid = checkedTxid(await popup.page.locator('a[href*="/tx/"] code').textContent());
  await transactionInMempool(txid);
  const transfer = await assertOrdinalTransferTransaction(
    txid,
    fixture,
    feeFunding,
    destination,
  );
  await confirmTransaction(txid);
  await assertOrdinalMoved(fixture, txid, destination, transfer.destinationVout);
});

test('@ordinals rescues a real wrong-lane inscription and returns directly to Gallery', async ({
  onboarding,
  popup,
}) => {
  test.slow();
  await assertRegtestReady();
  await onboarding.open();
  await onboarding.createDisposable({
    password: TEST_PASSWORD,
    name: 'Ordinals recovery regtest E2E',
  });
  await popup.open();

  await popup.page.getByRole('button', { name: 'Receive' }).click();
  const paymentAddress = await receiveAddress(popup.page, 'Bitcoin');
  await popup.page.getByRole('radio', { name: 'Ordinals' }).click();
  const ordinalAddress = await receiveAddress(popup.page, 'Ordinals');
  await popup.page.getByRole('button', { name: 'Close' }).click();

  const feeFunding = await fundWithoutConfirmation(paymentAddress, 80_000);
  const wrongLaneFixture = await createOrdinalFixture(paymentAddress, 'payment');

  await popup.page.bringToFront();
  await popup.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(popup.page.getByTestId('balance-card')).toContainText('80,000 sats', {
    timeout: 60_000,
  });
  await popup.page.getByRole('button', { name: 'Ordinals', exact: true }).click();
  const refresh = popup.page.getByRole('button', { name: 'Refresh' });
  await expect(refresh).toBeEnabled({ timeout: 60_000 });
  await refresh.click();
  await expect(refresh).toBeEnabled({ timeout: 60_000 });
  await expect(popup.page.getByRole('heading', { name: 'Needs attention' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(popup.page.getByText(
    'Rescue inscriptions in the Bitcoin lane or sweep excess bitcoin from the Ordinals lane.',
  )).toBeVisible();
  await expect(popup.page.getByText(wrongLaneFixture.inscriptionId)).toBeVisible();

  const rescueButton = popup.page.getByRole('button', { name: 'Rescue', exact: true });
  await expect(rescueButton).toBeEnabled({ timeout: 60_000 });
  await rescueButton.click();
  await expect(popup.page.getByRole('heading', { name: 'Rescue inscription' })).toBeVisible();
  await expect(popup.page.getByText(
    'Move this inscription from the Bitcoin lane to your owned Ordinals address.',
  )).toBeVisible();
  await expect(popup.page.getByLabel('Recipient address')).toHaveCount(0);
  await popup.page.getByRole('radio', { name: 'Custom' }).check();
  await popup.page.getByLabel('Fee rate (sat/vB)').fill('1');
  await popup.page.getByRole('button', { name: 'Review transaction' }).click();

  const rescueReview = popup.page.getByRole('heading', { name: 'Rescue this inscription?' });
  await expect(rescueReview).toBeVisible({ timeout: 45_000 });
  const rescueSection = rescueReview.locator('xpath=ancestor::section[1]');
  await expect(
    rescueSection
      .getByLabel('Immutable inscription ID')
      .getByText(wrongLaneFixture.inscriptionId, { exact: true }),
  ).toBeVisible();
  await expect(rescueSection).toContainText(ordinalAddress);
  await expect(rescueSection.getByText('Owned by this wallet', { exact: true })).toBeVisible();
  await expect(rescueSection.getByText('10,000 sats', { exact: true })).toBeVisible();
  const rescueAcknowledgement = rescueSection.getByLabel(
    /verified the inscription identifier and transaction effects/iu,
  );
  if (await rescueAcknowledgement.count() > 0) await rescueAcknowledgement.check();
  await rescueSection.getByRole('button', { name: 'Rescue inscription' }).click();

  await expect(popup.page.getByRole('heading', { name: 'Ordinals transaction sent' })).toBeVisible({
    timeout: 45_000,
  });
  const rescueTxid = checkedTxid(await popup.page.locator('a[href*="/tx/"] code').textContent());
  await transactionInMempool(rescueTxid);
  const rescue = await assertOrdinalRescueTransaction(
    rescueTxid,
    wrongLaneFixture,
    feeFunding,
    ordinalAddress,
  );
  await confirmTransaction(rescueTxid);
  await assertOrdinalMoved(
    wrongLaneFixture,
    rescueTxid,
    ordinalAddress,
    rescue.destinationVout,
  );
  await popup.page.getByRole('button', { name: 'Done' }).click();
  await expect(popup.page.getByRole('heading', { name: 'Ordinals' })).toBeVisible();
});

test('@ordinals safely reduces real inscription postage and returns excess bitcoin', async ({
  onboarding,
  popup,
}) => {
  test.slow();
  await assertRegtestReady();
  await onboarding.open();
  await onboarding.createDisposable({
    password: TEST_PASSWORD,
    name: 'Ordinals postage regtest E2E',
  });

  await popup.open();
  await popup.page.getByRole('button', { name: 'Receive' }).click();
  const paymentAddress = await receiveAddress(popup.page, 'Bitcoin');
  await popup.page.getByRole('radio', { name: 'Ordinals' }).click();
  const ordinalAddress = await receiveAddress(popup.page, 'Ordinals');
  await popup.page.getByRole('button', { name: 'Close' }).click();

  const feeFunding = await fundWithoutConfirmation(paymentAddress, 80_000);
  const fixture = await createOrdinalFixture(ordinalAddress);

  await popup.page.bringToFront();
  await popup.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await popup.page.getByRole('button', { name: 'Ordinals', exact: true }).click();
  await refreshUntilCount(popup.page, 1);
  const shelf = popup.page.locator('[data-gallery-collection]').first();
  await shelf.click();
  const card = popup.page.locator('[data-gallery-inscription]');
  await expect(card).toHaveCount(1);
  const details = card.getByText('Verified details');
  await expect(details).toBeVisible({ timeout: 60_000 });
  await details.click();
  await card.getByRole('button', {
    name: 'Manage bitcoin kept with this collectible',
  }).click();

  await expect(popup.page.getByRole('heading', {
    name: 'Bitcoin kept with collectible',
  })).toBeVisible();
  await expect(popup.page.getByText(
    'Currently with this collectible: 10,000 sats',
  )).toBeVisible();
  await popup.page.getByRole('radio', { name: 'Common — 546 sats' }).check();
  await popup.page.getByRole('group', { name: /Network fee/iu })
    .getByRole('radio', { name: 'Custom' }).check();
  await popup.page.getByLabel('Fee rate (sat/vB)').fill('1');
  await popup.page.getByRole('button', { name: 'Review transaction' }).click();

  const postageReview = popup.page.getByRole('heading', { name: 'Review postage change' });
  await expect(postageReview).toBeVisible({ timeout: 45_000 });
  const postageSection = postageReview.locator('xpath=ancestor::section[1]');
  await expect(postageSection.getByText('9,454 sats', { exact: true })).toBeVisible();
  await expect(postageSection.getByText('546 sats', { exact: true })).toBeVisible();
  await postageSection.getByRole('button', { name: 'Confirm postage change' }).click();

  await expect(popup.page.getByRole('heading', { name: 'Postage updated' })).toBeVisible({
    timeout: 45_000,
  });
  const postageTxid = checkedTxid(await popup.page.locator('a[href*="/tx/"] code').textContent());
  await transactionInMempool(postageTxid);
  const postage = await assertOrdinalPostageTransaction(
    postageTxid,
    fixture,
    feeFunding,
    ordinalAddress,
    546,
  );
  await confirmTransaction(postageTxid);
  await assertOrdinalMoved(
    fixture,
    postageTxid,
    ordinalAddress,
    postage.destinationVout,
    546,
  );
});

test('@ordinals batch-sends two real inscriptions with isolated postage and clean fees', async ({
  onboarding,
  popup,
}) => {
  test.slow();
  await assertRegtestReady();
  await onboarding.open();
  await onboarding.createDisposable({
    password: TEST_PASSWORD,
    name: 'Ordinals batch regtest E2E',
  });
  await popup.open();

  await popup.page.getByRole('button', { name: 'Receive' }).click();
  const paymentAddress = await receiveAddress(popup.page, 'Bitcoin');
  await popup.page.getByRole('radio', { name: 'Ordinals' }).click();
  const ordinalAddress = await receiveAddress(popup.page, 'Ordinals');
  await popup.page.getByRole('button', { name: 'Close' }).click();

  const feeFunding = await fundWithoutConfirmation(paymentAddress, 120_000);
  const fixtures = [
    await createOrdinalFixture(ordinalAddress),
    await createOrdinalFixture(ordinalAddress),
  ];

  await popup.page.bringToFront();
  await popup.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await popup.page.getByRole('button', { name: 'Ordinals', exact: true }).click();
  await refreshUntilCount(popup.page, 2);
  await popup.page.locator('[data-gallery-collection]').first().click();
  await expect(popup.page.locator('[data-gallery-inscription]')).toHaveCount(2);

  await popup.page.getByRole('button', { name: 'Select', exact: true }).click();
  for (const fixture of fixtures) {
    await popup.page.getByRole('button', { name: `Select #${fixture.number}` }).click();
  }
  const continueBatch = popup.page.getByRole('button', { name: 'Continue with 2' });
  await expect(continueBatch).toBeEnabled();
  await continueBatch.click();

  await expect(popup.page.getByRole('heading', { name: 'Send 2 inscriptions' })).toBeVisible();
  const destination = await freshExternalOrdinalAddress();
  await fillPrivate(popup.page.getByLabel('Recipient address'), destination);
  await popup.page.getByRole('radio', { name: 'Custom' }).check();
  await popup.page.getByLabel('Fee rate (sat/vB)').fill('1');
  await popup.page.getByRole('button', { name: 'Review transaction' }).click();

  const batchHeading = popup.page.getByRole('heading', {
    name: 'Send 2 inscriptions to one address?',
  });
  await expect(batchHeading).toBeVisible({ timeout: 45_000 });
  const review = batchHeading.locator('xpath=ancestor::section[1]');
  await expect(review.getByText(destination, { exact: true })).toBeVisible();
  await expect(review.getByText('External address', { exact: true })).toBeVisible();
  await expect(review.getByText('20,000 sats', { exact: true })).toBeVisible();
  await expect(review.getByText('1 sat/vB', { exact: true })).toBeVisible();
  const groups = review.getByText('Atomic inscription groups', { exact: true });
  await groups.click();
  for (const fixture of fixtures) {
    await expect(review.getByText(
      `${fixture.outpoint.txid}:${fixture.outpoint.vout}`,
      { exact: true },
    )).toHaveCount(1);
  }
  const acknowledgement = review.getByLabel(
    /verified the inscription identifier and transaction effects/iu,
  );
  if (await acknowledgement.count() > 0) await acknowledgement.check();
  await review.getByRole('button', { name: 'Send 2 inscriptions' }).click();

  await expect(popup.page.getByRole('heading', { name: '2 Ordinals sent' })).toBeVisible({
    timeout: 45_000,
  });
  const txid = checkedTxid(await popup.page.locator('a[href*="/tx/"] code').textContent());
  await transactionInMempool(txid);
  const batch = await assertOrdinalBatchTransferTransaction(
    txid,
    fixtures,
    feeFunding,
    destination,
  );
  await confirmTransaction(txid);
  for (const fixture of fixtures) {
    const source = `${fixture.outpoint.txid}:${fixture.outpoint.vout}`;
    const destinationVout = batch.destinationVouts.get(source);
    if (destinationVout === undefined) throw new Error('batch result lost a fixture output');
    await assertOrdinalMoved(fixture, txid, destination, destinationVout);
  }
});

test('@ordinals sweeps real excess bitcoin while retaining calm fixed postage', async ({
  onboarding,
  popup,
}) => {
  test.slow();
  await assertRegtestReady();
  await onboarding.open();
  await onboarding.createDisposable({
    password: TEST_PASSWORD,
    name: 'Ordinals sweep regtest E2E',
  });
  await popup.open();

  await popup.page.getByRole('button', { name: 'Receive' }).click();
  await popup.page.getByRole('radio', { name: 'Ordinals' }).click();
  const ordinalAddress = await receiveAddress(popup.page, 'Ordinals');
  await popup.page.getByRole('button', { name: 'Close' }).click();

  const source = await fundWithoutConfirmation(ordinalAddress, 50_000);
  await mineBlock();
  await popup.page.bringToFront();
  await popup.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await popup.page.getByRole('button', { name: 'Ordinals', exact: true }).click();
  const refresh = popup.page.getByRole('button', { name: 'Refresh' });
  await expect(refresh).toBeEnabled({ timeout: 60_000 });
  await refresh.click();
  await expect(refresh).toBeEnabled({ timeout: 60_000 });

  await expect(popup.page.getByRole('heading', { name: 'Needs attention' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(popup.page.getByText('50,000 sats in the Ordinals lane')).toBeVisible();
  await popup.page.getByRole('button', { name: 'Sweep', exact: true }).click();
  await expect(popup.page.getByRole('heading', { name: 'Sweep excess bitcoin' })).toBeVisible();
  await expect(popup.page.getByText(
    'Return economic excess to your Bitcoin balance while reserving fixed postage in the Ordinals lane.',
  )).toBeVisible();
  await expect(popup.page.getByLabel('Recipient address')).toHaveCount(0);
  await popup.page.getByRole('radio', { name: 'Custom' }).check();
  await popup.page.getByLabel('Fee rate (sat/vB)').fill('1');
  await popup.page.getByRole('button', { name: 'Review transaction' }).click();

  const sweepHeading = popup.page.getByRole('heading', { name: 'Sweep excess bitcoin?' });
  await expect(sweepHeading).toBeVisible({ timeout: 45_000 });
  const review = sweepHeading.locator('xpath=ancestor::section[1]');
  await expect(review.getByText(
    'No inscription is present. Fixed postage remains reserved at your Ordinals address.',
  )).toBeVisible();
  await expect(review.getByText('Owned by this wallet', { exact: true })).toBeVisible();
  await expect(review.getByText('10,000 sats', { exact: true })).toBeVisible();
  await review.getByText('Technical details', { exact: true }).click();
  await expect(review.getByText(`${source.txid}:${source.vout}`, { exact: true })).toBeVisible();
  await expect(review.getByText('None', { exact: true })).toHaveCount(3);
  await review.getByRole('button', { name: 'Sweep excess bitcoin' }).click();

  await expect(popup.page.getByRole('heading', { name: 'Excess bitcoin swept' })).toBeVisible({
    timeout: 45_000,
  });
  const txid = checkedTxid(await popup.page.locator('a[href*="/tx/"] code').textContent());
  await transactionInMempool(txid);
  const sweep = await assertOrdinalSweepTransaction(txid, source);
  await confirmTransaction(txid);
  await popup.page.getByRole('button', { name: 'Done' }).click();
  await expect(popup.page.getByRole('heading', { name: 'Ordinals' })).toBeVisible();
  const restingPostage = popup.page.getByText(
    '10,000 sats of plain bitcoin sit at your Ordinals address. Moving it would cost more in fees than it is worth, so it stays there. Nothing is wrong.',
  );
  await expect.poll(async () => ({
    restingPostage: await restingPostage.count(),
    oldSweep: await popup.page.getByText('50,000 sats in the Ordinals lane').count(),
    sweepButtons: await popup.page.getByRole('button', { name: 'Sweep', exact: true }).count(),
    error: await popup.page.getByText(
      'Verified inscription details are unavailable. Your inscriptions remain protected.',
      { exact: true },
    ).count(),
  }), { timeout: 60_000 }).toEqual({
    restingPostage: 1,
    oldSweep: 0,
    sweepButtons: 0,
    error: 0,
  });
  expect(sweep.paymentChange.sats).toBe(source.sats - 10_000 - sweep.feeSats);
});
