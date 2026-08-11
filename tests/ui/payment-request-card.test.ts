import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  paymentRequestCardModel,
  paymentRequestQrFits,
  renderPaymentRequestPng,
  shareOrSavePaymentRequest,
} from '../../src/entrypoints/popup/payment-request-card';

const ADDRESS = 'tb1q9n4rq3vz8pmawlm5t08qujg0r79ss4fwn3ff8v';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('payment request card model', () => {
  it('keeps an amountless request explicit and uses the supplied QR payload', () => {
    expect(paymentRequestCardModel({
      address: ADDRESS,
      label: '  ',
      network: 'signet',
      qrValue: ADDRESS,
    })).toEqual({
      address: ADDRESS,
      amountBtc: null,
      amountSats: null,
      label: null,
      network: 'signet',
      qrValue: ADDRESS,
    });
  });

  it('projects exact sats, BTC, label and payment URI without changing authority', () => {
    const uri = `bitcoin:${ADDRESS}?amount=1.23456789&label=Coffee`;
    expect(paymentRequestCardModel({
      address: ADDRESS,
      amountSats: 123_456_789n,
      label: ' Coffee ',
      network: 'mainnet',
      qrValue: uri,
    })).toMatchObject({
      amountBtc: '1.23456789',
      amountSats: '123456789',
      label: 'Coffee',
      qrValue: uri,
    });
  });

  it('rejects a payload beyond QR capacity before export', () => {
    expect(paymentRequestQrFits(ADDRESS)).toBe(true);
    expect(paymentRequestQrFits('x'.repeat(10_000))).toBe(false);
  });

  it('renders the complete local request as a PNG without loading an image', async () => {
    const output = new Blob(['png'], { type: 'image/png' });
    const fillStyles: string[] = [];
    const context = {
      fillRect: vi.fn(),
      fillStyle: '',
      fillText: vi.fn(),
      font: '',
      lineWidth: 0,
      measureText: vi.fn(() => ({ width: 20 })),
      strokeRect: vi.fn(),
      strokeStyle: '',
      textAlign: 'left',
    };
    Object.defineProperty(context, 'fillStyle', {
      configurable: true,
      get: () => fillStyles.at(-1) ?? '',
      set: (value: string) => { fillStyles.push(value); },
    });
    const canvas = {
      getContext: vi.fn(() => context),
      height: 0,
      toBlob: vi.fn((callback: BlobCallback) => callback(output)),
      width: 0,
    };
    vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement);

    await expect(renderPaymentRequestPng({
      accent: '#f7931a',
      model: paymentRequestCardModel({
        address: ADDRESS,
        amountSats: 25_000n,
        label: 'Coffee',
        network: 'signet',
        qrValue: `bitcoin:${ADDRESS}?amount=0.00025&label=Coffee`,
      }),
      testNetworkWarning: 'TEST NETWORK · NO REAL VALUE',
      title: 'Send bitcoin',
    })).resolves.toBe(output);
    expect(canvas).toMatchObject({ height: 1350, width: 1080 });
    expect(context.fillText).toHaveBeenCalledWith('25000 sats', 540, 1005);
    expect(context.fillText).toHaveBeenCalledWith('TEST NETWORK · NO REAL VALUE', 992, 126);
    expect(context.fillText).toHaveBeenCalledWith(ADDRESS, 540, 1232);
    expect(fillStyles.filter((value) => value === '#f4f4ef')).toHaveLength(2);

    context.fillText.mockClear();
    await renderPaymentRequestPng({
      accent: '#f7931a',
      model: paymentRequestCardModel({
        address: ADDRESS,
        label: '',
        network: 'mainnet',
        qrValue: ADDRESS,
      }),
      testNetworkWarning: 'TEST NETWORK · NO REAL VALUE',
      title: 'Send bitcoin',
    });
    expect(context.fillText).toHaveBeenCalledWith('Send bitcoin', 88, 204);
    expect(context.fillText).not.toHaveBeenCalledWith('MAINNET', expect.anything(), expect.anything());
    expect(context.fillText).not.toHaveBeenCalledWith(
      'TEST NETWORK · NO REAL VALUE',
      expect.anything(),
      expect.anything(),
    );
  });

  it('shares a PNG when file sharing is supported and saves it otherwise', async () => {
    const blob = new Blob(['png'], { type: 'image/png' });
    const share = vi.fn(async () => undefined);
    Object.defineProperties(navigator, {
      canShare: { configurable: true, value: vi.fn(() => true) },
      share: { configurable: true, value: share },
    });
    await expect(shareOrSavePaymentRequest(blob)).resolves.toBe('shared');
    expect(share).toHaveBeenCalledOnce();

    Object.defineProperties(navigator, {
      canShare: { configurable: true, value: undefined },
      share: { configurable: true, value: undefined },
    });
    const click = vi.fn();
    vi.spyOn(document, 'createElement').mockReturnValue({ click } as unknown as HTMLAnchorElement);
    const createObjectURL = vi.fn(() => 'blob:request');
    const revoke = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revoke },
    });
    await expect(shareOrSavePaymentRequest(blob)).resolves.toBe('saved');
    expect(click).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith('blob:request');
  });
});
