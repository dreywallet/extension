import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import encodeQR from 'qr';

/** Public deterministic authenticated coordinator frames; never signer data. */
function publicVaultContextFrames(): string[] {
  const vector = JSON.parse(readFileSync(
    new URL('../../node_modules/@drey/core/vectors/vault-coordinator-v1.json', import.meta.url),
    'utf8',
  )) as { records?: { mainnet?: { expected?: { pairingContextUrFrames?: unknown } } } };
  const frames = vector.records?.mainnet?.expected?.pairingContextUrFrames;
  if (!Array.isArray(frames) || frames.length < 2 ||
      !frames.every((frame) => typeof frame === 'string' && frame.startsWith('ur:x-drey-vault/'))) {
    throw new Error('core coordinator vector has no authenticated pairing-context frames');
  }
  return frames;
}

export const PUBLIC_UR_CAMERA_FRAMES = publicVaultContextFrames();

/**
 * Chromium's fake camera reads YUV4MPEG2. Generate a small animated fixture in
 * the disposable browser profile so no retained media artifact is needed.
 */
export async function writePublicUrCameraVideo(path: string): Promise<void> {
  const width = 352;
  const height = 288;
  const framesPerCode = 8;
  const chunks: Buffer[] = [Buffer.from(
    `YUV4MPEG2 W${width} H${height} F6:1 Ip A1:1 C420jpeg\n`,
    'ascii',
  )];
  const chroma = Buffer.alloc((width / 2) * (height / 2), 128);

  for (const value of PUBLIC_UR_CAMERA_FRAMES) {
    const matrix = encodeQR(value, 'raw', { ecc: 'medium', border: 4 });
    const scale = Math.min(
      Math.floor(width / matrix.length),
      Math.floor(height / matrix.length),
    );
    if (scale < 1) throw new Error('Synthetic camera QR does not fit its public video frame');
    const qrWidth = matrix.length * scale;
    const left = Math.floor((width - qrWidth) / 2);
    const top = Math.floor((height - qrWidth) / 2);
    const luma = Buffer.alloc(width * height, 235);
    for (let y = 0; y < qrWidth; y += 1) {
      for (let x = 0; x < qrWidth; x += 1) {
        if (matrix[Math.floor(y / scale)]![Math.floor(x / scale)]) {
          luma[(top + y) * width + left + x] = 16;
        }
      }
    }
    for (let repeat = 0; repeat < framesPerCode; repeat += 1) {
      chunks.push(Buffer.from('FRAME\n', 'ascii'), luma, chroma, chroma);
    }
  }
  await writeFile(path, Buffer.concat(chunks));
}
