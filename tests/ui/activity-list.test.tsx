import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ActivityList,
  clearActivityPreviewStore,
} from '../../src/entrypoints/popup/ActivityList';
import type { WalletHomeResult } from '@drey/core/messaging/ops';
import { installFakeChrome, Providers } from './fake-rpc';

const ACCOUNT_ID = `acct_mainnet_${'1'.repeat(64)}`;

afterEach(() => {
  cleanup();
  clearActivityPreviewStore();
});

const EXPECTATION = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};
const INSCRIPTION_ID = `${'5'.repeat(64)}i1`;

function ordinalActivity(): WalletHomeResult['activity'] {
  return [{
    txid: 'a'.repeat(64),
    deltaSats: '-1021',
    feeSats: '475',
    confirmationState: 'mempool',
    actionKind: 'ordinal_transfer',
    inscriptionId: INSCRIPTION_ID,
    inscriptionNumber: 67_368_437,
    returnedBtcSats: null,
    timestamp: null,
    height: null,
  }];
}

describe('ordinal activity presentation', () => {
  it('keeps the Home preview to the five newest entries while the Activity view stays complete', () => {
    installFakeChrome({});
    const activity: WalletHomeResult['activity'] = [1, 2, 3, 4, 5, 6].map((amount) => ({
      txid: String(amount).repeat(64),
      deltaSats: String(amount),
      feeSats: null,
      confirmationState: 'confirmed' as const,
      timestamp: `2026-07-2${5 - amount}T12:00:00.000Z`,
      height: 959_347 - amount,
    }));
    const rendered = render(
      <Providers>
        <ActivityList accountId={ACCOUNT_ID} activity={activity} compact
          expectation={EXPECTATION} network={null} />
      </Providers>,
    );

    expect(screen.getByText('+1 sats')).toBeInTheDocument();
    expect(screen.getByText('+2 sats')).toBeInTheDocument();
    expect(screen.getByText('+3 sats')).toBeInTheDocument();
    expect(screen.getByText('+4 sats')).toBeInTheDocument();
    expect(screen.getByText('+5 sats')).toBeInTheDocument();
    expect(screen.queryByText('+6 sats')).not.toBeInTheDocument();

    rendered.rerender(
      <Providers>
        <ActivityList accountId={ACCOUNT_ID} activity={activity}
          expectation={EXPECTATION} network={null} />
      </Providers>,
    );
    expect(screen.getByText('+6 sats')).toBeInTheDocument();
  });

  it('shows a recognizable numbered inscription and signed preview without technical postage', async () => {
    const preview = vi.fn(() => ({
      ok: true,
      result: {
        items: [{
          inscriptionId: INSCRIPTION_ID,
          preview: {
          kind: 'raster',
          rasterBase64: 'aQ==',
          pngSha256: 'b'.repeat(64),
          pngWidth: 1,
          pngHeight: 1,
          },
        }],
      },
    }));
    installFakeChrome({ 'activity.inscriptionPreviewBatch': preview });
    render(
      <Providers>
        <ActivityList accountId={ACCOUNT_ID}
          activity={ordinalActivity()}
          expectation={EXPECTATION}
          network="signet"
        />
      </Providers>,
    );

    expect(screen.getByText('Inscription sent')).toBeInTheDocument();
    expect(screen.getByText('Inscription #67,368,437')).toHaveAttribute('title', INSCRIPTION_ID);
    expect(screen.queryByText(INSCRIPTION_ID, { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/Postage/u)).not.toBeInTheDocument();
    expect(screen.getByText('475 sats network fee')).toBeInTheDocument();
    await waitFor(() => expect(preview).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      items: [{ txid: 'a'.repeat(64), inscriptionId: INSCRIPTION_ID }],
      ...EXPECTATION,
    }));
    expect(screen.getByTitle(`Inert preview for inscription ${INSCRIPTION_ID}`)).toBeInTheDocument();
  });

  it('shows an inbound inscription receipt instead of a generic bitcoin amount', async () => {
    const preview = vi.fn(() => ({
      ok: true,
      result: {
        items: [{
          inscriptionId: INSCRIPTION_ID,
          preview: {
          kind: 'raster',
          rasterBase64: 'aQ==',
          pngSha256: 'b'.repeat(64),
          pngWidth: 1,
          pngHeight: 1,
          },
        }],
      },
    }));
    installFakeChrome({ 'activity.inscriptionPreviewBatch': preview });
    render(
      <Providers>
        <ActivityList accountId={ACCOUNT_ID}
          activity={[{
            txid: '2'.repeat(64),
            deltaSats: '546',
            feeSats: null,
            confirmationState: 'confirmed',
            actionKind: 'ordinal_receive',
            inscriptionId: INSCRIPTION_ID,
            inscriptionNumber: 67_368_437,
            receivedInscriptionCount: 1,
            ordinalValueSats: '546',
            timestamp: '2026-07-23T12:00:00.000Z',
            height: 959_347,
          }]}
          expectation={EXPECTATION}
          network="mainnet"
        />
      </Providers>,
    );

    expect(screen.getByText('Inscription received')).toBeInTheDocument();
    expect(screen.getByText('Inscription #67,368,437')).toHaveAttribute('title', INSCRIPTION_ID);
    expect(screen.queryByText(/Postage/u)).not.toBeInTheDocument();
    expect(screen.queryByText('+546 sats')).not.toBeInTheDocument();
    await waitFor(() => expect(preview).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      items: [{ txid: '2'.repeat(64), inscriptionId: INSCRIPTION_ID }],
      ...EXPECTATION,
    }));
  });

  it('summarizes a multi-inscription receipt without duplicating its bitcoin value', () => {
    installFakeChrome({});
    render(
      <Providers>
        <ActivityList accountId={ACCOUNT_ID}
          activity={[{
            txid: '3'.repeat(64),
            deltaSats: '20000',
            feeSats: null,
            confirmationState: 'confirmed',
            actionKind: 'ordinal_receive',
            inscriptionId: INSCRIPTION_ID,
            inscriptionNumber: 1_234,
            receivedInscriptionCount: 3,
            ordinalValueSats: '20000',
            timestamp: null,
            height: 959_347,
          }]}
          expectation={EXPECTATION}
          network={null}
        />
      </Providers>,
    );
    expect(screen.getByText('Inscriptions received')).toBeInTheDocument();
    expect(screen.getByText('Inscription #1,234 · +2 more')).toBeInTheDocument();
    expect(screen.queryByText(/Postage/u)).not.toBeInTheDocument();
  });

  it('uses a short technical identifier when no inscription number was stored', () => {
    installFakeChrome({});
    const activity = ordinalActivity();
    activity[0] = { ...activity[0]!, inscriptionNumber: null };
    render(
      <Providers>
        <ActivityList accountId={ACCOUNT_ID} activity={activity} expectation={EXPECTATION} network={null} />
      </Providers>,
    );
    expect(screen.getByText('Inscription 55555555…555555i1')).toHaveAttribute('title', INSCRIPTION_ID);
    expect(screen.queryByText(INSCRIPTION_ID, { exact: true })).not.toBeInTheDocument();
  });

  it('describes a fee-only self-transfer without showing a scary zero-sat send', () => {
    installFakeChrome({});
    render(
      <Providers>
        <ActivityList accountId={ACCOUNT_ID}
          activity={[{
            txid: '6'.repeat(64),
            deltaSats: '-455',
            feeSats: '455',
            confirmationState: 'confirmed',
            bitcoinActionKind: 'self_transfer',
            timestamp: '2026-07-23T12:00:00.000Z',
            height: 959_347,
          }]}
          expectation={EXPECTATION}
          network="mainnet"
        />
      </Providers>,
    );
    expect(screen.getByText('Bitcoin moved')).toBeInTheDocument();
    expect(screen.getByText('Between your addresses')).toBeInTheDocument();
    expect(screen.getByText('455 sats network fee')).toBeInTheDocument();
    expect(screen.queryByText('−0 sats')).not.toBeInTheDocument();
  });

  it('labels verified Ordinals-address direction without claiming an inscription moved', () => {
    installFakeChrome({});
    render(
      <Providers>
        <ActivityList accountId={ACCOUNT_ID}
          activity={[{
            txid: '7'.repeat(64),
            deltaSats: '-1021',
            feeSats: '475',
            confirmationState: 'confirmed',
            addressContext: 'ordinals_sent',
            timestamp: '2026-07-24T12:00:00.000Z',
            height: 959_430,
          }, {
            txid: '8'.repeat(64),
            deltaSats: '546',
            feeSats: null,
            confirmationState: 'confirmed',
            addressContext: 'ordinals_received',
            timestamp: '2026-07-23T12:00:00.000Z',
            height: 959_308,
          }]}
          expectation={EXPECTATION}
          network="mainnet"
        />
      </Providers>,
    );

    expect(screen.getByText('Sent from Ordinals address')).toBeInTheDocument();
    expect(screen.getByText('Received at Ordinals address')).toBeInTheDocument();
    expect(screen.queryByText(/No verified inscription or Rune/u)).not.toBeInTheDocument();
    expect(screen.queryByText('Inscription sent')).not.toBeInTheDocument();
    expect(screen.getByText('−546 sats')).toBeInTheDocument();
    expect(screen.getByText('+546 sats')).toBeInTheDocument();
  });

  it('shows directly observed Rune identity without weakening unsupported-send copy', () => {
    installFakeChrome({});
    render(
      <Providers>
        <ActivityList accountId={ACCOUNT_ID}
          activity={[{
            txid: 'c'.repeat(64),
            deltaSats: '330',
            feeSats: null,
            confirmationState: 'confirmed',
            addressContext: 'ordinals_received',
            detectedAssets: [{
              protocol: 'rune', name: 'MAGIC•INTERNET•MONEY', amountAtoms: '100',
              divisibility: 0, symbol: null,
            }],
            detectedAssetCount: 1,
            assetIdentityComplete: true,
            timestamp: '2026-07-23T12:00:00.000Z',
            height: 959_308,
          }]}
          expectation={EXPECTATION}
          network="mainnet"
        />
      </Providers>,
    );

    expect(screen.getByText(
      '100 MAGIC•INTERNET•MONEY · Rune detected—sending unsupported',
    )).toBeInTheDocument();
    expect(screen.queryByText('Asset identity unavailable')).not.toBeInTheDocument();
  });

  it('uses a single concise lane label and hides fees in the compact list', () => {
    installFakeChrome({});
    render(
      <Providers>
        <ActivityList accountId={ACCOUNT_ID}
          activity={[{
            txid: '9'.repeat(64),
            deltaSats: '-1021',
            feeSats: '475',
            confirmationState: 'confirmed',
            addressContext: 'ordinals_sent',
            timestamp: '2026-07-24T12:00:00.000Z',
            height: 959_430,
          }]}
          compact
          expectation={EXPECTATION}
          network="mainnet"
        />
      </Providers>,
    );

    expect(screen.getByText('Sent from Ordinals address')).toBeInTheDocument();
    expect(screen.getByText('−546 sats')).toBeInTheDocument();
    expect(screen.queryByText('Asset identity unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText('475 sats network fee')).not.toBeInTheDocument();
  });

  it('groups Bitcoin activity by date and shows public source or destination context', () => {
    installFakeChrome({});
    const sourceAddress = `bc1q${'a'.repeat(38)}`;
    const sentAddress = `bc1p${'b'.repeat(58)}`;
    render(
      <Providers>
        <ActivityList accountId={ACCOUNT_ID}
          activity={[{
            txid: 'a'.repeat(64),
            deltaSats: '1001',
            feeSats: null,
            confirmationState: 'confirmed',
            transactionSource: { inputCount: 1, singleInputAddress: sourceAddress },
            timestamp: '2026-07-23T12:00:00.000Z',
            height: 959_347,
          }, {
            txid: 'b'.repeat(64),
            deltaSats: '-1234',
            feeSats: '234',
            confirmationState: 'mempool',
            addressDisplay: { kind: 'sent_to', address: sentAddress },
            timestamp: null,
            height: null,
          }]}
          expectation={EXPECTATION}
          network="mainnet"
        />
      </Providers>,
    );

    expect(screen.getByText('Received')).toBeInTheDocument();
    expect(screen.getByText('+1,001 sats')).toBeInTheDocument();
    expect(screen.getByTitle(`From ${sourceAddress}`)).toHaveTextContent('From bc1qaaaa…aaaaaa');
    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(screen.getByText('−1,000 sats')).toBeInTheDocument();
    expect(screen.getByTitle(`To ${sentAddress}`)).toHaveTextContent('To bc1pbbbb…bbbbbb');
    expect(screen.getByRole('heading', { name: /July 23, 2026/u })).toBeInTheDocument();
  });

  it('describes multi-input receipts without implying that one address sent them', () => {
    installFakeChrome({});
    render(
      <Providers>
        <ActivityList accountId={ACCOUNT_ID}
          activity={[{
            txid: 'c'.repeat(64),
            deltaSats: '1000',
            feeSats: null,
            confirmationState: 'confirmed',
            transactionSource: { inputCount: 3, singleInputAddress: null },
            timestamp: '2026-07-23T12:00:00.000Z',
            height: 959_347,
          }]}
          compact
          expectation={EXPECTATION}
          network="mainnet"
        />
      </Providers>,
    );

    expect(screen.getByText('From 3 inputs')).toBeInTheDocument();
  });
});
