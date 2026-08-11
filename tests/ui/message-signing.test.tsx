import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MessageSigning } from '../../src/entrypoints/fullpage/MessageSigning';
import { installFakeChrome, Providers } from './fake-rpc';

const ACCOUNT_ID = `acct_mainnet_${'1'.repeat(64)}`;
const EXPECTATION = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};
const ADDRESS = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

afterEach(cleanup);

describe('MessageSigning', () => {
  it('reviews immutable text and address before password reauth and signing', async () => {
    const calls: Array<{ op: string; payload: unknown }> = [];
    installFakeChrome({
      'address.receive': (payload) => {
        calls.push({ op: 'address.receive', payload });
        return { ok: true, result: {
          accountId: ACCOUNT_ID,
          kind: 'payment',
          network: 'mainnet',
          path: "m/84'/0'/0'/0/0",
          address: ADDRESS,
        } };
      },
      'message.sign': (payload) => {
        calls.push({ op: 'message.sign', payload });
        return { ok: true, result: {
          protocol: 'BIP-322',
          address: ADDRESS,
          signature: 'smp-test-signature',
          messageHashHex: 'a'.repeat(64),
        } };
      },
    });
    render(
      <Providers>
        <MessageSigning expectation={EXPECTATION} accountId={ACCOUNT_ID} onBack={() => undefined} />
      </Providers>,
    );

    const message = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(message, { target: { value: 'I control this address.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review message' }));

    expect(await screen.findByRole('heading', { name: 'Review before signing' })).toBeInTheDocument();
    expect(screen.getByText('I control this address.')).toBeInTheDocument();
    expect(screen.getByText(ADDRESS)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Confirm app password'), {
      target: { value: 'correct horse battery staple' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign message' }));

    expect(await screen.findByRole('heading', { name: 'Message signed' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('smp-test-signature')).toBeInTheDocument();
    expect(calls).toEqual([
      { op: 'address.receive', payload: {
        accountId: ACCOUNT_ID, kind: 'payment', ...EXPECTATION,
      } },
      { op: 'message.sign', payload: {
        accountId: ACCOUNT_ID,
        addressKind: 'payment',
        message: 'I control this address.',
        password: 'correct horse battery staple',
        ...EXPECTATION,
      } },
    ]);
  });

  it('blocks empty and oversized messages before invoking the worker', () => {
    installFakeChrome({});
    render(
      <Providers>
        <MessageSigning expectation={EXPECTATION} accountId={ACCOUNT_ID} onBack={() => undefined} />
      </Providers>,
    );
    const review = screen.getByRole('button', { name: 'Review message' });
    expect(review).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'a'.repeat(4097) },
    });
    expect(review).toBeDisabled();
    expect(screen.getByText('4097 of 4,096 bytes').className).toContain('error');
  });
});
