/**
 * ADR 0007 §6 kit transport: download / QR / print for the public recovery
 * kit. The load-bearing claims:
 *
 * - the QR frames reassemble byte-for-byte into the kit hex, stay inside the
 *   QR alphanumeric charset (so the encoder never falls back to byte mode),
 *   and are individually decodable from the rendered SVGs;
 * - the reassembler refuses a missing, duplicated, or mixed frame set rather
 *   than producing a kit whose checksum simply fails later;
 * - the download is exactly the file `read-kit --kit <file>` consumes —
 *   lowercase hex and one newline — under a policy-derived name;
 * - nothing here transports anything but the kitHex it was handed: the
 *   component takes the already-public kit as a prop and makes no RPC.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import decodeQR from 'qr/decode.js';
import { I18nProvider } from '../../src/ui/i18n';
import { VaultKitTransport } from '../../src/entrypoints/fullpage/vault/VaultKitTransport';
import {
  VAULT_KIT_QR_CHUNK,
  vaultKitFileBody,
  vaultKitFileName,
  vaultKitFromQrFrames,
  vaultKitQrFrames,
} from '../../src/entrypoints/fullpage/vault/kit-transport';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A deterministic stand-in for a real multi-kilobyte kit serialization. */
function fakeKitHex(bytes: number): string {
  return Array.from({ length: bytes }, (_, i) => ((i * 37 + 11) % 256).toString(16).padStart(2, '0')).join('');
}

const POLICY_ID = 'aa55'.repeat(16);

/** ISO/IEC 18004 §7.4.4 alphanumeric charset, the whole point of uppercasing. */
const QR_ALPHANUMERIC = /^[0-9A-Z $%*+\-./:]+$/u;

function renderTransport(kitHex: string): void {
  render(
    <I18nProvider initial="en">
      <VaultKitTransport kitHex={kitHex} policyId={POLICY_ID} />
    </I18nProvider>,
  );
}

/** Rebuild the module matrix from the QrCode SVG and decode it (as receive.test.tsx does). */
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

describe('kit QR frames', () => {
  it('reassemble byte-for-byte and never leave the alphanumeric charset', () => {
    const kitHex = fakeKitHex(2600);
    const frames = vaultKitQrFrames(kitHex);
    expect(frames.length).toBe(Math.ceil(kitHex.length / VAULT_KIT_QR_CHUNK));
    for (const frame of frames) {
      expect(frame.text).toMatch(QR_ALPHANUMERIC);
      expect(frame.text.startsWith(`DREY-VAULT-KIT-V1 ${frame.index}/${frame.count}: `)).toBe(true);
    }
    // Any scan order reassembles to the exact hex.
    const shuffled = [...frames].reverse().map((frame) => frame.text);
    expect(vaultKitFromQrFrames(shuffled)).toBe(kitHex);
  });

  it('refuse reassembly from an incomplete, duplicated, or foreign frame set', () => {
    const frames = vaultKitQrFrames(fakeKitHex(2600)).map((frame) => frame.text);
    expect(frames.length).toBeGreaterThan(1);
    expect(() => vaultKitFromQrFrames(frames.slice(1))).toThrow(/missing/u);
    expect(() => vaultKitFromQrFrames([frames[0]!, frames[0]!, ...frames.slice(2)])).toThrow(
      /missing or duplicated/u,
    );
    expect(() => vaultKitFromQrFrames(['bc1qsomethingelse'])).toThrow(/not a recovery kit/u);
  });

  it('a short kit is one self-labelling frame', () => {
    const kitHex = fakeKitHex(40);
    const frames = vaultKitQrFrames(kitHex);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.text).toBe(`DREY-VAULT-KIT-V1 1/1: ${kitHex.toUpperCase()}`);
    expect(vaultKitFromQrFrames([frames[0]!.text])).toBe(kitHex);
  });
});

describe('kit download body', () => {
  it('is exactly what read-kit consumes: lowercase hex plus one newline', () => {
    const kitHex = fakeKitHex(64);
    expect(vaultKitFileBody(kitHex.toUpperCase())).toBe(`${kitHex}\n`);
    expect(vaultKitFileName(POLICY_ID)).toBe(`drey-vault-recovery-kit-${POLICY_ID.slice(0, 12)}.hex`);
  });
});

describe('<VaultKitTransport />', () => {
  it('renders decodable QR frames whose scans reassemble the kit', async () => {
    const kitHex = fakeKitHex(1200); // two frames at the current chunk size
    renderTransport(kitHex);
    fireEvent.click(screen.getByTestId('vault-kit-qr-toggle'));
    const container = screen.getByTestId('vault-kit-qr-frames');
    const svgs = [...container.querySelectorAll('svg')];
    expect(svgs.length).toBe(vaultKitQrFrames(kitHex).length);
    const scanned = svgs.map((svg) => decodeRenderedQr(svg as unknown as SVGElement));
    expect(vaultKitFromQrFrames(scanned)).toBe(kitHex);
    // The toggle really hides them again.
    fireEvent.click(screen.getByTestId('vault-kit-qr-toggle'));
    expect(screen.queryByTestId('vault-kit-qr-frames')).toBeNull();
  });

  it('downloads the kit as the read-kit file under a policy-derived name', () => {
    const kitHex = fakeKitHex(600).toUpperCase();
    const captured: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      captured.push(blob);
      return 'blob:vault-kit-test';
    });
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL: vi.fn() }));
    let anchorDownload: string | null = null;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        anchorDownload = this.download;
      });
    renderTransport(kitHex);
    fireEvent.click(screen.getByTestId('vault-kit-download'));
    expect(click).toHaveBeenCalledTimes(1);
    expect(anchorDownload).toBe(vaultKitFileName(POLICY_ID));
    expect(captured).toHaveLength(1);
    return captured[0]!.text().then((body) => {
      expect(body).toBe(vaultKitFileBody(kitHex));
    });
  });

  it('print hands off to the browser print dialog', () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    renderTransport(fakeKitHex(64));
    fireEvent.click(screen.getByTestId('vault-kit-print'));
    expect(print).toHaveBeenCalledTimes(1);
  });
});
