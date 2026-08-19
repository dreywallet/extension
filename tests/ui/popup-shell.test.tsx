import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Shell } from '../../src/entrypoints/popup/Shell';
import type { GatewayStatusView } from '@drey/core/domain/gateway/status-view';
import type { WalletHomeResult } from '@drey/core/messaging/ops';
import type { SessionView } from '../../src/ui/hooks/use-session';
import { emitRuntimeMessage, installFakeChrome, Providers } from './fake-rpc';

afterEach(cleanup);

const EXPECTATION = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};
const ACCOUNT_ID = `acct_signet_${'1'.repeat(64)}`;

const gateway: GatewayStatusView = {
  state: 'connected',
  network: 'signet',
  mode: 'full_sat_safety',
  missingProtections: [],
  tipHeight: 250000,
  verifiedAtMs: 1,
  ageMs: 0,
  lastReason: null,
};

const home: WalletHomeResult = {
  accountId: ACCOUNT_ID,
  balances: {
    availableSats: '0',
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
  collectiblesCount: 0,
  wrongLaneCount: 0,
  dataGating: { state: 'fresh', blockedActions: [] },
  activity: [],
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
};

function session(refresh: () => void): SessionView {
  return {
    state: 'ready',
    activeVaultId: 'vault-1',
    preferredUnlockVaultId: 'vault-1',
    vaults: [{ vaultId: 'vault-1', name: 'Main' }],
    expectation: EXPECTATION,
    deadline: Date.now() + 60_000,
    quarantinedVaultCount: 0,
    activeAccountId: ACCOUNT_ID,
    activeAccount: 0,
    selectableAccounts: [0],
    accountSummaries: [{
      accountId: ACCOUNT_ID,
      account: 0,
      name: 'Main',
      signingSource: 'software',
    }],
    accountAddState: null,
    activeRecoveredAddressCount: 0,
    refresh,
    capabilities: {
      canView: true,
      canDeriveAddresses: true,
      canPlanTransactions: true,
      canSignTransactions: true,
      canSignMessages: true,
      canBroadcast: true,
      canExposeToProviders: true,
      canUseMarketplaces: true,
      signMethod: 'software',
      canBuildUnsignedPsbt: true,
      canSignPsbt: true,
      canSignBip322: true,
      canRevealSeed: true,
      canExportPublicAccount: false,
      canVerifyAddress: false,
    },
  };
}

describe('popup shell navigation', () => {
  it('offers docking only from stable popup navigation and never inside the panel', async () => {
    installFakeChrome({
      'gateway.status': () => ({ ok: true, result: gateway }),
      'wallet.home': () => ({ ok: true, result: home }),
      'scan.status': () => ({
        ok: true,
        result: { ...home.scan, kind: 'completed', scanId: 'scan-1' },
      }),
      'scan.start': () => ({ ok: true, result: { scanId: 'scan-2' } }),
      'fees.quote': () => ({
        ok: true,
        result: {
          prioritySatPerKvB: 5000,
          standardSatPerKvB: 3500,
          economySatPerKvB: 2000,
          floorSatPerKvB: 1000,
          sampledAt: '2026-07-22T12:00:00.000Z',
          expiresAt: '2026-07-22T12:02:00.000Z',
        },
      }),
    });
    const open = vi.fn(async () => undefined);
    Object.assign(chrome, {
      windows: { getCurrent: vi.fn(async () => ({ id: 12, type: 'normal' })) },
      sidePanel: { open },
    });

    const surface = render(
      <Providers>
        <Shell session={session(() => undefined)} surface="popup" />
      </Providers>,
    );
    const dock = await screen.findByRole('button', { name: 'Open in side panel' });
    await userEvent.click(dock);
    await waitFor(() => expect(open).toHaveBeenCalledWith({ windowId: 12 }));

    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.queryByRole('button', { name: 'Open in side panel' })).not.toBeInTheDocument();

    surface.unmount();
    render(
      <Providers>
        <Shell session={session(() => undefined)} surface="sidepanel" />
      </Providers>,
    );
    expect(screen.queryByRole('button', { name: 'Open in side panel' })).not.toBeInTheDocument();
  });

  it('keeps Send in the popup by default and offers an explicit full-page action', async () => {
    const ownedAddress = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
    installFakeChrome({
      'gateway.status': () => ({ ok: true, result: gateway }),
      'wallet.home': () => ({ ok: true, result: home }),
      'gallery.list': () => ({
        ok: true,
        result: { accountId: ACCOUNT_ID, items: [], refreshedAt: 1_752_969_600_000 },
      }),
      'fees.quote': () => ({
        ok: true,
        result: {
          prioritySatPerKvB: 5000,
          standardSatPerKvB: 3500,
          economySatPerKvB: 2000,
          floorSatPerKvB: 1000,
          sampledAt: '2026-07-22T12:00:00.000Z',
          expiresAt: '2026-07-22T12:02:00.000Z',
        },
      }),
      'addressBook.list': () => ({ ok: true, result: {
        version: 1, network: 'mainnet', saved: [], recent: [],
      } }),
      'address.receive': () => ({ ok: true, result: {
        accountId: ACCOUNT_ID,
        address: ownedAddress,
        path: "m/84'/0'/0'/0/0",
        kind: 'payment',
        network: 'mainnet',
      } }),
    });
    const createTab = vi.fn(async () => ({}));
    (chrome.tabs as unknown as { create: typeof createTab }).create = createTab;

    render(
      <Providers>
        <Shell session={session(() => undefined)} />
      </Providers>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('heading', { name: 'Send Bitcoin' })).toBeInTheDocument();
    expect(screen.getByLabelText('Amount (BTC)')).toBeInTheDocument();
    expect(createTab).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Address book' }));
    const picker = await screen.findByRole('dialog', { name: 'Choose recipient' });
    expect(within(picker).getByRole('heading', { name: 'My accounts' })).toBeInTheDocument();
    expect(within(picker).getByText('Main')).toBeInTheDocument();
    expect(within(picker).getByText(ownedAddress)).toBeInTheDocument();
    await userEvent.click(within(picker).getByRole('button', { name: 'Close' }));

    await userEvent.click(screen.getByRole('button', { name: 'Open send in full page' }));
    expect(createTab).toHaveBeenCalledWith({
      url: 'chrome-extension://test/fullpage.html#/send',
    });
  });

  it('opens Manage coins from the protected-sats disclosure', async () => {
    installFakeChrome({
      'gateway.status': () => ({ ok: true, result: gateway }),
      'wallet.home': () => ({
        ok: true,
        result: {
          ...home,
          balances: { ...home.balances, frozenSats: '293' },
          protectionBreakdown: { ...home.protectionBreakdown, dustQuarantinedSats: '293' },
        },
      }),
    });
    const createTab = vi.fn(async () => ({}));
    (chrome.tabs as unknown as { create: typeof createTab }).create = createTab;

    render(
      <Providers>
        <Shell session={session(() => undefined)} />
      </Providers>,
    );

    await userEvent.click(await screen.findByRole('button', {
      name: 'Bitcoin set aside from regular sends, 293 sats',
    }));
    await userEvent.click(screen.getByRole('button', { name: 'Review protected sats' }));
    expect(createTab).toHaveBeenCalledWith({
      url: 'chrome-extension://test/fullpage.html#/send/utxos',
    });
  });

  it('separates Settings and Lock from the persistent primary navigation', async () => {
    const refresh = vi.fn();
    const lockPayloads: unknown[] = [];
    installFakeChrome({
      'gateway.status': () => ({ ok: true, result: gateway }),
      'wallet.home': () => ({ ok: true, result: home }),
      'gallery.list': () => ({
        ok: true,
        result: { accountId: ACCOUNT_ID, items: [], refreshedAt: 1_752_969_600_000 },
      }),
      'vault.lock': (payload) => {
        lockPayloads.push(payload);
        return { ok: true, result: { locked: true } };
      },
    });
    const createTab = vi.fn(async () => ({}));
    (chrome.tabs as unknown as { create: typeof createTab }).create = createTab;

    render(
      <Providers>
        <Shell session={session(refresh)} />
      </Providers>,
    );

    const balanceCard = (await screen.findByText('Available to send')).parentElement;
    expect(balanceCard).toHaveTextContent('0 sats');
    const settings = screen.getByRole('button', { name: 'Settings' });
    const lock = screen.getByRole('button', { name: 'Lock' });
    const account = screen.getByRole('button', { name: 'Active account' });
    const header = account.closest('header');
    expect(screen.queryByRole('button', { name: 'Manage' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('DREY')).not.toBeInTheDocument();
    expect(settings).toHaveAttribute('title', 'Settings');
    expect(lock).toHaveAttribute('title', 'Lock');
    expect(header?.firstElementChild).toBe(account.parentElement);
    expect(within(header as HTMLElement).getByLabelText('Wallet service status')).toHaveAttribute(
      'aria-label',
      'Wallet service status',
    );

    const primaryNavigation = screen.getByRole('navigation', { name: 'Drey' });
    const bitcoin = within(primaryNavigation).getByRole('button', { name: 'Bitcoin' });
    const ordinals = within(primaryNavigation).getByRole('button', { name: 'Ordinals' });
    const activity = within(primaryNavigation).getByRole('button', { name: 'Activity' });
    expect(bitcoin).toHaveAttribute('aria-current', 'page');
    expect(primaryNavigation.querySelectorAll('button > svg[aria-hidden="true"]')).toHaveLength(3);
    // Name each header icon rather than counting anonymously, so a stray
    // svg landing in the wrong button cannot hide inside a bare total. The
    // account trigger stays icon-free: identity marks render only inside the
    // open menu, never on the always-visible header.
    expect(settings.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(1);
    expect(lock.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(1);
    expect(account.querySelectorAll('svg')).toHaveLength(0);
    expect(document.querySelectorAll('header button > svg[aria-hidden="true"]')).toHaveLength(2);

    await userEvent.click(ordinals);
    expect(ordinals).toHaveAttribute('aria-current', 'page');
    expect(bitcoin).not.toHaveAttribute('aria-current');
    expect(await screen.findByRole('heading', { name: 'Ordinals' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'All (0)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Hidden (0)' })).toBeInTheDocument();
    expect(screen.getByText('No Ordinals in this wallet.')).toBeInTheDocument();

    await userEvent.click(activity);
    expect(activity).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Your transaction history will appear here.')).toBeInTheDocument();

    await userEvent.click(settings);
    expect(createTab).toHaveBeenCalledWith({
      url: 'chrome-extension://test/fullpage.html#/settings',
    });

    await userEvent.click(lock);
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(lockPayloads).toEqual([{}]);
  });

  it('shows owned Ordinals in one view and moves them to and from Hidden locally', async () => {
    const visibleId = `${'a'.repeat(64)}i0`;
    const hiddenId = `${'b'.repeat(64)}i0`;
    const galleryList = vi.fn(() => ({
      ok: true as const,
      result: {
        accountId: ACCOUNT_ID,
        items: [
          {
            inscriptionId: visibleId,
            state: 'visible' as const,
            number: 1,
            contentType: 'image/png',
            contentLength: 68,
            satpoint: `${'c'.repeat(64)}:0:0`,
            outpoint: { txid: 'c'.repeat(64), vout: 0 },
            confirmations: 2,
            parent: null,
            delegate: null,
            reinscription: false,
            cursed: false,
            classificationRevision: 'rev-1',
            rareSats: [],
            ownership: {
              address: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
              lane: 'ordinals' as const,
              role: 'primary' as const,
            },
            preview: {
              kind: 'raster' as const,
              rasterBase64: 'AA==',
              pngSha256: 'e'.repeat(64),
              pngWidth: 1,
              pngHeight: 1,
            },
            mediaAvailable: true,
            action: { status: 'available' as const, kind: 'send' as const },
          },
          {
            inscriptionId: hiddenId,
            state: 'hidden' as const,
            number: 2,
            contentType: 'text/plain',
            contentLength: 4,
            satpoint: `${'d'.repeat(64)}:1:0`,
            outpoint: { txid: 'd'.repeat(64), vout: 1 },
            confirmations: 1,
            parent: null,
            delegate: null,
            reinscription: false,
            cursed: false,
            classificationRevision: 'rev-1',
            rareSats: [],
            ownership: {
              address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
              lane: 'payment' as const,
              role: 'recovered' as const,
            },
            preview: { kind: 'placeholder' as const, reason: 'unsupported_type' },
            mediaAvailable: false,
            action: { status: 'available' as const, kind: 'rescue' as const },
          },
        ],
        sweepCandidates: [],
        refreshedAt: 1_752_969_600_000,
      },
    }));
    const updates: unknown[] = [];
    installFakeChrome({
      'gateway.status': () => ({ ok: true, result: gateway }),
      'wallet.home': () => ({ ok: true, result: home }),
      'gallery.list': galleryList,
      'gallery.update': (payload) => {
        updates.push(payload);
        return { ok: true, result: { updated: true } };
      },
      'gallery.media.open': () => ({
        ok: true,
        result: {
          disposition: 'media',
          leaseId: 'f'.repeat(32),
          expiresAt: Date.now() + 30_000,
          inscriptionId: visibleId,
          contentType: 'image/png',
          contentSha256: 'e'.repeat(64),
          contentByteLength: 1,
          bytesBase64: 'AA==',
        },
      }),
      'fees.quote': () => ({
        ok: true,
        result: {
          prioritySatPerKvB: 5000, standardSatPerKvB: 3500,
          economySatPerKvB: 2000, floorSatPerKvB: 1000,
          sampledAt: '2026-07-21T12:00:00.000Z',
          expiresAt: '2026-07-21T12:02:00.000Z',
        },
      }),
    });

    const rendered = render(
      <Providers>
        <Shell session={session(() => undefined)} />
      </Providers>,
    );

    const navigation = await screen.findByRole('navigation', { name: 'Drey' });
    await userEvent.click(within(navigation).getByRole('button', { name: 'Ordinals' }));
    expect(await screen.findByRole('tab', { name: 'All (1)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Hidden (1)' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Hidden (1)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Other inscriptions (1)' }));
    expect(screen.getByText('#2')).toBeInTheDocument();
    expect(screen.getByText('Recovered Bitcoin address')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rescue' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await userEvent.click(screen.getByRole('tab', { name: 'All (1)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Other inscriptions (1)' }));
    // The card face carries the number, because a 66-character id could only be
    // shown truncated there. The id and satpoint sit a line below in the
    // disclosure: the viewer needs a media lease, so it cannot be the only
    // route to them.
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.queryByText('#2')).not.toBeInTheDocument();
    expect(screen.getByText(visibleId)).toBeInTheDocument();
    expect(screen.getByText(`${'c'.repeat(64)}:0:0`)).toBeInTheDocument();
    expect(screen.getByText('Held at')).toBeInTheDocument();
    expect(screen.getByText(
      'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
    )).toBeInTheDocument();
    expect(screen.getByText('Primary Ordinals address')).toBeInTheDocument();

    const openMedia = screen.getByRole('button', { name: 'Open media' });
    await userEvent.click(openMedia);
    const viewer = await screen.findByRole('dialog', { name: 'Sandboxed inscription media' });
    expect(viewer.tagName).toBe('DIALOG');
    expect(within(viewer).getByRole('button', { name: 'Close' })).toHaveFocus();
    expect(within(viewer).getByText(visibleId)).toBeInTheDocument();
    expect(within(viewer).getByText('Held at')).toBeInTheDocument();
    expect(within(viewer).getByText('Primary Ordinals address')).toBeInTheDocument();
    fireEvent(viewer, new Event('cancel', { bubbles: false, cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', {
      name: 'Sandboxed inscription media',
    })).not.toBeInTheDocument());
    expect(openMedia).toHaveFocus();

    await userEvent.click(openMedia);
    await screen.findByRole('dialog', { name: 'Sandboxed inscription media' });
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(openMedia).toHaveFocus();

    await userEvent.click(screen.getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'All (0)' })).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'Hidden (2)' })).toBeInTheDocument();
    expect(galleryList).toHaveBeenCalledOnce();
    expect(updates[0]).toMatchObject({ inscriptionId: visibleId, state: 'hidden' });
    rendered.rerender(
      <Providers>
        <Shell session={{ ...session(() => undefined), expectation: { ...EXPECTATION } }} />
      </Providers>,
    );
    expect(galleryList).toHaveBeenCalledOnce();

    await userEvent.click(screen.getByRole('tab', { name: 'Hidden (2)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Other inscriptions (2)' }));
    expect(await screen.findByText('#1')).toBeInTheDocument();
    expect(screen.getByText('#2')).toBeInTheDocument();
    // #2 is a placeholder of an unsupported type, so it has no viewer to open.
    // That is precisely the item whose satpoint and outpoint are worth reading,
    // so the card must carry them itself.
    const unopenable = screen.getByText('#2').closest('article')!;
    expect(within(unopenable).queryByRole('button', { name: 'Open media' }))
      .not.toBeInTheDocument();
    expect(within(unopenable).getByText(hiddenId)).toBeInTheDocument();
    expect(within(unopenable).getByText(`${'d'.repeat(64)}:1:0`)).toBeInTheDocument();
    expect(within(unopenable).getByText(`${'d'.repeat(64)}:1`)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Unhide' })[0]!);
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Hidden (1)' })).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: 'All (1)' })).toBeInTheDocument();
    expect(updates[1]).toMatchObject({ inscriptionId: visibleId, state: 'visible' });
    expect(galleryList).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('tab', { name: 'All (1)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Other inscriptions (1)' }));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('heading', { name: 'Send inscription' })).toBeInTheDocument();
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('Technical details').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText(visibleId)).toBeInTheDocument();
  });

  it('shows signed wallet history in both Recent Activity and the Activity destination', async () => {
    const pendingHome: WalletHomeResult = {
      ...home,
      balances: { ...home.balances, pendingSats: '10000' },
      activity: [{
        txid: 'e'.repeat(64),
        deltaSats: '10000',
        feeSats: null,
        confirmationState: 'mempool',
        timestamp: null,
        height: null,
      }],
    };
    let currentHome = pendingHome;
    installFakeChrome({
      'gateway.status': () => ({ ok: true, result: gateway }),
      'wallet.home': () => ({ ok: true, result: currentHome }),
      'scan.status': () => ({ ok: true, result: home.scan }),
      'scan.start': () => ({ ok: true, result: { scanId: 'scan-2' } }),
    });

    render(
      <Providers>
        <Shell session={session(() => undefined)} />
      </Providers>,
    );

    expect(await screen.findByText('Pending confirmation')).toBeInTheDocument();
    expect(screen.getByText('Included in your balance; spendable after confirmation'))
      .toBeInTheDocument();
    expect(screen.getByText('Bitcoin balance').parentElement).toHaveTextContent('10,000 sats');
    expect(screen.getByText('Available now').parentElement).toHaveTextContent('0 sats');
    expect(screen.getByText(/\+10,000 sats/u)).toBeInTheDocument();
    expect(screen.getByText(/^Pending$/u)).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      `https://mempool.space/signet/tx/${'e'.repeat(64)}`,
    );

    const navigation = screen.getByRole('navigation', { name: 'Drey' });
    await userEvent.click(within(navigation).getByRole('button', { name: 'Activity' }));
    expect(await screen.findByText(/\+10,000 sats/u)).toBeInTheDocument();
    expect(screen.getAllByText(/^Pending$/u)).toHaveLength(2);
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      `https://mempool.space/signet/tx/${'e'.repeat(64)}`,
    );
    expect(screen.queryByText('Your transaction history will appear here.')).not.toBeInTheDocument();

    currentHome = {
      ...pendingHome,
      balances: { ...pendingHome.balances, availableSats: '10000', pendingSats: '0' },
      activity: [{
        ...pendingHome.activity[0]!,
        confirmationState: 'confirmed',
        height: 959193,
      }],
    };
    act(() => emitRuntimeMessage({ type: 'squirrel:scan-progress' }));
    await waitFor(() => expect(screen.getByText('Date unavailable')).toBeInTheDocument());
    expect(screen.queryByText(/^Pending$/u)).not.toBeInTheDocument();
    expect(screen.getByText(/\+10,000 sats/u)).toBeInTheDocument();
  });

  it('shows a just-submitted outgoing principal and fee in both activity views', async () => {
    const submittedTxid = 'f'.repeat(64);
    const submittedHome: WalletHomeResult = {
      ...home,
      activity: [{
        txid: submittedTxid,
        deltaSats: '-2734',
        feeSats: '234',
        confirmationState: 'mempool',
        timestamp: '2026-07-22T18:00:00.000Z',
        height: null,
      }],
    };
    installFakeChrome({
      'gateway.status': () => ({ ok: true, result: gateway }),
      'wallet.home': () => ({ ok: true, result: submittedHome }),
      'scan.status': () => ({ ok: true, result: home.scan }),
      'scan.start': () => ({ ok: true, result: { scanId: 'scan-2' } }),
    });

    render(
      <Providers>
        <Shell session={session(() => undefined)} />
      </Providers>,
    );

    expect(await screen.findByText(/−2,500 sats/u)).toBeInTheDocument();
    expect(screen.queryByText('234 sats network fee')).not.toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      `https://mempool.space/signet/tx/${submittedTxid}`,
    );

    const navigation = screen.getByRole('navigation', { name: 'Drey' });
    await userEvent.click(within(navigation).getByRole('button', { name: 'Activity' }));
    expect(await screen.findByText(/−2,500 sats/u)).toBeInTheDocument();
    expect(screen.getByText('234 sats network fee')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      `https://mempool.space/signet/tx/${submittedTxid}`,
    );
  });
});
