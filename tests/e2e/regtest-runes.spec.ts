import type { TransactionPlanResult } from '@drey/core/messaging/transaction-schemas';
import { HDKey } from '@scure/bip32';
import { generateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english';
import { p2tr, p2wpkh, SigHash, Transaction, TEST_NETWORK } from '@scure/btc-signer';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { fillPrivate } from './pages';
import { assertRegtestReady, assertTransactionIntent, coreRpc, confirmTransaction, freshExternalAddress, freshExternalOrdinalAddress, fundAndConfirm, gatewayOrigin, mempoolTransactionIds, mineBlock, transactionInMempool } from './regtest';
import { terminateExtensionWorker, wakeExtensionWorker } from './worker';
import { assertRuneTransfer, assertReferenceRuneAddressBalance, createRuneFixture, inspectRuneTransaction, lastRuneTransfer, ownedRuneAddresses, ownedPaymentAddresses, prepareRune, runeController, runeMessage, runeState, sendMoreRuneFixture, waitForRune, type RuneFixture } from './regtest-runes';

const PASSWORD = ['disposable', 'regtest', 'runes', 'only'].join('-');
async function receiveAddress(page: Page, role?: 'ordinals'): Promise<string> {
  if (role === 'ordinals') await expect.poll(async () => (await page.getByTestId('receive-address').textContent())?.startsWith('bcrt1p'), { timeout: 15_000 }).toBe(true);
  const value = await page.getByTestId('receive-address').textContent();
  if (value === null || !/^bcrt1[qp][ac-hj-np-z02-9]{8,87}$/u.test(value)) throw new Error('Rune receiving address malformed');
  return value;
}
async function openRunes(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Runes/u }).click();
  await expect(page.getByRole('heading', { name: 'Runes', exact: true })).toBeVisible();
}
async function openToken(page: Page, fixture: RuneFixture): Promise<void> {
  await page.getByRole('button', { name: new RegExp(fixture.name, 'u') }).click();
  await expect(page.getByRole('heading', { name: fixture.name })).toBeVisible();
}
// A fresh isolated chain may legitimately have no Core fee-estimator history.
// Exercise the real custom-rate fallback; never substitute a synthetic quote.
async function chooseRuneFee(page: Page, tier: 'Standard' | 'Economy' = 'Standard'): Promise<'quoted' | 'custom'> {
  await page.getByRole('button', { name: 'Change fee', exact: true }).click();
  const choice = page.getByRole('radio', { name: new RegExp(tier, 'u') });
  let state: 'loading' | 'quoted' | 'custom' = 'loading';
  await expect.poll(async () => {
    state = await choice.isEnabled() ? 'quoted' : await page.getByText(/^Recommended fee rates are unavailable/u).isVisible() ? 'custom' : 'loading';
    return state;
  }).not.toBe('loading');
  if (await choice.isEnabled()) {
    await choice.check();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    return 'quoted';
  }
  await page.getByRole('radio', { name: 'Custom', exact: true }).check();
  await page.getByLabel('Fee rate (sat/vB)').fill('1.25');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  return 'custom';
}
async function reviewFigures(page: Page): Promise<{ feeSats: string; postageSats: string }> {
  const value = async (label: string) => {
    const text = await page.locator('dt').filter({ hasText: label }).locator('xpath=following-sibling::dd[1]').textContent();
    if (!text || !/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+) sats$/u.test(text)) throw new Error('Rune review cost was not exact satoshis');
    return text.split(' ')[0]!.replaceAll(',', '');
  };
  return { feeSats: await value('Bitcoin network fee'), postageSats: await value('Bitcoin sent with tokens') };
}

async function trackSessionPresence(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const safe = window as unknown as { runeSessionEvents: { present: boolean; priorPresent: boolean; deadlineRemainingMs: number | null }[] };
    safe.runeSessionEvents = [];
    chrome.storage.onChanged.addListener((changes, area) => {
      const event = changes['squirrel:session'];
      if (area === 'session' && event) {
        const next = event.newValue as { deadline?: unknown } | undefined;
        safe.runeSessionEvents = [...safe.runeSessionEvents, { present: Boolean(next), priorPresent: Boolean(event.oldValue), deadlineRemainingMs: typeof next?.deadline === 'number' ? next.deadline - Date.now() : null }].slice(-16);
      }
    });
  });
}

test('@runes receives, combines, partially sends, confirms and sends Max with exact ord allocation', async ({ onboarding, popup, extensionContext, extensionId }) => {
  test.setTimeout(600_000);
  await assertRegtestReady();
  await onboarding.open();
  await onboarding.createDisposable({ password: PASSWORD, name: 'Rune lifecycle regtest' });
  await popup.open();
  await openRunes(popup.page);
  await popup.page.getByRole('button', { name: 'Receive Runes', exact: true }).click();
  await expect(popup.page.getByRole('radio')).toHaveCount(0);
  await expect(popup.page.locator('[role="radiogroup"]')).toHaveCount(0);
  const assetAddress = await receiveAddress(popup.page, 'ordinals');
  if (!assetAddress.startsWith('bcrt1p')) throw new Error('Runes receiving role is not the asset role');
  await popup.page.getByRole('button', { name: 'Close', exact: true }).click();
  const ownedAssets = await ownedRuneAddresses(popup.page, PASSWORD);
  const ownedPayment = await ownedPaymentAddresses(popup.page, PASSWORD);
  const first = createRuneFixture(assetAddress, '250.00');
  const second = sendMoreRuneFixture(first, assetAddress, '250.00');
  await waitForRune(popup.page, first, '50000');
  await openToken(popup.page, first);
  await expect(popup.page.getByText('500 R', { exact: true })).toBeVisible();
  const recipient = await freshExternalOrdinalAddress();
  await popup.page.getByRole('button', { name: 'Send', exact: true }).click();
  await chooseRuneFee(popup.page);
  await fillPrivate(popup.page.getByLabel('Recipient’s Runes address'), recipient);
  await popup.page.getByLabel('Amount', { exact: true }).fill('300');
  await expect(popup.page.getByText('Add Bitcoin for fees, then return to this transfer.')).toBeVisible();
  const beforeFunding = await mempoolTransactionIds();
  await expect(popup.page.getByRole('button', { name: 'Review transfer', exact: true })).toBeDisabled();
  expect((await runeMessage(popup.page, 'runes.prepare', { runeId: first.runeId, recipient, amount: '300', feeRate: '1' })).ok).toBe(false);
  expect(await mempoolTransactionIds()).toEqual(beforeFunding);
  await popup.page.getByRole('button', { name: 'Receive Bitcoin', exact: true }).click();
  const paymentAddress = await receiveAddress(popup.page);
  if (paymentAddress === assetAddress) throw new Error('Bitcoin receiving role equals asset role');
  await fundAndConfirm(paymentAddress, 100_000);
  await popup.page.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(popup.page.getByLabel('Amount', { exact: true })).toHaveValue('300');
  await expect.poll(async () => (await runeState(popup.page)).feeFundingSats, { timeout: 90_000 }).toBe('100000');
  await popup.page.getByRole('button', { name: 'Review transfer', exact: true }).click();
  await expect(popup.page.getByRole('heading', { name: 'Review transfer' })).toBeFocused();
  const figures = await reviewFigures(popup.page);
  expect((await popup.page.locator('section').last().textContent())?.includes(recipient)).toBe(true);
  await popup.page.getByRole('button', { name: 'Confirm and send', exact: true }).click();
  await expect(popup.page.getByRole('heading', { name: 'Transfer pending' })).toBeVisible({ timeout: 60_000 });
  const txid = await lastRuneTransfer(popup.page);
  await transactionInMempool(txid);
  const pendingPool = await mempoolTransactionIds();
  for (const kind of ['rbf', 'cpfp']) {
    expect((await runeMessage(popup.page, 'transaction.plan', { kind, account: 0, txid, fee: { type: 'custom', rateSatPerVb: '2' } })).ok).toBe(false);
    expect(await mempoolTransactionIds()).toEqual(pendingPool);
  }
  await trackSessionPresence(popup.page);
  await terminateExtensionWorker(extensionContext, extensionId);
  await wakeExtensionWorker(popup.page, extensionId);
  expect(await mempoolTransactionIds()).toEqual(pendingPool);
  await popup.lock();
  await popup.unlock(PASSWORD);
  expect((await runeState(popup.page)).transfers.some((item) => item.txid === txid && item.status === 'pending')).toBe(true);
  await confirmTransaction(txid);
  await assertRuneTransfer(txid, first, { destination: recipient, amount: '30000', retained: '20000', ownAssetAddresses: ownedAssets, ownPaymentAddresses: ownedPayment, sourceOutpoints: [first.outpoint, second.outpoint], ...figures });
  assertReferenceRuneAddressBalance(recipient, first, '30000');
  await waitForRune(popup.page, first, '20000');
  await popup.open();
  await openRunes(popup.page);
  await openToken(popup.page, first);
  const sentHistory = popup.page.locator('details').filter({ hasText: txid });
  await expect(sentHistory.locator('summary')).toContainText('Confirmed');
  await sentHistory.locator('summary').click();
  await expect(sentHistory.getByText(txid, { exact: true })).toBeVisible();
  const retainedOutput = inspectRuneTransaction(txid).outputs.find((output) => output.ord.address !== null && ownedAssets.includes(output.ord.address) && output.ord.runes[first.name]);
  if (!retainedOutput) throw new Error('reference ord found no explicit token change');
  await popup.page.getByRole('button', { name: 'Send', exact: true }).click();
  await chooseRuneFee(popup.page);
  await fillPrivate(popup.page.getByLabel('Recipient’s Runes address'), recipient);
  await popup.page.getByRole('button', { name: 'Max', exact: true }).click();
  await expect(popup.page.getByLabel('Amount', { exact: true })).toHaveValue('200');
  await popup.page.getByRole('button', { name: 'Review transfer', exact: true }).click();
  await expect(popup.page.getByRole('heading', { name: 'Review transfer' })).toBeVisible();
  const maxFigures = await reviewFigures(popup.page);
  await popup.page.getByRole('button', { name: 'Confirm and send', exact: true }).click();
  await expect(popup.page.getByRole('heading', { name: 'Transfer pending' })).toBeVisible();
  const maxTxid = await lastRuneTransfer(popup.page);
  await confirmTransaction(maxTxid);
  await assertRuneTransfer(maxTxid, first, { destination: recipient, amount: '20000', retained: '0', ownAssetAddresses: ownedAssets, ownPaymentAddresses: ownedPayment, sourceOutpoints: [retainedOutput.outpoint], ...maxFigures });
  assertReferenceRuneAddressBalance(recipient, first, '50000');
  expect(await coreRpc('gettxout', [txid, Number(retainedOutput.outpoint.split(':')[1]), true])).toBeNull();
  await expect.poll(async () => {
    const state = await runeState(popup.page);
    return { ready: state.status === 'ready', available: state.holdings.find((holding) => holding.id === first.runeId)?.available ?? '0' };
  }, { timeout: 90_000 }).toEqual({ ready: true, available: '0' });
});

test('@runes cancels reservations and rejects changed or stale approval authority before dispatch', async ({ onboarding, popup, extensionContext, extensionId }) => {
  test.setTimeout(300_000);
  await assertRegtestReady();
  await onboarding.open();
  await onboarding.createDisposable({ password: PASSWORD, name: 'Rune authority regtest' });
  await popup.open();
  await popup.page.getByRole('button', { name: 'Receive Bitcoin', exact: true }).click();
  const payment = await receiveAddress(popup.page);
  await popup.page.getByRole('radio', { name: 'Ordinals', exact: true }).click();
  const asset = await receiveAddress(popup.page, 'ordinals');
  await popup.page.getByRole('button', { name: 'Close' }).click();
  const fixture = createRuneFixture(asset);
  await fundAndConfirm(payment, 100_000);
  await waitForRune(popup.page, fixture, fixture.atomic);
  const recipient = await freshExternalOrdinalAddress();
  const review = await prepareRune(popup.page, fixture, recipient, '100');
  const before = await mempoolTransactionIds();
  const changed = await runeMessage(popup.page, 'runes.approve', { planId: review.planId, planHash: '00'.repeat(32) });
  expect(changed.ok).toBe(false);
  expect(await mempoolTransactionIds()).toEqual(before);
  const cancelled = await runeMessage(popup.page, 'runes.cancel', { planId: review.planId });
  expect(cancelled.ok).toBe(true);
  const afterCancel = await runeMessage(popup.page, 'runes.approve', { planId: review.planId, planHash: review.planHash });
  expect(afterCancel.ok).toBe(false);
  expect(await mempoolTransactionIds()).toEqual(before);
  await waitForRune(popup.page, fixture, fixture.atomic);
  const stale = await prepareRune(popup.page, fixture, recipient, '100');
  await mineBlock();
  expect((await runeMessage(popup.page, 'runes.approve', { planId: stale.planId, planHash: stale.planHash })).ok).toBe(false);
  expect(await mempoolTransactionIds()).toEqual(before);
  await waitForRune(popup.page, fixture, fixture.atomic);
  const restart = await prepareRune(popup.page, fixture, recipient, '100');
  await terminateExtensionWorker(extensionContext, extensionId);
  await wakeExtensionWorker(popup.page, extensionId);
  expect((await runeMessage(popup.page, 'runes.approve', { planId: restart.planId, planHash: restart.planHash })).ok).toBe(false);
  await waitForRune(popup.page, fixture, fixture.atomic);
  const switched = await prepareRune(popup.page, fixture, recipient, '100');
  expect((await runeMessage(popup.page, 'account.add', { acknowledgeEmptyAccountRisk: true })).ok).toBe(true);
  expect((await runeMessage(popup.page, 'runes.approve', { planId: switched.planId, planHash: switched.planHash })).ok).toBe(false);
  expect(await mempoolTransactionIds()).toEqual(before);
});

test('@runes reference negative control decodes and burns a malformed disposable runestone', async ({ onboarding, popup }) => {
  test.setTimeout(300_000);
  await assertRegtestReady();
  await onboarding.open();
  await onboarding.createDisposable({ password: PASSWORD, name: 'Rune cenotaph regtest' });
  await popup.open();
  await openRunes(popup.page);
  await popup.page.getByRole('button', { name: 'Receive Runes', exact: true }).click();
  const destination = await receiveAddress(popup.page);
  await popup.page.getByRole('button', { name: 'Close' }).click();
  const fixture = createRuneFixture(destination, '250.00');
  await waitForRune(popup.page, fixture, '25000');
  const change = inspectRuneTransaction(fixture.txid).outputs.find((output) => output.ord.address !== destination && output.ord.runes[fixture.name]);
  if (!change) throw new Error('disposable source token change absent');
  const result = runeController<{ burned: string; referenceDecode: { runestone: { Cenotaph: { flaw: string } } } }>('rune-cenotaph', ['--confirm', process.env.DREY_REGTEST_PROJECT ?? 'drey-regtest', '--name', fixture.name, '--outpoint', change.outpoint]);
  expect(result.burned).toBe('75000');
  expect(result.referenceDecode.runestone.Cenotaph.flaw).toBe('varint');
  await waitForRune(popup.page, fixture, '25000');
});

test('@runes refuses inscription, rare-sat and other-Rune combinations while preserving totals', async ({ onboarding, popup }) => {
  test.setTimeout(600_000);
  await assertRegtestReady();
  await onboarding.open();
  await onboarding.createDisposable({ password: PASSWORD, name: 'Rune mixed eligibility regtest' });
  await popup.open();
  await popup.page.getByRole('button', { name: 'Receive Bitcoin', exact: true }).click();
  const payment = await receiveAddress(popup.page);
  await popup.page.getByRole('radio', { name: 'Ordinals', exact: true }).click();
  const asset = await receiveAddress(popup.page, 'ordinals');
  await popup.page.getByRole('button', { name: 'Close' }).click();
  await fundAndConfirm(payment, 100_000);
  for (const kind of ['inscription', 'rare', 'other-rune']) {
    const fixture = createRuneFixture(asset, '250.00');
    const args = ['--confirm', process.env.DREY_REGTEST_PROJECT ?? 'drey-regtest', '--name', fixture.name, '--kind', kind, '--destination', asset];
    if (kind === 'other-rune') {
      const other = createRuneFixture(asset, '250.00');
      args.push('--other-name', other.name);
    }
    const mixed = runeController<{ txid: string; output: { inscriptions: string[] } }>('rune-mix', args);
    await waitForRune(popup.page, fixture, '25000');
    await expect.poll(async () => {
      const item = (await runeState(popup.page)).holdings.find((entry) => entry.id === fixture.runeId);
      return { total: item?.total, available: item?.available, protected: item?.constrained.some((entry) => entry.reason === 'mixed_assets') };
    }, { timeout: 90_000 }).toEqual({ total: '100000', available: '25000', protected: true });
    const before = await mempoolTransactionIds();
    const rejected = await runeMessage(popup.page, 'runes.prepare', { runeId: fixture.runeId, recipient: await freshExternalOrdinalAddress(), amount: '30000', feeRate: '1' });
    expect(rejected.ok).toBe(false);
    if (kind === 'inscription') {
      const ordinal = await runeMessage(popup.page, 'transaction.plan', {
        account: 0, fee: { type: 'custom', rateSatPerVb: '1' }, kind: 'ordinal_transfer',
        inscriptionId: mixed.output.inscriptions[0], outpoint: { txid: mixed.txid, vout: 0 },
        recipient: await freshExternalOrdinalAddress(),
      });
      expect(ordinal.ok).toBe(false);
      expect(await coreRpc('gettxout', [mixed.txid, 0, true])).not.toBeNull();
    }
    expect(await mempoolTransactionIds()).toEqual(before);
  }
});

test('@runes reconciles a lost broadcast response without a second dispatch', async ({ onboarding, popup, extensionContext, extensionId }) => {
  test.setTimeout(300_000);
  await assertRegtestReady();
  await onboarding.open();
  await onboarding.createDisposable({ password: PASSWORD, name: 'Rune indeterminate regtest' });
  await popup.open();
  await popup.page.getByRole('button', { name: 'Receive Bitcoin', exact: true }).click();
  const payment = await receiveAddress(popup.page);
  await popup.page.getByRole('radio', { name: 'Ordinals', exact: true }).click();
  const asset = await receiveAddress(popup.page, 'ordinals');
  await popup.page.getByRole('button', { name: 'Close' }).click();
  const fixture = createRuneFixture(asset);
  await fundAndConfirm(payment, 100_000);
  await waitForRune(popup.page, fixture, fixture.atomic);
  const recipient = await freshExternalOrdinalAddress();
  const review = await prepareRune(popup.page, fixture, recipient, '100');
  let dispatches = 0;
  const url = `${gatewayOrigin}/v1/runes/broadcast`;
  await extensionContext.route(url, async (route) => { dispatches += 1; await route.fetch(); await route.abort('failed'); });
  let txid: string;
  try {
    const result = await runeMessage<{ status: string; txid: string }>(popup.page, 'runes.approve', { planId: review.planId, planHash: review.planHash });
    expect(result.ok).toBe(true);
    expect(result.result?.status).toBe('indeterminate');
    if (!result.result?.txid) throw new Error('lost-response journal has no identity');
    txid = result.result.txid;
  } finally { await extensionContext.unroute(url); }
  expect(dispatches).toBe(1);
  await transactionInMempool(txid);
  const before = await mempoolTransactionIds();
  await terminateExtensionWorker(extensionContext, extensionId);
  await wakeExtensionWorker(popup.page, extensionId);
  await runeState(popup.page);
  expect(await mempoolTransactionIds()).toEqual(before);
  expect(dispatches).toBe(1);
  await confirmTransaction(txid);
  await expect.poll(async () => (await runeState(popup.page)).transfers.find((item) => item.txid === txid)?.status).toBe('confirmed');
});

test('@runes refuses unverified current evidence and never reports unavailable data as zero', async ({ onboarding, popup, extensionContext }) => {
  test.setTimeout(300_000);
  await assertRegtestReady();
  await onboarding.open();
  await onboarding.createDisposable({ password: PASSWORD, name: 'Rune evidence regtest' });
  await popup.open();
  await openRunes(popup.page);
  await popup.page.getByRole('button', { name: 'Receive Runes', exact: true }).click();
  const asset = await receiveAddress(popup.page, 'ordinals');
  await popup.page.getByRole('button', { name: 'Close' }).click();
  const fixture = createRuneFixture(asset);
  await waitForRune(popup.page, fixture, fixture.atomic);
  const before = await mempoolTransactionIds();
  const url = `${gatewayOrigin}/v1/runes/outputs`;
  await extensionContext.route(url, (route) => route.abort('failed'));
  try {
    expect((await runeState(popup.page)).status).toBe('unavailable');
    const result = await runeMessage(popup.page, 'runes.prepare', { runeId: fixture.runeId, recipient: await freshExternalOrdinalAddress(), amount: '100', feeRate: '1' });
    expect(result.ok).toBe(false);
    expect(await mempoolTransactionIds()).toEqual(before);
  } finally { await extensionContext.unroute(url); }
  await waitForRune(popup.page, fixture, fixture.atomic);
});

test('@runes restores a fresh disposable account and rediscovers exact indexed holdings', async ({ onboarding, popup, extensionContext, extensionId }) => {
  test.setTimeout(300_000);
  await assertRegtestReady();
  let mnemonic = generateMnemonic(english, 128);
  const seed = mnemonicToSeedSync(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  const paymentNode = master.derive("m/84'/1'/0'/0/0");
  const ordinalNode = master.derive("m/86'/1'/0'/0/0");
  let payment: string;
  let asset: string;
  try {
    if (!paymentNode.publicKey || !ordinalNode.publicKey) throw new Error('disposable address derivation failed');
    payment = p2wpkh(paymentNode.publicKey, { ...TEST_NETWORK, bech32: 'bcrt' }).address!;
    asset = p2tr(ordinalNode.publicKey.slice(1), undefined, { ...TEST_NETWORK, bech32: 'bcrt' }).address!;
  } finally { paymentNode.wipePrivateData(); ordinalNode.wipePrivateData(); master.wipePrivateData(); seed.fill(0); }
  const fixture = createRuneFixture(asset);
  await fundAndConfirm(payment, 100_000);
  await onboarding.open();
  try { await onboarding.restorePublicFixture({ mnemonic, password: PASSWORD, name: 'Restored Rune regtest' }); }
  finally { mnemonic = ''; }
  await popup.open();
  await waitForRune(popup.page, fixture, fixture.atomic);
  await openRunes(popup.page);
  await openToken(popup.page, fixture);
  await expect(popup.page.locator('dt').filter({ hasText: /^Available$/u }).locator('xpath=following-sibling::dd[1]')).toHaveText('1,000 R');
  await terminateExtensionWorker(extensionContext, extensionId);
  await wakeExtensionWorker(popup.page, extensionId);
  await waitForRune(popup.page, fixture, fixture.atomic);
});

test('@runes reconciles an externally replaced parent and its dispatched extension child', async ({ onboarding, popup, extensionContext, extensionId }) => {
  test.setTimeout(420_000);
  await assertRegtestReady();
  await onboarding.open();
  await onboarding.createDisposable({ password: PASSWORD, name: 'Rune parent conflict regtest' });
  await popup.open();
  await popup.page.getByRole('button', { name: 'Receive Bitcoin', exact: true }).click();
  const payment = await receiveAddress(popup.page);
  await popup.page.getByRole('radio', { name: 'Ordinals', exact: true }).click();
  const asset = await receiveAddress(popup.page, 'ordinals');
  await popup.page.getByRole('button', { name: 'Close' }).click();
  // Fee funding predates the Rune parent, so invalidating only that parent's
  // exact latest block leaves the child's other input confirmed and unchanged.
  await fundAndConfirm(payment, 100_000);
  const fixture = createRuneFixture(asset, '250.00');
  await waitForRune(popup.page, fixture, '25000');
  const review = await prepareRune(popup.page, fixture, await freshExternalOrdinalAddress(), '100');
  const sent = await runeMessage<{ txid: string; status: string }>(popup.page, 'runes.approve', { planId: review.planId, planHash: review.planHash });
  expect(sent.ok).toBe(true);
  if (!sent.result) throw new Error('extension child dispatch missing');
  const child = sent.result.txid;
  await transactionInMempool(child);
  const parent = await coreRpc<{ blockhash: string }>('getrawtransaction', [fixture.txid, true]);
  if (parent.blockhash !== await coreRpc<string>('getbestblockhash')) throw new Error('fixture parent is not the exact latest block');
  await coreRpc('invalidateblock', [parent.blockhash]);
  const replacement = runeController<{ txid: string }>('rune-replace-parent', ['--confirm', process.env.DREY_REGTEST_PROJECT ?? 'drey-regtest', '--name', fixture.name, '--txid', fixture.txid, '--expected-atomic', '100000']);
  expect((await mempoolTransactionIds()).includes(child)).toBe(false);
  const decoded = inspectRuneTransaction(replacement.txid);
  expect(decoded.outputs[0]?.ord.runes[fixture.name]?.amount).toBe('100000');
  await terminateExtensionWorker(extensionContext, extensionId);
  await wakeExtensionWorker(popup.page, extensionId);
  await expect.poll(async () => {
    const state = await runeState(popup.page);
    const holding = state.holdings.find((item) => item.id === fixture.runeId);
    const transfer = state.transfers.find((item) => item.txid === child);
    return { zeroAvailable: !holding || holding.available === '0', safeHistory: transfer?.status === 'conflicted' || transfer?.status === 'indeterminate' };
  }, { timeout: 90_000 }).toEqual({ zeroAvailable: true, safeHistory: true });
  const retry = await runeMessage(popup.page, 'runes.approve', { planId: review.planId, planHash: review.planHash });
  expect(retry.ok).toBe(false);
  expect((await mempoolTransactionIds()).includes(child)).toBe(false);
});


test('@runes protects Rune coins from ordinary Bitcoin selection, consolidation and fee acceleration', async ({ onboarding, popup }) => {
  test.setTimeout(360_000);
  await assertRegtestReady();
  await onboarding.open();
  await onboarding.createDisposable({ password: PASSWORD, name: 'Rune Bitcoin protection regtest' });
  await popup.open();
  await popup.page.getByRole('button', { name: 'Receive Bitcoin', exact: true }).click();
  const payment = await receiveAddress(popup.page);
  await popup.page.getByRole('radio', { name: 'Ordinals', exact: true }).click();
  const asset = await receiveAddress(popup.page, 'ordinals');
  await popup.page.getByRole('button', { name: 'Close' }).click();
  const fixture = createRuneFixture(asset);
  const funding = await fundAndConfirm(payment, 100_000);
  await waitForRune(popup.page, fixture, fixture.atomic);
  const recipient = await freshExternalAddress();
  expect((await runeMessage(popup.page, 'runes.visibility', { runeId: fixture.runeId, hidden: true })).ok).toBe(true);
  expect((await runeState(popup.page)).holdings.find((holding) => holding.id === fixture.runeId)?.hidden).toBe(true);
  const outpoint = { txid: fixture.txid, vout: Number(fixture.outpoint.split(':')[1]) };
  const fee = { type: 'custom', rateSatPerVb: '1' };
  const before = await mempoolTransactionIds();
  for (const intent of [
    { kind: 'native_send', recipient, amountSats: '1000', sendMax: false, selectedOutpoints: [outpoint] },
    { kind: 'consolidation', selectedOutpoints: [outpoint, { txid: funding.txid, vout: funding.vout }] },
    { kind: 'ordinal_sweep', outpoint },
    { kind: 'cpfp', txid: fixture.txid },
    { kind: 'rbf', txid: fixture.txid },
  ]) {
    const refused = await runeMessage(popup.page, 'transaction.plan', { account: 0, fee, ...intent });
    expect(refused.ok).toBe(false);
    expect(await mempoolTransactionIds()).toEqual(before);
  }
  const planned = await runeMessage<TransactionPlanResult>(popup.page, 'transaction.plan', { account: 0, fee, kind: 'native_send', recipient, amountSats: '10000', sendMax: false });
  if (!planned.ok || !planned.result) throw new Error('ordinary funded Bitcoin plan rejected');
  const review = planned.result;
  expect(review.review.network).toBe('regtest');
  expect(review.review.recipients[0]?.address).toBe(recipient);
  expect(review.review.amountSats).toBe('10000');
  expect(review.review.inputs.some((input) => input.txid === fixture.txid && input.vout === outpoint.vout)).toBe(false);
  const sent = await runeMessage<{ txid: string }>(popup.page, 'transaction.approve', { planId: review.planId, planHash: review.planHash, password: PASSWORD });
  if (!sent.ok || !sent.result?.txid) throw new Error('ordinary Bitcoin dispatch rejected');
  const raw = await coreRpc<{ vin: { txid: string; vout: number }[] }>('getrawtransaction', [sent.result.txid, true]);
  expect(raw.vin.some((input) => input.txid === fixture.txid && input.vout === outpoint.vout)).toBe(false);
  await assertTransactionIntent(sent.result.txid, funding, recipient, 10_000);
  await confirmTransaction(sent.result.txid);
  expect(await coreRpc('gettxout', [fixture.txid, outpoint.vout, true])).not.toBeNull();
  expect(inspectRuneTransaction(fixture.txid).outputs.find((output) => output.outpoint === fixture.outpoint)?.ord.runes[fixture.name]?.amount).toBe(fixture.atomic);
});


test('@runes session preflight survives restart and lock/unlock without chain funding', async ({ onboarding, popup, extensionContext, extensionId }) => {
  test.setTimeout(90_000);
  await assertRegtestReady();
  const before = await mempoolTransactionIds();
  await onboarding.open();
  await onboarding.createDisposable({ password: PASSWORD, name: 'Rune session preflight regtest' });
  await popup.open();
  await trackSessionPresence(popup.page);
  await terminateExtensionWorker(extensionContext, extensionId);
  await wakeExtensionWorker(popup.page, extensionId);
  await popup.lock();
  await popup.unlock(PASSWORD);
  expect((await runeState(popup.page)).canSign).toBe(true);
  expect(await mempoolTransactionIds()).toEqual(before);
});


test('@runes refuses an approval after its exact prepared input is externally spent', async ({ onboarding, popup, extensionContext }) => {
  test.setTimeout(300_000);
  await assertRegtestReady();
  let mnemonic = generateMnemonic(english, 128);
  const seed = mnemonicToSeedSync(mnemonic);
  const master = HDKey.fromMasterSeed(seed);
  const paymentNode = master.derive("m/84'/1'/0'/0/0");
  const ordinalNode = master.derive("m/86'/1'/0'/0/0");
  let payment: string;
  let asset: string;
  let assetScript: Uint8Array;
  let internalKey: Uint8Array;
  let disposableKey: Uint8Array;
  try {
    if (!paymentNode.publicKey || !ordinalNode.publicKey || !ordinalNode.privateKey) throw new Error('disposable account derivation failed');
    payment = p2wpkh(paymentNode.publicKey, { ...TEST_NETWORK, bech32: 'bcrt' }).address!;
    internalKey = ordinalNode.publicKey.slice(1);
    const output = p2tr(internalKey, undefined, { ...TEST_NETWORK, bech32: 'bcrt' });
    asset = output.address!;
    assetScript = output.script;
    disposableKey = Uint8Array.from(ordinalNode.privateKey);
  } finally { paymentNode.wipePrivateData(); ordinalNode.wipePrivateData(); master.wipePrivateData(); seed.fill(0); }
  try {
    const fixture = createRuneFixture(asset);
    await fundAndConfirm(payment, 100_000);
    await onboarding.open();
    try { await onboarding.restorePublicFixture({ mnemonic, password: PASSWORD, name: 'Rune spent input regtest' }); }
    finally { mnemonic = ''; }
    await popup.open();
    await waitForRune(popup.page, fixture, fixture.atomic);
    const recipient = await freshExternalOrdinalAddress();
    const review = await prepareRune(popup.page, fixture, recipient, '100');
    const source = inspectRuneTransaction(fixture.txid).outputs.find((output) => output.outpoint === fixture.outpoint);
    if (!source || source.ord.address !== asset || source.ord.value !== '10000' || source.ord.inscriptions.length !== 0 || Object.keys(source.ord.runes).length !== 1 || source.ord.runes[fixture.name]?.amount !== fixture.atomic) throw new Error('external disposable spend source does not match the prepared fixture');
    const live = await coreRpc<{ value: number; scriptPubKey: { hex: string } } | null>('gettxout', [fixture.txid, Number(fixture.outpoint.split(':')[1]), true]);
    if (!live || live.scriptPubKey.hex !== Buffer.from(assetScript).toString('hex') || Math.round(live.value * 100_000_000) !== 10_000) throw new Error('external disposable source is not exact unspent owned postage');
    const destination = await coreRpc<{ isvalid: boolean; scriptPubKey: string }>('validateaddress', [recipient]);
    if (!destination.isvalid || !recipient.startsWith('bcrt1p')) throw new Error('external disposable destination is not regtest Taproot');
    // Independent same-wallet signer: one known Rune carrier, no runestone, and
    // one output. Reference default allocation preserves the entire token pile.
    const external = new Transaction({ version: 2, lockTime: 0 });
    external.addInput({ txid: fixture.txid, index: Number(fixture.outpoint.split(':')[1]), sequence: 0xffffffff, sighashType: SigHash.DEFAULT, witnessUtxo: { amount: 10_000n, script: assetScript }, tapInternalKey: internalKey });
    external.addOutput({ amount: 9_000n, script: Buffer.from(destination.scriptPubKey, 'hex') });
    if ((await coreRpc<{ chain: string }>('getblockchaininfo')).chain !== 'regtest') throw new Error('external signer requires exact regtest network');
    external.signIdx(disposableKey, 0, [SigHash.DEFAULT]);
    disposableKey.fill(0);
    external.finalize();
    const raw = external.hex;
    const decoded = await coreRpc<{ txid: string; vin: { txid: string; vout: number }[]; vout: { value: number; scriptPubKey: { hex: string } }[] }>('decoderawtransaction', [raw]);
    if (decoded.txid !== external.id || decoded.vin.length !== 1 || decoded.vin[0]?.txid !== fixture.txid || decoded.vin[0]?.vout !== Number(fixture.outpoint.split(':')[1]) || decoded.vout.length !== 1 || decoded.vout[0]?.scriptPubKey.hex !== destination.scriptPubKey || Math.round((decoded.vout[0]?.value ?? 0) * 100_000_000) !== 9_000) throw new Error('external disposable final bytes differ from the exact 1000-sat-fee intent');
    const accepted = await coreRpc<{ allowed?: boolean }[]>('testmempoolaccept', [[raw]]);
    if (accepted[0]?.allowed !== true) throw new Error('Core refused the independent disposable fixture spend');
    const sent = await coreRpc<string>('sendrawtransaction', [raw]);
    if (sent !== external.id) throw new Error('external fixture outcome indeterminate; do not retry');
    await confirmTransaction(sent);
    assertReferenceRuneAddressBalance(recipient, fixture, fixture.atomic);
    expect(await coreRpc('gettxout', [fixture.txid, Number(fixture.outpoint.split(':')[1]), true])).toBeNull();
    const before = await mempoolTransactionIds();
    let dispatches = 0;
    const url = `${gatewayOrigin}/v1/runes/broadcast`;
    await extensionContext.route(url, (route) => { dispatches += 1; return route.abort('failed'); });
    try {
      expect((await runeMessage(popup.page, 'runes.approve', { planId: review.planId, planHash: review.planHash })).ok).toBe(false);
      expect(dispatches).toBe(0);
      expect(await mempoolTransactionIds()).toEqual(before);
    } finally { await extensionContext.unroute(url); }
  } finally { mnemonic = ''; disposableKey.fill(0); }
});

test('@runes keeps warm balances through focus with a themed narrow toolbar', async ({ onboarding, popup, extensionContext }, testInfo) => {
  test.setTimeout(240_000);
  await assertRegtestReady();
  await onboarding.open();
  await onboarding.createDisposable({ password: PASSWORD, name: 'Rune display regtest' });
  await popup.open();
  await popup.page.getByRole('button', { name: 'Receive Bitcoin', exact: true }).click();
  const payment = await receiveAddress(popup.page);
  await popup.page.getByRole('radio', { name: 'Ordinals', exact: true }).click();
  const asset = await receiveAddress(popup.page, 'ordinals');
  await popup.page.getByRole('button', { name: 'Close' }).click();
  const fixture = createRuneFixture(asset);
  await fundAndConfirm(payment, 100_000);
  await waitForRune(popup.page, fixture, fixture.atomic);
  const entry = popup.page.getByRole('button', { name: /^Runes/u });
  await expect(entry).toContainText('1 assets');
  const evidence = `${gatewayOrigin}/v1/runes/outputs`;
  await extensionContext.route(evidence, (route) => route.abort('failed'));
  try {
    await entry.click();
    const row = popup.page.getByRole('button', { name: new RegExp(fixture.name, 'u') });
    expect(await row.isVisible()).toBe(true);
    expect(await row.locator(':scope > span').last().textContent()).toBe('1,000 R');
    await popup.page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    expect(await row.isVisible()).toBe(true);
    await expect(popup.page.getByRole('status').filter({ hasText: 'Showing your last loaded balances' })).toBeVisible({ timeout: 25_000 });
    await expect(row.locator(':scope > span').last()).toHaveText('1,000 R');
    await popup.page.reload();
    await expect(popup.page.getByRole('button', { name: /^Runes/u })).toContainText('1 assets', { timeout: 3_000 });
    await popup.page.getByRole('button', { name: /^Runes/u }).click();
    await expect(row).toBeVisible({ timeout: 3_000 });
    await extensionContext.unroute(evidence);
    for (const language of ['en', 'es'] as const) {
      await popup.page.evaluate(async (lang) => {
        const key = 'squirrel:uiPrefs';
        const stored = (await chrome.storage.local.get(key))[key] as Record<string, unknown> | undefined;
        await chrome.storage.local.set({ [key]: { ...stored, language: lang } });
      }, language);
      await popup.page.reload();
      await popup.page.getByRole('button', { name: /^Runes/u }).click();
      await expect(row).toBeVisible({ timeout: 45_000 });
      const back = popup.page.getByRole('button', { name: language === 'en' ? '← Back' : '← Atrás', exact: true });
      const expand = popup.page.getByRole('button', { name: language === 'en' ? 'Open in full page' : 'Abrir en página completa', exact: true });
      await expect(back).toBeVisible();
      await expect(expand.locator('svg')).toBeVisible();
      for (const width of [392]) {
        await popup.page.setViewportSize({ width, height: 720 });
        const geometry = await expand.evaluate((button) => {
          const rect = button.getBoundingClientRect(); const css = getComputedStyle(button);
          return { right: rect.right, width: rect.width, height: rect.height, radius: css.borderRadius, overflow: document.documentElement.scrollWidth > window.innerWidth };
        });
        expect(geometry.right).toBeLessThanOrEqual(width);
        expect(geometry.width).toBeGreaterThanOrEqual(32);
        expect(geometry.height).toBeGreaterThanOrEqual(32);
        expect(geometry.radius).not.toBe('0px');
        expect(geometry.overflow).toBe(false);
        await expect(row).toBeVisible();
        await popup.page.screenshot({ path: testInfo.outputPath(`runes-warm-${language}-${width}.png`), mask: [row.locator('small')] });
      }
    }
  } finally { await extensionContext.unroute(evidence); }
  const fullpage = new URL('fullpage.html#/runes', popup.page.url()).href;
  await popup.page.goto(fullpage);
  const fullRow = popup.page.getByRole('button', { name: new RegExp(fixture.name, 'u') });
  await expect(fullRow).toBeVisible({ timeout: 45_000 });
  for (const language of ['en', 'es'] as const) {
    await popup.page.evaluate(async (lang) => {
      const key = 'squirrel:uiPrefs';
      const stored = (await chrome.storage.local.get(key))[key] as Record<string, unknown> | undefined;
      await chrome.storage.local.set({ [key]: { ...stored, language: lang } });
    }, language);
    await popup.page.reload();
    await expect(fullRow).toBeVisible({ timeout: 45_000 });
    await expect(popup.page.getByRole('button', { name: language === 'en' ? '← Back' : '← Atrás', exact: true })).toBeVisible();
    for (const width of [320, 390]) {
      await popup.page.setViewportSize({ width, height: 720 });
      expect(await popup.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      await expect(fullRow).toBeVisible();
      expect(await fullRow.locator(':scope > span').last().evaluate((amount) => amount.getBoundingClientRect().height <= Number.parseFloat(getComputedStyle(amount).lineHeight) + 1)).toBe(true);
      await popup.page.screenshot({ path: testInfo.outputPath(`runes-fullpage-${language}-${width}.png`), mask: [fullRow.locator('small')] });
    }
  }
  await popup.page.goto(new URL('sidepanel.html', popup.page.url()).href);
  await popup.page.getByRole('button', { name: /^Runes/u }).click();
  const sideRow = popup.page.getByRole('button', { name: new RegExp(fixture.name, 'u') });
  await expect(sideRow).toBeVisible({ timeout: 45_000 });
  for (const language of ['en', 'es'] as const) {
    await popup.page.evaluate(async (lang) => {
      const key = 'squirrel:uiPrefs';
      const stored = (await chrome.storage.local.get(key))[key] as Record<string, unknown> | undefined;
      await chrome.storage.local.set({ [key]: { ...stored, language: lang } });
    }, language);
    await popup.page.reload();
    await popup.page.getByRole('button', { name: /^Runes/u }).click();
    await expect(sideRow).toBeVisible({ timeout: 45_000 });
    const expand = popup.page.getByRole('button', { name: language === 'en' ? 'Open in full page' : 'Abrir en página completa', exact: true });
    await expect(expand.locator('svg')).toBeVisible();
    for (const width of [320, 390]) {
      await popup.page.setViewportSize({ width, height: 720 });
      expect(await expand.evaluate((button) => button.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
      expect(await popup.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
      await expect(sideRow).toBeVisible();
      expect(await sideRow.locator(':scope > span').last().evaluate((amount) => amount.getBoundingClientRect().height <= Number.parseFloat(getComputedStyle(amount).lineHeight) + 1)).toBe(true);
      await popup.page.screenshot({ path: testInfo.outputPath(`runes-sidepanel-${language}-${width}.png`), mask: [sideRow.locator('small')] });
    }
  }

});

test('@runes lays out send controls and restores fee choices in narrow views', async ({ onboarding, popup }, testInfo) => {
  test.setTimeout(240_000);
  await assertRegtestReady();
  await onboarding.open();
  await onboarding.createDisposable({ password: PASSWORD, name: 'Rune send layout' });
  await popup.open();
  await popup.page.getByRole('button', { name: 'Receive Bitcoin', exact: true }).click();
  const payment = await receiveAddress(popup.page);
  await popup.page.getByRole('radio', { name: 'Ordinals', exact: true }).click();
  const asset = await receiveAddress(popup.page, 'ordinals');
  await popup.page.getByRole('button', { name: 'Close' }).click();
  const fixture = createRuneFixture(asset);
  await fundAndConfirm(payment, 100_000);
  await waitForRune(popup.page, fixture, fixture.atomic);
  await openRunes(popup.page);
  await openToken(popup.page, fixture);
  await popup.page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(popup.page.getByRole('radio', { name: /Standard/u })).toHaveCount(0);
  const feeMode = await chooseRuneFee(popup.page, 'Economy');
  await popup.page.getByLabel('Amount', { exact: true }).fill('123.45');
  // A new popup opens at the list and offers an explicit continuation.
  await popup.open();
  await openRunes(popup.page);
  await expect(popup.page.getByLabel('Amount', { exact: true })).toHaveCount(0);
  await popup.page.getByRole('button', { name: 'Resume transfer', exact: true }).click();
  await expect(popup.page.getByLabel('Amount', { exact: true })).toHaveValue('123.45');
  // Expansion flushes the encrypted draft before navigating to the new surface.
  await popup.page.getByRole('button', { name: 'Open in full page', exact: true }).click();
  await popup.page.goto(new URL('fullpage.html#/runes/resume', popup.page.url()).href);
  await popup.page.getByRole('button', { name: 'Change fee', exact: true }).click();
  await expect(popup.page.getByRole('radio', { name: feeMode === 'quoted' ? /Economy/u : 'Custom' })).toBeChecked();
  if (feeMode === 'custom') await expect(popup.page.getByLabel('Fee rate (sat/vB)')).toHaveValue('1.25');
  await popup.page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(popup.page.getByLabel('Amount', { exact: true })).toHaveValue('123.45');
  for (const language of ['en', 'es'] as const) {
    await popup.page.evaluate(async (lang) => {
      const key = 'squirrel:uiPrefs';
      const stored = (await chrome.storage.local.get(key))[key] as Record<string, unknown> | undefined;
      await chrome.storage.local.set({ [key]: { ...stored, language: lang } });
    }, language);
    await popup.page.reload();
    const review = popup.page.getByRole('button', { name: language === 'en' ? 'Review transfer' : 'Revisar transferencia', exact: true });
    await expect(review).toBeVisible();
    await expect(popup.page.getByRole('button', { name: language === 'en' ? 'Receive Bitcoin' : 'Recibir Bitcoin', exact: true })).toHaveCount(0);
    for (const width of [320, 390]) {
      await popup.page.setViewportSize({ width, height: 850 });
      const geometry = await popup.page.getByRole('button', { name: language === 'en' ? 'Max' : 'Máx.', exact: true }).evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const input = button.parentElement!.querySelector('input')!.getBoundingClientRect();
        return { maxRight: rect.right, inputRight: input.right, bottom: rect.bottom, inputBottom: input.bottom,
          overflow: document.documentElement.scrollWidth > window.innerWidth };
      });
      expect(geometry.overflow).toBe(false);
      expect(geometry.maxRight).toBeLessThanOrEqual(geometry.inputRight);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.inputBottom);
      await popup.page.screenshot({ path: testInfo.outputPath(`rune-send-${language}-${width}.png`), fullPage: true });
    }
  }
});
