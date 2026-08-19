import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VaultCoordinator } from '../../src/entrypoints/fullpage/VaultCoordinator';
import { Providers, installFakeChrome } from './fake-rpc';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('<VaultCoordinator /> role form', () => {
  it('explains that the role name is an optional device label', async () => {
    installFakeChrome({
      'vaultCoordinator.status': () => ({
        ok: true,
        result: {
          available: true,
          network: 'signet',
          movement: 'full',
          bound: null,
          role: 'absent',
          policy: 'absent',
          importPending: [],
        },
      }),
    });

    render(
      <Providers>
        <VaultCoordinator
          expectation={{
            expectedVaultId: 'vault-1',
            expectedSessionId: '00000000-0000-4000-8000-000000000001',
          }}
          onBack={() => undefined}
        />
      </Providers>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Create Desktop role' }));

    const input = screen.getByRole('textbox', { name: 'Role name (optional)' });
    expect(input).toHaveAttribute('placeholder', 'e.g., Home desktop');
    expect(input).toHaveAccessibleDescription(
      'Choose any name that helps you recognize this device. Leave blank to use “Desktop A”.',
    );
    expect(screen.getByText(/Next, you’ll connect your phone/u)).toBeInTheDocument();
    expect(screen.queryByText(/The Vault is a separate wallet/u)).not.toBeInTheDocument();
  });

  it('leads with one next step and hides technical details after creating Desktop A', async () => {
    installFakeChrome({
      'vaultCoordinator.status': () => ({
        ok: true,
        result: {
          available: true,
          network: 'signet',
          movement: 'full',
          bound: null,
          role: 'present',
          policy: 'absent',
          importPending: [],
        },
      }),
      'vaultCoordinator.roleOrigin': () => ({
        ok: true,
        result: {
          role: {
            roleId: 'role-a',
            label: 'Home desktop',
            createdAt: 1,
            origin: {
              version: 1,
              role: 'desktop-a',
              network: 'signet',
              masterFingerprintHex: '11111111',
              originPath: "m/48'/1'/0'/2'",
              accountXpub: 'tpub-desktop',
            },
          },
        },
      }),
      'vaultCoordinator.recoveryCReadiness': () => ({
        ok: true,
        result: {
          localRole: 'usable',
          policyState: 'absent',
          phoneSignerPaired: false,
          standaloneRecoveryPackageAvailable: true,
          state: 'not_started',
          policyId: null,
          setupComplete: false,
          kitExported: false,
          backupCheckComplete: false,
          ready: false,
        },
      }),
      'vaultCoordinator.beginImport': () => ({
        ok: true,
        result: {
          sessionIdHex: '11'.repeat(16),
          challengeNonceHex: '22'.repeat(32),
          transcriptHashHex: '33'.repeat(32),
          expiresAtMs: '1786660070280',
          imported: [],
          pending: ['mobile-b', 'recovery-c'],
          challengeQrFrames: null,
        },
      }),
      'passkey.list': () => ({ ok: true, result: { entries: [] } }),
    });

    render(
      <Providers>
        <VaultCoordinator
          expectation={{
            expectedVaultId: 'vault-1',
            expectedSessionId: '00000000-0000-4000-8000-000000000001',
          }}
          onBack={() => undefined}
        />
      </Providers>,
    );

    expect(await screen.findByRole('heading', { name: 'Next: connect your other two roles' }))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start setup' })).toBeInTheDocument();
    expect(screen.getByText('Account public key')).not.toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Start setup' }));

    expect(await screen.findByRole('heading', { name: 'Connect Mobile B' })).toBeInTheDocument();
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument();
    expect(screen.getByText('First, scan the identity QR shown on your phone.'))
      .toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Create Recovery C offline' }))
      .not.toBeInTheDocument();
    expect(screen.getByText('Challenge for the other signer')).not.toBeVisible();

    fireEvent.click(screen.getByText('Technical details and manual entry'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Signer record from the other device' }), {
      target: { value: 'scanned-mobile-origin' },
    });
    expect(screen.getByText('Mobile B identity scanned.')).toBeInTheDocument();
    expect(screen.getByLabelText('App password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create pairing QR' })).toBeDisabled();
  });
});
