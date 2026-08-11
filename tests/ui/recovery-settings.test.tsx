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
): { onBack: ReturnType<typeof vi.fn>; onReveal: ReturnType<typeof vi.fn> } {
  installFakeChrome({ 'vault.verifyBackup': handler });
  const onBack = vi.fn();
  const onReveal = vi.fn();
  render(
    <Providers>
      <RecoverySettings expectation={EXPECTATION} onBack={onBack} onReveal={onReveal} />
    </Providers>,
  );
  return { onBack, onReveal };
}

function openCheck(): HTMLInputElement[] {
  fireEvent.click(screen.getByRole('button', { name: 'Check my backup' }));
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
  it('presents routine recovery care separately from the sensitive reveal action', () => {
    const { onReveal } = renderRecovery();

    expect(screen.getByRole('heading', { name: 'Recovery center' })).toBeInTheDocument();
    expect(screen.getByText(/support will never ask/iu)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check my backup' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reveal recovery phrase' }));
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it('uses three distinct positions and hardened word inputs', () => {
    renderRecovery();
    const inputs = openCheck();

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
    openCheck();
    fillCheck([' legal ', 'wave', ' useful ']);
    fireEvent.click(screen.getByRole('button', { name: 'Check backup' }));

    expect(await screen.findByRole('heading', { name: 'Backup check passed' })).toBeInTheDocument();
    expect(calls).toEqual([{
      words: [
        { index: 0, word: 'legal' },
        { index: 4, word: 'wave' },
        { index: 8, word: 'useful' },
      ],
      ...EXPECTATION,
    }]);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText('legal')).toBeNull();
    expect(screen.queryByRole('button', { name: /copy/iu })).toBeNull();
  });

  it('clears a mismatch, retains the positions, and gives no field-level hints', async () => {
    renderRecovery(() => ({ ok: true, result: { verified: false } }));
    openCheck();
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
    openCheck();
    fillCheck();
    fireEvent.click(screen.getByRole('button', { name: 'Check backup' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The wallet is locked.');
    expect(screen.queryByText(/do not match/iu)).toBeNull();
    for (const input of screen.getAllByRole('textbox')) expect(input).toHaveValue('');
  });

  it('randomizes a new set after success and clears words before navigation', async () => {
    mockedPickPositions
      .mockReturnValueOnce([0, 4, 8])
      .mockReturnValueOnce([1, 5, 9]);
    const { onBack } = renderRecovery();
    openCheck();
    fillCheck();
    fireEvent.click(screen.getByRole('button', { name: 'Check backup' }));
    await screen.findByRole('heading', { name: 'Backup check passed' });

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
});
