import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PasskeyOffer } from '../../src/entrypoints/onboarding/PasskeyOffer';
import { installFakeChrome, Providers } from './fake-rpc';

const EXPECTATION = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};
const originalPublicKeyCredential = globalThis.PublicKeyCredential;

afterEach(() => {
  cleanup();
  Object.defineProperty(globalThis, 'PublicKeyCredential', {
    configurable: true,
    value: originalPublicKeyCredential,
  });
});

describe('onboarding passkey offer', () => {
  it('explains that passkeys are optional unlock methods and can be skipped', async () => {
    class FakePublicKeyCredential {
      static getClientCapabilities(): Promise<Record<string, boolean>> {
        return Promise.resolve({ 'extension:prf': true });
      }
    }
    Object.defineProperty(globalThis, 'PublicKeyCredential', {
      configurable: true,
      value: FakePublicKeyCredential,
    });
    installFakeChrome({});
    const onDone = vi.fn();
    render(<Providers><PasskeyOffer expectation={EXPECTATION} onDone={onDone} /></Providers>);

    expect(await screen.findByText(/cannot recover this wallet/iu)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('skips cleanly before asking for a password when this device has no passkey surface', async () => {
    Object.defineProperty(globalThis, 'PublicKeyCredential', {
      configurable: true,
      value: undefined,
    });
    installFakeChrome({});
    const onDone = vi.fn();
    render(<Providers><PasskeyOffer expectation={EXPECTATION} onDone={onDone} /></Providers>);

    await waitFor(() => expect(onDone).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText('App password')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps password unlock unchanged when password reauthentication fails', async () => {
    class FakePublicKeyCredential {
      static getClientCapabilities(): Promise<Record<string, boolean>> {
        return Promise.resolve({ 'extension:prf': true });
      }
    }
    Object.defineProperty(globalThis, 'PublicKeyCredential', {
      configurable: true,
      value: FakePublicKeyCredential,
    });
    installFakeChrome({
      'passkey.beginEnrollment': () => ({ ok: false, code: 'ERR_WRONG_PASSWORD' }),
    });
    const onDone = vi.fn();
    render(<Providers><PasskeyOffer expectation={EXPECTATION} onDone={onDone} /></Providers>);

    fireEvent.change(await screen.findByLabelText('App password'), {
      target: { value: 'wrong-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Set up passkey' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/wrong password/iu);
    expect(onDone).not.toHaveBeenCalled();
  });
});
