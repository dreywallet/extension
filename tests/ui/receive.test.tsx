/** §10.6 receive: stable address + QR + copy, BIP-321 URI, ordinals explanation. */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import decodeQR from 'qr/decode.js';
import { Receive } from '../../src/entrypoints/popup/Receive';
import { installFakeChrome, Providers } from './fake-rpc';

afterEach(cleanup);

const PAYMENT_ADDR = 'bc1qpaymentaddressxxxxxxxxxxxxxxxxxxxxx';
const ORDINALS_ADDR = 'bc1pordinalsaddressxxxxxxxxxxxxxxxxxxxx';
const EXPECTATION = {
  expectedVaultId: 'vault-1',
  expectedSessionId: '00000000-0000-4000-8000-000000000001',
};
const ACCOUNT_ID = `acct_mainnet_${'1'.repeat(64)}`;
const OTHER_ACCOUNT_ID = `acct_mainnet_${'2'.repeat(64)}`;

function decodeRenderedQr(svg: SVGElement): string {
  const viewBox = svg.getAttribute('viewBox')?.split(' ').map(Number);
  const size = viewBox?.[2];
  if (!Number.isInteger(size) || size === undefined || size <= 0) throw new Error('Invalid QR viewBox');
  const modules = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const path = svg.querySelector('path')?.getAttribute('d') ?? '';
  const runs = path.matchAll(/M(\d+) (\d+)h(\d+)v1H\d+z/gu);
  for (const run of runs) {
    const start = Number(run[1]);
    const y = Number(run[2]);
    const width = Number(run[3]);
    for (let x = start; x < start + width; x += 1) modules[y]![x] = true;
  }
  const scale = 4;
  const width = size * scale;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = modules[Math.floor(y / scale)]![Math.floor(x / scale)] ? 0 : 255;
      const offset = (y * width + x) * 4;
      data[offset] = color;
      data[offset + 1] = color;
      data[offset + 2] = color;
      data[offset + 3] = 255;
    }
  }
  return decodeQR({ width, height: width, data });
}

function setup(gateClosed = false, network: 'mainnet' | 'signet' = 'mainnet'): void {
  installFakeChrome({
    'address.receive': (payload) => {
      if (gateClosed) return { ok: false, code: 'ERR_BACKUP_REQUIRED' };
      const { kind } = payload as { kind: 'payment' | 'ordinals' };
      return {
        ok: true,
        result: {
          accountId: ACCOUNT_ID,
          address: kind === 'payment' ? PAYMENT_ADDR : ORDINALS_ADDR,
          path: "m/84'/0'/0'/0/0",
          kind,
          network,
        },
      };
    },
  });
  render(
    <Providers>
      <Receive initialKind="payment" expectation={EXPECTATION} activeAccountId={ACCOUNT_ID} onClose={vi.fn()} />
    </Providers>,
  );
}

describe('Receive', () => {
  it('shows the payment address, QR, and copy action', async () => {
    setup();
    expect(await screen.findByText(PAYMENT_ADDR)).toBeInTheDocument();
    const qr = screen.getByRole('img');
    expect(qr.tagName).toBe('svg');
    expect(qr).not.toHaveAttribute('src');
    expect(qr).toHaveAttribute('shape-rendering', 'crispEdges');
    expect(qr.style.border).toBe('');
    expect(qr.style.padding).toBe('');
    const qrSize = Number(qr.getAttribute('viewBox')?.split(' ')[2]);
    const darkRuns = [...(qr.querySelector('path')?.getAttribute('d') ?? '')
      .matchAll(/M(\d+) (\d+)h(\d+)v1H\d+z/gu)];
    expect(darkRuns.every((run) =>
      Number(run[1]) >= 4 && Number(run[2]) >= 4 &&
      Number(run[1]) + Number(run[3]) <= qrSize - 4 && Number(run[2]) < qrSize - 4,
    )).toBe(true);
    expect(decodeRenderedQr(qr as unknown as SVGElement)).toBe(PAYMENT_ADDR);
    expect(screen.getByRole('button', { name: 'Copy address' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share request' })).toBeEnabled();
    expect(screen.queryByRole('region', { name: 'Send bitcoin' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy payment link' })).toBeNull();
  });

  it('explains the network the worker answered with, not a UI assumption (M6)', async () => {
    setup(false, 'signet');
    expect(screen.queryByText(/stable Bitcoin address on Mainnet/u)).toBeNull();
    await screen.findByText(PAYMENT_ADDR);
    expect(screen.getByText(/stable Bitcoin address on Signet/u)).toBeInTheDocument();
    cleanup();
    setup(false, 'mainnet');
    await screen.findByText(PAYMENT_ADDR);
    expect(screen.getByText(/stable Bitcoin address on Mainnet/u)).toBeInTheDocument();
  });

  it('builds a BIP-321 payment link once an amount is entered', async () => {
    setup();
    await screen.findByText(PAYMENT_ADDR);
    fireEvent.change(screen.getByLabelText(/Amount/u), { target: { value: '250000' } });
    expect(screen.getByRole('button', { name: 'Copy payment link' })).toBeInTheDocument();
    expect(decodeRenderedQr(screen.getByRole('img') as unknown as SVGElement))
      .toBe(`bitcoin:${PAYMENT_ADDR}?amount=0.0025`);
  });

  it('rejects a non-integer amount with a visible error', async () => {
    setup();
    await screen.findByText(PAYMENT_ADDR);
    fireEvent.change(screen.getByLabelText(/Amount/u), { target: { value: '0.5' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/whole number/u);
    expect(screen.getByRole('button', { name: 'Share request' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Copy payment link' })).toBeNull();
  });

  it('rejects an amount above the total Bitcoin supply without crashing render', async () => {
    setup();
    await screen.findByText(PAYMENT_ADDR);
    fireEvent.change(screen.getByLabelText(/Amount/u), { target: { value: '2100000000000001' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/whole number/u);
    expect(screen.queryByRole('button', { name: 'Copy payment link' })).toBeNull();
  });

  it('contains QR encoder capacity errors instead of crashing the receive screen', async () => {
    setup();
    await screen.findByText(PAYMENT_ADDR);
    fireEvent.change(screen.getByLabelText(/Message for sender/u), {
      target: { value: 'x'.repeat(3_000) },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/too long/iu);
    expect(screen.getByText(PAYMENT_ADDR)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share request' })).toBeDisabled();
  });

  it('switches to the ordinals address with its purpose explanation and no amount field', async () => {
    setup();
    await screen.findByText(PAYMENT_ADDR);
    fireEvent.click(screen.getByRole('radio', { name: 'Ordinals' }));
    expect(await screen.findByText(ORDINALS_ADDR)).toBeInTheDocument();
    expect(decodeRenderedQr(screen.getByRole('img') as unknown as SVGElement)).toBe(ORDINALS_ADDR);
    expect(screen.getByText(/inscriptions and protected sats/u)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Amount/u)).toBeNull();
  });

  it('supports arrow-key navigation between receive lanes', async () => {
    setup();
    await screen.findByText(PAYMENT_ADDR);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Bitcoin' }), { key: 'ArrowRight' });
    expect(await screen.findByText(ORDINALS_ADDR)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Ordinals' })).toHaveFocus();
  });

  it('surfaces clipboard rejection without an unhandled promise', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    setup();
    await screen.findByText(PAYMENT_ADDR);
    fireEvent.click(screen.getByRole('button', { name: 'Copy address' }));
    expect(await screen.findByRole('button', { name: /copy failed/iu })).toBeInTheDocument();
  });

  it('surfaces the §7.1 backup gate error', async () => {
    setup(true);
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('derives the selected account address while the receive view remains open', async () => {
    let accountAddress = PAYMENT_ADDR;
    let calls = 0;
    installFakeChrome({
      'address.receive': () => {
        calls += 1;
        return {
          ok: true,
          result: {
            accountId: calls === 1 ? ACCOUNT_ID : OTHER_ACCOUNT_ID,
            address: accountAddress,
            path: `m/84'/0'/${calls - 1}'/0/0`,
            kind: 'payment',
            network: 'mainnet',
          },
        };
      },
    });
    const rendered = render(
      <Providers>
        <Receive initialKind="payment" expectation={EXPECTATION} activeAccountId={ACCOUNT_ID} onClose={vi.fn()} />
      </Providers>,
    );
    expect(await screen.findByText(PAYMENT_ADDR)).toBeInTheDocument();

    const secondAddress = 'bc1qsecondaccountxxxxxxxxxxxxxxxxxxxxxx';
    accountAddress = secondAddress;
    rendered.rerender(
      <Providers>
        <Receive initialKind="payment" expectation={EXPECTATION} activeAccountId={OTHER_ACCOUNT_ID} onClose={vi.fn()} />
      </Providers>,
    );
    expect(await screen.findByText(secondAddress)).toBeInTheDocument();
    expect(calls).toBe(2);
  });
});
