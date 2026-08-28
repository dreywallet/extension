import type { Page } from '@playwright/test';
import { test, expect, type DappPage, type OnboardingPage, type PopupPage } from './fixtures';
import {
  assertRegtestReady,
  assertTransactionIntent,
  broadcastFinalizedProviderBatch,
  confirmTransaction,
  createProviderPsbtFixture,
  freshExternalAddress,
  fundWithoutConfirmation,
  mempoolTransactionIds,
  mineBlock,
  mutateAndFinalizeFlexibleProviderPsbt,
  transactionInMempool,
  verifySignedProviderBatch,
  type ProviderPsbtFixture,
} from './regtest';

const TEST_PASSWORD = ['disposable', 'regtest', 'provider', 'batch', 'only'].join('-');

interface ProviderBatchResult {
  psbtBase64?: unknown;
  txId?: unknown;
}

interface ProviderPsbtResult {
  psbt?: unknown;
}

interface ProviderErrorResult {
  error?: { code?: unknown; message?: unknown };
}

function checkedRegtestAddress(value: string | null): string {
  if (value === null || !/^bcrt1[ac-hj-np-z02-9]{8,87}$/u.test(value)) {
    throw new Error('receive surface did not return a valid regtest address');
  }
  return value;
}

function batchRequest(paymentAddress: string, fixtures: readonly ProviderPsbtFixture[]) {
  return {
    network: { type: 'Regtest' as const, address: paymentAddress },
    message: 'Review independent local transactions',
    psbts: fixtures.map((fixture) => ({
      psbtBase64: fixture.psbtBase64,
      inputsToSign: [{ address: paymentAddress, signingIndexes: [0], sigHash: 1 as const }],
    })),
  };
}

async function createProviderWallet(input: {
  onboarding: OnboardingPage;
  popup: PopupPage;
  name: string;
}): Promise<string> {
  await input.onboarding.open();
  await input.onboarding.createDisposable({ password: TEST_PASSWORD, name: input.name });
  await input.popup.open();
  await expect(input.popup.page.getByText('Regtest', { exact: true })).toBeVisible();
  await input.popup.page.getByRole('button', { name: 'Receive' }).click();
  const paymentAddress = checkedRegtestAddress(
    await input.popup.page.getByTestId('receive-address').textContent(),
  );
  await input.popup.page.getByRole('button', { name: 'Close' }).click();

  return paymentAddress;
}

async function connectProvider(dapp: DappPage): Promise<void> {
  await dapp.open();
  const connection = await dapp.invokeWithApproval('Connect');
  try {
    await connection.expectMethod('wallet_connect');
  } catch (cause) {
    const output = await dapp.output().textContent();
    let providerState = output?.startsWith('Pending ') === true ? 'pending' : 'unexpected';
    try {
      const parsed = JSON.parse(output ?? '') as ProviderErrorResult;
      if (parsed.error) {
        providerState = `error:${String(parsed.error.code)}:${String(parsed.error.message)}`;
      }
    } catch {
      // Successful provider payloads can contain wallet data and are never
      // included in diagnostics.
    }
    throw new Error(`Connection approval unavailable while provider was ${providerState}`, { cause });
  }
  await connection.approve();
  await expect(dapp.output()).toContainText('"walletType": "software"');
}

async function fundProviderWallet(
  popup: PopupPage,
  address: string,
  amounts: readonly number[],
) {
  const fundings = [];
  for (const amount of amounts) fundings.push(await fundWithoutConfirmation(address, amount));
  await mineBlock();
  await popup.page.bringToFront();
  await popup.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const expected = amounts.reduce((sum, amount) => sum + amount, 0);
  await expect(popup.page.getByTestId('balance-card')).toContainText(
    `${expected.toLocaleString('en-US')} sats`,
    { timeout: 60_000 },
  );
  return fundings;
}

async function providerFixtures(
  address: string,
  fundings: Awaited<ReturnType<typeof fundProviderWallet>>,
  sends: readonly number[],
): Promise<ProviderPsbtFixture[]> {
  const fixtures: ProviderPsbtFixture[] = [];
  for (let index = 0; index < fundings.length; index += 1) {
    fixtures.push(await createProviderPsbtFixture({
      funding: fundings[index]!,
      walletAddress: address,
      destination: await freshExternalAddress(),
      sendSats: sends[index]!,
    }));
  }
  return fixtures;
}

async function expectNoHorizontalApprovalOverflow(page: Page): Promise<void> {
  const health = await page.evaluate(() => {
    const main = document.querySelector('main');
    const clippedButtons = [...document.querySelectorAll('button')]
      .filter((button) => button.getClientRects().length > 0 && button.scrollWidth > button.clientWidth + 1)
      .map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim() ?? 'unnamed');
    return {
      clippedButtons,
      noHorizontalOverflow:
        document.documentElement.scrollWidth <= window.innerWidth &&
        document.body.scrollWidth <= window.innerWidth &&
        (main === null || main.scrollWidth <= main.clientWidth),
    };
  });
  expect(health).toEqual({ clippedButtons: [], noHorizontalOverflow: true });
}

test('@extended signs two real independent provider PSBTs in one review and never broadcasts', async ({
  onboarding,
  popup,
  dapp,
}) => {
  test.slow();
  await assertRegtestReady();
  const paymentAddress = await createProviderWallet({
    onboarding, popup, name: 'Provider batch regtest E2E',
  });
  const fundings = await fundProviderWallet(popup, paymentAddress, [90_000, 110_000]);
  await connectProvider(dapp);
  const fixtures = await providerFixtures(paymentAddress, fundings, [30_000, 40_000]);
  const mempoolBeforeSigning = await mempoolTransactionIds();

  await dapp.configureTransactionBatch(batchRequest(paymentAddress, fixtures));
  const approval = await dapp.invokeWithApproval('Sign transaction batch');
  await approval.expectMethod('signMultipleTransactions');
  await expect(approval.page.getByText('2 independent transactions')).toBeVisible();
  await expect(approval.page.getByText('71,000 sats', { exact: true })).toBeVisible();
  await expect(approval.page.getByText('1,000 sats', { exact: true })).toBeVisible();
  await expect(approval.page.getByText('Transaction 1 of 2')).toBeVisible();
  await approval.page.getByText('Transaction 1 of 2').click();
  await expect(approval.page.getByText(fixtures[0]!.destination, { exact: true })).toBeVisible();
  await approval.page.getByText('Transaction 2 of 2').click();
  await expect(approval.page.getByText(fixtures[1]!.destination, { exact: true })).toBeVisible();
  await expectNoHorizontalApprovalOverflow(approval.page);
  await approval.approve();
  await expect(dapp.output()).toContainText('psbtBase64', { timeout: 60_000 });

  const result = await dapp.outputJson<ProviderBatchResult[]>();
  expect(result).toHaveLength(2);
  expect(result.every((item) => typeof item.psbtBase64 === 'string' && item.txId === undefined))
    .toBe(true);
  expect(await mempoolTransactionIds()).toEqual(mempoolBeforeSigning);
  const finalized = await verifySignedProviderBatch(
    result.map((item) => String(item.psbtBase64)),
    fixtures,
  );
  expect(finalized.map((item) => item.txid)).toEqual(fixtures.map((fixture) => fixture.unsignedTxid));
  expect(await mempoolTransactionIds()).toEqual(mempoolBeforeSigning);

  const txids = await broadcastFinalizedProviderBatch(finalized);
  for (let index = 0; index < txids.length; index += 1) {
    await transactionInMempool(txids[index]!);
    await assertTransactionIntent(
      txids[index]!,
      fixtures[index]!.funding,
      fixtures[index]!.destination,
      fixtures[index]!.sendSats,
      { min: 2.5, max: 5 },
    );
  }
  await confirmTransaction(txids[0]!);
});

test('@extended signs exact zero-fee alternatives with clear shared-funding review', async ({
  onboarding,
  popup,
  dapp,
}) => {
  test.slow();
  await assertRegtestReady();
  const paymentAddress = await createProviderWallet({
    onboarding, popup, name: 'Provider deferred alternatives regtest E2E',
  });
  const [funding] = await fundProviderWallet(popup, paymentAddress, [100_000]);
  await connectProvider(dapp);
  const fixtures = await Promise.all([30_000, 35_000].map(async (sendSats) =>
    createProviderPsbtFixture({
      funding: funding!,
      walletAddress: paymentAddress,
      destination: await freshExternalAddress(),
      sendSats,
      feeSats: 0,
    })));
  const mempoolBefore = await mempoolTransactionIds();

  await dapp.configureTransactionBatch(batchRequest(paymentAddress, fixtures));
  const approval = await dapp.invokeWithApproval('Sign transaction batch');
  await approval.expectMethod('signMultipleTransactions');
  await expect(approval.page.getByText('2 related transactions')).toBeVisible();
  await expect(approval.page.getByText('Shared funding', { exact: true })).toBeVisible();
  await expect(approval.page.getByText(
    'Some transaction options use the same funds. Only one can be completed.',
    { exact: true },
  )).toBeVisible();
  const group = approval.page.getByTestId('approval-transaction-group');
  await expect(group.getByText('Maximum leaving your wallet')).toBeVisible();
  await expect(group.getByText('35,000 sats', { exact: true })).toBeVisible();
  await expect(group.getByText('Maximum network fees')).toBeVisible();
  await expect(group.getByText('0 sats', { exact: true })).toBeVisible();
  await expect(approval.page.getByTestId('approval-signature-rules')
    .getByText('Fee added later', { exact: true }).first()).toBeVisible();
  await expectNoHorizontalApprovalOverflow(approval.page);
  await approval.approve();
  await expect(dapp.output()).toContainText('psbtBase64', { timeout: 60_000 });

  const result = await dapp.outputJson<ProviderBatchResult[]>();
  expect(result).toHaveLength(2);
  await verifySignedProviderBatch(
    result.map((item) => String(item.psbtBase64)),
    fixtures,
    { expectMempoolAcceptance: false },
  );
  expect(await mempoolTransactionIds()).toEqual(mempoolBefore);
});

test('@extended signs and validates real flexible PSBT mutations against Bitcoin Core', async ({
  onboarding,
  popup,
  dapp,
}) => {
  test.slow();
  await assertRegtestReady();
  const paymentAddress = await createProviderWallet({
    onboarding, popup, name: 'Provider flexible regtest E2E',
  });
  const fundings = await fundProviderWallet(popup, paymentAddress, [120_000, 120_000, 120_000]);
  await connectProvider(dapp);

  const externalFundings = [];
  for (let index = 0; index < 2; index += 1) {
    externalFundings.push(await fundWithoutConfirmation(await freshExternalAddress(), 20_000));
  }
  await mineBlock();
  const mempoolBefore = await mempoolTransactionIds();
  const cases = [
    { sighash: 129 as const, label: 'ALL|ANYONECANPAY', externalFunding: externalFundings[0] },
    { sighash: 3 as const, label: 'SINGLE', changeOutputSats: 68_400 },
    { sighash: 131 as const, label: 'SINGLE|ANYONECANPAY', changeOutputSats: 68_400,
      externalFunding: externalFundings[1] },
  ];

  for (let index = 0; index < cases.length; index += 1) {
    const scenario = cases[index]!;
    const fixture = await createProviderPsbtFixture({
      funding: fundings[index]!,
      walletAddress: paymentAddress,
      destination: await freshExternalAddress(),
      sendSats: 50_000,
      sighash: scenario.sighash,
    });
    await dapp.configurePsbtRequest({
      psbt: fixture.psbtBase64,
      signInputs: { [paymentAddress]: [0] },
      broadcast: false,
    });
    const approval = await dapp.invokeWithApproval('Sign PSBT');
    await approval.expectMethod('signPsbt');
    const rules = approval.page.getByTestId('approval-signature-rules');
    await expect(rules.getByText('Signature rules', { exact: true })).toBeVisible();
    if (scenario.sighash >= 128) {
      await expect(rules).toContainText('The site can add or remove other inputs.');
    } else {
      await expect(rules).toContainText('All current inputs are fixed.');
    }
    if (scenario.sighash === 3 || scenario.sighash === 131) {
      await expect(rules).toContainText('Only output 1 is fixed.');
    } else {
      await expect(rules).toContainText('All current outputs are fixed.');
    }
    await expect(rules).toContainText('The final network fee can change.');
    await expect(approval.page.getByLabel('App password')).toHaveCount(0);
    await expect(approval.page.getByLabel(/SIGN PSBT/u)).toHaveCount(0);
    await approval.approve();
    await expect(dapp.output()).toContainText('"psbt"', { timeout: 60_000 });
    const result = await dapp.outputJson<ProviderPsbtResult>();
    expect(typeof result.psbt).toBe('string');
    const finalized = await verifySignedProviderBatch([String(result.psbt)], [fixture]);
    const mutated = await mutateAndFinalizeFlexibleProviderPsbt({
      psbtBase64: String(result.psbt),
      ...(scenario.changeOutputSats === undefined ? {} : {
        changeOutputSats: scenario.changeOutputSats,
      }),
      ...(scenario.externalFunding === undefined ? {} : {
        externalFunding: scenario.externalFunding,
      }),
    });
    expect(mutated.txid).not.toBe(finalized[0]!.txid);
    expect(await mempoolTransactionIds()).toEqual(mempoolBefore);
  }
});

test('@extended rejects a duplicate real provider transaction before approval', async ({
  onboarding,
  popup,
  dapp,
  extensionContext,
}) => {
  test.slow();
  await assertRegtestReady();
  const paymentAddress = await createProviderWallet({
    onboarding, popup, name: 'Provider rejection regtest E2E',
  });
  const [funding] = await fundProviderWallet(popup, paymentAddress, [100_000]);
  await connectProvider(dapp);
  const [first] = await providerFixtures(paymentAddress, [funding!], [30_000]);
  const mempoolBefore = await mempoolTransactionIds();

  const pageCount = extensionContext.pages().length;
  await dapp.configureTransactionBatch(batchRequest(paymentAddress, [first!, first!]));
  await dapp.invoke('Sign transaction batch');
  await expect(dapp.output()).toContainText('Invalid params', { timeout: 60_000 });
  const error = await dapp.outputJson<ProviderErrorResult>();
  expect(error.error).toMatchObject({ code: -32602, message: 'Invalid params' });
  expect(extensionContext.pages()).toHaveLength(pageCount);
  expect(await mempoolTransactionIds()).toEqual(mempoolBefore);
});

test('@extended returns no batch result when a real input is spent during approval', async ({
  onboarding,
  popup,
  dapp,
}) => {
  test.slow();
  await assertRegtestReady();
  const paymentAddress = await createProviderWallet({
    onboarding, popup, name: 'Provider stale regtest E2E',
  });
  const fundings = await fundProviderWallet(popup, paymentAddress, [100_000, 120_000]);
  await connectProvider(dapp);
  const conflict = (await providerFixtures(paymentAddress, [fundings[0]!], [25_000]))[0]!;

  await dapp.configureTransactionBatch(batchRequest(paymentAddress, [conflict]));
  const conflictApproval = await dapp.invokeWithApproval('Sign transaction batch');
  await expect(conflictApproval.page.getByRole('heading', { name: 'Sign this transaction?' })).toBeVisible();
  await conflictApproval.approve();
  await expect(dapp.output()).toContainText('psbtBase64', { timeout: 60_000 });
  const conflictResult = await dapp.outputJson<ProviderBatchResult[]>();
  const finalizedConflict = await verifySignedProviderBatch(
    conflictResult.map((item) => String(item.psbtBase64)),
    [conflict],
  );

  const stale = await createProviderPsbtFixture({
    funding: fundings[0]!,
    walletAddress: paymentAddress,
    destination: await freshExternalAddress(),
    sendSats: 30_000,
  });
  const independent = (await providerFixtures(paymentAddress, [fundings[1]!], [40_000]))[0]!;
  await dapp.configureTransactionBatch(batchRequest(paymentAddress, [stale, independent]));
  const approval = await dapp.invokeWithApproval('Sign transaction batch');
  await approval.expectMethod('signMultipleTransactions');
  await expect(approval.page.getByText('Transaction 2 of 2')).toBeVisible();

  const [conflictTxid] = await broadcastFinalizedProviderBatch(finalizedConflict);
  await transactionInMempool(conflictTxid!);
  await confirmTransaction(conflictTxid!);
  await approval.approve();
  await expect(dapp.output()).toContainText('Wallet data is not current', { timeout: 60_000 });
  const error = await dapp.outputJson<ProviderErrorResult>();
  expect(error.error).toMatchObject({ code: -32009 });
  expect(await dapp.output().textContent()).not.toContain('psbtBase64');
  expect(await mempoolTransactionIds()).not.toContain(stale.unsignedTxid);
  expect(await mempoolTransactionIds()).not.toContain(independent.unsignedTxid);
});
