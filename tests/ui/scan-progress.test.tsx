import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(cleanup);
import { ScanProgress } from '../../src/ui/components/ScanProgress';
import { installFakeChrome, Providers } from './fake-rpc';

const EXPECTATION = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};
const ACCOUNT_ID = `acct_signet_${'1'.repeat(64)}`;

function statusResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    result: {
      kind: 'running',
      scanId: 'scan-1',
      unitsDone: 4,
      unitsTotal: 23,
      currentUnit: { source: 'standard', accountId: ACCOUNT_ID, account: 2, lane: 'ordinals' },
      boundaryUnits: [],
      failureReason: null,
      ...overrides,
    },
  };
}

describe('ScanProgress (§8.2 full UX)', () => {
  it('shows per-account progress and a working cancel', async () => {
    const cancel = vi.fn(() => ({ ok: true, result: { cancelled: true } }));
    installFakeChrome({
      'scan.status': () => statusResult(),
      'scan.cancel': cancel,
      'gateway.status': () => ({ ok: false, code: 'ERR_INTERNAL' }),
    });
    render(
      <Providers>
        <ScanProgress expectation={EXPECTATION} />
      </Providers>,
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Scanning account 3 · Ordinals');
    expect(screen.getByRole('status')).toHaveTextContent('4 of 23');
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel scan' }));
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ scanId: 'scan-1' }));
  });

  it('offers the Extended-scan opt-in and wires Continue to scan.extend', async () => {
    const extend = vi.fn(() => ({ ok: true, result: { resumed: true } }));
    installFakeChrome({
      'scan.status': () =>
        statusResult({
          kind: 'awaiting_extend',
          boundaryUnits: [{ source: 'standard', accountId: ACCOUNT_ID, account: 0, lane: 'payment' }],
        }),
      'scan.extend': extend,
      'gateway.status': () => ({ ok: false, code: 'ERR_INTERNAL' }),
    });
    render(
      <Providers>
        <ScanProgress expectation={EXPECTATION} />
      </Providers>,
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/near the scan boundary/u);
    await userEvent.click(screen.getByRole('button', { name: 'Continue scanning' }));
    expect(extend).toHaveBeenCalledWith(expect.objectContaining({ scanId: 'scan-1' }));
  });

  it('auto-starts when idle and offers resume when interrupted', async () => {
    const start = vi.fn(() => ({ ok: true, result: { scanId: 'scan-2' } }));
    installFakeChrome({
      'scan.status': () => statusResult({ kind: 'idle', scanId: null, currentUnit: null }),
      'scan.start': start,
      'gateway.status': () => ({ ok: false, code: 'ERR_INTERNAL' }),
    });
    render(
      <Providers>
        <ScanProgress expectation={EXPECTATION} autoStart="initial" />
      </Providers>,
    );
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ mode: 'initial' }));
    });
    cleanup();

    const resume = vi.fn(() => ({ ok: true, result: { scanId: 'scan-1' } }));
    installFakeChrome({
      'scan.status': () => statusResult({ kind: 'interrupted', currentUnit: null }),
      'scan.start': resume,
      'gateway.status': () => ({ ok: false, code: 'ERR_INTERNAL' }),
    });
    render(
      <Providers>
        <ScanProgress expectation={EXPECTATION} />
      </Providers>,
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/interrupted/u);
    await userEvent.click(screen.getByRole('button', { name: 'Resume scan' }));
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ mode: 'resume' }));
  });

  it('starts a rescan even when the worker still reports the previous scan as completed', async () => {
    const start = vi.fn(() => ({ ok: true, result: { scanId: 'scan-3' } }));
    installFakeChrome({
      'scan.status': () => statusResult({ kind: 'completed', currentUnit: null }),
      'scan.start': start,
      'gateway.status': () => ({ ok: false, code: 'ERR_INTERNAL' }),
    });
    render(
      <Providers>
        <ScanProgress expectation={EXPECTATION} autoStart="rescan" />
      </Providers>,
    );
    await vi.waitFor(() => {
      expect(start).toHaveBeenCalledWith(expect.objectContaining({ mode: 'rescan' }));
    });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('Not now dismisses the Extended-scan prompt locally', async () => {
    installFakeChrome({
      'scan.status': () =>
        statusResult({
          kind: 'awaiting_extend',
          boundaryUnits: [{ source: 'standard', accountId: ACCOUNT_ID, account: 0, lane: 'payment' }],
        }),
      'gateway.status': () => ({ ok: false, code: 'ERR_INTERNAL' }),
    });
    render(
      <Providers>
        <ScanProgress expectation={EXPECTATION} />
      </Providers>,
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/near the scan boundary/u);
    await userEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.getByRole('status')).toHaveTextContent('Scan complete.');
    expect(screen.queryByRole('button', { name: 'Continue scanning' })).toBeNull();
  });

  it('reports completion and failure as text', async () => {
    installFakeChrome({
      'scan.status': () => statusResult({ kind: 'completed', currentUnit: null }),
      'gateway.status': () => ({ ok: false, code: 'ERR_INTERNAL' }),
    });
    render(
      <Providers>
        <ScanProgress expectation={EXPECTATION} />
      </Providers>,
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Scan complete.');
    cleanup();

    installFakeChrome({
      'scan.status': () => statusResult({ kind: 'failed', currentUnit: null, failureReason: 'gateway' }),
      'gateway.status': () => ({ ok: false, code: 'ERR_INTERNAL' }),
    });
    render(
      <Providers>
        <ScanProgress expectation={EXPECTATION} />
      </Providers>,
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not finish/u);
  });
});
