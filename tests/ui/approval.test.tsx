import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalApp } from '../../src/entrypoints/approval/ApprovalApp';
import { ProviderSighashEffects, ProviderTransactionGroupReview } from
  '../../src/entrypoints/approval/ProviderTransactionGroupReview';
import { I18nProvider } from '../../src/ui/i18n';
import { bip322MessageHash } from '@drey/core/domain/transactions/bip322';
import { bytesToHex } from '@drey/core/domain/vault/encoding';
import type { ProviderPsbtApprovalExplanationV1 } from
  '@drey/core/domain/transactions/provider-psbt-approval';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderApproval(): void {
  render(<I18nProvider initial="en"><ApprovalApp /></I18nProvider>);
}

function messageHash(message: string): string {
  return bytesToHex(bip322MessageHash(new TextEncoder().encode(message)));
}

function transactionReview(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'transaction',
    walletName: 'Primary wallet',
    account: 0,
    network: 'signet',
    authorization: 'complete',
    feeSats: '500',
    walletInputSats: '51000',
    walletOutputSats: '500',
    externalOutputSats: '50000',
    netWalletDebitSats: '50500',
    economicClaims: [],
    outputs: [{
      index: 0,
      address: 'tb1qrecipient',
      valueSats: '50000',
      ownership: 'external',
      role: 'recipient',
      committed: true,
    }],
    ...overrides,
  };
}

function psbtExplanation(input: {
  flexible?: boolean;
  guaranteedProceedsSats?: string;
  outputOwnership?: 'wallet' | 'external';
  outputValueSats?: string;
} = {}): ProviderPsbtApprovalExplanationV1 {
  const flexible = input.flexible === true;
  const outputOwnership = input.outputOwnership ?? 'external';
  const outputValueSats = input.outputValueSats ?? '50000';
  return {
    version: 1,
    presentation: flexible ? 'flexible' : 'standard',
    intent: input.guaranteedProceedsSats ? 'list_inscription' : 'send_btc',
    currentWalletInputSats: '51000',
    currentWalletOutputSats: outputOwnership === 'wallet' ? outputValueSats : '0',
    guaranteedWalletReturnSats: outputOwnership === 'wallet' ? outputValueSats : '0',
    guaranteedProceedsSats: input.guaranteedProceedsSats ?? '0',
    maximumWalletDebitSats: outputOwnership === 'wallet' ? '0' : '51000',
    commitments: {
      inputs: flexible ? 'changeable' : 'fixed',
      outputs: flexible ? 'changeable' : 'fixed',
      fee: flexible ? 'changeable' : 'fixed',
      feeRate: 'fixed',
    },
    sighashes: [{
      inputIndex: 0,
      raw: flexible ? 131 : 1,
      name: flexible ? 'SINGLE|ANYONECANPAY' : 'ALL',
      inputSet: flexible ? 'changeable' : 'fixed',
      outputs: flexible ? 'corresponding' : 'all',
      correspondingOutputIndex: flexible ? 0 : null,
      fee: flexible ? 'changeable' : 'fixed',
    }],
    outputs: [{
      index: 0,
      valueSats: outputValueSats,
      scriptPubKey: `0014${'11'.repeat(20)}`,
      scriptType: 'p2wpkh',
      address: 'bc1qseller',
      ownership: outputOwnership,
      role: 'recipient',
      commitment: 'fixed',
      guaranteed: true,
    }],
    rbf: 'final',
    broadcastOwner: 'site',
    assetMovements: [],
    warningCodes: flexible
      ? ['inputs_changeable', 'outputs_changeable', 'fee_changeable']
      : [],
    blockReasonCodes: [],
  };
}

describe('provider approval window', () => {
  it('shows a calm complete message-batch review without extra approval friction', async () => {
    const posted: unknown[] = [];
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: (message: unknown) => posted.push(message), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174200',
        method: 'signMultipleMessages', origin: 'https://market.example',
        unicodeOrigin: 'https://market.example', warnings: [], createdAt: 1,
        expiresAt: 300_001, approveAfter: 1,
        review: {
          kind: 'message_batch', walletName: 'Primary wallet', account: 0, network: 'signet',
          messageCount: 2, totalMessageBytes: 26,
          messages: [
            {
              index: 0, address: 'tb1qpaymentaddress', addressKind: 'payment',
              message: 'Payment proof', messageBytes: 13, messageHash: messageHash('Payment proof'),
              protocol: 'BIP322',
            },
            {
              index: 1, address: 'tb1pordinaladdress', addressKind: 'ordinals',
              message: 'Ordinal proof', messageBytes: 13, messageHash: messageHash('Ordinal proof'),
              protocol: 'BIP322',
            },
          ],
        },
        details: { messageBatch: { messageCount: 2, batchHash: '33'.repeat(32) } },
        requiresPassword: false, confirmationPhrase: null, approvalError: null,
      },
    });

    expect(await screen.findByRole('heading', { name: 'Sign 2 messages?' })).toBeInTheDocument();
    expect(screen.getByText('Messages can sign you in or confirm an action. They cannot spend bitcoin.'))
      .toBeInTheDocument();
    expect(screen.getByText('2 messages from this site')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Message 1 of 2' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Message 2 of 2' })).toBeInTheDocument();
    expect(screen.getByText('Payment proof')).toBeInTheDocument();
    expect(screen.getByText('Ordinal proof')).toBeInTheDocument();
    expect(screen.queryByLabelText('App password')).toBeNull();
    expect(screen.queryByText('Hidden formatting is shown as U+ codes.'))
      .toBeNull();
    expect(screen.getByText('Reject affects this request. Closing the window cancels all pending requests.'))
      .toBeInTheDocument();
    const approve = screen.getByRole('button', { name: 'Sign messages' });
    expect(approve).toBeEnabled();
    await userEvent.click(approve);
    expect(posted.at(-1)).toMatchObject({ command: 'resolve', approved: true });
  });

  it('adds a short note only to a message containing hidden text formatting', async () => {
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: vi.fn(), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    const message = 'Review \u202ethis';
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174199',
        method: 'signMultipleMessages', origin: 'https://market.example',
        unicodeOrigin: 'https://market.example', warnings: [], createdAt: 1,
        expiresAt: 300_001, approveAfter: 1,
        review: {
          kind: 'message_batch', walletName: 'Primary wallet', account: 0, network: 'signet',
          messageCount: 1, totalMessageBytes: new TextEncoder().encode(message).length,
          messages: [{
            index: 0, address: 'tb1pordinaladdress', addressKind: 'ordinals',
            message, messageBytes: new TextEncoder().encode(message).length,
            messageHash: messageHash(message), protocol: 'BIP322',
          }],
        },
        details: {}, requiresPassword: false, confirmationPhrase: null, approvalError: null,
      },
    });
    expect(await screen.findByText('Hidden formatting is shown as U+ codes.'))
      .toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sign this message?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign message' })).toBeInTheDocument();
    expect(screen.getByText('Review ⟦U+202E⟧this')).toBeInTheDocument();
    expect(screen.queryByText(message)).toBeNull();
  });

  it('shows aggregate exposure and a complete expandable review for every batch item', async () => {
    const posted: unknown[] = [];
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: (message: unknown) => posted.push(message), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    const itemReview = (index: number, address: string) => ({
      index,
      authorization: 'complete',
      feeSats: '500',
      walletInputSats: '10500',
      walletOutputSats: '0',
      externalOutputSats: '10000',
      netWalletDebitSats: '10500',
      economicClaims: [],
      outputs: [{
        index: 0, address, valueSats: '10000', ownership: 'external',
        role: 'recipient', committed: true,
      }],
    });
    const itemDetails = (index: number) => ({
      approvalExplanation: psbtExplanation(),
      feeSats: '500', feeRateSatPerVb: '5', vsize: '100', rbf: false,
      security: {
        requiresAdvanced: true,
        protectedValueExposedToFees: '0',
        planHash: String(index + 1).repeat(64),
        psbtHash: String(index + 3).repeat(64),
        psbtBytes: 6,
      },
      inputs: [{ index: 0, outpoint: `${String(index + 1).repeat(64)}:0` }],
      outputs: [], warnings: [], effectCount: 0, inscriptions: [],
      requiresPreviewAcknowledgement: false,
    });
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174201',
        method: 'signMultipleTransactions', origin: 'https://app.example',
        unicodeOrigin: 'https://app.example', warnings: [], createdAt: 1,
        expiresAt: 300_001, approveAfter: 1,
        review: {
          kind: 'batch', walletName: 'Primary wallet', account: 0, network: 'signet',
          transactionCount: 2, walletInputSats: '21000', walletOutputSats: '0',
          netWalletDebitSats: '21000', feeExposureSats: '1000',
          transactions: [itemReview(0, 'tb1qfirstrecipient'), itemReview(1, 'tb1qsecondrecipient')],
        },
        details: {
          approvalModelVersion: 1,
          batch: { transactionCount: 2, batchHash: '99'.repeat(32) },
          transactions: [itemDetails(0), itemDetails(1)],
        },
        requiresPassword: true, confirmationPhrase: 'SIGN PSBT', approvalError: null,
      },
    });

    expect(await screen.findByRole('heading', { name: 'Sign 2 transactions?' })).toBeInTheDocument();
    expect(screen.getByText('2 independent transactions')).toBeInTheDocument();
    expect(screen.getByText('1,000 sats')).toBeInTheDocument();
    expect(screen.getByText('Transaction 1 of 2')).toBeInTheDocument();
    expect(screen.getByText('Transaction 2 of 2')).toBeInTheDocument();
    expect(screen.queryByText('tb1qfirstrecipient')).toBeNull();
    expect(screen.queryByText('Signature rules')).toBeNull();
    await userEvent.click(screen.getByText('Transaction 1 of 2'));
    expect(screen.getByText('tb1qfirstrecipient')).toBeInTheDocument();
    await userEvent.click(screen.getByText('Transaction 2 of 2'));
    expect(screen.getByText('tb1qsecondrecipient')).toBeInTheDocument();
    expect(screen.queryByText(/70736274ff/u)).toBeNull();
    expect(screen.getByText(new RegExp(String(3).repeat(64), 'u'))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(String(4).repeat(64), 'u'))).toBeInTheDocument();
    expect(screen.getAllByText('Signature rules')).toHaveLength(2);
    const approve = screen.getByRole('button', { name: 'Sign transactions' });
    expect(approve).toBeDisabled();
    await userEvent.type(screen.getByLabelText('App password'), 'password');
    await userEvent.type(screen.getByLabelText('Type SIGN PSBT to continue'), 'SIGN PSBT');
    expect(approve).toBeEnabled();
    await userEvent.click(approve);
    expect(posted.at(-1)).toMatchObject({ command: 'resolve', approved: true });
  });

  it('keeps verified marketplace intent above the independent batch fallback title', async () => {
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: vi.fn(), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    const item = (index: number) => ({
      index, authorization: 'complete', feeSats: '250', walletInputSats: '10250',
      walletOutputSats: '0', externalOutputSats: '10000', netWalletDebitSats: '10250',
      economicClaims: [], outputs: [{
        index: 0, address: `bc1qrecipient${index}`, valueSats: '10000',
        ownership: 'external', role: 'recipient', committed: true,
      }],
    });
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174299',
        method: 'signMultipleTransactions', origin: 'https://ord.net',
        unicodeOrigin: 'https://ord.net', warnings: [], createdAt: 1,
        expiresAt: 300_001, approveAfter: 1,
        review: {
          kind: 'batch', walletName: 'Primary wallet', account: 0, network: 'mainnet',
          transactionCount: 2, walletInputSats: '20500', walletOutputSats: '0',
          netWalletDebitSats: '20500', feeExposureSats: '500',
          transactions: [item(0), item(1)],
        },
        details: {
          transactions: [{}, {}],
          marketplace: {
            status: 'recognized', id: 'ordnet', name: 'ord.net',
            templateId: 'ordnet-collection-offer-v2', templateVersion: 'drey-1',
            action: 'collection_offer', role: 'buyer', assetKind: 'collection',
            step: 1, stepCount: 2, broadcaster: 'site', flexible: false,
            economics: null,
          },
        },
        requiresPassword: false, confirmationPhrase: null, approvalError: null,
      },
    });

    expect(await screen.findByRole('heading', { name: 'Collection offer?' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sign 2 transactions?' })).toBeNull();
    expect(screen.getByText('2 independent transactions')).toBeInTheDocument();
  });

  it('has a branch-aware linked-group hierarchy ready for a Core explanation', () => {
    render(
      <I18nProvider initial="en">
        <ProviderTransactionGroupReview presentation={{
          kind: 'linked', transactionCount: 3,
          maximumWalletDebitSats: '50600', maximumNetworkFeeSats: '600',
          branchEconomicsExact: true,
          sharedFundingConflictCount: 2,
          outcomeGroups: [{ id: 'sale-or-recovery', settlements: [
            { id: 'settlement', guaranteedWalletReturnSats: '50000',
              maximumWalletDebitSats: '0' },
          ], recovery: { id: 'recovery', guaranteedWalletReturnSats: '9500',
            maximumWalletDebitSats: '600' } }],
        }} />
      </I18nProvider>,
    );

    expect(screen.getByText('3 related transactions')).toBeInTheDocument();
    expect(screen.getByText('Maximum leaving your wallet')).toBeInTheDocument();
    expect(screen.getByText('Maximum network fees')).toBeInTheDocument();
    expect(screen.getByText('50,600 sats')).toBeInTheDocument();
    expect(screen.getByText('600 sats')).toBeInTheDocument();
    const sharedFunding = screen.getByTestId('approval-shared-funding');
    expect(sharedFunding).toHaveTextContent('Shared funding');
    expect(sharedFunding).toHaveTextContent(
      'Some transaction options use the same funds. Only one can be completed.',
    );
    expect(screen.getAllByText('Shared funding')).toHaveLength(1);
    expect(screen.getByRole('region', { name: 'Possible outcomes' })).toHaveTextContent(
      'Only one outcome in this set can complete.',
    );
    expect(screen.getByText('Up to 0 sats may leave your wallet.')).toBeInTheDocument();
    expect(screen.getByText('Up to 600 sats may leave your wallet.')).toBeInTheDocument();
  });

  it('shows Foundry recipients, unlock times, fees, and no-broadcast behavior together', async () => {
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: vi.fn(), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    const item = (index: number) => ({
      index, authorization: 'complete', feeSats: String(330 + index),
      walletInputSats: '663', walletOutputSats: '333', externalOutputSats: '0',
      netWalletDebitSats: String(330 + index), economicClaims: [],
      outputs: [{
        index: 0, address: `bc1pfoundryrecipient${index}`, valueSats: '333',
        ownership: 'wallet', role: 'ordinal_change', committed: true,
      }],
    });
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174297',
        method: 'signMultipleTransactions', origin: 'https://ord.net',
        unicodeOrigin: 'https://ord.net', warnings: [], createdAt: 1,
        expiresAt: 300_001, approveAfter: 1,
        review: {
          kind: 'batch', walletName: 'Primary wallet', account: 0, network: 'mainnet',
          transactionCount: 2, walletInputSats: '1326', walletOutputSats: '666',
          netWalletDebitSats: '661', feeExposureSats: '661',
          transactions: [item(0), item(1)],
        },
        details: {
          approvalModelVersion: 1,
          transactions: [
            {
              ordnetFoundryPresale: {
                recipientAddress: 'bc1pfoundryrecipient0', unlockAt: 1_788_098_400,
                feeReserveSats: '330', inputStatus: 'future_delivery',
              },
            },
            {
              ordnetFoundryPresale: {
                recipientAddress: 'bc1pfoundryrecipient1', unlockAt: 1_784_865_600,
                feeReserveSats: '331', inputStatus: 'classified',
              },
            },
          ],
        },
        requiresPassword: false, confirmationPhrase: null, approvalError: null,
      },
    });

    const review = await screen.findByTestId('approval-foundry-presale');
    expect(review).toHaveTextContent('Verified Foundry presale withdrawals');
    expect(review).toHaveTextContent('bc1pfoundryrecipient0');
    expect(review).toHaveTextContent('bc1pfoundryrecipient1');
    expect(review).toHaveTextContent('Unlocks');
    expect(review).toHaveTextContent('330 sats');
    expect(review).toHaveTextContent('Future delivery inputs will be checked again before signing.');
    expect(review).toHaveTextContent('authoritative inscription and fee-reserve checks');
    expect(review).toHaveTextContent('Drey signs these withdrawals but never broadcasts them.');
  });

  it('describes the complete OMB listing group as one approval', async () => {
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: vi.fn(), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    const transaction = {
      authorization: 'complete', feeSats: '0', walletInputSats: '10000',
      walletOutputSats: '10000', externalOutputSats: '0', netWalletDebitSats: '0',
      economicClaims: [],
      outputs: [{
        index: 0, address: 'bc1pomblistingoutput', valueSats: '10000', ownership: 'wallet',
        role: 'ordinal_change', committed: true,
      }],
    };
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174296',
        method: 'signMultipleTransactions', origin: 'https://ordinalmaxibiz.wiki',
        unicodeOrigin: 'https://ordinalmaxibiz.wiki', warnings: [], createdAt: 1,
        expiresAt: 300_001, approveAfter: 1,
        review: {
          kind: 'batch', walletName: 'Primary wallet', account: 0, network: 'mainnet',
          transactionCount: 3, walletInputSats: '30000', walletOutputSats: '29000',
          netWalletDebitSats: '1000', feeExposureSats: '1000', linked: true,
          maximumWalletDebitSats: '1000', maximumFeeExposureSats: '1000',
          branchEconomicsExact: true, sharedFundingConflictCount: 0,
          alternativeOutcomeGroups: [{
            settlements: [{
              nodeId: 'transaction-2', guaranteedWalletReturnSats: '9000',
              maximumWalletDebitSats: '0',
            }],
            recovery: {
              nodeId: 'transaction-3', guaranteedWalletReturnSats: '10000',
              maximumWalletDebitSats: '1000',
            },
          }],
          transactions: [0, 1, 2].map((index) => ({ index, ...transaction })),
        },
        details: {
          approvalModelVersion: 1,
          transactions: [psbtExplanation(), psbtExplanation({ flexible: true }), psbtExplanation()],
          marketplace: {
            status: 'recognized', id: 'ordnet', name: 'OMB Wiki · ord.net',
            templateId: 'omb-wiki-ordnet-list-v1', templateVersion: 'omb-wiki-ordnet-list-v1',
            action: 'list', role: 'seller', assetKind: 'inscription', step: 1, stepCount: 3,
            groupedStepCount: 3, broadcaster: 'site', flexible: false,
          },
        },
        requiresPassword: false, confirmationPhrase: null, approvalError: null,
      },
    });

    expect(await screen.findByRole('heading', { name: 'List inscription?' })).toBeInTheDocument();
    expect(screen.getByText((_content, node) => node?.tagName === 'P' &&
      node.textContent?.includes('3 linked steps · one approval') === true)).toBeInTheDocument();
    expect(screen.getByText('The site receives the signed PSBT and controls submission.'))
      .toBeInTheDocument();
  });

  it('compresses 50 identical signature effects into one readable rule', () => {
    const explanation = {
      ...psbtExplanation({ flexible: true }),
      sighashes: Array.from({ length: 50 }, (_, inputIndex) => ({
        inputIndex,
        raw: 131 as const,
        name: 'SINGLE|ANYONECANPAY' as const,
        inputSet: 'changeable' as const,
        outputs: 'corresponding' as const,
        correspondingOutputIndex: inputIndex,
        fee: 'changeable' as const,
      })),
    };
    render(<I18nProvider initial="en">
      <ProviderSighashEffects explanation={explanation} deferredFee />
    </I18nProvider>);

    const rules = screen.getByTestId('approval-signature-rules');
    expect(within(rules).getAllByRole('article')).toHaveLength(1);
    expect(within(rules).getByText('50 inputs use this rule')).toBeInTheDocument();
    expect(rules).toHaveTextContent('Each signature fixes its matching output.');
    expect(within(rules).getByText('Fee added later')).toBeInTheDocument();
    expect(rules).not.toHaveTextContent('Input 50');
  });

  it('keeps mixed signature effects as compact distinct rows', () => {
    const explanation = {
      ...psbtExplanation(),
      sighashes: [
        ...Array.from({ length: 25 }, (_, inputIndex) => ({
          inputIndex,
          raw: 1 as const,
          name: 'ALL' as const,
          inputSet: 'fixed' as const,
          outputs: 'all' as const,
          correspondingOutputIndex: null,
          fee: 'fixed' as const,
        })),
        ...Array.from({ length: 25 }, (_, offset) => ({
          inputIndex: offset + 25,
          raw: 131 as const,
          name: 'SINGLE|ANYONECANPAY' as const,
          inputSet: 'changeable' as const,
          outputs: 'corresponding' as const,
          correspondingOutputIndex: offset + 25,
          fee: 'changeable' as const,
        })),
      ],
    };
    render(<I18nProvider initial="en">
      <ProviderSighashEffects explanation={explanation} />
    </I18nProvider>);

    const rules = screen.getByTestId('approval-signature-rules');
    expect(within(rules).getAllByRole('article')).toHaveLength(2);
    expect(within(rules).getAllByText('25 inputs use this rule')).toHaveLength(2);
    expect(within(rules).getByText('ALL')).toBeInTheDocument();
    expect(within(rules).getByText('SINGLE|ANYONECANPAY')).toBeInTheDocument();
  });

  it('keeps deferred and ordinary fixed fees separate in one group', () => {
    const explanation = psbtExplanation();
    render(<I18nProvider initial="en">
      <ProviderSighashEffects explanations={[
        { explanation, deferredFee: true },
        { explanation, deferredFee: false },
      ]} />
    </I18nProvider>);

    const rules = screen.getByTestId('approval-signature-rules');
    const rows = within(rules).getAllByRole('article');
    expect(rows).toHaveLength(2);
    expect(rules).toHaveTextContent('Some fees are added later');
    expect(rows[0]).toHaveTextContent('This transaction stays at 0 sats');
    expect(rows[1]).toHaveTextContent('The network fee is fixed');
  });

  it('keeps independent outcome sets separate and labels conservative limits', () => {
    render(
      <I18nProvider initial="en">
        <ProviderTransactionGroupReview presentation={{
          kind: 'linked', transactionCount: 4,
          maximumWalletDebitSats: '1500', maximumNetworkFeeSats: '1500',
          branchEconomicsExact: false, sharedFundingConflictCount: 0,
          outcomeGroups: [
            { id: 'first', settlements: [{ id: 'first-sale',
              guaranteedWalletReturnSats: '50000', maximumWalletDebitSats: '0' }],
              recovery: { id: 'first-recovery', guaranteedWalletReturnSats: '9500',
                maximumWalletDebitSats: '500' } },
            { id: 'second', settlements: [{ id: 'second-sale',
              guaranteedWalletReturnSats: '60000', maximumWalletDebitSats: '0' }],
              recovery: { id: 'second-recovery', guaranteedWalletReturnSats: '19000',
                maximumWalletDebitSats: '1000' } },
          ],
        }} />
      </I18nProvider>,
    );

    expect(screen.getByText('Conservative debit limit')).toBeInTheDocument();
    expect(screen.getByText('Conservative fee limit')).toBeInTheDocument();
    expect(screen.getByText(/options overlap/iu)).toBeInTheDocument();
    expect(screen.getByText('Sale or recovery 1')).toBeInTheDocument();
    expect(screen.getByText('Sale or recovery 2')).toBeInTheDocument();
    expect(screen.getAllByText('Only one outcome in this set can complete.')).toHaveLength(2);
  });

  it('keeps a maximum transaction group light until an item is opened', async () => {
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: vi.fn(), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    const transactions = Array.from({ length: 41 }, (_, index) => ({
      index, authorization: 'complete' as const, feeSats: '100', walletInputSats: '1000',
      walletOutputSats: '900', externalOutputSats: '0', netWalletDebitSats: '100',
      economicClaims: [], outputs: [{ index: 0, address: `tb1qbatchdestination${index}`,
        valueSats: '900', ownership: 'wallet' as const, role: 'payment_change' as const,
        committed: true }],
    }));
    const oversizedRawPsbt = 'aa'.repeat(700_000);
    const transactionDetails = transactions.map((_, index) => ({
      approvalExplanation: psbtExplanation({ outputOwnership: 'wallet', outputValueSats: '900' }),
      effectCount: 0, inscriptions: [], deferredZeroFee: false,
      security: index === 0
        ? { rawPsbtHex: oversizedRawPsbt }
        : { psbtHash: String((index % 9) + 1).repeat(64), psbtBytes: 500 },
    }));
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174298',
        method: 'signMultipleTransactions', origin: 'https://batch.example',
        unicodeOrigin: 'https://batch.example', warnings: [], createdAt: 1,
        expiresAt: 300_001, approveAfter: 1,
        review: { kind: 'batch', walletName: 'Primary wallet', account: 0, network: 'signet',
          transactionCount: 41, walletInputSats: '41000', walletOutputSats: '36900',
          netWalletDebitSats: '4100', feeExposureSats: '4100', transactions },
        details: { approvalModelVersion: 1, transactions: transactionDetails },
        requiresPassword: false, confirmationPhrase: null, approvalError: null,
      },
    });

    expect(await screen.findByText('41 independent transactions')).toBeInTheDocument();
    expect(screen.getAllByText(/Transaction \d+ of 41/u)).toHaveLength(41);
    expect(screen.queryByText('tb1qbatchdestination0')).toBeNull();
    expect(document.body.textContent).not.toContain(oversizedRawPsbt.slice(0, 128));
    await userEvent.click(screen.getByText('Transaction 41 of 41'));
    expect(screen.getByText('tb1qbatchdestination40')).toBeInTheDocument();
    expect(screen.queryByText('tb1qbatchdestination0')).toBeNull();
    await userEvent.click(screen.getByText('Transaction 1 of 41'));
    expect(screen.getByText('tb1qbatchdestination0')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(oversizedRawPsbt.slice(0, 128));
  });

  it('shows one unavailable state instead of a partial group signature summary', async () => {
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: vi.fn(), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    const transactions = [0, 1].map((index) => ({
      index, authorization: 'complete' as const, feeSats: '100', walletInputSats: '1000',
      walletOutputSats: '900', externalOutputSats: '0', netWalletDebitSats: '100',
      economicClaims: [], outputs: [{ index: 0, address: `tb1qreview${index}`,
        valueSats: '900', ownership: 'wallet' as const, role: 'payment_change' as const,
        committed: true }],
    }));
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174297',
        method: 'signMultipleTransactions', origin: 'https://batch.example',
        unicodeOrigin: 'https://batch.example', warnings: [], createdAt: 1,
        expiresAt: 300_001, approveAfter: 1,
        review: { kind: 'batch', walletName: 'Primary wallet', account: 0, network: 'signet',
          transactionCount: 2, walletInputSats: '2000', walletOutputSats: '1800',
          netWalletDebitSats: '200', feeExposureSats: '200', transactions },
        details: { approvalModelVersion: 1, transactions: [
          { approvalExplanation: psbtExplanation(), effectCount: 0, inscriptions: [] },
          { approvalExplanation: { version: 1 }, effectCount: 0, inscriptions: [] },
        ] },
        requiresPassword: false, confirmationPhrase: null, approvalError: null,
      },
    });

    expect(await screen.findByText(/cannot be safely summarized/iu)).toBeInTheDocument();
    expect(screen.queryByText('Signature rules')).toBeNull();
    await userEvent.click(screen.getByText('Transaction 1 of 2'));
    expect(screen.queryByText('Signature rules')).toBeNull();
    expect(screen.getByTestId('approval-approve')).toBeDisabled();
  });

  it('resets and focuses a queued request while honoring its approval timestamp', () => {
    vi.useFakeTimers({ now: 10_000 });
    const posted: unknown[] = [];
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: (message: unknown) => posted.push(message), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    const snapshot = (requestNonce: string, approveAfter: number) => ({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce,
        method: 'signPsbt', origin: 'https://app.example', unicodeOrigin: 'https://app.example',
        warnings: [], createdAt: 1, expiresAt: 300_001, approveAfter,
        review: transactionReview(),
        details: { security: { requiresAdvanced: true } },
        requiresPassword: true, confirmationPhrase: 'SIGN PSBT', approvalError: null,
      },
    });
    act(() => listener!(snapshot('123e4567-e89b-42d3-a456-426614174130', 10_000)));
    const firstHeading = screen.getByRole('heading', { name: 'Sign this transaction?' });
    expect(firstHeading).toHaveFocus();
    fireEvent.change(screen.getByLabelText('App password'), { target: { value: 'password one' } });
    fireEvent.change(screen.getByLabelText('Type SIGN PSBT to continue'), {
      target: { value: 'SIGN PSBT' },
    });
    expect(screen.getByRole('button', { name: 'Sign transaction' })).toBeEnabled();

    const reviewBody = screen.getByTestId('approval-review-body');
    reviewBody.scrollTop = 240;
    document.documentElement.scrollTop = 200;
    act(() => listener!(snapshot('123e4567-e89b-42d3-a456-426614174131', 10_750)));
    expect(screen.getByRole('heading', { name: 'Sign this transaction?' })).toHaveFocus();
    expect(reviewBody.scrollTop).toBe(0);
    expect(document.documentElement.scrollTop).toBe(0);
    expect(screen.getByLabelText('App password')).toHaveValue('');
    expect(screen.getByLabelText('Type SIGN PSBT to continue')).toHaveValue('');
    const approve = screen.getByRole('button', { name: 'Sign transaction' });
    const reject = screen.getByRole('button', { name: 'Reject' });
    expect(approve).toBeDisabled();
    expect(reject).toBeEnabled();
    fireEvent.change(screen.getByLabelText('App password'), { target: { value: 'password two' } });
    fireEvent.change(screen.getByLabelText('Type SIGN PSBT to continue'), {
      target: { value: 'SIGN PSBT' },
    });
    fireEvent.click(approve);
    expect(posted).toHaveLength(1); // initial snapshot command only
    act(() => vi.advanceTimersByTime(749));
    expect(approve).toBeDisabled();
    act(() => vi.advanceTimersByTime(1));
    expect(approve).toBeEnabled();
  });

  it('renders exact origin warnings and preserves global password confirmation without a typed phrase', async () => {
    const posted: unknown[] = [];
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: (message: unknown) => posted.push(message),
      disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: { connect: () => port },
    };
    renderApproval();
    expect(posted[0]).toMatchObject({ command: 'snapshot' });
    expect(listener).not.toBeNull();
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174001',
        method: 'signPsbt', origin: 'https://xn--pple-43d.example',
        unicodeOrigin: 'https://аpple.example', warnings: ['punycode', 'confusable'],
        createdAt: 1, expiresAt: 300_001, approveAfter: 1,
        review: transactionReview({ feeSats: '2000', netWalletDebitSats: '52000' }),
        details: {
          feeSats: '2000',
          security: { requiresAdvanced: true, psbtHash: 'ab'.repeat(32), psbtBytes: 5 },
          outputs: [{ address: 'tb1qrecipient', valueSats: '50000' }],
        },
        requiresPassword: true, confirmationPhrase: null, approvalError: null,
      },
    });
    expect(await screen.findByRole('heading', { name: 'Sign this transaction?' })).toBeInTheDocument();
    expect(await screen.findByText('https://аpple.example')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Punycode web address');
    expect(screen.getByRole('alert')).toHaveTextContent('characters that can imitate another address');
    expect(screen.getByRole('alert')).not.toHaveTextContent('punycode');
    expect(screen.queryByText('All outputs are fixed')).toBeNull();
    expect(screen.queryByText(/70736274ff/u)).toBeNull();
    expect(screen.getByText(/abababababababab/u)).toBeInTheDocument();
    const approve = screen.getByRole('button', { name: 'Sign transaction' });
    expect(approve).toBeDisabled();
    await userEvent.type(screen.getByLabelText('App password'), 'correct horse battery staple');
    expect(screen.queryByLabelText(/Type SIGN PSBT/u)).toBeNull();
    expect(approve).toBeEnabled();
    await userEvent.click(approve);
    expect(posted.at(-1)).toMatchObject({
      command: 'resolve', approved: true,
      password: 'correct horse battery staple',
    });
  });

  it('shows one simple password approval for an exact Community Vault sale', async () => {
    const posted: unknown[] = [];
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: (message: unknown) => posted.push(message), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174132', method: 'signPsbt',
        origin: 'https://ordinalmaxibiz.wiki', unicodeOrigin: 'https://ordinalmaxibiz.wiki',
        warnings: [], createdAt: 1, expiresAt: 300_001, approveAfter: 1,
        review: transactionReview({
          network: 'mainnet', feeSats: '2000', walletInputSats: '0', walletOutputSats: '0',
          externalOutputSats: '112000', netWalletDebitSats: '0',
          economicClaims: [{ kind: 'guaranteed_proceeds', valueSats: '20000' }],
        }),
        details: {
          security: { requiresAdvanced: false, protectedValueExposedToFees: '0' },
          inputs: [], outputs: [],
          communityVaultSale: {
            campaignId: 'campaign-1', ownerId: 'owner-1', units: Array.from({ length: 20 }, (_, i) => i),
            ownerPayoutSats: '20000', grossOfferSats: '100000', settlementFeeSats: '2000',
          },
        },
        requiresPassword: true, confirmationPhrase: null, approvalError: null,
      },
    });
    expect(await screen.findByRole('heading', { name: 'Approve this OMB sale?' })).toBeInTheDocument();
    expect(screen.getByText(/signs all your units once/iu)).toBeInTheDocument();
    expect(screen.getByText('20,000 sats')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Type SIGN PSBT/u)).toBeNull();
    const approve = screen.getByRole('button', { name: 'Sign transaction' });
    expect(approve).toBeDisabled();
    await userEvent.type(screen.getByLabelText('App password'), 'owner password');
    expect(approve).toBeEnabled();
    await userEvent.click(approve);
    expect(posted.at(-1)).toMatchObject({
      command: 'resolve', approved: true, password: 'owner password',
    });
  });

  it('shows one simple approval for exact buyer funding and never offers broadcast', async () => {
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: vi.fn(), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174133', method: 'signPsbt',
        origin: 'https://ordinalmaxibiz.wiki', unicodeOrigin: 'https://ordinalmaxibiz.wiki',
        warnings: [], createdAt: 1, expiresAt: 300_001, approveAfter: 1,
        review: transactionReview({
          network: 'mainnet', feeSats: '2000', walletInputSats: '103000', walletOutputSats: '1000',
          externalOutputSats: '112000', netWalletDebitSats: '102000',
          economicClaims: [{ kind: 'buyer_total', valueSats: '102000' }],
        }),
        details: {
          security: { requiresAdvanced: false, protectedValueExposedToFees: '0' },
          inputs: [], outputs: [],
          communityVaultSaleBuyer: {
            campaignId: 'campaign-1', buyerId: 'buyer-1', grossOfferSats: '100000',
            buyerTotalSats: '102000', settlementFeeSats: '2000',
          },
        },
        requiresPassword: false, confirmationPhrase: null, approvalError: null,
      },
    });
    expect(await screen.findByRole('heading', { name: 'Fund this OMB offer?' })).toBeInTheDocument();
    expect(screen.getByText(/authorizes only the clean BTC inputs/iu)).toBeInTheDocument();
    expect(screen.getByText('102,000 sats')).toBeInTheDocument();
    expect(screen.queryByLabelText('App password')).toBeNull();
    expect(screen.queryByText(/broadcast transaction/iu)).toBeNull();
  });

  it('shows a complete-position transfer without marketplace language', async () => {
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: vi.fn(), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174134', method: 'signPsbt',
        origin: 'https://ordinalmaxibiz.wiki', unicodeOrigin: 'https://ordinalmaxibiz.wiki',
        warnings: [], createdAt: 1, expiresAt: 300_001, approveAfter: 1,
        review: transactionReview({
          network: 'mainnet', feeSats: '2000', walletInputSats: '0', walletOutputSats: '0',
          externalOutputSats: '111000', netWalletDebitSats: '0', economicClaims: [],
        }),
        details: {
          security: { requiresAdvanced: false, protectedValueExposedToFees: '0' },
          inputs: [], outputs: [],
          communityVaultPositionTransfer: {
            role: 'owner', campaignId: 'campaign-1', transferId: 'transfer-1',
            units: Array.from({ length: 20 }, (_, index) => index + 20),
            sellerPriceSats: '100000', buyerTotalSats: '102000', settlementFeeSats: '2000',
          },
        },
        requiresPassword: true, confirmationPhrase: null, approvalError: null,
      },
    });

    expect(await screen.findByRole('heading', { name: 'Approve this position transfer?' }))
      .toBeInTheDocument();
    expect(screen.getByText(/complete 20% position/iu)).toBeInTheDocument();
    expect(screen.getByText(/seller is paid in the same transaction/iu)).toBeInTheDocument();
    expect(screen.queryByText(/marketplace/iu)).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign transaction' })).toBeDisabled();
  });

  it('shows the buyer one complete-position purchase and no password field', async () => {
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: vi.fn(), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174135', method: 'signPsbt',
        origin: 'https://ordinalmaxibiz.wiki', unicodeOrigin: 'https://ordinalmaxibiz.wiki',
        warnings: [], createdAt: 1, expiresAt: 300_001, approveAfter: 1,
        review: transactionReview({
          network: 'mainnet', feeSats: '2000', walletInputSats: '103000', walletOutputSats: '1000',
          externalOutputSats: '111000', netWalletDebitSats: '102000',
          economicClaims: [{ kind: 'buyer_total', valueSats: '102000' }],
        }),
        details: {
          security: { requiresAdvanced: false, protectedValueExposedToFees: '0' },
          inputs: [], outputs: [],
          communityVaultPositionTransfer: {
            role: 'buyer', campaignId: 'campaign-1', transferId: 'transfer-1',
            units: Array.from({ length: 20 }, (_, index) => index + 20),
            sellerPriceSats: '100000', buyerTotalSats: '102000', settlementFeeSats: '2000',
          },
        },
        requiresPassword: false, confirmationPhrase: null, approvalError: null,
      },
    });

    expect(await screen.findByRole('heading', { name: 'Buy this complete position?' }))
      .toBeInTheDocument();
    expect(screen.getByText(/buying the seller’s complete 20% position/iu)).toBeInTheDocument();
    expect(screen.getByText('102,000 sats')).toBeInTheDocument();
    expect(screen.queryByLabelText('App password')).toBeNull();
  });

  it('reprices a transfer without executing it from a React effect', async () => {
    const posted: unknown[] = [];
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: (message: unknown) => posted.push(message), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    expect(listener).not.toBeNull();
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174002',
        method: 'sendTransfer', origin: 'https://app.example', unicodeOrigin: 'https://app.example',
        warnings: [], createdAt: 1, expiresAt: 300_001, approveAfter: 1,
        review: transactionReview(),
        details: {
          feeSats: '500', feeRateSatPerVb: '5', inputs: [], outputs: [],
          warnings: [{ code: 'high_relative_fee' }],
        },
        requiresPassword: true, confirmationPhrase: null, approvalError: null,
      },
    });
    expect(await screen.findByRole('heading', { name: 'Send bitcoin?' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('high compared with the payment');
    expect(screen.getByRole('alert')).not.toHaveTextContent('high_relative_fee');
    expect(screen.queryByText('All outputs are fixed')).toBeNull();
    expect(screen.queryByLabelText('Fee rate (sat/vB)')).not.toBeVisible();
    await userEvent.click(screen.getByText('Adjust network fee'));
    const field = await screen.findByLabelText('Fee rate (sat/vB)');
    expect(field).toHaveValue(5);
    await userEvent.clear(field);
    await userEvent.type(field, '12');
    await userEvent.click(screen.getByRole('button', { name: 'Update fee' }));
    expect(posted.at(-1)).toEqual({
      type: 'drey:approval', protocolVersion: 1, command: 'setFee',
      requestNonce: '123e4567-e89b-42d3-a456-426614174002', feeRateSatPerVb: 12,
    });
    expect(posted.some((message) => (message as { command?: string }).command === 'resolve')).toBe(false);
  });

  it('separates marketplace economics and explains flexible commitment limits', async () => {
    const posted: unknown[] = [];
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: (message: unknown) => posted.push(message), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174003', method: 'signPsbt',
        origin: 'https://ord.net', unicodeOrigin: 'https://ord.net', warnings: [], createdAt: 1, expiresAt: 300_001, approveAfter: 1,
        review: transactionReview({
          network: 'mainnet',
          authorization: 'partial',
          feeSats: '0',
          walletInputSats: '0',
          walletOutputSats: '0',
          externalOutputSats: '25000',
          netWalletDebitSats: '0',
          economicClaims: [
            { kind: 'guaranteed_proceeds', valueSats: '25000' },
            { kind: 'marketplace_fee', valueSats: '500' },
            { kind: 'creator_royalty', valueSats: '250' },
            { kind: 'miner_fee', valueSats: '100' },
          ],
          outputs: [{
            index: 0, address: 'bc1qseller', valueSats: '25000',
            ownership: 'external', role: 'recipient', committed: true,
          }],
        }),
        details: {
          approvalModelVersion: 1,
          approvalExplanation: psbtExplanation({
            flexible: true,
            guaranteedProceedsSats: '25000',
            outputValueSats: '25000',
          }),
          account: 0, network: 'mainnet', feeSats: '0',
          security: { requiresAdvanced: false, psbtHash: 'ac'.repeat(32), psbtBytes: 5 },
          inputs: [], outputs: [],
          marketplace: {
            status: 'recognized', id: 'ordnet', name: 'ord.net', templateId: 'ordnet-list',
            templateVersion: 'drey-1', action: 'list', role: 'seller', assetKind: 'inscription',
            step: 2, stepCount: 3, broadcaster: 'site', flexible: true,
            economics: { sellerProceedsSats: '25000', marketplaceFeeSats: '500', royaltySats: '250', minerFeeSats: '100' },
          },
        },
        requiresPassword: false, confirmationPhrase: null, approvalError: null,
      },
    });
    expect(await screen.findByRole('heading', { name: 'List inscription?' })).toBeInTheDocument();
    expect(screen.getByText(/Step 2 of 3/u)).toBeInTheDocument();
    const transactionSummary = screen.getByRole('region', { name: 'Transaction summary' });
    expect(within(transactionSummary).getByText('Guaranteed proceeds')).toBeInTheDocument();
    expect(within(transactionSummary).getByText('25,000 sats')).toBeInTheDocument();
    expect(within(transactionSummary).getByText('Fee verified now')).toBeInTheDocument();
    expect(within(transactionSummary).getByText('0 sats')).toBeInTheDocument();
    expect(within(transactionSummary).getByText(/final fee may change/iu)).toBeInTheDocument();
    expect(within(transactionSummary).queryByText('Marketplace fee')).toBeNull();
    expect(within(transactionSummary).queryByText('Creator royalty')).toBeNull();
    expect(within(transactionSummary).queryByText('Miner fee')).toBeNull();
    const surfacedRules = screen.getByTestId('approval-signature-rules');
    expect(surfacedRules).toHaveTextContent('SINGLE|ANYONECANPAY');
    expect(surfacedRules).toHaveTextContent('The site can add or remove other inputs.');
    expect(surfacedRules).toHaveTextContent('Only output 1 is fixed.');
    expect(surfacedRules).toHaveTextContent('The final network fee can change.');
    expect(screen.queryByText('All outputs are fixed')).toBeNull();
    await userEvent.click(screen.getByText('Technical details'));
    const signatureRules = screen.getByTestId('approval-signature-rules');
    expect(within(signatureRules).getByText('Input 1')).toBeInTheDocument();
    expect(within(signatureRules).getByText('SINGLE|ANYONECANPAY')).toBeInTheDocument();
    expect(signatureRules).toHaveTextContent('The site can add or remove other inputs.');
    expect(signatureRules).toHaveTextContent('Only output 1 is fixed.');
    expect(signatureRules).toHaveTextContent('The final network fee can change.');
    const rawDetails = signatureRules.parentElement?.querySelector('pre');
    expect(rawDetails).not.toBeNull();
    expect(signatureRules.compareDocumentPosition(rawDetails!) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  it('presents a proven generic listing as a listing with guaranteed proceeds', async () => {
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: vi.fn(), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174273', method: 'signPsbt',
        origin: 'https://list.example', unicodeOrigin: 'https://list.example',
        warnings: [], createdAt: 1, expiresAt: 300_001, approveAfter: 1,
        review: transactionReview({
          network: 'mainnet', authorization: 'partial', feeSats: '0',
          walletInputSats: '10000', walletOutputSats: '25000',
          externalOutputSats: '0', netWalletDebitSats: '-15000',
          economicClaims: [{ kind: 'guaranteed_proceeds', valueSats: '25000' }],
          outputs: [{
            index: 0, address: 'bc1qseller', valueSats: '25000',
            ownership: 'wallet', role: 'recipient', committed: true,
          }],
        }),
        details: {
          approvalModelVersion: 1,
          approvalExplanation: psbtExplanation({
            flexible: true,
            guaranteedProceedsSats: '25000',
            outputOwnership: 'wallet',
            outputValueSats: '25000',
          }),
          account: 0, network: 'mainnet', feeSats: '0',
          security: { requiresAdvanced: false, psbtHash: 'ad'.repeat(32), psbtBytes: 5 },
          inputs: [], outputs: [],
          genericListing: { guaranteedProceedsSats: '25000', flexible: true },
        },
        requiresPassword: false, confirmationPhrase: null, approvalError: null,
      },
    });

    expect(await screen.findByRole('heading', { name: 'List inscription?' })).toBeInTheDocument();
    const summary = screen.getByRole('region', { name: 'Transaction summary' });
    expect(within(summary).getByText('Guaranteed proceeds')).toBeInTheDocument();
    expect(within(summary).getByText('25,000 sats')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign listing' })).toBeInTheDocument();
    expect(screen.getByTestId('approval-signature-rules')).toHaveTextContent(
      'SINGLE|ANYONECANPAY',
    );
    expect(screen.queryByText('Verified marketplace request')).toBeNull();
  });

  it('shows every co-located inscription with its full ID and requires the signed-placeholder acknowledgement', async () => {
    const posted: unknown[] = [];
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: (message: unknown) => posted.push(message), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        connect: () => port,
        getURL: (path: string) => `chrome-extension://fixture/${path}`,
      },
    };
    const firstId = `${'a'.repeat(64)}i0`;
    const secondId = `${'b'.repeat(64)}i1`;
    const txid = 'c'.repeat(64);
    renderApproval();
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174004', method: 'signPsbt',
        origin: 'https://market.example', unicodeOrigin: 'https://market.example', warnings: [],
        createdAt: 1, expiresAt: 300_001, approveAfter: 1,
        review: transactionReview(),
        details: {
          inputs: [], outputs: [], effectCount: 2, requiresPreviewAcknowledgement: true,
          inscriptions: [
            {
              inscriptionId: firstId, satpoint: `${txid}:0:0`, outpoint: { txid, vout: 0 },
              movement: 'received', coLocationGroup: `${txid}:0:0`,
              qualifiedPartialAuthorization: false,
              preview: {
                kind: 'raster',
                rasterBase64: 'iVBORw0KGgo=',
                pngSha256: 'd'.repeat(64),
                pngWidth: 1,
                pngHeight: 1,
              },
            },
            {
              inscriptionId: secondId, satpoint: `${txid}:0:0`, outpoint: { txid, vout: 0 },
              movement: 'retained', coLocationGroup: `${txid}:0:0`,
              qualifiedPartialAuthorization: true,
              preview: { kind: 'placeholder', reason: 'active_content' },
            },
          ],
        },
        requiresPassword: false, confirmationPhrase: null, approvalError: null,
      },
    });

    expect(await screen.findByRole('heading', { name: '2 co-located inscriptions' })).toBeInTheDocument();
    expect(screen.getByText(firstId)).toBeInTheDocument();
    expect(screen.getByText(secondId)).toBeInTheDocument();
    expect(screen.getByText('Received')).toBeInTheDocument();
    expect(screen.getByText('Retained')).toBeInTheDocument();
    expect(screen.getByText('Qualified partial marketplace authorization')).toBeInTheDocument();
    expect(screen.getByTitle(`Inert preview for inscription ${firstId}`)).toHaveAttribute(
      'sandbox', 'allow-scripts',
    );
    expect(screen.getByTitle(`Inert preview for inscription ${firstId}`)).toHaveAttribute(
      'referrerpolicy', 'no-referrer',
    );
    expect(screen.getByRole('status')).toHaveTextContent('Executable or active content is not rendered.');
    expect(screen.getByRole('button', { name: 'Sign transaction' })).toBeDisabled();
    await userEvent.click(screen.getByLabelText(
      'Drey verified the inscription identifier and transaction effects, but no safe image is available. I checked the full inscription identifier and want to continue without an image.',
    ));
    expect(screen.getByRole('button', { name: 'Sign transaction' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Sign transaction' }));
    expect(posted.at(-1)).toMatchObject({
      command: 'resolve', approved: true, previewUnavailableAcknowledged: true,
    });
  });

  it('fails closed instead of dropping a malformed preview record', async () => {
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: vi.fn(), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174005', method: 'signPsbt',
        origin: 'https://app.example', unicodeOrigin: 'https://app.example', warnings: [],
        createdAt: 1, expiresAt: 300_001, approveAfter: 1,
        review: transactionReview(),
        details: {
          inputs: [], outputs: [], effectCount: 1,
          inscriptions: [{ inscriptionId: `${'e'.repeat(64)}i0`, preview: { kind: 'raster' } }],
        },
        requiresPassword: false, confirmationPhrase: null, approvalError: null,
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('preview data is invalid');
    expect(screen.getByRole('button', { name: 'Sign transaction' })).toBeDisabled();
  });

  it('renders the sat-flow diagram alongside the authoritative output list', async () => {
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: vi.fn(), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174006', method: 'sendTransfer',
        origin: 'https://app.example', unicodeOrigin: 'https://app.example', warnings: [],
        createdAt: 1, expiresAt: 300_001, approveAfter: 1,
        review: transactionReview({
          feeSats: '411',
          walletInputSats: '130000',
          walletOutputSats: '10000',
          externalOutputSats: '119589',
          netWalletDebitSats: '120000',
          outputs: [{
            index: 0, address: 'tb1qrecipientaddressinfull', valueSats: '119589',
            ownership: 'external', role: 'recipient', committed: true,
          }],
        }),
        details: {
          feeSats: '411', feeRateSatPerVb: '5',
          security: { protectedValueExposedToFees: '0' },
          inputs: [{ index: 0, valueSats: '130000', ownership: 'wallet' }],
          outputs: [
            {
              index: 0, address: 'tb1qrecipientaddressinfull', valueSats: '119589',
              ownership: 'external', role: 'recipient', committed: true,
            },
          ],
        },
        requiresPassword: false, confirmationPhrase: null, approvalError: null,
      },
    });
    expect(await screen.findByRole('heading', { name: 'Sat flow' })).toBeInTheDocument();
    // The full address must remain readable from the list, not only the picture.
    const destination = screen.getByText('Destination').parentElement;
    expect(destination).not.toBeNull();
    expect(within(destination!).getByText(/tb1qrecipientaddressinfull/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign and send' })).toBeEnabled();
  });

  it('never lets a malformed diagram projection block approval', async () => {
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: vi.fn(), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174007', method: 'sendTransfer',
        origin: 'https://app.example', unicodeOrigin: 'https://app.example', warnings: [],
        createdAt: 1, expiresAt: 300_001, approveAfter: 1,
        review: transactionReview({
          feeSats: '411',
          walletInputSats: '130000',
          walletOutputSats: '10000',
          externalOutputSats: '119589',
          netWalletDebitSats: '120000',
          outputs: [{
            index: 0, address: 'tb1qout', valueSats: '119589',
            ownership: 'external', role: 'recipient', committed: true,
          }],
        }),
        details: {
          feeSats: '411',
          security: { protectedValueExposedToFees: '0' },
          // Index disagrees with position: the diagram must decline to draw,
          // while the ordinary review continues unaffected.
          inputs: [{ index: 4, valueSats: '130000', ownership: 'wallet' }],
          outputs: [{ index: 0, address: 'tb1qout', valueSats: '119589', ownership: 'external', role: 'recipient', committed: true }],
        },
        requiresPassword: false, confirmationPhrase: null, approvalError: null,
      },
    });
    const destination = (await screen.findByText('Destination')).parentElement;
    expect(destination).not.toBeNull();
    expect(within(destination!).getByText(/tb1qout/u)).toBeInTheDocument();
    const transactionSummary = screen.getByRole('region', { name: 'Transaction summary' });
    expect(within(transactionSummary).getByText('Leaving your wallet')).toBeInTheDocument();
    expect(within(transactionSummary).getByText('120,000 sats')).toBeInTheDocument();
    expect(within(transactionSummary).getByText('Network fee')).toBeInTheDocument();
    expect(within(transactionSummary).getByText('411 sats')).toBeInTheDocument();
    expect(screen.getByText('Requested by')).toBeInTheDocument();
    expect(screen.queryByText('All outputs are fixed')).toBeNull();
    expect(within(transactionSummary).getByText(/exact fee for this transaction/iu)).toBeInTheDocument();
    expect(screen.queryByText('Fixed')).toBeNull();
    expect(screen.getByText(/Reject affects this request/iu)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sat flow' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign and send' })).toBeEnabled();
  });

  it('blocks approval and explains when protected value would become a miner fee', async () => {
    const posted: unknown[] = [];
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: (message: unknown) => posted.push(message), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174010', method: 'sendTransfer',
        origin: 'https://app.example', unicodeOrigin: 'https://app.example', warnings: [],
        createdAt: 1, expiresAt: 300_001, approveAfter: 1,
        review: transactionReview({
          feeSats: '6500', walletInputSats: '56500', walletOutputSats: '0',
          externalOutputSats: '50000', netWalletDebitSats: '56500',
        }),
        details: {
          feeSats: '6500', feeRateSatPerVb: '5',
          security: { protectedValueExposedToFees: '6000' },
          inputs: [{ index: 0, valueSats: '56500', ownership: 'wallet' }],
          outputs: [{
            index: 0, address: 'tb1qrecipient', valueSats: '50000', ownership: 'external',
            role: 'recipient', committed: true,
          }],
        },
        requiresPassword: false, confirmationPhrase: null, approvalError: null,
      },
    });

    expect(await screen.findByText('Signing blocked'))
      .toBeInTheDocument();
    expect(screen.getByText(/6,000 protected sats would pay the fee/iu)).toBeInTheDocument();
    expect(screen.getByText(/using clean Bitcoin for fees/iu)).toBeInTheDocument();
    const approve = screen.getByRole('button', { name: 'Sign and send' });
    expect(approve).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();
    await userEvent.click(approve);
    expect(posted.some((message) => (message as { command?: string }).command === 'resolve')).toBe(false);
  });

  it('shows wallet identity and plain-language access without adding an approval step', async () => {
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: vi.fn(), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot', protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174008',
        method: 'wallet_connect',
        origin: 'https://app.example',
        unicodeOrigin: 'https://app.example',
        warnings: [],
        createdAt: 1,
        expiresAt: 300_001,
        approveAfter: 1,
        review: {
          kind: 'connection',
          walletName: 'Savings',
          account: 2,
          network: 'signet',
          categories: ['account_identity', 'balance', 'network'],
          purposes: ['payment'],
        },
        details: {},
        requiresPassword: false,
        confirmationPhrase: null,
        approvalError: null,
      },
    });
    expect(await screen.findByText('Savings')).toBeInTheDocument();
    expect(screen.getByText('Account 3')).toBeInTheDocument();
    expect(screen.getByText('Balance')).toBeInTheDocument();
    expect(screen.getByText('Bitcoin payment address')).toBeInTheDocument();
    expect(screen.getByText(/does not let the site sign messages or spend bitcoin/iu))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
  });

  it('fails closed with a recoverable message only when the authoritative review is malformed', async () => {
    let listener: ((message: unknown) => void) | null = null;
    const port = {
      postMessage: vi.fn(), disconnect: vi.fn(),
      onMessage: {
        addListener: (next: (message: unknown) => void) => { listener = next; },
        removeListener: vi.fn(),
      },
      onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    };
    (globalThis as { chrome?: unknown }).chrome = { runtime: { connect: () => port } };
    renderApproval();
    (listener as unknown as (message: unknown) => void)({
      type: 'drey:approval:snapshot',
      protocolVersion: 1,
      request: {
        requestNonce: '123e4567-e89b-42d3-a456-426614174009',
        method: 'sendTransfer',
        origin: 'https://app.example',
        unicodeOrigin: 'https://app.example',
        warnings: [],
        createdAt: 1,
        expiresAt: 300_001,
        approveAfter: 1,
        details: {},
        requiresPassword: false,
        confirmationPhrase: null,
        approvalError: null,
      },
    });
    expect(await screen.findByRole('heading', { name: 'Unable to verify request summary' }))
      .toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign and send' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
  });
});
