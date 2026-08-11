import '@testing-library/jest-dom/vitest';
import { Buffer } from 'node:buffer';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UR, UREncoder } from '@ngraveio/bc-ur';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WatchAccountScanner } from '../../src/entrypoints/fullpage/accounts/WatchAccountScanner';
import { createQrVideoFrameDecoder } from '../../src/ui/vault/qr-scanner/frame-decoder';
import { I18nProvider } from '../../src/ui/i18n';

vi.mock('../../src/ui/vault/qr-scanner/frame-decoder', () => ({ createQrVideoFrameDecoder: vi.fn() }));
const createDecoder = vi.mocked(createQrVideoFrameDecoder);
let callbacks: Map<number, FrameRequestCallback>;

function camera(value: Promise<MediaStream>): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(() => value) },
  });
}

function renderScanner(onPayload = vi.fn()): void {
  render(<I18nProvider initial="en"><WatchAccountScanner onPayload={onPayload} /></I18nProvider>);
}

beforeEach(() => {
  callbacks = new Map();
  let next = 1;
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const id = next++;
    callbacks.set(id, callback);
    return id;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => callbacks.delete(id)));
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'mediaDevices');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  createDecoder.mockReset();
});

describe('watch-account camera scanner', () => {
  it('requests permission only after Start camera and reports denial', async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    renderScanner();
    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/denied/iu);
  });

  it('stops a late camera grant after cancellation', async () => {
    let resolve!: (value: MediaStream) => void;
    camera(new Promise((next) => { resolve = next; }));
    renderScanner();
    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop camera' }));
    const stop = vi.fn();
    resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(createDecoder).not.toHaveBeenCalled();
  });

  it('returns a complete account-descriptor UR and releases the camera', async () => {
    const stop = vi.fn();
    camera(Promise.resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream));
    const frame = UREncoder.encodeSinglePart(new UR(Buffer.from([1, 2, 3]), 'account-descriptor'));
    createDecoder.mockResolvedValue({
      kind: 'barcode-detector',
      detect: vi.fn(async () => ({ status: 'decoded' as const, value: frame })),
    });
    const onPayload = vi.fn();
    renderScanner(onPayload);
    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    await waitFor(() => expect(callbacks.size).toBe(1));
    const entry = callbacks.entries().next().value as [number, FrameRequestCallback];
    callbacks.delete(entry[0]);
    await act(async () => { entry[1](100); await Promise.resolve(); });
    expect(onPayload).toHaveBeenCalledWith({
      kind: 'ur', type: 'account-descriptor', cbor: Uint8Array.of(1, 2, 3),
    });
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
