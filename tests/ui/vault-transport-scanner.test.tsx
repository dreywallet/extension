import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import vectorsJson from '@drey/core/vectors/vault-coordinator-v1.json';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/ui/i18n';
import { createQrVideoFrameDecoder } from '../../src/ui/vault/qr-scanner/frame-decoder';
import VaultTransportScanner from '../../src/entrypoints/fullpage/vault/VaultTransportScanner';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';

beforeAll(installTestCryptoProvider);

vi.mock('../../src/ui/vault/qr-scanner/frame-decoder', () => ({
  createQrVideoFrameDecoder: vi.fn(),
}));

const createDecoder = vi.mocked(createQrVideoFrameDecoder);
let callbacks: Map<number, FrameRequestCallback>;
let nextAnimationId: number;

function renderScanner(onComplete = vi.fn()): void {
  render(
    <I18nProvider initial="en">
      <VaultTransportScanner kind="context" onComplete={onComplete} onClose={vi.fn()} />
    </I18nProvider>,
  );
}

function installCamera(getUserMedia: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia },
  });
}

async function runNextFrame(now = 100): Promise<void> {
  const entry = callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
  if (entry === undefined) throw new Error('no animation frame was scheduled');
  callbacks.delete(entry[0]);
  await act(async () => {
    entry[1](now);
    await Promise.resolve();
  });
}

beforeEach(() => {
  callbacks = new Map();
  nextAnimationId = 1;
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const id = nextAnimationId;
    nextAnimationId += 1;
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

describe('<VaultTransportScanner />', () => {
  it('presents permission denial precisely without starting a decoder', async () => {
    installCamera(vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')));
    renderScanner();
    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Camera access was denied. Nothing was captured.',
    );
    expect(createDecoder).not.toHaveBeenCalled();
  });

  it('ignores a late camera grant after the user cancels the pending request', async () => {
    let resolveCamera!: (stream: MediaStream) => void;
    const pending = new Promise<MediaStream>((resolve) => { resolveCamera = resolve; });
    const getUserMedia = vi.fn(() => pending);
    installCamera(getUserMedia);
    renderScanner();
    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Stop camera' }));

    const stopTrack = vi.fn();
    resolveCamera({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
    await waitFor(() => expect(stopTrack).toHaveBeenCalledTimes(1));
    expect(createDecoder).not.toHaveBeenCalled();
    expect(screen.queryByText(/Camera active/u)).not.toBeInTheDocument();
  });

  it('stops every track on cancellation and when the page backgrounds', async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    installCamera(vi.fn().mockResolvedValue(stream));
    createDecoder.mockResolvedValue({
      kind: 'jsqr',
      detect: vi.fn(async () => ({ status: 'none' as const })),
    });
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    renderScanner();

    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    expect(await screen.findByText('Camera active. Local decoder: jsqr.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop camera' }));
    expect(stopTrack).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    await waitFor(() => expect(createDecoder).toHaveBeenCalledTimes(2));
    visibility = 'hidden';
    fireEvent(document, new Event('visibilitychange'));
    expect(await screen.findByText('Camera stopped when this page left the foreground.'))
      .toBeInTheDocument();
    expect(stopTrack).toHaveBeenCalledTimes(2);
    expect(callbacks.size).toBe(0);
  });

  it('completes and decodes authenticated Vault context, then releases the camera', async () => {
    const stopTrack = vi.fn();
    const stream = { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
    installCamera(vi.fn().mockResolvedValue(stream));
    const frames = vectorsJson.records.mainnet.expected.pairingContextUrFrames;
    let frameIndex = 0;
    createDecoder.mockResolvedValue({
      kind: 'barcode-detector',
      detect: vi.fn(async () => ({
        status: 'decoded' as const,
        value: frames[Math.min(frameIndex++, frames.length - 1)]!,
      })),
    });
    const onComplete = vi.fn();
    renderScanner(onComplete);

    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    await waitFor(() => expect(callbacks.size).toBe(1));
    for (let index = 0; index < frames.length; index += 1) {
      await runNextFrame((index + 1) * 100);
    }

    expect(await screen.findByText('Vault QR reconstructed and verified.'))
      .toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', String(frames.length));
    expect(screen.getByRole('progressbar')).toHaveAttribute('max', String(frames.length));
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(callbacks.size).toBe(0);
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'context',
      context: expect.objectContaining({ kind: 'pairing' }),
    }));
  });
});
