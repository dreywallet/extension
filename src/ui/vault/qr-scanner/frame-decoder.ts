import { decodeQrPixels } from '../../../adapters/qr/jsqr-decoder';

const MAX_FALLBACK_WIDTH = 720;

export type QrFrameResult =
  | { status: 'none' }
  | { status: 'decoded'; value: string }
  | { status: 'ambiguous' };

export interface QrVideoFrameDecoder {
  readonly kind: 'barcode-detector' | 'jsqr';
  detect(video: HTMLVideoElement): Promise<QrFrameResult>;
}

/** Decode a user-selected raster entirely in this extension page. */
export async function decodeQrImageFile(
  file: File,
  canvas: HTMLCanvasElement,
): Promise<QrFrameResult> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_FALLBACK_WIDTH / Math.max(bitmap.width, 1));
    canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
    canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) return { status: 'none' };
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const value = decodeQrPixels(image.data, image.width, image.height);
    return value === null ? { status: 'none' } : { status: 'decoded', value };
  } finally {
    bitmap.close();
    canvas.width = 1;
    canvas.height = 1;
  }
}

interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
}

interface BarcodeDetectorConstructor {
  new(options: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats(): Promise<string[]>;
}

function barcodeDetectorConstructor(): BarcodeDetectorConstructor | undefined {
  return (globalThis as typeof globalThis & { BarcodeDetector?: BarcodeDetectorConstructor })
    .BarcodeDetector;
}

/** Native when this exact platform supports QR; deterministic local JS otherwise. */
export async function createQrVideoFrameDecoder(
  canvas: HTMLCanvasElement,
): Promise<QrVideoFrameDecoder> {
  const Detector = barcodeDetectorConstructor();
  if (Detector !== undefined) {
    try {
      const formats = await Detector.getSupportedFormats();
      if (formats.includes('qr_code')) {
        const detector = new Detector({ formats: ['qr_code'] });
        return {
          kind: 'barcode-detector',
          async detect(video) {
            const values = new Set(
              (await detector.detect(video)).map((item) => item.rawValue).filter(Boolean),
            );
            if (values.size === 0) return { status: 'none' };
            if (values.size !== 1) return { status: 'ambiguous' };
            return { status: 'decoded', value: [...values][0]! };
          },
        };
      }
    } catch {
      // A present interface is not a supported platform. Fall through to the
      // bundled local decoder; do not send pixels anywhere.
    }
  }

  return {
    kind: 'jsqr',
    async detect(video) {
      if (video.videoWidth <= 0 || video.videoHeight <= 0) return { status: 'none' };
      const scale = Math.min(1, MAX_FALLBACK_WIDTH / video.videoWidth);
      canvas.width = Math.max(1, Math.floor(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.floor(video.videoHeight * scale));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (context === null) return { status: 'none' };
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      const value = decodeQrPixels(image.data, image.width, image.height);
      return value === null ? { status: 'none' } : { status: 'decoded', value };
    },
  };
}
