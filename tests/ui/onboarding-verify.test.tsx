/**
 * §7.1 create-flow gating: the mnemonic is shown once, forgotten by the UI
 * before verification, and only a worker-verified match advances the flow.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CreateFlow } from '../../src/entrypoints/onboarding/CreateFlow';
import { ResumeVerify } from '../../src/entrypoints/onboarding/ResumeVerify';
import type { ErrorCode } from '@drey/core/messaging/envelope';
import { installFakeChrome, Providers } from './fake-rpc';

const MNEMONIC =
  'legal winner thank year wave sausage worth useful legal winner thank yellow';

afterEach(cleanup);

type VerifyResult = boolean | { code: ErrorCode };
type RevealResult = string | { code: ErrorCode };

function setup(
  verifyResults: VerifyResult[],
  revealResults: RevealResult[] = [MNEMONIC],
): { onDone: ReturnType<typeof vi.fn>; verifyCalls: unknown[] } {
  const verifyCalls: unknown[] = [];
  let revealCalls = 0;
  installFakeChrome({
    'vault.create': () => ({ ok: true, result: { vaultId: 'vault-1' } }),
    'vault.unlock': () => ({
      ok: true,
      result: {
        vaultId: 'vault-1',
        sessionId: '00000000-0000-4000-8000-000000000001',
        deadline: 123,
      },
    }),
    'vault.revealMnemonic': () => {
      const result = revealResults[revealCalls] ?? MNEMONIC;
      revealCalls += 1;
      return typeof result === 'string'
        ? { ok: true, result: { mnemonic: result } }
        : { ok: false, code: result.code };
    },
    'vault.verifyBackup': (payload) => {
      verifyCalls.push(payload);
      const result = verifyResults[verifyCalls.length - 1] ?? false;
      return typeof result === 'boolean'
        ? { ok: true, result: { verified: result } }
        : { ok: false, code: result.code };
    },
  });
  const onDone = vi.fn();
  render(
    <Providers>
      <CreateFlow onDone={onDone} onBack={vi.fn()} />
    </Providers>,
  );
  return { onDone, verifyCalls };
}

async function reachRevealStep(): Promise<void> {
  fireEvent.change(screen.getByLabelText('App password'), { target: { value: 'a-long-password' } });
  fireEvent.change(screen.getByLabelText('Confirm app password'), { target: { value: 'a-long-password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await screen.findAllByText('legal');
}

describe('CreateFlow', () => {
  it('explains the requirements and keeps Continue disabled until the password is valid (§7.2)', () => {
    setup([]);
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDisabled();
    expect(screen.getByText(/at least 12 characters/iu)).toBeVisible();
    fireEvent.change(screen.getByLabelText('App password'), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText('Confirm app password'), { target: { value: 'short' } });
    expect(continueButton).toBeDisabled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps Continue disabled while valid password entries do not match', () => {
    setup([]);
    fireEvent.change(screen.getByLabelText('App password'), { target: { value: 'a-long-password' } });
    fireEvent.change(screen.getByLabelText('Confirm app password'), {
      target: { value: 'a-different-password' },
    });
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Passwords do not match.');
  });

  it('warns about an exact common password without blocking progress', async () => {
    setup([true]);
    fireEvent.change(screen.getByLabelText('App password'), { target: { value: 'password1234' } });
    fireEvent.change(screen.getByLabelText('Confirm app password'), { target: { value: 'password1234' } });
    expect(screen.getByRole('status')).toHaveTextContent(/can continue/iu);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Write down your recovery phrase' }))
      .toBeInTheDocument();
  });

  it('shows the mnemonic, then forgets it before verification', async () => {
    setup([true]);
    await reachRevealStep();
    expect(screen.getAllByText('winner')).toHaveLength(2); // both occurrences rendered

    fireEvent.click(screen.getByRole('button', { name: 'I wrote the words down' }));
    await screen.findByText('Confirm your recovery phrase');
    // The mnemonic words are gone from the DOM once verification starts.
    expect(screen.queryByText('winner')).toBeNull();
  });

  it('reauthenticates before review and creates a fresh challenge afterward', async () => {
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues');
    let randomCall = 0;
    random.mockImplementation((array) => {
      const values = randomCall === 2 ? [6, 6, 6] : [0, 0, 0];
      randomCall += 1;
      (array as Uint32Array).set(values);
      return array;
    });
    setup([], [MNEMONIC, MNEMONIC]);
    await reachRevealStep();
    fireEvent.click(screen.getByRole('button', { name: 'I wrote the words down' }));
    expect(await screen.findByLabelText('Word #1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Review recovery phrase' }));
    expect(await screen.findByRole('heading', { name: 'Review recovery phrase' }))
      .toBeInTheDocument();
    expect(screen.queryByLabelText('Word #1')).not.toBeInTheDocument();
    expect(screen.queryByText('sausage')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('App password'), { target: { value: 'a-long-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(await screen.findByText('sausage')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'I wrote the words down' }));

    expect(await screen.findByLabelText('Word #7')).toBeInTheDocument();
    expect(screen.getByLabelText('Word #8')).toHaveValue('');
    expect(screen.getByLabelText('Word #9')).toHaveValue('');
    random.mockRestore();
  });

  it('does not reveal or restore the challenge after failed reauthentication', async () => {
    setup([], [MNEMONIC, { code: 'ERR_WRONG_PASSWORD' }]);
    await reachRevealStep();
    fireEvent.click(screen.getByRole('button', { name: 'I wrote the words down' }));
    await screen.findByText('Confirm your recovery phrase');
    fireEvent.click(screen.getByRole('button', { name: 'Review recovery phrase' }));
    fireEvent.change(screen.getByLabelText('App password'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/wrong password/iu);
    expect(screen.queryByText('sausage')).not.toBeInTheDocument();
    expect(screen.queryByText('Confirm your recovery phrase')).not.toBeInTheDocument();
  });

  it('keeps recovery words visible by default and offers one reversible hide control', async () => {
    setup([]);
    await reachRevealStep();
    expect(screen.getByText('sausage')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Hide words' }));
    expect(screen.queryByText('sausage')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show words' }));
    expect(screen.getByText('sausage')).toBeVisible();
  });

  it('advances only on a verified match and reshuffles on failure', async () => {
    const { onDone, verifyCalls } = setup([false, true]);
    await reachRevealStep();
    fireEvent.click(screen.getByRole('button', { name: 'I wrote the words down' }));
    await screen.findByText('Confirm your recovery phrase');

    const fill = (): void => {
      for (const input of screen.getAllByRole('textbox')) {
        fireEvent.change(input, { target: { value: 'legal' } });
      }
    };

    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/do not match/u);
    expect(onDone).not.toHaveBeenCalled();
    // Inputs were cleared by the reshuffle.
    for (const input of screen.getAllByRole('textbox')) {
      expect(input).toHaveValue('');
    }

    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(verifyCalls).toHaveLength(2);
  });

  it('shows a mapped RPC error without treating it as a wrong phrase', async () => {
    setup([{ code: 'ERR_LOCKED' }]);
    await reachRevealStep();
    fireEvent.click(screen.getByRole('button', { name: 'I wrote the words down' }));
    await screen.findByText('Confirm your recovery phrase');

    for (const input of screen.getAllByRole('textbox')) {
      fireEvent.change(input, { target: { value: 'legal' } });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('The wallet is locked.');
    expect(screen.queryByText(/do not match/u)).toBeNull();
    for (const input of screen.getAllByRole('textbox')) {
      expect(input).toHaveValue('legal');
    }
  });

  it('never renders a copy affordance for the mnemonic', async () => {
    setup([]);
    await reachRevealStep();
    expect(screen.queryByRole('button', { name: /copy/iu })).toBeNull();
  });
});

describe('ResumeVerify', () => {
  it('uses the same invalidating phrase-review route after interrupted onboarding', async () => {
    const random = vi.spyOn(globalThis.crypto, 'getRandomValues');
    let randomCall = 0;
    random.mockImplementation((array) => {
      const values = randomCall === 1 ? [6, 6, 6] : [0, 0, 0];
      randomCall += 1;
      (array as Uint32Array).set(values);
      return array;
    });
    installFakeChrome({
      'vault.revealMnemonic': () => ({ ok: true, result: { mnemonic: MNEMONIC } }),
    });
    render(
      <Providers>
        <ResumeVerify
          onDone={vi.fn()}
          expectation={{
            expectedVaultId: 'vault-1',
            expectedSessionId: '00000000-0000-4000-8000-000000000001',
          }}
        />
      </Providers>,
    );
    expect(screen.getByLabelText('Word #1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review recovery phrase' }));
    expect(screen.queryByLabelText('Word #1')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('App password'), { target: { value: 'a-long-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(await screen.findByText('sausage')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'I wrote the words down' }));
    expect(await screen.findByLabelText('Word #7')).toBeInTheDocument();
    random.mockRestore();
  });
});
