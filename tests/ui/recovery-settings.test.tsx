import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RecoverySettings } from '../../src/entrypoints/fullpage/RecoverySettings';
import { pickPositions } from '../../src/ui/random';
import { installFakeChrome, Providers } from './fake-rpc';

vi.mock('../../src/ui/random', () => ({
  pickPositions: vi.fn(),
}));

const EXPECTATION = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};

const mockedPickPositions = vi.mocked(pickPositions);

beforeEach(() => {
  mockedPickPositions.mockReset();
  mockedPickPositions.mockReturnValue([0, 4, 8]);
});

afterEach(cleanup);

function renderRecovery(
  handler: (payload: unknown) => unknown = () => ({ ok: true, result: { verified: true } }),
): { onBack: ReturnType<typeof vi.fn>; onReveal: ReturnType<typeof vi.fn>; onVault: ReturnType<typeof vi.fn> } {
  installFakeChrome({
    'backup.status': () => ({
      ok: true,
      result: {
        backupVerified: false,
        metadata: {
          version: 1, origin: 'generated', usageGatePassed: false, wordCount: 12,
          usesPassphrase: false, lastSpotCheckAt: null, lastFullRecoveryCheckAt: null,
        },
      },
    }),
    'vaultCoordinator.recoveryCReadiness': () => ({
      ok: true,
      result: {
        state: 'not_started', localRole: 'absent', policyState: 'absent',
        phoneSignerPaired: false, standaloneRecoveryPackageAvailable: true,
        policyId: null, setupComplete: false, kitExported: false,
        backupCheckComplete: false, ready: false,
      },
    }),
    'vault.verifyBackup': handler,
  });
  const onBack = vi.fn();
  const onReveal = vi.fn();
  const onVault = vi.fn();
  render(
    <Providers>
      <RecoverySettings expectation={EXPECTATION} onBack={onBack} onReveal={onReveal} onVault={onVault} />
    </Providers>,
  );
  return { onBack, onReveal, onVault };
}

async function openCheck(): Promise<HTMLInputElement[]> {
  fireEvent.click(await screen.findByRole('button', { name: 'Check Spending backup' }));
  return screen.getAllByRole('textbox') as HTMLInputElement[];
}

function fillCheck(words: readonly string[] = ['legal', 'wave', 'useful']): HTMLInputElement[] {
  const inputs = screen.getAllByRole('textbox') as HTMLInputElement[];
  inputs.forEach((input, index) => {
    fireEvent.change(input, { target: { value: words[index] ?? '' } });
  });
  return inputs;
}

function inputLabels(): Array<string | null> {
  return (screen.getAllByRole('textbox') as HTMLInputElement[])
    .map((input) => input.labels?.item(0)?.textContent ?? null);
}

describe('RecoverySettings', () => {
  it('presents routine recovery care separately from the sensitive reveal action', async () => {
    const { onReveal } = renderRecovery();

    expect(screen.getByRole('heading', { name: 'Recovery center' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Spending recovery' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check Spending backup' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reveal recovery phrase' }));
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it('uses three distinct positions and hardened word inputs', async () => {
    renderRecovery();
    const inputs = await openCheck();

    expect(inputs).toHaveLength(3);
    expect(inputLabels()).toEqual([
      'Word #1',
      'Word #5',
      'Word #9',
    ]);
    for (const input of inputs) {
      expect(input).toHaveAttribute('autocomplete', 'off');
      expect(input).toHaveAttribute('autocorrect', 'off');
      expect(input).toHaveAttribute('autocapitalize', 'none');
      expect(input).toHaveAttribute('spellcheck', 'false');
    }
    expect(screen.getByRole('button', { name: 'Check backup' })).toBeDisabled();
  });

  it('binds the check to the active session and clears words after success', async () => {
    const calls: unknown[] = [];
    renderRecovery((payload) => {
      calls.push(payload);
      return { ok: true, result: { verified: true } };
    });
    await openCheck();
    fillCheck([' legal ', 'wave', ' useful ']);
    fireEvent.click(screen.getByRole('button', { name: 'Check backup' }));

    expect(await screen.findByRole('heading', { name: 'Three-word spot check passed' })).toBeInTheDocument();
    expect(calls).toEqual([{
      words: [
        { index: 0, word: 'legal' },
        { index: 4, word: 'wave' },
        { index: 8, word: 'useful' },
      ],
      wordCount: 12,
      ...EXPECTATION,
    }]);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText('legal')).toBeNull();
    expect(screen.queryByRole('button', { name: /copy/iu })).toBeNull();
  });

  it('clears a mismatch, retains the positions, and gives no field-level hints', async () => {
    renderRecovery(() => ({ ok: true, result: { verified: false } }));
    await openCheck();
    const labels = inputLabels();
    fillCheck();
    fireEvent.click(screen.getByRole('button', { name: 'Check backup' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/iu);
    expect(inputLabels()).toEqual(labels);
    for (const input of screen.getAllByRole('textbox')) expect(input).toHaveValue('');
    expect(screen.queryAllByText(/word #[159].*(?:match|wrong)/iu)).toHaveLength(0);
  });

  it('clears words and preserves a session error instead of calling it a mismatch', async () => {
    renderRecovery(() => ({ ok: false, code: 'ERR_LOCKED' }));
    await openCheck();
    fillCheck();
    fireEvent.click(screen.getByRole('button', { name: 'Check backup' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The wallet is locked.');
    expect(screen.queryByText(/do not match/iu)).toBeNull();
    for (const input of screen.getAllByRole('textbox')) expect(input).toHaveValue('');
  });

  it('randomizes a new set after success and clears words before navigation', async () => {
    mockedPickPositions
      .mockReturnValueOnce([0, 4, 8])
      .mockReturnValueOnce([0, 4, 8])
      .mockReturnValueOnce([0, 4, 8])
      .mockReturnValueOnce([1, 5, 9]);
    const { onBack } = renderRecovery();
    await openCheck();
    fillCheck();
    fireEvent.click(screen.getByRole('button', { name: 'Check backup' }));
    await screen.findByRole('heading', { name: 'Three-word spot check passed' });

    fireEvent.click(screen.getByRole('button', { name: 'Check another set' }));
    expect(inputLabels()).toEqual([
      'Word #2',
      'Word #6',
      'Word #10',
    ]);

    fillCheck();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
  });

  it('clears the complete phrase after one aggregate recovery response', async () => {
    const calls: unknown[] = [];
    installFakeChrome({
      'backup.status': () => ({
        ok: true,
        result: {
          backupVerified: true,
          metadata: {
            version: 1,
            origin: 'imported',
            usageGatePassed: true,
            wordCount: 12,
            usesPassphrase: true,
            lastSpotCheckAt: null,
            lastFullRecoveryCheckAt: null,
          },
        },
      }),
      'vaultCoordinator.recoveryCReadiness': () => ({
        ok: true,
        result: {
          state: 'not_started', localRole: 'absent', policyState: 'absent',
          phoneSignerPaired: false, standaloneRecoveryPackageAvailable: true,
          policyId: null, setupComplete: false, kitExported: false,
          backupCheckComplete: false, ready: false,
        },
      }),
      'vault.verifyFullRecovery': (payload) => {
        calls.push(payload);
        return { ok: true, result: { verified: false } };
      },
    });
    render(
      <Providers>
        <RecoverySettings expectation={EXPECTATION} onBack={vi.fn()} onReveal={vi.fn()} onVault={vi.fn()} />
      </Providers>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Test complete Spending recovery' }));
    fireEvent.change(screen.getByLabelText('Complete recovery phrase'), {
      target: { value: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' },
    });
    fireEvent.change(screen.getByLabelText('BIP39 passphrase (optional)'), {
      target: { value: 'secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test recovery' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/do not restore/iu);
    expect(screen.getByLabelText('Complete recovery phrase')).toHaveValue('');
    expect(screen.getByLabelText('BIP39 passphrase (optional)')).toHaveValue('');
    expect(calls).toHaveLength(1);
  });

  it('treats a malformed complete phrase as a recovery mismatch', async () => {
    installFakeChrome({
      'backup.status': () => ({
        ok: true,
        result: {
          backupVerified: true,
          metadata: {
            version: 1, origin: 'imported', usageGatePassed: true, wordCount: 12,
            usesPassphrase: false, lastSpotCheckAt: Date.now(), lastFullRecoveryCheckAt: null,
          },
        },
      }),
      'vaultCoordinator.recoveryCReadiness': () => ({
        ok: true,
        result: {
          state: 'not_started', localRole: 'absent', policyState: 'absent',
          phoneSignerPaired: false, standaloneRecoveryPackageAvailable: true,
          policyId: null, setupComplete: false, kitExported: false,
          backupCheckComplete: false, ready: false,
        },
      }),
      'vault.verifyFullRecovery': () => ({ ok: false, code: 'ERR_INVALID_PAYLOAD' }),
    });
    render(
      <Providers>
        <RecoverySettings expectation={EXPECTATION} onBack={vi.fn()} onReveal={vi.fn()} onVault={vi.fn()} />
      </Providers>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Test complete Spending recovery' }));
    fireEvent.change(screen.getByLabelText('Complete recovery phrase'), {
      target: { value: 'abandon abandon abandon' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test recovery' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/do not restore this wallet/iu);
    expect(screen.queryByText(/something went wrong/iu)).toBeNull();
    expect(screen.getByLabelText('Complete recovery phrase')).toHaveValue('');
  });

  it('keeps valid Vault evidence when Spending status fails and recovers on retry', async () => {
    let attempts = 0;
    installFakeChrome({
      'backup.status': () => {
        attempts += 1;
        return attempts === 1
          ? { ok: false, code: 'ERR_INTERNAL' }
          : {
              ok: true,
              result: {
                backupVerified: true,
                metadata: {
                  version: 1, origin: 'generated', usageGatePassed: true, wordCount: 12,
                  usesPassphrase: false, lastSpotCheckAt: 1, lastFullRecoveryCheckAt: 1,
                },
              },
            };
      },
      'vaultCoordinator.recoveryCReadiness': () => ({
        ok: true,
        result: {
          state: 'ready', localRole: 'usable', policyState: 'usable',
          phoneSignerPaired: true, standaloneRecoveryPackageAvailable: true,
          policyId: '11'.repeat(32), setupComplete: true, kitExported: true,
          backupCheckComplete: true, ready: true,
        },
      }),
    });
    render(
      <Providers>
        <RecoverySettings expectation={EXPECTATION} onBack={vi.fn()} onReveal={vi.fn()} onVault={vi.fn()} />
      </Providers>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing unknown is marked Ready');
    expect(screen.getByRole('heading', { name: 'Spending recovery' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Vault protection' })).toBeInTheDocument();
    expect(screen.getAllByText('Ready').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Not checked').length).toBeGreaterThan(0);
    expect(screen.queryByText('How this phrase was generated')).toBeNull();
    expect(screen.queryByText(/older version of Drey/iu)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Spending recovery' })).toBeInTheDocument();
    expect(screen.getAllByText('Ready').length).toBeGreaterThan(0);
    expect(attempts).toBe(2);
  });

  it('keeps valid Spending evidence when Vault status fails', async () => {
    installFakeChrome({
      'backup.status': () => ({
        ok: true,
        result: {
          backupVerified: true,
          metadata: {
            version: 1, origin: 'generated', usageGatePassed: true, wordCount: 12,
            usesPassphrase: false, lastSpotCheckAt: 1, lastFullRecoveryCheckAt: 1,
          },
        },
      }),
      'vaultCoordinator.recoveryCReadiness': () => ({ ok: false, code: 'ERR_INTERNAL' }),
    });
    render(
      <Providers>
        <RecoverySettings expectation={EXPECTATION} onBack={vi.fn()} onReveal={vi.fn()} onVault={vi.fn()} />
      </Providers>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing unknown is marked Ready');
    expect(screen.getByText('12 words')).toBeInTheDocument();
    expect(screen.getAllByText('Ready')).toHaveLength(3);
    expect(screen.getAllByText('Not checked').length).toBeGreaterThan(0);
  });

  it('does not show generic success when the post-check Spending refresh fails', async () => {
    let spendingReads = 0;
    installFakeChrome({
      'backup.status': () => {
        spendingReads += 1;
        return spendingReads === 1 ? {
          ok: true,
          result: {
            backupVerified: false,
            metadata: {
              version: 1, origin: 'generated', usageGatePassed: false, wordCount: 12,
              usesPassphrase: false, lastSpotCheckAt: null, lastFullRecoveryCheckAt: null,
            },
          },
        } : { ok: false, code: 'ERR_INTERNAL' };
      },
      'vaultCoordinator.recoveryCReadiness': () => ({
        ok: true,
        result: {
          state: 'not_started', localRole: 'absent', policyState: 'absent',
          phoneSignerPaired: false, standaloneRecoveryPackageAvailable: true,
          policyId: null, setupComplete: false, kitExported: false,
          backupCheckComplete: false, ready: false,
        },
      }),
      'vault.verifyBackup': () => ({ ok: true, result: { verified: true } }),
    });
    render(
      <Providers>
        <RecoverySettings expectation={EXPECTATION} onBack={vi.fn()} onReveal={vi.fn()} onVault={vi.fn()} />
      </Providers>,
    );
    await openCheck();
    fillCheck();
    fireEvent.click(screen.getByRole('button', { name: 'Check backup' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing unknown is marked Ready');
    expect(screen.queryByText('Backup check complete')).toBeNull();
    expect(screen.queryByDisplayValue('legal')).toBeNull();
  });

  it('clears secret inputs and returns to the overview when the document is hidden', async () => {
    renderRecovery();
    await openCheck();
    fillCheck();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));

    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
    expect(screen.queryByText('legal')).toBeNull();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('coalesces a focus and foreground burst into one bounded refresh per source', async () => {
    let spendingReads = 0;
    let vaultReads = 0;
    installFakeChrome({
      'backup.status': () => {
        spendingReads += 1;
        return {
          ok: true,
          result: {
            backupVerified: true,
            metadata: {
              version: 1, origin: 'generated', usageGatePassed: true, wordCount: 12,
              usesPassphrase: false, lastSpotCheckAt: 1, lastFullRecoveryCheckAt: 1,
            },
          },
        };
      },
      'vaultCoordinator.recoveryCReadiness': () => {
        vaultReads += 1;
        return {
          ok: true,
          result: {
            state: 'ready', localRole: 'usable', policyState: 'usable',
            phoneSignerPaired: true, standaloneRecoveryPackageAvailable: true,
            policyId: '11'.repeat(32), setupComplete: true, kitExported: true,
            backupCheckComplete: true, ready: true,
          },
        };
      },
    });
    render(
      <Providers>
        <RecoverySettings expectation={EXPECTATION} onBack={vi.fn()} onReveal={vi.fn()} onVault={vi.fn()} />
      </Providers>,
    );
    await screen.findByRole('heading', { name: 'Vault protection' });
    expect([spendingReads, vaultReads]).toEqual([1, 1]);

    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect([spendingReads, vaultReads]).toEqual([2, 2]));
  });

  it('keeps the overview visible while a foreground refresh is pending', async () => {
    let spendingReads = 0;
    let resolveRefresh: ((value: unknown) => void) | undefined;
    installFakeChrome({
      'backup.status': () => {
        spendingReads += 1;
        if (spendingReads > 1) {
          return new Promise((resolve) => { resolveRefresh = resolve; });
        }
        return {
          ok: true,
          result: {
            backupVerified: true,
            metadata: {
              version: 1, origin: 'generated', usageGatePassed: true, wordCount: 12,
              usesPassphrase: false, lastSpotCheckAt: 1, lastFullRecoveryCheckAt: 1,
            },
          },
        };
      },
      'vaultCoordinator.recoveryCReadiness': () => ({
        ok: true,
        result: {
          state: 'ready', localRole: 'usable', policyState: 'usable',
          phoneSignerPaired: true, standaloneRecoveryPackageAvailable: true,
          policyId: '11'.repeat(32), setupComplete: true, kitExported: true,
          backupCheckComplete: true, ready: true,
        },
      }),
    });
    render(
      <Providers>
        <RecoverySettings expectation={EXPECTATION} onBack={vi.fn()} onReveal={vi.fn()} onVault={vi.fn()} />
      </Providers>,
    );
    await screen.findByRole('heading', { name: 'Spending recovery' });

    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(spendingReads).toBe(2));
    expect(screen.getByRole('heading', { name: 'Spending recovery' })).toBeInTheDocument();
    expect(screen.queryByText('Loading...')).toBeNull();

    resolveRefresh?.({
      ok: true,
      result: {
        backupVerified: true,
        metadata: {
          version: 1, origin: 'generated', usageGatePassed: true, wordCount: 12,
          usesPassphrase: false, lastSpotCheckAt: 1, lastFullRecoveryCheckAt: 1,
        },
      },
    });
    await waitFor(() => expect(screen.queryByText('Loading...')).toBeNull());
  });

  it('does not reload for a value-equivalent session expectation object', async () => {
    let spendingReads = 0;
    let vaultReads = 0;
    installFakeChrome({
      'backup.status': () => {
        spendingReads += 1;
        return {
          ok: true,
          result: {
            backupVerified: true,
            metadata: {
              version: 1, origin: 'generated', usageGatePassed: true, wordCount: 12,
              usesPassphrase: false, lastSpotCheckAt: 1, lastFullRecoveryCheckAt: 1,
            },
          },
        };
      },
      'vaultCoordinator.recoveryCReadiness': () => {
        vaultReads += 1;
        return {
          ok: true,
          result: {
            state: 'ready', localRole: 'usable', policyState: 'usable',
            phoneSignerPaired: true, standaloneRecoveryPackageAvailable: true,
            policyId: '11'.repeat(32), setupComplete: true, kitExported: true,
            backupCheckComplete: true, ready: true,
          },
        };
      },
    });
    const onBack = vi.fn();
    const onReveal = vi.fn();
    const onVault = vi.fn();
    const view = render(
      <Providers>
        <RecoverySettings expectation={EXPECTATION} onBack={onBack} onReveal={onReveal} onVault={onVault} />
      </Providers>,
    );
    await screen.findByRole('heading', { name: 'Spending recovery' });

    view.rerender(
      <Providers>
        <RecoverySettings expectation={{ ...EXPECTATION }} onBack={onBack} onReveal={onReveal} onVault={onVault} />
      </Providers>,
    );
    await Promise.resolve();

    expect([spendingReads, vaultReads]).toEqual([1, 1]);
    expect(screen.getByRole('heading', { name: 'Spending recovery' })).toBeInTheDocument();
    expect(screen.queryByText('Loading...')).toBeNull();
  });

  it('ignores a stale status response after the active session changes', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined;
    const first = new Promise((resolve) => { resolveFirst = resolve; });
    installFakeChrome({
      'backup.status': (payload) => {
        const sessionId = (payload as typeof EXPECTATION).expectedSessionId;
        if (sessionId === EXPECTATION.expectedSessionId) return first;
        return {
          ok: true,
          result: {
            backupVerified: true,
            metadata: {
              version: 1, origin: 'generated', usageGatePassed: true, wordCount: 15,
              usesPassphrase: false, lastSpotCheckAt: 1, lastFullRecoveryCheckAt: 1,
            },
          },
        };
      },
      'vaultCoordinator.recoveryCReadiness': () => ({
        ok: true,
        result: {
          state: 'not_started', localRole: 'absent', policyState: 'absent',
          phoneSignerPaired: false, standaloneRecoveryPackageAvailable: true,
          policyId: null, setupComplete: false, kitExported: false,
          backupCheckComplete: false, ready: false,
        },
      }),
    });
    const onBack = vi.fn();
    const onReveal = vi.fn();
    const onVault = vi.fn();
    const view = render(
      <Providers>
        <RecoverySettings expectation={EXPECTATION} onBack={onBack} onReveal={onReveal} onVault={onVault} />
      </Providers>,
    );
    const nextExpectation = {
      expectedVaultId: 'vault-2',
      expectedSessionId: '00000000-0000-4000-8000-000000000002',
    };
    view.rerender(
      <Providers>
        <RecoverySettings expectation={nextExpectation} onBack={onBack} onReveal={onReveal} onVault={onVault} />
      </Providers>,
    );
    expect(await screen.findByText('15 words')).toBeInTheDocument();

    resolveFirst?.({
      ok: true,
      result: {
        backupVerified: true,
        metadata: {
          version: 1, origin: 'generated', usageGatePassed: true, wordCount: 24,
          usesPassphrase: false, lastSpotCheckAt: 1, lastFullRecoveryCheckAt: 1,
        },
      },
    });
    await Promise.resolve();
    expect(screen.getByText('15 words')).toBeInTheDocument();
    expect(screen.queryByText('24 words')).toBeNull();
  });

  it('deep-links the single Vault setup action without starting a ceremony here', async () => {
    installFakeChrome({
      'backup.status': () => ({
        ok: true,
        result: {
          backupVerified: true,
          metadata: {
            version: 1, origin: 'generated', usageGatePassed: true, wordCount: 12,
            usesPassphrase: false, lastSpotCheckAt: 1, lastFullRecoveryCheckAt: 1,
          },
        },
      }),
      'vaultCoordinator.recoveryCReadiness': () => ({
        ok: true,
        result: {
          state: 'not_started', localRole: 'absent', policyState: 'absent',
          phoneSignerPaired: false, standaloneRecoveryPackageAvailable: true,
          policyId: null, setupComplete: false, kitExported: false,
          backupCheckComplete: false, ready: false,
        },
      }),
    });
    const onVault = vi.fn();
    render(
      <Providers>
        <RecoverySettings expectation={EXPECTATION} onBack={vi.fn()} onReveal={vi.fn()} onVault={onVault} />
      </Providers>,
    );
    await screen.findByRole('heading', { name: 'Vault protection' });
    fireEvent.click(screen.getByRole('button', { name: 'Set up Vault' }));
    expect(onVault).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText(/password/iu)).toBeNull();
  });
});
