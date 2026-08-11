/** The one lint-confined import boundary for the bundled QR fallback. */
import jsQR from 'jsqr';

export function decodeQrPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): string | null {
  if (
    !Number.isSafeInteger(width)
    || !Number.isSafeInteger(height)
    || width <= 0
    || height <= 0
    || data.length !== width * height * 4
  ) {
    return null;
  }
  return jsQR(data, width, height, { inversionAttempts: 'dontInvert' })?.data ?? null;
}
