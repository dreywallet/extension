import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearGalleryDataStore,
  type GalleryViewResult,
} from '../../src/ui/hooks/use-gallery-data';

afterEach(() => {
  cleanup();
  clearGalleryDataStore();
  vi.useRealTimers();
});
import { Home } from '../../src/entrypoints/popup/Home';
import type { GatewayStatusView } from '@drey/core/domain/gateway/status-view';
import {
  GALLERY_PREVIEW_UNAVAILABLE,
  type WalletHomeResult,
} from '@drey/core/messaging/ops';
import { GATEWAY_TRANSIENT_GRACE_MS } from '../../src/ui/hooks/use-gateway-status';
import { emitRuntimeMessage, installFakeChrome, Providers } from './fake-rpc';

const EXPECTATION = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};
const ACCOUNT_ID = `acct_signet_${'1'.repeat(64)}`;

const connectedView: GatewayStatusView = {
  state: 'connected',
  network: 'signet',
  mode: 'full_sat_safety',
  missingProtections: [],
  tipHeight: 250000,
  verifiedAtMs: 1,
  ageMs: 0,
  lastReason: null,
};

function homeResult(overrides: Partial<WalletHomeResult> = {}): WalletHomeResult {
  return {
    balances: {
      availableSats: '205556',
      protectedSats: '10000',
      reservedSats: '0',
      pendingSats: '0',
      frozenSats: '0',
      unavailableCleanSats: '0',
    },
    protectionBreakdown: {
      assetSats: '10000',
      awaitingClassificationSats: '0',
      userFrozenSats: '0',
      dustQuarantinedSats: '0',
    },
    collectiblesCount: 1,
    wrongLaneCount: 0,
    dataGating: { state: 'fresh', blockedActions: [] },
    activity: [
      {
        txid: 'a'.repeat(64),
        deltaSats: '123456',
        feeSats: null,
        confirmationState: 'confirmed',
        timestamp: '2026-07-19T12:00:00.000Z',
        height: 249900,
      },
      {
        txid: 'b'.repeat(64),
        deltaSats: '-50234',
        feeSats: '234',
        confirmationState: 'mempool',
        timestamp: null,
        height: null,
      },
    ],
    historyComplete: true,
    wrongLane: [],
    lastSyncedAt: 1_752_969_600_000,
    scan: {
      kind: 'completed',
      scanId: 'scan-1',
      unitsDone: 23,
      unitsTotal: 23,
      currentUnit: null,
      boundaryUnits: [],
      failureReason: null,
      historyPartial: false,
    },
    ...overrides,
    accountId: overrides.accountId ?? ACCOUNT_ID,
  };
}

function renderHome(
  result: WalletHomeResult,
  gateway: GatewayStatusView = connectedView,
  onManageUtxos = () => undefined,
) {
  installFakeChrome({
    'wallet.home': () => ({ ok: true, result }),
  });
  render(
    <Providers>
      <Home activeAccountId={ACCOUNT_ID}
        gateway={gateway}
        expectation={EXPECTATION}
        onReceive={() => undefined}
        onManageUtxos={onManageUtxos}
      />
    </Providers>,
  );
}

describe('Home with live balances (§10.2)', () => {
  it('settles on an explicit retry state when the initial balance request fails', async () => {
    let fail = true;
    installFakeChrome({
      'wallet.home': () =>
        fail ? { ok: false, code: 'ERR_INTERNAL' } : { ok: true, result: homeResult() },
    });
    render(
      <Providers>
        <Home activeAccountId={ACCOUNT_ID} gateway={connectedView} expectation={EXPECTATION} onReceive={() => undefined} />
      </Providers>,
    );

    expect(await screen.findByText('Balance unavailable. Try again.')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('205,556 sats')).toBeInTheDocument();
  });

  it('keeps protected and reserved bitcoin compact until the user asks for its breakdown', async () => {
    renderHome(homeResult());
    expect(await screen.findByText('205,556 sats')).toBeInTheDocument();
    expect(screen.getByText('Available to send')).toBeInTheDocument();
    expect(screen.queryByText('Bitcoin balance')).not.toBeInTheDocument();
    expect(screen.getByText('0.00205556 BTC')).toBeInTheDocument();
    expect(screen.getByText('10,000 sats')).toBeInTheDocument();
    const disclosure = screen.getByRole('button', {
      name: 'Bitcoin set aside from regular sends, 10,000 sats',
    });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/outputs carrying protected assets or collectibles/iu))
      .not.toBeInTheDocument();
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/outputs carrying protected assets or collectibles/iu))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review protected sats' }))
      .toBeInTheDocument();
    expect(screen.queryByText(/sample data/iu)).not.toBeInTheDocument();
    expect(screen.getByTestId('home-collectibles-count')).toHaveTextContent('1');
  });

  it('omits the set-aside disclosure when every protected band is zero', async () => {
    renderHome(homeResult({
      balances: {
        availableSats: '205556',
        protectedSats: '0',
        reservedSats: '0',
        pendingSats: '0',
        frozenSats: '0',
        unavailableCleanSats: '0',
      },
      protectionBreakdown: {
        assetSats: '0',
        awaitingClassificationSats: '0',
        userFrozenSats: '0',
        dustQuarantinedSats: '0',
      },
    }));

    expect(await screen.findByText('Available to send')).toBeInTheDocument();
    expect(screen.queryByText('Set aside')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /set aside from regular sends/iu }))
      .not.toBeInTheDocument();
  });

  it('keeps cached account data visible with a compact status during refresh', async () => {
    renderHome(homeResult({
      scan: {
        kind: 'running',
        scanId: 'scan-2',
        unitsDone: 0,
        unitsTotal: 2,
        currentUnit: {
          source: 'standard',
          accountId: ACCOUNT_ID,
          account: 0,
          lane: 'payment',
        },
        boundaryUnits: [],
        failureReason: null,
        historyPartial: false,
      },
    }));

    expect(await screen.findByText('205,556 sats')).toBeInTheDocument();
    const syncStatus = screen.getByRole('status', { name: /Syncing with Bitcoin/iu });
    expect(syncStatus).toHaveTextContent('Syncing');
    expect(screen.getByTestId('balance-meta')).toContainElement(syncStatus);
  });

  it('shows a fresh mainnet USD estimate and preserves exact sats as accessible detail', async () => {
    const now = Date.now();
    installFakeChrome({
      'wallet.home': () => ({ ok: true, result: homeResult() }),
      'price.quote': () => ({
        ok: true,
        result: {
          instanceId: 'gateway-1',
          network: 'mainnet',
          protocolVersion: 2,
          requestNonce: 'a'.repeat(32),
          timestamp: new Date(now).toISOString(),
          coreTip: { height: 900000, hash: 'b'.repeat(64) },
          indexTip: { height: 900000, hash: 'b'.repeat(64) },
          classificationRevision: 'mainnet-rev-1',
          capabilities: [],
          signature: 'c'.repeat(128),
          base: 'BTC',
          quote: 'USD',
          priceUsdCentsPerBtc: '10000000',
          observedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 120_000).toISOString(),
          quality: 'consensus',
          sourceCount: 3,
          maxDeviationBps: 10,
        },
      }),
    });
    render(
      <Providers>
        <Home activeAccountId={ACCOUNT_ID}
          gateway={{ ...connectedView, network: 'mainnet' }}
          expectation={EXPECTATION}
          onReceive={() => undefined}
        />
      </Providers>,
    );
    expect(await screen.findByText('≈ $205.56 USD')).toBeInTheDocument();
    expect(screen.getByText('205,556 sats')).toHaveAttribute('title', '0.00205556 BTC');
  });

  it('falls back to exact sats when the optional mainnet price is unavailable', async () => {
    installFakeChrome({
      'wallet.home': () => ({ ok: true, result: homeResult() }),
      'price.quote': () => ({ ok: true, result: null }),
    });
    render(
      <Providers>
        <Home activeAccountId={ACCOUNT_ID}
          gateway={{ ...connectedView, network: 'mainnet' }}
          expectation={EXPECTATION}
          onReceive={() => undefined}
        />
      </Providers>,
    );

    expect(await screen.findByText('205,556 sats')).toBeInTheDocument();
    expect(screen.getByText('0.00205556 BTC')).toBeInTheDocument();
    expect(screen.queryByText(/USD/u)).not.toBeInTheDocument();
  });

  it('folds frozen value into the Protected row, never Available', async () => {
    renderHome(
      homeResult({
        balances: {
          availableSats: '82100',
          protectedSats: '10000',
          reservedSats: '0',
          pendingSats: '0',
          frozenSats: '123456',
          unavailableCleanSats: '0',
        },
        protectionBreakdown: {
          assetSats: '10000',
          awaitingClassificationSats: '0',
          userFrozenSats: '123456',
          dustQuarantinedSats: '0',
        },
      }),
    );
    expect(await screen.findByText('82,100 sats')).toBeInTheDocument();
    expect(screen.getByText('133,456 sats')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {
      name: 'Bitcoin set aside from regular sends, 133,456 sats',
    }));
    expect(screen.getByText('123,456 sats were frozen by you.')).toBeInTheDocument();
  });

  it('explains dust quarantine on demand and opens the protected UTXO review', async () => {
    const onManageUtxos = vi.fn();
    renderHome(
      homeResult({
        balances: {
          availableSats: '10000',
          protectedSats: '0',
          reservedSats: '0',
          pendingSats: '0',
          frozenSats: '293',
          unavailableCleanSats: '0',
        },
        protectionBreakdown: {
          assetSats: '0',
          awaitingClassificationSats: '0',
          userFrozenSats: '0',
          dustQuarantinedSats: '293',
        },
      }),
      connectedView,
      onManageUtxos,
    );
    const disclosure = await screen.findByRole('button', {
      name: 'Bitcoin set aside from regular sends, 293 sats',
    });
    expect(screen.queryByText(/below Bitcoin's script dust limit/iu)).not.toBeInTheDocument();
    fireEvent.click(disclosure);
    expect(await screen.findByText(/293 sats are below Bitcoin's script dust limit/iu))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review protected sats' }));
    expect(onManageUtxos).toHaveBeenCalledOnce();
  });

  it('shows the §12.1 wrong-lane alert', async () => {
    const onManageUtxos = vi.fn();
    renderHome(homeResult({ wrongLaneCount: 1 }), connectedView, onManageUtxos);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Drey found 1 coin holding a collectible at a Bitcoin address.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Review coins' }));
    expect(onManageUtxos).toHaveBeenCalledOnce();
  });

  it('reconciles §12.2 reserved value inside the combined disclosure', async () => {
    renderHome(
      homeResult({
        balances: {
          availableSats: '40000',
          protectedSats: '0',
          reservedSats: '200000',
          pendingSats: '0',
          frozenSats: '0',
          unavailableCleanSats: '0',
        },
      }),
    );
    const disclosure = await screen.findByRole('button', {
      name: 'Bitcoin set aside from regular sends, 200,000 sats',
    });
    expect(screen.queryByText(/plain Bitcoin held at your collectibles address/iu))
      .not.toBeInTheDocument();
    fireEvent.click(disclosure);
    expect(screen.getByText(/200,000 sats are plain Bitcoin held at your collectibles address/iu))
      .toBeInTheDocument();
  });

  it('separates a verified pending Ordinal from generic incoming bitcoin', async () => {
    const ordinalTxid = 'b'.repeat(64);
    renderHome(homeResult({
      balances: {
        availableSats: '205556',
        protectedSats: '0',
        reservedSats: '0',
        pendingSats: '1546',
        pendingOrdinalSats: '546',
        frozenSats: '0',
        unavailableCleanSats: '0',
      },
      protectionBreakdown: {
        assetSats: '0',
        awaitingClassificationSats: '0',
        userFrozenSats: '0',
        dustQuarantinedSats: '0',
      },
      pendingOrdinalCount: 1,
      activity: [{
        txid: ordinalTxid,
        deltaSats: '546',
        feeSats: null,
        confirmationState: 'mempool',
        pendingAsset: 'ordinal',
        timestamp: null,
        height: null,
      }],
    }));

    expect((await screen.findAllByText('Pending Ordinal'))[0]).toBeInTheDocument();
    expect(screen.getByText('546 sats', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('Verification completes after confirmation')).toBeInTheDocument();
    expect(screen.getByText('Pending confirmation')).toBeInTheDocument();
    expect(screen.getByText('Included in your balance; spendable after confirmation'))
      .toBeInTheDocument();
    expect(screen.getByText('1,000 sats', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('Bitcoin balance').parentElement)
      .toHaveTextContent('206,556 sats');
    expect(screen.getByText('Available now').parentElement)
      .toHaveTextContent('205,556 sats');
    expect(screen.getAllByText(/^Pending Ordinal/u)).toHaveLength(2);
  });

  it('renders non-transient §11.4 gating states immediately, outranking the gateway banner', async () => {
    const cases = [
      ['backend_unreachable', /cannot reach the wallet service/iu],
      ['backend_read_only', /gateway is read-only/iu],
      ['reorg_reconciliation', /reorganized recent blocks/iu],
      ['conflicting_sources', /inconsistent data/iu],
    ] as const;
    for (const [state, pattern] of cases) {
      cleanup();
      renderHome(
        homeResult({
          dataGating: {
            state,
            blockedActions: ['native_send'],
          },
        }),
        { ...connectedView, state: 'degraded', mode: 'standard_ordinals_safety' },
      );
      const status = await screen.findByRole('status');
      expect(status.textContent, state).toMatch(pattern);
      expect(status.textContent).not.toContain('Unavailable:');
      expect(screen.getByText('Bitcoin balance')).toBeInTheDocument();
      expect(screen.queryByText('Available to send')).not.toBeInTheDocument();
    }
  });

  it('hides a transient index lag that recovers within the gateway grace period', async () => {
    vi.useFakeTimers();
    let current = homeResult({
      dataGating: { state: 'index_lag', blockedActions: ['native_send'] },
    });
    installFakeChrome({
      'wallet.home': () => ({ ok: true, result: current }),
    });
    render(
      <Providers>
        <Home activeAccountId={ACCOUNT_ID}
          gateway={connectedView}
          expectation={EXPECTATION}
          onReceive={() => undefined}
        />
      </Providers>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('205,556 sats')).toBeInTheDocument();
    expect(screen.getByText('Bitcoin balance')).toBeInTheDocument();
    expect(screen.getByTestId('balance-meta')).toBeInTheDocument();
    expect(screen.queryByText('Syncing', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/wallet service is catching up/iu)).not.toBeInTheDocument();

    current = homeResult();
    await act(async () => {
      emitRuntimeMessage({ type: 'squirrel:wallet-data-changed', reason: 'utxo' });
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(GATEWAY_TRANSIENT_GRACE_MS);
    });
    expect(screen.queryByText('Syncing', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/wallet service is catching up/iu)).not.toBeInTheDocument();
  });

  it('presents a published normal block confirmation compactly instead of read-only', async () => {
    vi.useFakeTimers();
    renderHome(
      homeResult({
        dataGating: { state: 'index_lag', blockedActions: ['native_send'] },
      }),
      {
        ...connectedView,
        state: 'read_only',
        mode: null,
        walletDataFresh: false,
        spendingReady: false,
        commonTip: true,
        classificationState: 'active',
        reorgState: 'clear',
        readinessReasons: [
          'classification_revision_mismatch',
          'classification_tip_mismatch',
          'spending_endpoints_unavailable',
        ],
      },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const syncStatus = screen.getByRole('status', { name: /Syncing with Bitcoin/iu });
    expect(syncStatus).toHaveTextContent('Syncing');
    expect(syncStatus).not.toHaveTextContent('Syncing with Bitcoin');
    expect(screen.getByTestId('balance-meta')).toContainElement(syncStatus);
    expect(screen.queryByText(/read-only/iu)).not.toBeInTheDocument();
    expect(screen.queryByText(/wallet service is catching up/iu)).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GATEWAY_TRANSIENT_GRACE_MS);
    });
    expect(screen.getByRole('status', { name: /Syncing with Bitcoin/iu }))
      .toHaveTextContent('Syncing');
    expect(screen.queryByText(/read-only/iu)).not.toBeInTheDocument();
    expect(screen.queryByText(/wallet service is catching up/iu)).not.toBeInTheDocument();
  });

  it('shows persistent index lag compactly after the gateway grace period', async () => {
    vi.useFakeTimers();
    renderHome(homeResult({
      dataGating: { state: 'index_lag', blockedActions: ['native_send'] },
    }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByText('Syncing', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/wallet service is catching up/iu)).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GATEWAY_TRANSIENT_GRACE_MS - 1);
    });
    expect(screen.queryByText('Syncing', { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText(/wallet service is catching up/iu)).not.toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const syncStatus = screen.getByRole('status', { name: /Syncing with Bitcoin/iu });
    expect(syncStatus).toHaveTextContent('Syncing');
    expect(screen.getByTestId('balance-meta')).toContainElement(syncStatus);
    expect(screen.queryByText(/wallet service is catching up/iu)).not.toBeInTheDocument();
  });

  it('keeps owned clean bitcoin visible while freshness temporarily gates spending', async () => {
    vi.useFakeTimers();
    const onSend = vi.fn();
    installFakeChrome({
      'wallet.home': () => ({
        ok: true,
        result: homeResult({
          balances: {
            ...homeResult().balances,
            availableSats: '0',
            unavailableCleanSats: '205556',
          },
          dataGating: { state: 'index_lag', blockedActions: ['native_send'] },
        }),
      }),
    });
    render(
      <Providers>
        <Home activeAccountId={ACCOUNT_ID}
          gateway={connectedView}
          expectation={EXPECTATION}
          onReceive={() => undefined}
          onSend={onSend}
        />
      </Providers>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('Bitcoin balance').parentElement).toHaveTextContent('205,556 sats');
    expect(screen.queryByText('Available now')).not.toBeInTheDocument();
    expect(screen.queryByText('Syncing', { exact: true })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Syncing with Bitcoin. Sending will be available in a moment.',
    );
  });

  it('keeps a higher-priority gateway fault prominent instead of adding syncing', async () => {
    vi.useFakeTimers();
    renderHome(
      homeResult({
        dataGating: { state: 'index_lag', blockedActions: ['native_send'] },
      }),
      {
        ...connectedView,
        state: 'read_only',
        mode: null,
        walletDataFresh: true,
        spendingReady: false,
        commonTip: true,
        classificationState: 'blocked',
        reorgState: 'clear',
        readinessReasons: ['capacity_low', 'spending_endpoints_unavailable'],
      },
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(GATEWAY_TRANSIENT_GRACE_MS);
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'The wallet service cannot protect collectibles right now.',
    );
    expect(screen.queryByText('Syncing', { exact: true })).not.toBeInTheDocument();
  });

  it('tells the user when a conflicting-data recovery scan is already running', async () => {
    renderHome(homeResult({
      dataGating: { state: 'conflicting_sources', blockedActions: ['native_send'] },
      scan: {
        kind: 'running',
        scanId: 'scan-recovery',
        unitsDone: 0,
        unitsTotal: 2,
        currentUnit: { source: 'standard', accountId: ACCOUNT_ID, account: 0, lane: 'payment' },
        boundaryUnits: [],
        failureReason: null,
        historyPartial: false,
      },
    }));
    expect(await screen.findByRole('status')).toHaveTextContent('Retrying automatically');
  });

  it('renders recent activity with direction and state', async () => {
    renderHome(homeResult(), { ...connectedView, network: 'mainnet' });
    expect(await screen.findByText(/\+123,456 sats/u)).toBeInTheDocument();
    expect(screen.getByText(/−50,000 sats/u)).toBeInTheDocument();
    expect(screen.queryByText('234 sats network fee')).not.toBeInTheDocument();
    expect(screen.getByText(/^Pending/u)).toBeInTheDocument();
    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveAttribute(
      'href',
      `https://mempool.space/tx/${'a'.repeat(64)}`,
    );
    expect(links[0]).toHaveAttribute('target', '_blank');
    expect(links[0]).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('shows only visible safe carousel rasters and exposes both navigation paths', async () => {
    const onViewOrdinals = vi.fn();
    const onOpenCollectible = vi.fn();
    const visibleId = `${'c'.repeat(64)}i0`;
    const hiddenId = `${'d'.repeat(64)}i0`;
    const galleryItem = (inscriptionId: string, state: 'visible' | 'hidden', number: number) => ({
      inscriptionId,
      state,
      number,
      contentType: 'image/png',
      contentLength: 10,
      satpoint: `${inscriptionId.slice(0, 64)}:0:0`,
      outpoint: { txid: inscriptionId.slice(0, 64), vout: 0 },
      confirmations: 1,
      parent: null,
      delegate: null,
      reinscription: false,
      cursed: false,
      classificationRevision: 'revision-1',
      rareSats: [],
      display: { title: null, collections: [] },
      ownership: { address: 'tb1powner', lane: 'ordinals' as const, role: 'primary' as const },
      preview: {
        kind: 'raster' as const,
        rasterBase64: 'AA==',
        pngSha256: 'e'.repeat(64),
        pngWidth: 1,
        pngHeight: 1,
      },
      mediaAvailable: false,
      action: { status: 'blocked' as const, kind: 'send' as const,
        reason: 'stale_classification' as const },
    });
    installFakeChrome({
      'wallet.home': () => ({ ok: true, result: homeResult({ collectiblesCount: 2 }) }),
      'gallery.cached': () => ({ ok: true, result: { accountId: ACCOUNT_ID, hit: false } }),
      'gallery.list': () => ({
        ok: true,
        result: {
          accountId: ACCOUNT_ID,
          items: [galleryItem(visibleId, 'visible', 42), galleryItem(hiddenId, 'hidden', 43)],
          attentionItems: [], sweepCandidates: [], previewsUnavailable: false,
          recoveredAddressCount: 0, collectionCatalog: null, refreshedAt: 1,
        },
      }),
    });
    render(
      <Providers>
        <Home activeAccountId={ACCOUNT_ID} gateway={connectedView} expectation={EXPECTATION}
          onReceive={() => undefined} onViewOrdinals={onViewOrdinals}
          onOpenCollectible={onOpenCollectible} />
      </Providers>,
    );

    const tile = await screen.findByRole('button', { name: 'Open Inscription #42' });
    expect(screen.queryByRole('button', { name: 'Open Inscription #43' })).not.toBeInTheDocument();
    fireEvent.click(tile);
    expect(onOpenCollectible).toHaveBeenCalledWith(visibleId);
    fireEvent.click(screen.getByRole('button', { name: /View all/u }));
    expect(onViewOrdinals).toHaveBeenCalledOnce();
    expect(screen.getByTestId('home-collectibles-count')).toHaveTextContent('2');
    expect(screen.getByTestId('home-collectibles-carousel').childElementCount).toBe(2);
    const unavailable = screen.getByLabelText('Preview unavailable');
    expect(unavailable).toBeInTheDocument();
    expect(unavailable.querySelector('svg')).toBeInTheDocument();
    expect(unavailable).toHaveTextContent('Preview unavailable');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not flash paint-only carousel pixels before live ownership reconciles', async () => {
    const liveId = `${'c'.repeat(64)}i0`;
    const staleIds = [liveId, `${'d'.repeat(64)}i0`, `${'e'.repeat(64)}i0`];
    let settleLive!: (value: unknown) => void;
    const live = new Promise((resolve) => { settleLive = resolve; });
    const common = (inscriptionId: string, number: number) => ({
      inscriptionId,
      state: 'visible' as const,
      number,
      contentType: 'image/png',
      contentLength: 10,
      satpoint: `${inscriptionId.slice(0, 64)}:0:0`,
      outpoint: { txid: inscriptionId.slice(0, 64), vout: 0 },
      confirmations: 1,
      parent: null,
      delegate: null,
      reinscription: false,
      cursed: false,
      classificationRevision: 'revision-1',
      rareSats: [],
      display: { title: null, collections: [] },
    });
    const raster = {
      kind: 'raster' as const,
      rasterBase64: 'AA==',
      pngSha256: 'f'.repeat(64),
      pngWidth: 1,
      pngHeight: 1,
    };
    installFakeChrome({
      'wallet.home': () => ({ ok: true, result: homeResult({ collectiblesCount: 1 }) }),
      'gallery.cached': () => ({
        ok: true,
        result: {
          accountId: ACCOUNT_ID,
          hit: true,
          items: staleIds.map((id, index) => ({ ...common(id, index + 40), preview: raster })),
          cachedAt: 5,
        },
      }),
      'gallery.list': () => live,
    });
    render(
      <Providers>
        <Home activeAccountId={ACCOUNT_ID} gateway={connectedView} expectation={EXPECTATION}
          onReceive={() => undefined} />
      </Providers>,
    );

    const reservedRow = await screen.findByRole('status');
    expect(reservedRow.childElementCount).toBe(1);
    expect(screen.queryByRole('button', { name: /Open Inscription/u })).not.toBeInTheDocument();

    settleLive({
      ok: true,
      result: {
        accountId: ACCOUNT_ID,
        items: [{
          ...common(liveId, 42),
          ownership: { address: 'tb1powner', lane: 'ordinals' as const, role: 'primary' as const },
          preview: raster,
          mediaAvailable: false,
          action: { status: 'blocked' as const, kind: 'send' as const,
            reason: 'stale_classification' as const },
        }],
        attentionItems: [], sweepCandidates: [], previewsUnavailable: false,
        recoveredAddressCount: 0, collectionCatalog: null, refreshedAt: 1,
      },
    });

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Open Inscription #42' })).toBeInTheDocument();
  });

  it('paints a locally revalidated Home preview before the live gallery settles', async () => {
    const inscriptionId = `${'c'.repeat(64)}i0`;
    let settleLive!: (value: unknown) => void;
    const live = new Promise((resolve) => { settleLive = resolve; });
    const common = {
      inscriptionId,
      state: 'visible' as const,
      number: 42,
      contentType: 'image/png',
      contentLength: 10,
      satpoint: `${'c'.repeat(64)}:0:0`,
      outpoint: { txid: 'c'.repeat(64), vout: 0 },
      confirmations: 1,
      parent: null,
      delegate: null,
      reinscription: false,
      cursed: false,
      classificationRevision: 'revision-1',
      rareSats: [],
      display: { title: null, collections: [] },
    };
    const raster = {
      kind: 'raster' as const,
      rasterBase64: 'AA==',
      pngSha256: 'f'.repeat(64),
      pngWidth: 1,
      pngHeight: 1,
    };
    installFakeChrome({
      'wallet.home': () => ({ ok: true, result: homeResult() }),
      'gallery.cached': () => ({ ok: true, result: { accountId: ACCOUNT_ID, hit: false } }),
      'gallery.home.cached': () => ({
        ok: true,
        result: {
          accountId: ACCOUNT_ID,
          hit: true,
          items: [{ ...common, preview: raster }],
          cachedAt: 5,
        },
      }),
      'gallery.list': () => live,
    });
    render(
      <Providers>
        <Home activeAccountId={ACCOUNT_ID} gateway={connectedView} expectation={EXPECTATION}
          onReceive={() => undefined} />
      </Providers>,
    );

    expect(await screen.findByRole('button', { name: 'Open Inscription #42' }))
      .toBeInTheDocument();
    expect(screen.queryByText('Preview rendering…')).not.toBeInTheDocument();

    settleLive({
      ok: true,
      result: {
        accountId: ACCOUNT_ID,
        items: [{
          ...common,
          ownership: { address: 'tb1powner', lane: 'ordinals' as const, role: 'primary' as const },
          preview: raster,
          mediaAvailable: false,
          action: { status: 'available' as const, kind: 'send' as const },
        }],
        attentionItems: [], sweepCandidates: [], previewsUnavailable: false,
        recoveredAddressCount: 0, collectionCatalog: null, refreshedAt: 6,
      },
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open Inscription #42' }))
      .toBeInTheDocument());
  });

  it('keeps exact Home paint through a transient live miss and swaps in the replacement', async () => {
    const inscriptionId = `${'c'.repeat(64)}i0`;
    let settleLive!: (value: unknown) => void;
    let settleRaster!: (value: unknown) => void;
    const live = new Promise((resolve) => { settleLive = resolve; });
    const replacement = new Promise((resolve) => { settleRaster = resolve; });
    const common = {
      inscriptionId,
      state: 'visible' as const,
      number: 42,
      contentType: 'image/png',
      contentLength: 10,
      satpoint: `${'c'.repeat(64)}:0:0`,
      outpoint: { txid: 'c'.repeat(64), vout: 0 },
      confirmations: 1,
      parent: null,
      delegate: null,
      reinscription: false,
      cursed: false,
      classificationRevision: 'revision-1',
      rareSats: [],
      display: { title: null, collections: [] },
    };
    const cachedRaster = {
      kind: 'raster' as const,
      rasterBase64: 'AA==',
      pngSha256: 'f'.repeat(64),
      pngWidth: 1,
      pngHeight: 1,
    };
    const nextRaster = { ...cachedRaster, rasterBase64: 'AQ==', pngSha256: 'e'.repeat(64) };
    const result = (preview: GalleryViewResult['items'][number]['preview']) => ({
      accountId: ACCOUNT_ID,
      items: [{
        ...common,
        ownership: { address: 'tb1powner', lane: 'ordinals' as const, role: 'primary' as const },
        preview,
        mediaAvailable: false,
        action: { status: 'available' as const, kind: 'send' as const },
      }],
      attentionItems: [], sweepCandidates: [], previewsUnavailable: false,
      recoveredAddressCount: 0, collectionCatalog: null, refreshedAt: 6,
    });
    const galleryList = vi.fn()
      .mockReturnValueOnce(live)
      .mockReturnValueOnce(replacement);
    installFakeChrome({
      'wallet.home': () => ({ ok: true, result: homeResult() }),
      'gallery.cached': () => ({ ok: true, result: { accountId: ACCOUNT_ID, hit: false } }),
      'gallery.home.cached': () => ({
        ok: true,
        result: {
          accountId: ACCOUNT_ID,
          hit: true,
          items: [{ ...common, preview: cachedRaster }],
          cachedAt: 5,
        },
      }),
      'gallery.list': galleryList,
    });
    render(
      <Providers>
        <Home activeAccountId={ACCOUNT_ID} gateway={connectedView} expectation={EXPECTATION}
          onReceive={() => undefined} />
      </Providers>,
    );

    const firstFrame = await screen.findByTitle(`Inert preview for inscription ${inscriptionId}`);
    settleLive({ ok: true, result: result({ kind: 'placeholder', reason: 'not_requested' }) });
    await waitFor(() => expect(galleryList).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Preview rendering…')).not.toBeInTheDocument();
    expect(screen.queryByText('Preview unavailable')).not.toBeInTheDocument();
    expect(screen.getByTitle(`Inert preview for inscription ${inscriptionId}`)).toBe(firstFrame);

    settleRaster({ ok: true, result: result(nextRaster) });
    await waitFor(() => expect(
      screen.getByTitle(`Inert preview for inscription ${inscriptionId}`),
    ).not.toBe(firstFrame));
  });

  it('keeps three reserved slots through lazy loading and a transient preview failure', async () => {
    const inscriptionId = `${'c'.repeat(64)}i0`;
    const common = {
      inscriptionId,
      state: 'visible' as const,
      number: 42,
      contentType: 'image/png',
      contentLength: 10,
      satpoint: `${'c'.repeat(64)}:0:0`,
      outpoint: { txid: 'c'.repeat(64), vout: 0 },
      confirmations: 1,
      parent: null,
      delegate: null,
      reinscription: false,
      cursed: false,
      classificationRevision: 'revision-1',
      rareSats: [],
      display: { title: null, collections: [] },
      ownership: { address: 'tb1powner', lane: 'ordinals' as const, role: 'primary' as const },
      mediaAvailable: false,
      action: { status: 'blocked' as const, kind: 'send' as const,
        reason: 'stale_classification' as const },
    };
    const result = (preview: GalleryViewResult['items'][number]['preview']) => ({
      accountId: ACCOUNT_ID,
      items: [{ ...common, preview }],
      attentionItems: [], sweepCandidates: [],
      previewsUnavailable: preview.kind === 'placeholder',
      recoveredAddressCount: 0, collectionCatalog: null, refreshedAt: 1,
    });
    let releaseRaster!: (value: unknown) => void;
    const rasterResponse = new Promise((resolve) => { releaseRaster = resolve; });
    const galleryList = vi.fn()
      .mockReturnValueOnce({
        ok: true,
        result: result({ kind: 'placeholder', reason: 'not_requested' }),
      })
      .mockReturnValueOnce(rasterResponse);
    installFakeChrome({
      'wallet.home': () => ({ ok: true, result: homeResult({ collectiblesCount: 15 }) }),
      'gallery.cached': () => ({ ok: true, result: { accountId: ACCOUNT_ID, hit: false } }),
      'gallery.list': galleryList,
    });
    render(
      <Providers>
        <Home activeAccountId={ACCOUNT_ID} gateway={connectedView} expectation={EXPECTATION}
          onReceive={() => undefined} />
      </Providers>,
    );

    await waitFor(() => expect(galleryList).toHaveBeenCalledTimes(2));
    const reserved = screen.getByRole('status');
    expect(reserved.childElementCount).toBe(3);
    expect(screen.getAllByText('Preview rendering…')).toHaveLength(3);
    expect(screen.getByLabelText('Inscription #42: Preview rendering…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open Inscription/u })).not.toBeInTheDocument();
    expect(galleryList.mock.calls[1]?.[0]).toMatchObject({ rasterFor: [inscriptionId] });

    releaseRaster({
      ok: true,
      result: result({ kind: 'placeholder', reason: GALLERY_PREVIEW_UNAVAILABLE }),
    });
    await waitFor(() => expect(galleryList).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    const unavailableTiles = screen.getAllByLabelText('Preview unavailable');
    expect(unavailableTiles).toHaveLength(3);
    expect(unavailableTiles.every((tile) => tile.querySelector('svg') !== null)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(galleryList).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'Open Inscription #42' }))
      .not.toBeInTheDocument();
  });

  it('does not retry a permanent active-content placeholder', async () => {
    const inscriptionId = `${'c'.repeat(64)}i0`;
    const galleryList = vi.fn(() => ({
      ok: true,
      result: {
        accountId: ACCOUNT_ID,
        items: [{
          inscriptionId, state: 'visible', number: 42,
          contentType: 'text/html', contentLength: 10,
          satpoint: `${'c'.repeat(64)}:0:0`,
          outpoint: { txid: 'c'.repeat(64), vout: 0 }, confirmations: 1,
          parent: null, delegate: null, reinscription: false, cursed: false,
          classificationRevision: 'revision-1', rareSats: [],
          display: { title: null, collections: [] },
          ownership: { address: 'tb1powner', lane: 'ordinals', role: 'primary' },
          preview: { kind: 'placeholder', reason: 'active_content' },
          mediaAvailable: false,
          action: { status: 'blocked', kind: 'send', reason: 'stale_classification' },
        }],
        attentionItems: [], sweepCandidates: [], previewsUnavailable: false,
        recoveredAddressCount: 0, collectionCatalog: null, refreshedAt: 1,
      },
    }));
    installFakeChrome({
      'wallet.home': () => ({ ok: true, result: homeResult() }),
      'gallery.cached': () => ({ ok: true, result: { accountId: ACCOUNT_ID, hit: false } }),
      'gallery.list': galleryList,
    });
    render(
      <Providers>
        <Home activeAccountId={ACCOUNT_ID} gateway={connectedView} expectation={EXPECTATION}
          onReceive={() => undefined} />
      </Providers>,
    );

    await waitFor(() => expect(galleryList).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(galleryList).toHaveBeenCalledOnce();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    const carousel = screen.getByTestId('home-collectibles-carousel');
    expect(carousel.childElementCount).toBe(1);
    expect(screen.getByLabelText('Preview unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open Inscription/u })).not.toBeInTheDocument();
  });
});
