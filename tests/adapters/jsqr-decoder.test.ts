import { describe, expect, it } from 'vitest';
import encodeQR from 'qr';
import { decodeQrPixels } from '../../src/adapters/qr/jsqr-decoder';

function qrPixels(value: string): { data: Uint8ClampedArray; width: number; height: number } {
  const matrix = encodeQR(value, 'raw', { ecc: 'medium', border: 4 });
  const scale = 5;
  const width = matrix.length * scale;
  const data = new Uint8ClampedArray(width * width * 4);
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const color = matrix[Math.floor(y / scale)]![Math.floor(x / scale)] ? 0 : 255;
      const offset = (y * width + x) * 4;
      data[offset] = color;
      data[offset + 1] = color;
      data[offset + 2] = color;
      data[offset + 3] = 255;
    }
  }
  return { data, width, height: width };
}

describe('lint-confined jsQR adapter', () => {
  it('decodes the exact text from a deterministic local RGBA matrix', () => {
    const value = 'ur:bytes/1-4/lpadbbcsfphdckcfcyglcwcwtnfefgmhdm';
    const image = qrPixels(value);
    expect(decodeQrPixels(image.data, image.width, image.height)).toBe(value);
  });

  it('refuses invalid dimensions and pixel lengths without invoking unsafe coercions', () => {
    expect(decodeQrPixels(new Uint8ClampedArray(), 0, 0)).toBeNull();
    expect(decodeQrPixels(new Uint8ClampedArray(16), 2, 3)).toBeNull();
    expect(decodeQrPixels(new Uint8ClampedArray(16), 1.5, 2)).toBeNull();
  });
});
