import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

afterEach(cleanup);
import { GatewayBadge } from '../../src/ui/components/GatewayBadge';
import { Home } from '../../src/entrypoints/popup/Home';
import type { GatewayStatusView } from '@drey/core/domain/gateway/status-view';
import { installFakeChrome, Providers } from './fake-rpc';

const EXPECTATION = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};
const ACCOUNT_ID = `acct_signet_${'1'.repeat(64)}`;

function view(overrides: Partial<GatewayStatusView> = {}): GatewayStatusView {
  return {
    state: 'connected',
    network: 'signet',
    mode: 'full_sat_safety',
    missingProtections: [],
    tipHeight: 250000,
    verifiedAtMs: 1,
    ageMs: 0,
    lastReason: null,
    ...overrides,
  };
}

describe('GatewayBadge', () => {
  it('shows a neutral checking placeholder before the first status arrives', () => {
    installFakeChrome({});
    render(
      <Providers>
        <GatewayBadge view={null} />
      </Providers>,
    );
    expect(screen.getByLabelText('Checking…')).toHaveAttribute('title', 'Checking…');
    expect(screen.queryByText('Mainnet')).not.toBeInTheDocument();
  });

  it('shows signet explicitly and collapses a healthy connection to an accessible dot', () => {
    installFakeChrome({});
    render(
      <Providers>
        <GatewayBadge view={view()} />
      </Providers>,
    );
    expect(screen.getByLabelText('Signet')).toHaveAttribute('title', 'Signet');
    expect(screen.getByText('Signet')).toBeInTheDocument();
    expect(screen.getByLabelText('Connected')).toHaveAttribute('title', 'Connected');
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
    expect(screen.queryByText('Standard Ordinals Safety')).not.toBeInTheDocument();
  });

  it('does not spend header space restating mainnet', () => {
    installFakeChrome({});
    render(
      <Providers>
        <GatewayBadge view={view({ network: 'mainnet' })} />
      </Providers>,
    );
    expect(screen.queryByText('Mainnet')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Connected')).toBeInTheDocument();
  });

  it('collapses degraded to an accessible warning dot while Home explains the condition', () => {
    installFakeChrome({});
    render(
      <Providers>
        <GatewayBadge
          view={view({
            state: 'degraded',
            mode: 'standard_ordinals_safety',
            missingProtections: ['sat_index', 'rarity'],
          })}
        />
      </Providers>,
    );
    expect(screen.getByLabelText('Standard Ordinals Safety')).toHaveAttribute(
      'title',
      'Standard Ordinals Safety',
    );
    expect(screen.queryByText('Standard Ordinals Safety')).not.toBeInTheDocument();
  });

  it('keeps unreachable and read-only labels accessible without header pills', () => {
    installFakeChrome({});
    const { rerender } = render(
      <Providers>
        <GatewayBadge view={view({ state: 'unreachable', network: null, mode: null })} />
      </Providers>,
    );
    expect(screen.getByLabelText('Unreachable')).toHaveAttribute('title', 'Unreachable');
    expect(screen.queryByText('Unreachable')).not.toBeInTheDocument();
    rerender(
      <Providers>
        <GatewayBadge view={view({ state: 'read_only', mode: null })} />
      </Providers>,
    );
    expect(screen.getByLabelText('Read-only')).toHaveAttribute('title', 'Read-only');
    expect(screen.queryByText('Read-only')).not.toBeInTheDocument();
  });

  it('presents a normal tip transition as syncing instead of an outage', () => {
    installFakeChrome({});
    render(
      <Providers>
        <GatewayBadge
          view={view({
            state: 'stale',
            walletDataFresh: false,
            commonTip: false,
            classificationState: 'advancing',
          })}
        />
      </Providers>,
    );
    expect(screen.getByLabelText('Syncing')).toHaveAttribute('title', 'Syncing');
    expect(screen.queryByLabelText('Out of date')).not.toBeInTheDocument();
  });
});

describe('Home degraded-status slot (§10.2)', () => {
  it('names the absent protections in Standard mode', () => {
    installFakeChrome({});
    render(
      <Providers>
        <Home activeAccountId={ACCOUNT_ID}
          gateway={view({
            state: 'degraded',
            mode: 'standard_ordinals_safety',
            missingProtections: ['sat_index', 'rarity', 'rune_detection', 'unsupported_asset_detection'],
          })}
          expectation={EXPECTATION}
          onReceive={() => undefined}
        />
      </Providers>,
    );
    const banner = screen.getByRole('status');
    expect(banner.textContent).toContain('rare-sat detection');
    expect(banner.textContent).toContain('Rune and unknown-token detection');
    expect(banner.textContent).toContain('Inscriptions stay protected');
  });

  it('shows the stale and unreachable one-liners', () => {
    installFakeChrome({});
    const { rerender } = render(
      <Providers>
        <Home activeAccountId={ACCOUNT_ID} gateway={view({ state: 'stale' })} expectation={EXPECTATION} onReceive={() => undefined} />
      </Providers>,
    );
    expect(screen.getByRole('status').textContent).toContain('out of date');
    rerender(
      <Providers>
        <Home activeAccountId={ACCOUNT_ID} gateway={view({ state: 'unreachable' })} expectation={EXPECTATION} onReceive={() => undefined} />
      </Providers>,
    );
    expect(screen.getByRole('status').textContent).toContain('Cannot reach');
  });

  it('uses a compact balance status during a normal block/index transition', () => {
    installFakeChrome({});
    render(
      <Providers>
        <Home activeAccountId={ACCOUNT_ID}
          gateway={view({
            state: 'stale',
            walletDataFresh: false,
            commonTip: false,
            classificationState: 'advancing',
          })}
          expectation={EXPECTATION}
          onReceive={() => undefined}
        />
      </Providers>,
    );
    const status = screen.getByRole('status', { name: /Syncing with Bitcoin/iu });
    expect(status).toHaveTextContent('Syncing');
    expect(screen.getByTestId('balance-meta')).toContainElement(status);
    expect(screen.queryByText('Syncing with Bitcoin')).not.toBeInTheDocument();
    expect(screen.queryByText(/out of date/iu)).not.toBeInTheDocument();
  });

  it('renders no gateway banner while connected', () => {
    installFakeChrome({});
    render(
      <Providers>
        <Home activeAccountId={ACCOUNT_ID} gateway={view()} expectation={EXPECTATION} onReceive={() => undefined} />
      </Providers>,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
