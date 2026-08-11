import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuickAddresses } from '../../src/entrypoints/popup/QuickAddresses';
import { installFakeChrome, Providers } from './fake-rpc';

afterEach(cleanup);

const EXPECTATION = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};
const ACCOUNT_ID = `acct_mainnet_${'1'.repeat(64)}`;
const PAYMENT = 'bc1qpaymentaddressxxxxxxxxxxxxxxxxxxxxx';
const ORDINALS = 'bc1pordinalsaddressxxxxxxxxxxxxxxxxxxxx';

describe('quick receive addresses', () => {
  it('loads both lanes in parallel and copies either address from Home', async () => {
    const requests: string[] = [];
    installFakeChrome({
      'address.receive': (payload) => {
        const kind = (payload as { kind: 'payment' | 'ordinals' }).kind;
        requests.push(kind);
        return {
          ok: true,
          result: {
            accountId: ACCOUNT_ID,
            address: kind === 'payment' ? PAYMENT : ORDINALS,
            path: kind === 'payment' ? "m/84'/0'/0'/0/0" : "m/86'/0'/0'/0/0",
            kind,
            network: 'mainnet',
          },
        };
      },
    });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <Providers>
        <QuickAddresses expectation={EXPECTATION} activeAccountId={ACCOUNT_ID} />
      </Providers>,
    );

    await userEvent.click(
      await screen.findByRole('button', { name: 'Copy Bitcoin address' }),
    );
    expect(requests).toEqual(['payment', 'ordinals']);
    expect(writeText).toHaveBeenCalledWith(PAYMENT);
    expect(await screen.findByText('Bitcoin address copied')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Copy Ordinals address' }));
    expect(writeText).toHaveBeenCalledWith(ORDINALS);
    expect(await screen.findByText('Ordinals address copied')).toBeInTheDocument();
  });
});
