/** §7.6 timed masking: the countdown remasks and the parent clears the secret. */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RevealSeedSettings } from '../../src/entrypoints/fullpage/RevealSeedSettings';
import { installFakeChrome, Providers } from './fake-rpc';

const MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';
const EXPECTATION = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};

beforeEach(() => {
  // shouldAdvanceTime keeps testing-library's waitFor/find* queries working
  // while the countdown interval stays controllable via advanceTimersByTime.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function revealWords(revealCalls: { count: number }): Promise<void> {
  installFakeChrome({
    'vault.revealMnemonic': (payload) => {
      revealCalls.count += 1;
      const { password } = payload as { password: string };
      return password === 'correct-password'
        ? { ok: true, result: { mnemonic: MNEMONIC } }
        : { ok: false, code: 'ERR_WRONG_PASSWORD' };
    },
  });
  render(
    <Providers>
      <RevealSeedSettings expectation={EXPECTATION} onBack={vi.fn()} />
    </Providers>,
  );
  fireEvent.change(screen.getByLabelText('App password'), { target: { value: 'correct-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
  await act(async () => {
    await Promise.resolve();
  });
}

describe('RevealSeedSettings', () => {
  it('requires the password (wrong password shows an error, no words)', async () => {
    installFakeChrome({
      'vault.revealMnemonic': () => ({ ok: false, code: 'ERR_WRONG_PASSWORD' }),
    });
    render(
      <Providers>
        <RevealSeedSettings expectation={EXPECTATION} onBack={vi.fn()} />
      </Providers>,
    );
    fireEvent.change(screen.getByLabelText('App password'), { target: { value: 'nope-nope-nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/wrong password/iu);
    expect(screen.queryByText('winner')).toBeNull();
  });

  it('shows the words, counts down, and remasks (clearing them) at zero', async () => {
    const revealCalls = { count: 0 };
    await revealWords(revealCalls);
    expect(screen.getAllByText('winner')).toHaveLength(2);
    expect(screen.getByRole('timer')).toHaveTextContent('60');

    await act(async () => {
      vi.advanceTimersByTime(61_000);
    });
    // Remasked: words gone, back to the reauth form.
    expect(screen.queryByText('winner')).toBeNull();
    expect(screen.getByLabelText('App password')).toBeInTheDocument();
    // Re-reveal requires typing the password again (no cached secret).
    expect(revealCalls.count).toBe(1);
  });

  it('hide-now clears the words immediately', async () => {
    const revealCalls = { count: 0 };
    await revealWords(revealCalls);
    fireEvent.click(screen.getByRole('button', { name: 'Hide now' }));
    expect(screen.queryByText('winner')).toBeNull();
  });

  it('remasks from elapsed wall-clock time after a suspended interval', async () => {
    const revealCalls = { count: 0 };
    await revealWords(revealCalls);
    expect(screen.getAllByText('winner')).toHaveLength(2);

    vi.setSystemTime(Date.now() + 61_000);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(screen.queryByText('winner')).toBeNull();
  });
});
