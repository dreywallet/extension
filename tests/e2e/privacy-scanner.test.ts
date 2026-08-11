import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// The production scanner intentionally stays a directly executable ESM file.
// @ts-expect-error JavaScript scanner has no runtime dependency on TypeScript.
import { scanArtifactPaths, scanText, videoFrameExtractionArgs } from '../../scripts/audit-e2e-artifacts.mjs';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ADDRESS = 'tb1q053ptqlv0ugz8fcc3njw355rdluk4tqnhf0g0j';
const INSCRIPTION = `${'a'.repeat(64)}i0`;

describe('E2E artifact privacy scanner', () => {
  it('treats already-cleaned artifact roots as an empty successful scan', () => {
    expect(scanArtifactPaths(['/definitely/missing/drey-e2e-artifacts'])).toEqual([]);
  });
  it('detects BIP39 phrases without echoing the phrase', () => {
    const findings = scanText(`before ${MNEMONIC} after`, 'trace.trace');
    expect(findings).toEqual([{ source: 'trace.trace', kind: 'BIP39 recovery phrase' }]);
    expect(JSON.stringify(findings)).not.toContain(MNEMONIC);
  });

  it('detects secret fields and private keys', () => {
    const findings = scanText('{"password":"not-for-an-artifact","privateKey":"tprv8ZgxMBicQKsPdexamplevalue"}');
    expect(findings.map((finding: { kind: string }) => finding.kind)).toContain('sensitive key/value field');
  });

  it('detects the test password even under a generic serialized value field', () => {
    const password = ['public', 'e2e', 'password', 'only'].join('-');
    expect(scanText(JSON.stringify({ value: password })).map((finding: { kind: string }) => finding.kind))
      .toContain('test password');
  });

  it('requires wallet data to be explicitly allowlisted', () => {
    expect(scanText(ADDRESS).map((finding: { kind: string }) => finding.kind))
      .toContain('non-allowlisted wallet data');
    expect(scanText(ADDRESS, 'report.html', { allowlistedWalletData: [ADDRESS] })).toEqual([]);
  });

  it('rejects unexpected inscription IDs and raw preview byte payloads', () => {
    expect(scanText(INSCRIPTION).map((finding: { kind: string }) => finding.kind))
      .toContain('non-allowlisted inscription ID');
    expect(scanText(INSCRIPTION, 'report.html', { allowlistedInscriptionIds: [INSCRIPTION] })).toEqual([]);
    expect(scanText(JSON.stringify({ rasterBase64: 'A'.repeat(64) }))
      .map((finding: { kind: string }) => finding.kind)).toContain('raw inscription preview payload');
    expect(scanText(`data:image/png;base64,${'A'.repeat(64)}`)
      .map((finding: { kind: string }) => finding.kind)).toContain('raw inscription preview payload');
  });

  it('does not mistake ordinary BIP39 words for a recovery phrase', () => {
    expect(scanText('legal winner thank year wave sausage')).toEqual([]);
  });

  it('samples one frame per second past the former 60-frame cutoff', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'drey-scanner-video-'));
    try {
      const video = path.join(directory, 'artifact.avi');
      const generated = spawnSync('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
        'color=c=black:s=16x16:r=1:d=62', '-c:v', 'ffv1', video,
      ]);
      expect(generated.status).toBe(0);
      const frames = path.join(directory, 'frames');
      mkdirSync(frames);
      const extracted = spawnSync(
        'ffmpeg',
        videoFrameExtractionArgs(video, path.join(frames, 'frame-%03d.png')),
      );
      expect(extracted.status).toBe(0);
      expect(readdirSync(frames).filter((entry) => entry.endsWith('.png'))).toHaveLength(62);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('scans ZIP contents, rejects symlinks, and fails closed on unreadable media', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'drey-scanner-test-'));
    try {
      const source = path.join(directory, 'source');
      mkdirSync(source);
      writeFileSync(path.join(source, 'trace.txt'), MNEMONIC);
      const zip = path.join(directory, 'trace.zip');
      const zipped = spawnSync('zip', ['-q', zip, 'trace.txt'], { cwd: source });
      expect(zipped.status).toBe(0);
      expect(scanArtifactPaths([zip]).map((finding: { kind: string }) => finding.kind))
        .toContain('BIP39 recovery phrase');

      const link = path.join(directory, 'profile-link');
      symlinkSync(source, link);
      expect(scanArtifactPaths([link]).map((finding: { kind: string }) => finding.kind))
        .toContain('symbolic link in artifact output');

      const invalidImage = path.join(directory, 'artifact.png');
      writeFileSync(invalidImage, 'not a PNG');
      expect(scanArtifactPaths([invalidImage]).map((finding: { kind: string }) => finding.kind))
        .toContain('image could not be privacy-scanned');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects a retained heap snapshot even when its contents look innocuous', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'drey-scanner-heap-'));
    try {
      for (const name of ['renderer.heapsnapshot', 'worker.heapprofile', 'worker.heaptimeline']) {
        const dump = path.join(directory, name);
        writeFileSync(dump, '{"snapshot":{},"strings":["nothing sensitive here"]}');
        expect(scanArtifactPaths([dump]), name)
          .toEqual([{ source: dump, kind: 'retained heap snapshot' }]);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
