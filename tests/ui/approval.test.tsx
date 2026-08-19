import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalApp } from '../../src/entrypoints/approval/ApprovalApp';
import { I18nProvider } from '../../src/ui/i18n';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderApproval(): void {
  render(<I18nProvider initial="en"><ApprovalApp /></I18nProvider>);
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

describe('provider approval window', () => {
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

    document.documentElement.scrollTop = 200;
    act(() => listener!(snapshot('123e4567-e89b-42d3-a456-426614174131', 10_750)));
    expect(screen.getByRole('heading', { name: 'Sign this transaction?' })).toHaveFocus();
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

  it('renders exact origin warnings and enforces PSBT reauth and typed confirmation', async () => {
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
          security: { requiresAdvanced: true, rawPsbtHex: '70736274ff' },
          outputs: [{ address: 'tb1qrecipient', valueSats: '50000' }],
        },
        requiresPassword: true, confirmationPhrase: 'SIGN PSBT', approvalError: null,
      },
    });
    expect(await screen.findByRole('heading', { name: 'Sign this transaction?' })).toBeInTheDocument();
    expect(await screen.findByText('https://аpple.example')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Punycode web address');
    expect(screen.getByRole('alert')).toHaveTextContent('characters that can imitate another address');
    expect(screen.getByRole('alert')).not.toHaveTextContent('punycode');
    expect(screen.getByRole('alert')).toHaveTextContent('trust the site and have checked every transaction detail');
    expect(screen.queryByText('All outputs are fixed')).toBeNull();
    expect(screen.getByText(/70736274ff/u)).toBeInTheDocument();
    const approve = screen.getByRole('button', { name: 'Sign transaction' });
    expect(approve).toBeDisabled();
    await userEvent.type(screen.getByLabelText('App password'), 'correct horse battery staple');
    await userEvent.type(screen.getByLabelText('Type SIGN PSBT to continue'), 'SIGN PSBT');
    expect(approve).toBeEnabled();
    await userEvent.click(approve);
    expect(posted.at(-1)).toMatchObject({
      command: 'resolve', approved: true, confirmation: 'SIGN PSBT',
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
            ownership: 'external', role: 'recipient', committed: false,
          }],
        }),
        details: {
          account: 0, network: 'mainnet', feeSats: '0',
          security: { requiresAdvanced: false, rawPsbtHex: '70736274ff' },
          inputs: [], outputs: [],
          marketplace: {
            status: 'recognized', id: 'ordnet', name: 'ord.net', templateId: 'ordnet-list',
            templateVersion: 'drey-1', action: 'list', role: 'seller', assetKind: 'inscription',
            step: 2, stepCount: 3, broadcaster: 'site', flexible: true,
            economics: { sellerProceedsSats: '25000', marketplaceFeeSats: '500', royaltySats: '250', minerFeeSats: '100' },
          },
        },
        requiresPassword: true, confirmationPhrase: 'SIGN PSBT', approvalError: null,
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
    const warnings = screen.getAllByRole('alert').map((element) => element.textContent).join(' ');
    expect(warnings).toContain('may add funding');
    expect(warnings).toContain('cannot take back the signature');
    expect(warnings).toContain('Some outputs can change');
    expect(screen.getByText('Can change')).toBeInTheDocument();
    expect(screen.queryByText('All outputs are fixed')).toBeNull();
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
    expect(screen.getByText(/Reject this request only/iu)).toBeInTheDocument();
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
