import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { FixedRateUrDecoder } from '@drey/core/domain/ur/fixed-rate';
import { decodeVaultContextCbor } from '@drey/core/domain/vault/multisig-qr';
import { PUBLIC_UR_CAMERA_FRAMES } from '../e2e/synthetic-camera';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';

const root = new URL('../..', import.meta.url).pathname;
const require = createRequire(import.meta.url);

beforeAll(installTestCryptoProvider);

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

describe('MB3c scanner dependency and channel boundaries', () => {
  it('confines the decoder package to one pixel-only adapter', () => {
    const sourceRoot = join(root, 'src');
    const imports = filesBelow(sourceRoot)
      .filter((file) => /\.tsx?$/u.test(file))
      .filter((file) => readFileSync(file, 'utf8').includes("from 'jsqr'"))
      .map((file) => relative(root, file).replaceAll('\\', '/'));
    expect(imports).toEqual(['src/adapters/qr/jsqr-decoder.ts']);

    const adapter = readFileSync(join(sourceRoot, 'adapters/qr/jsqr-decoder.ts'), 'utf8');
    expect(adapter).not.toMatch(/entrypoints|useRpc|chrome\.|browser\.|fetch\(/u);
  });

  it('pins the audited zero-dependency decoder release exactly', () => {
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const lockfile = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
    expect(packageJson.dependencies['jsqr']).toBe('1.4.0');
    expect(lockfile).toContain(
      'jsqr@1.4.0:\n    resolution: {integrity: sha512-dxLob7q65Xg2DvstYkRpkYtmKm2sPJ9oFhrhmudT1dZvNFFTlroai3AWSpLey/w5vMcLBXRgOJsbXpdN9HzU/A==}',
    );
    expect(lockfile).toContain('jsqr@1.4.0: {}');

    const decoderPackagePath = require.resolve('jsqr/package.json');
    const decoderPackage = JSON.parse(readFileSync(decoderPackagePath, 'utf8')) as {
      license?: string;
      dependencies?: Record<string, string>;
    };
    const decoderBundle = readFileSync(
      join(dirname(decoderPackagePath), 'dist/jsQR.js'),
      'utf8',
    );
    expect(decoderPackage.license).toBe('Apache-2.0');
    expect(decoderPackage.dependencies).toBeUndefined();
    expect(decoderBundle).not.toMatch(
      /\beval\s*\(|\bnew\s+Function\b|\bfetch\s*\(|XMLHttpRequest|WebSocket|importScripts|WebAssembly|document\.|window\.|navigator\./u,
    );
  });

  it('derives the public camera fixture from the authenticated core coordinator vector', () => {
    expect(PUBLIC_UR_CAMERA_FRAMES).toHaveLength(5);
    expect(PUBLIC_UR_CAMERA_FRAMES.every((frame) => frame.startsWith('ur:x-drey-vault/')))
      .toBe(true);
    const decoder = new FixedRateUrDecoder({ expectedType: 'x-drey-vault' });
    let complete: { type: string; cborMessage: Uint8Array } | null = null;
    for (const frame of PUBLIC_UR_CAMERA_FRAMES) {
      const result = decoder.receive(frame);
      if (result.status === 'complete') complete = result;
    }
    expect(complete).not.toBeNull();
    expect(complete!.type).toBe('x-drey-vault');
    expect([...complete!.cborMessage.slice(0, 3)]).toEqual([0x83, 0x01, 0x01]);
    expect(decodeVaultContextCbor(complete!.type, complete!.cborMessage).kind).toBe('pairing');
  });

  it('keeps composition compile-time gated to test and production', () => {
    const coordinator = readFileSync(
      join(root, 'src/entrypoints/fullpage/VaultCoordinator.tsx'),
      'utf8',
    );
    const scanner = readFileSync(
      join(root, 'src/entrypoints/fullpage/vault/VaultTransportScanner.tsx'),
      'utf8',
    );
    const audit = readFileSync(join(root, 'scripts/audit-production.mjs'), 'utf8');
    expect(coordinator).toContain("__BUILD_CHANNEL__ === 'test'");
    expect(coordinator).toContain("lazy(() => import('./vault/VaultTransportScanner'))");
    expect(coordinator).toContain("__BUILD_CHANNEL__ === 'production'");
    expect(scanner).toContain('DREY_PRODUCTION_VAULT_SCANNER_v1');
    expect(scanner).not.toMatch(/useRpc|setOriginHex|setProofHex/u);
    expect(audit).toContain('channel scanner graph confinement mismatch');
    expect(audit).toContain("requestedChannel === 'production'");
  });
});
