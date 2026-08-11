import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Unlock } from '../../src/ui/components/Unlock';
import { installFakeChrome, Providers } from './fake-rpc';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const VAULTS = [
  { vaultId: 'vault-1', name: 'Main' },
  { vaultId: 'vault-2', name: 'Cold' },
];

function setup(
  vaults = VAULTS,
  preferredUnlockVaultId: string | null = null,
): { onUnlocked: ReturnType<typeof vi.fn>; unlockRequests: unknown[] } {
  const unlockRequests: unknown[] = [];
  installFakeChrome({
    'vault.unlock': (payload) => {
      unlockRequests.push(payload);
      const { vaultId, password } = payload as { vaultId: string; password: string };
      return password === 'correct-password'
        ? {
            ok: true,
            result: {
              vaultId,
              sessionId: '00000000-0000-4000-8000-000000000001',
              deadline: 123,
            },
          }
        : { ok: false, code: 'ERR_WRONG_PASSWORD' };
    },
  });
  const onUnlocked = vi.fn();
  render(
    <Providers>
      <Unlock
        vaults={vaults}
        preferredUnlockVaultId={preferredUnlockVaultId}
        onUnlocked={onUnlocked}
      />
    </Providers>,
  );
  return { onUnlocked, unlockRequests };
}

describe('Unlock', () => {
  it('shows a vault picker only when there is more than one vault', () => {
    setup();
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    cleanup();
    setup([VAULTS[0]!]);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('surfaces a wrong password and does not unlock', async () => {
    const { onUnlocked } = setup();
    fireEvent.change(screen.getByLabelText('App password'), { target: { value: 'wrong-password-x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/wrong password/iu);
    expect(onUnlocked).not.toHaveBeenCalled();
  });

  it('unlocks the selected vault and clears the password field', async () => {
    const { onUnlocked } = setup();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'vault-2' } });
    fireEvent.change(screen.getByLabelText('App password'), { target: { value: 'correct-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText('App password')).toHaveValue('');
  });

  it('starts on the last successfully unlocked vault when it still exists', async () => {
    const { onUnlocked, unlockRequests } = setup(VAULTS, 'vault-2');
    expect(screen.getByRole('combobox')).toHaveValue('vault-2');

    fireEvent.change(screen.getByLabelText('App password'), {
      target: { value: 'correct-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

    await waitFor(() => expect(onUnlocked).toHaveBeenCalledTimes(1));
    expect(unlockRequests).toContainEqual({ vaultId: 'vault-2', password: 'correct-password' });
  });

  it('requests its first passkey challenge for the preferred wallet', async () => {
    vi.stubGlobal('PublicKeyCredential', class PublicKeyCredential {});
    const challengeRequests: unknown[] = [];
    installFakeChrome({
      'passkey.challenge': (payload) => {
        challengeRequests.push(payload);
        return { ok: true, result: { available: false, entries: [] } };
      },
    });
    render(
      <Providers>
        <Unlock
          vaults={VAULTS}
          preferredUnlockVaultId="vault-2"
          onUnlocked={() => undefined}
        />
      </Providers>,
    );

    await waitFor(() => expect(challengeRequests).toEqual([{ vaultId: 'vault-2' }]));
  });

  it('falls back to the first wallet when the preferred wallet is missing', () => {
    setup(VAULTS, 'removed-vault');
    expect(screen.getByRole('combobox')).toHaveValue('vault-1');
  });

  it('preserves a valid choice and reconciles only when that wallet disappears', async () => {
    const unlockRequests: unknown[] = [];
    installFakeChrome({
      'vault.unlock': (payload) => {
        unlockRequests.push(payload);
        return { ok: false, code: 'ERR_WRONG_PASSWORD' };
      },
    });
    const onUnlocked = vi.fn();
    const form = (vaults: typeof VAULTS, preferredUnlockVaultId: string | null): ReactNode => (
      <Providers>
        <Unlock
          vaults={vaults}
          preferredUnlockVaultId={preferredUnlockVaultId}
          onUnlocked={onUnlocked}
        />
      </Providers>
    );
    const rendered = render(form(VAULTS, 'vault-1'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'vault-2' } });

    rendered.rerender(form([...VAULTS], 'vault-1'));
    expect(screen.getByRole('combobox')).toHaveValue('vault-2');

    rendered.rerender(form([VAULTS[0]!], 'vault-1'));
    fireEvent.change(screen.getByLabelText('App password'), {
      target: { value: 'wrong-password-x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(unlockRequests).toContainEqual({ vaultId: 'vault-1', password: 'wrong-password-x' });
  });
});
