import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { URDecoder } from '@ngraveio/bc-ur';
import jsQR from 'jsqr';
import { setCryptoProvider } from '../../core/src/domain/vault/crypto-provider.ts';
import { validateVaultPsbt } from '../../core/src/domain/vault/multisig-psbt.ts';
import { createLibsodiumCryptoProvider } from '../src/adapters/crypto/libsodium-provider.ts';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspaceDirectory = path.resolve(scriptDirectory, '..', '..');
const vectorPath = path.join(workspaceDirectory, 'core', 'vectors', 'vault-recovery-plan-v1.json');
const camera = process.argv[2] ?? '0';
const width = 1280;
const height = 720;
const frameBytes = width * height * 4;
const timeoutMs = 180_000;

const vectors = JSON.parse(await readFile(vectorPath, 'utf8'));
const record = vectors.records.signet;
const probe = record.cases.sweep;
const decoder = new URDecoder();
const frames = new Set();
setCryptoProvider(await createLibsodiumCryptoProvider());

const ffmpeg = spawn('ffmpeg', [
  '-hide_banner', '-loglevel', 'error',
  '-f', 'avfoundation', '-framerate', '30', '-video_size', `${width}x${height}`,
  '-pixel_format', '0rgb', '-i', `${camera}:none`,
  '-vf', 'fps=8', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1',
], { stdio: ['ignore', 'pipe', 'pipe'] });

let pending = Buffer.alloc(0);
let settled = false;
let lastPercent = -1;

const stop = () => {
  if (!ffmpeg.killed) ffmpeg.kill('SIGTERM');
};

const timeout = setTimeout(() => {
  if (settled) return;
  settled = true;
  stop();
  console.error('Timed out before the animated QR was complete.');
  process.exitCode = 1;
}, timeoutMs);

ffmpeg.stderr.on('data', (chunk) => process.stderr.write(chunk));
ffmpeg.on('error', (error) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  console.error(`Camera capture failed: ${error.message}`);
  process.exitCode = 1;
});

ffmpeg.stdout.on('data', (chunk) => {
  if (settled) return;
  pending = Buffer.concat([pending, chunk]);
  while (!settled && pending.length >= frameBytes) {
    const frame = pending.subarray(0, frameBytes);
    pending = pending.subarray(frameBytes);
    const result = jsQR(new Uint8ClampedArray(frame.buffer, frame.byteOffset, frameBytes), width, height, {
      inversionAttempts: 'dontInvert',
    });
    if (!result?.data.toLowerCase().startsWith('ur:crypto-psbt/')) continue;

    const normalized = result.data.toLowerCase();
    if (frames.has(normalized)) continue;
    frames.add(normalized);
    if (!decoder.receivePart(result.data)) continue;

    const percent = Math.floor(decoder.estimatedPercentComplete() * 100);
    if (percent !== lastPercent) {
      lastPercent = percent;
      console.log(`Animated QR: ${percent}%`);
    }
    if (!decoder.isComplete()) continue;

    settled = true;
    clearTimeout(timeout);
    stop();
    if (!decoder.isSuccess()) {
      console.error(`Animated QR failed: ${decoder.resultError()}`);
      process.exitCode = 1;
      return;
    }

    try {
      const ur = decoder.resultUR();
      if (ur.type !== 'crypto-psbt') throw new Error(`unexpected UR type: ${ur.type}`);
      const signed = Buffer.from(ur.decodeCBOR());
      const validated = validateVaultPsbt(record.policy, probe.plan, signed.toString('hex'));
      if (validated.roles.length !== 1) {
        throw new Error(`expected one signing role, received ${validated.roles.length}`);
      }
      console.log(JSON.stringify({
        result: 'verified',
        network: probe.plan.network,
        role: validated.roles[0],
        inputSignatures: probe.plan.inputs.length,
        signedPsbtBytes: signed.length,
        signedPsbtSha256: createHash('sha256').update(signed).digest('hex'),
      }, null, 2));
    } catch (error) {
      console.error(`Signed PSBT verification failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
});

ffmpeg.on('close', (code, signal) => {
  clearTimeout(timeout);
  if (!settled && code !== 0) {
    settled = true;
    console.error(`Camera capture stopped (${signal ?? code}).`);
    process.exitCode = 1;
  }
});

console.log('Camera ready. Hold the animated QR steady in front of the Mac camera.');
