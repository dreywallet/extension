import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQrVideoFrameDecoder } from '../../src/ui/vault/qr-scanner/frame-decoder';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('QR video-frame decoder selection', () => {
  it('uses the native detector only when this platform reports QR support', async () => {
    class NativeDetector {
      static results: Array<{ rawValue: string }> = [];
      static getSupportedFormats = vi.fn(async () => ['qr_code']);
      detect = vi.fn(async () => NativeDetector.results);
    }
    vi.stubGlobal('BarcodeDetector', NativeDetector);
    const decoder = await createQrVideoFrameDecoder({} as HTMLCanvasElement);
    const video = {} as HTMLVideoElement;
    expect(decoder.kind).toBe('barcode-detector');

    NativeDetector.results = [{ rawValue: 'ur:bytes/one' }];
    await expect(decoder.detect(video)).resolves.toEqual({
      status: 'decoded', value: 'ur:bytes/one',
    });
    NativeDetector.results = [{ rawValue: 'one' }, { rawValue: 'two' }];
    await expect(decoder.detect(video)).resolves.toEqual({ status: 'ambiguous' });
  });

  it('falls back locally and bounds the RGBA work surface to 720 pixels wide', async () => {
    vi.stubGlobal('BarcodeDetector', undefined);
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({
        drawImage,
        getImageData: (_x: number, _y: number, width: number, height: number) => ({
          data: new Uint8ClampedArray(width * height * 4), width, height,
        }),
      })),
    } as unknown as HTMLCanvasElement;
    const video = { videoWidth: 1_440, videoHeight: 80 } as HTMLVideoElement;
    const decoder = await createQrVideoFrameDecoder(canvas);

    expect(decoder.kind).toBe('jsqr');
    await expect(decoder.detect(video)).resolves.toEqual({ status: 'none' });
    expect(canvas.width).toBe(720);
    expect(canvas.height).toBe(40);
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 720, 40);
  });

  it('falls back when a present native capability probe throws', async () => {
    class BrokenDetector {
      static getSupportedFormats = vi.fn(async () => { throw new Error('not implemented'); });
    }
    vi.stubGlobal('BarcodeDetector', BrokenDetector);
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => null),
    } as unknown as HTMLCanvasElement;
    await expect(createQrVideoFrameDecoder(canvas)).resolves.toMatchObject({ kind: 'jsqr' });
  });
});
