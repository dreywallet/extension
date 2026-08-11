import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VaultCoordinator } from '../../src/entrypoints/fullpage/VaultCoordinator';
import { Providers, installFakeChrome } from './fake-rpc';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const expectation = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};

const desktopOrigin = {
  version: 1 as const,
  role: 'desktop-a' as const,
  network: 'signet' as const,
  masterFingerprintHex: '11111111',
  originPath: "m/48'/1'/0'/2'",
  accountXpub: 'tpub-desktop',
};

const recoveryOrigin = {
  ...desktopOrigin,
  role: 'recovery-c' as const,
  masterFingerprintHex: '33333333',
  accountXpub: 'tpub-recovery',
};

const policy = {
  policyId: '44'.repeat(32),
  network: 'signet' as const,
  policyVersion: 1 as const,
  threshold: 2 as const,
  createdAt: 1,
  vaultLabel: 'Test Vault',
  birthdayHeight: null,
  signers: [
    { ...desktopOrigin, label: 'Desktop A' },
    {
      ...desktopOrigin,
      role: 'mobile-b' as const,
      masterFingerprintHex: '22222222',
      accountXpub: 'tpub-mobile',
      label: 'Mobile B',
    },
    { ...recoveryOrigin, label: 'Recovery C' },
  ],
  receiveDescriptor: 'wsh(sortedmulti(2,A,B,C))#recv0001',
  changeDescriptor: 'wsh(sortedmulti(2,A,B,C))#chng0001',
  receiveChecksum: 'recv0001',
  changeChecksum: 'chng0001',
  firstReceiveAddress: null as string | null,
};

function renderCoordinator(): void {
  render(
    <Providers>
      <VaultCoordinator expectation={expectation} onBack={() => undefined} />
    </Providers>,
  );
}

function baseHandlers(policyState: 'absent' | 'present', pending: string[]) {
  return {
    'vaultCoordinator.status': () => ({
      ok: true,
      result: {
        available: true,
        network: 'signet',
        movement: 'full',
        bound: null,
        role: 'present',
        policy: policyState,
        importPending: pending,
      },
    }),
    'vaultCoordinator.roleOrigin': () => ({
      ok: true,
      result: {
        role: { roleId: 'role-a', label: 'Desktop A', createdAt: 1, origin: desktopOrigin },
      },
    }),
  };
}

describe('<VaultCoordinator /> Recovery C states', () => {
  it('offers the safe next step after a page or worker restart', async () => {
    installFakeChrome({
      ...baseHandlers('absent', []),
      'vaultCoordinator.recoveryCReadiness': () => ({
        ok: true,
        result: {
          state: 'setup_complete',
          policyId: null,
          setupComplete: true,
          kitExported: false,
          backupCheckComplete: false,
          ready: false,
        },
      }),
    });
    renderCoordinator();
    expect(await screen.findByRole('button', { name: 'Create Vault' })).toBeInTheDocument();
  });

  it('explains that an interrupted open challenge must be replaced', async () => {
    installFakeChrome({
      ...baseHandlers('absent', ['recovery-c']),
      'vaultCoordinator.recoveryCReadiness': () => ({
        ok: true,
        result: {
          state: 'setup_open',
          policyId: null,
          setupComplete: false,
          kitExported: false,
          backupCheckComplete: false,
          ready: false,
        },
      }),
    });
    renderCoordinator();
    expect(await screen.findByText(/A previous challenge is still open/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start over with a new challenge' }))
      .toBeInTheDocument();
  });

  it('hides every funding target and value-moving panel until the paper check passes', async () => {
    installFakeChrome({
      ...baseHandlers('present', []),
      'vaultCoordinator.recoveryCReadiness': () => ({
        ok: true,
        result: {
          state: 'kit_required',
          policyId: policy.policyId,
          setupComplete: true,
          kitExported: false,
          backupCheckComplete: false,
          ready: false,
        },
      }),
      'vaultCoordinator.policy': () => ({ ok: true, result: { state: 'present', policy } }),
    });
    renderCoordinator();
    expect(await screen.findByRole('heading', { name: 'Offline Recovery C readiness' }))
      .toBeInTheDocument();
    expect(screen.getByText(/Do not fund this Vault yet/u)).toBeInTheDocument();
    expect(screen.queryByText('tb1qfundingaddress')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Withdraw to your Spending wallet' }))
      .not.toBeInTheDocument();
  });

  it('shows the derived address and plan surface only in the ready state', async () => {
    const readyPolicy = { ...policy, firstReceiveAddress: 'tb1qfundingaddress' };
    installFakeChrome({
      ...baseHandlers('present', []),
      'vaultCoordinator.recoveryCReadiness': () => ({
        ok: true,
        result: {
          state: 'ready',
          policyId: policy.policyId,
          setupComplete: true,
          kitExported: true,
          backupCheckComplete: true,
          ready: true,
        },
      }),
      'vaultCoordinator.policy': () => ({
        ok: true,
        result: { state: 'present', policy: readyPolicy },
      }),
      'vaultCoordinator.plan': () => ({
        ok: true,
        result: { plan: null, psbtHex: null, stale: false, broadcast: null },
      }),
    });
    renderCoordinator();
    expect(await screen.findByText('tb1qfundingaddress')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Withdraw to your Spending wallet' }))
      .toBeInTheDocument();
    expect(screen.getByText(/paper copy was proved against this exact Vault policy/u))
      .toBeInTheDocument();
  });

  it('requires an explicit saved-location confirmation after starting the kit download', async () => {
    let kitExported = false;
    const acknowledge = vi.fn(() => {
      kitExported = true;
      return { ok: true, result: { policyId: policy.policyId, kitExported: true } };
    });
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    vi.stubGlobal('URL', Object.assign(Object.create(URL), {
      createObjectURL: vi.fn(() => 'blob:recovery-kit-ui-test'),
      revokeObjectURL: vi.fn(),
    }));
    installFakeChrome({
      ...baseHandlers('present', []),
      'vaultCoordinator.recoveryCReadiness': () => ({
        ok: true,
        result: {
          state: kitExported ? 'backup_required' : 'kit_required',
          policyId: policy.policyId,
          setupComplete: true,
          kitExported,
          backupCheckComplete: false,
          ready: false,
        },
      }),
      'vaultCoordinator.policy': () => ({ ok: true, result: { state: 'present', policy } }),
      'vaultCoordinator.recoveryKit': () => ({
        ok: true,
        result: {
          kitHex: '0102',
          standaloneToolPublished: true,
          standaloneToolCoreTag: 'v0.5.0',
          kit: {
            version: 1,
            network: 'signet',
            policyVersion: 1,
            policyId: policy.policyId,
            signers: [
              desktopOrigin,
              {
                ...desktopOrigin,
                role: 'mobile-b',
                masterFingerprintHex: '22222222',
                accountXpub: 'tpub-mobile',
              },
              recoveryOrigin,
            ],
            receiveDescriptor: policy.receiveDescriptor,
            changeDescriptor: policy.changeDescriptor,
            createdAtMs: '1',
            birthdayHeight: null,
            vaultLabel: policy.vaultLabel,
            signerLabels: ['Desktop A', 'Mobile B', 'Recovery C'],
            firstReceiveAddress: 'tb1qpublickitaddress',
            compatibilityRequirements: ['Drey Vault recovery v1'],
            minimumReaderVersion: 1,
            standaloneToolSourceDigest: '11'.repeat(32),
            standaloneToolArtifactDigest: '22'.repeat(32),
            recoveryInstructions: 'Use any two independent roles.',
            rotationInstructions: 'Move funds to a new policy after recovery.',
            recoveryInstructionsVersion: 1,
          },
        },
      }),
      'vaultCoordinator.acknowledgeRecoveryKitExport': acknowledge,
    });
    renderCoordinator();
    fireEvent.click(await screen.findByRole('button', { name: 'Show recovery kit' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Download kit file' }));
    expect(download).toHaveBeenCalledTimes(1);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(screen.getByText(/Confirm only after you can see the kit file/u)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'I saved the kit separately' }));
    await waitFor(() => expect(acknowledge).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'I saved the kit separately' }))
      .not.toBeInTheDocument();
  });

  it('downloads a public setup challenge and imports only the selected response file', async () => {
    let state: 'not_started' | 'setup_open' | 'setup_complete' = 'not_started';
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const beginSetup = vi.fn(() => {
      state = 'setup_open' as const;
      return {
        ok: true,
        result: {
          challengeHex: '0102',
          challengeDigestHex: 'dd'.repeat(32),
          fingerprint: '1111-2222-3333-4444',
          network: 'signet',
          expiresAtMs: '4102444800000',
          fileName: 'drey-vault-recovery-c-setup-test.sqvb',
        },
      };
    });
    vi.stubGlobal('URL', Object.assign(Object.create(URL), {
      createObjectURL: vi.fn(() => 'blob:recovery-c-ui-test'),
      revokeObjectURL: vi.fn(),
    }));
    installFakeChrome({
      ...baseHandlers('absent', ['recovery-c']),
      'vaultCoordinator.recoveryCReadiness': () => ({
        ok: true,
        result: {
          state,
          policyId: null,
          setupComplete: state === 'setup_complete',
          kitExported: false,
          backupCheckComplete: false,
          ready: false,
        },
      }),
      'vaultCoordinator.beginImport': () => ({
        ok: true,
        result: {
          sessionIdHex: 'aa'.repeat(16),
          challengeNonceHex: 'bb'.repeat(32),
          transcriptHashHex: 'cc'.repeat(32),
          expiresAtMs: '4102444800000',
          imported: ['mobile-b'],
          pending: ['recovery-c'],
          challengeQrFrames: null,
        },
      }),
      'vaultCoordinator.beginRecoveryCSetup': beginSetup,
      'vaultCoordinator.importRecoveryCSetupResponse': () => {
        state = 'setup_complete';
        return {
          ok: true,
          result: {
            role: 'recovery-c',
            origin: recoveryOrigin,
            imported: ['mobile-b', 'recovery-c'],
            pending: [],
            complete: true,
          },
        };
      },
    });
    renderCoordinator();
    fireEvent.click(await screen.findByRole('button', { name: 'Start over with a new challenge' }));
    const setupButton = await screen.findByRole('button', { name: 'Download setup challenge' });
    fireEvent.click(setupButton);
    fireEvent.click(setupButton);
    expect(await screen.findByText(/Challenge fingerprint: 1111-2222-3333-4444/u))
      .toBeInTheDocument();
    expect(download).toHaveBeenCalledTimes(1);
    expect(beginSetup).toHaveBeenCalledTimes(1);

    const input = screen.getByTestId('vault-recovery-c-setup-file');
    fireEvent.change(input, { target: { files: [new File([Uint8Array.of(3, 4)], 'answer.any')] } });
    await waitFor(() => {
      expect(screen.getByText(
        'Recovery C was verified. Its words remain only on your paper copy.',
      )).toBeInTheDocument();
    });
    expect(screen.queryByTestId('vault-recovery-c-setup-file')).not.toBeInTheDocument();
  });
});
