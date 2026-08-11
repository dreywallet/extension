#!/usr/bin/env node
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMnemonic } from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english';

const SUPPORTED_WORD_COUNTS = [24, 21, 18, 15, 12];
const WORDS = new Set(english);
const TEXT_EXTENSIONS = new Set([
  '', '.css', '.csv', '.html', '.js', '.json', '.log', '.md', '.network', '.svg', '.text', '.trace', '.ts', '.txt', '.xml', '.yaml', '.yml',
]);
const IMAGE_EXTENSIONS = new Set(['.jpeg', '.jpg', '.png']);
const VIDEO_EXTENSIONS = new Set(['.avi', '.gif', '.mp4', '.webm', '.webp']);
const HEAP_DUMP_EXTENSIONS = new Set(['.heapprofile', '.heapsnapshot', '.heaptimeline']);
const SENSITIVE_FIELD = /["']?(?:app_?password|password|mnemonic|seed(?:_?phrase)?|private_?key|secret_?key|entropy|dek|data_?encryption_?key)["']?\s*[:=]\s*["']([^"'\r\n]{1,4096})["']/giu;
const PRIVATE_KEY = /\b(?:xprv|tprv)[1-9A-HJ-NP-Za-km-z]{20,}\b|\b[KLc9][1-9A-HJ-NP-Za-km-z]{50,51}\b/gu;
const WALLET_DATA = /\b(?:(?:bc1|tb1|bcrt1)[ac-hj-np-z02-9]{8,87}|(?:xpub|tpub)[1-9A-HJ-NP-Za-km-z]{20,})\b/giu;
const INSCRIPTION_ID = /(?<![0-9a-f])[0-9a-f]{64}i(?:0|[1-9][0-9]*)(?![0-9])/giu;
const PREVIEW_PAYLOAD = /(?:["'](?:rasterBase64|bytesBase64|contentBase64|rawContent)["']\s*:\s*["'][A-Za-z0-9+/=]{32,}["']|data:(?:image|audio|video|text\/html|application\/xml|image\/svg\+xml)[^,;]*;base64,[A-Za-z0-9+/=]{32,})/giu;
const PROHIBITED_TEST_PASSWORD = ['public', 'e2e', 'password', 'only'].join('-');

function addFinding(findings, source, kind) {
  if (!findings.some((entry) => entry.source === source && entry.kind === kind)) {
    findings.push({ source, kind });
  }
}

export function scanText(text, source = '<memory>', options = {}) {
  const findings = [];
  const allowlistedWalletData = new Set(options.allowlistedWalletData ?? []);
  const allowlistedInscriptionIds = new Set(options.allowlistedInscriptionIds ?? []);
  SENSITIVE_FIELD.lastIndex = 0;
  if (SENSITIVE_FIELD.test(text)) addFinding(findings, source, 'sensitive key/value field');
  PRIVATE_KEY.lastIndex = 0;
  if (PRIVATE_KEY.test(text)) addFinding(findings, source, 'extended/WIF private key');
  if (text.includes(PROHIBITED_TEST_PASSWORD)) addFinding(findings, source, 'test password');
  if (options.scanPreviewPayload !== false) {
    PREVIEW_PAYLOAD.lastIndex = 0;
    if (PREVIEW_PAYLOAD.test(text)) addFinding(findings, source, 'raw inscription preview payload');
  }

  WALLET_DATA.lastIndex = 0;
  for (const match of text.matchAll(WALLET_DATA)) {
    if (!allowlistedWalletData.has(match[0])) {
      addFinding(findings, source, 'non-allowlisted wallet data');
      break;
    }
  }

  INSCRIPTION_ID.lastIndex = 0;
  for (const match of text.matchAll(INSCRIPTION_ID)) {
    if (!allowlistedInscriptionIds.has(match[0])) {
      addFinding(findings, source, 'non-allowlisted inscription ID');
      break;
    }
  }

  if (options.scanMnemonic !== false) {
    const tokens = text.toLowerCase().match(/[a-z]+/gu) ?? [];
    for (let start = 0; start < tokens.length; start += 1) {
      for (const count of SUPPORTED_WORD_COUNTS) {
        const candidateWords = tokens.slice(start, start + count);
        if (candidateWords.length !== count || candidateWords.some((word) => !WORDS.has(word))) continue;
        if (validateMnemonic(candidateWords.join(' '), english)) {
          addFinding(findings, source, 'BIP39 recovery phrase');
          return findings;
        }
      }
    }
  }
  return findings;
}

function looksTextual(buffer, filename) {
  const extension = path.extname(filename).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension) || VIDEO_EXTENSIONS.has(extension)) return false;
  if (TEXT_EXTENSIONS.has(extension)) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  let zeroes = 0;
  for (const byte of sample) if (byte === 0) zeroes += 1;
  return sample.length === 0 || zeroes / sample.length < 0.01;
}

function scanImage(filename, displayName, options) {
  const result = spawnSync('tesseract', [filename, 'stdout'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return [{ source: displayName, kind: 'image could not be privacy-scanned' }];
  }
  return scanText(result.stdout, `${displayName}#ocr`, options);
}

export function videoFrameExtractionArgs(filename, outputPattern) {
  return [
    '-hide_banner', '-loglevel', 'error', '-i', filename, '-vf', 'fps=1',
    outputPattern,
  ];
}

function scanMedia(filename, displayName, options) {
  const extension = path.extname(filename).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return scanImage(filename, displayName, options);
  if (!VIDEO_EXTENSIONS.has(extension)) return [];
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'drey-artifact-video-'));
  try {
    const result = spawnSync(
      'ffmpeg',
      videoFrameExtractionArgs(filename, path.join(temporaryDirectory, 'frame-%03d.png')),
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    if (result.error || result.status !== 0) {
      return [{ source: displayName, kind: 'video could not be privacy-scanned' }];
    }
    return readdirSync(temporaryDirectory)
      .filter((entry) => entry.endsWith('.png'))
      .sort()
      .flatMap((entry) => scanImage(
        path.join(temporaryDirectory, entry),
        `${displayName}#${entry}`,
        options,
      ));
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function zipEntries(filename) {
  const result = spawnSync('unzip', ['-Z1', filename], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new Error(`Cannot inspect ZIP ${filename}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Cannot list ZIP ${filename}: unzip exited ${result.status}`);
  return result.stdout.split(/\r?\n/u).filter(Boolean);
}

function zipEntry(filename, entry) {
  const result = spawnSync('unzip', ['-p', filename, entry], { encoding: null, maxBuffer: 128 * 1024 * 1024 });
  if (result.error) throw new Error(`Cannot inspect ${filename}!/${entry}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Cannot read ${filename}!/${entry}: unzip exited ${result.status}`);
  return result.stdout;
}

function scanZip(filename, displayName, options, depth = 0) {
  if (depth > 3) throw new Error(`Nested ZIP depth exceeded at ${displayName}`);
  const findings = [];
  const scratch = [];
  try {
    for (const entry of zipEntries(filename)) {
      if (entry.endsWith('/')) continue;
      const buffer = zipEntry(filename, entry);
      const source = `${displayName}!/${entry}`;
      if (path.extname(entry).toLowerCase() === '.zip') {
        const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'drey-artifact-zip-'));
        scratch.push(temporaryDirectory);
        const nested = path.join(temporaryDirectory, 'nested.zip');
        writeFileSync(nested, buffer);
        findings.push(...scanZip(nested, source, options, depth + 1));
      } else if (IMAGE_EXTENSIONS.has(path.extname(entry).toLowerCase()) ||
          VIDEO_EXTENSIONS.has(path.extname(entry).toLowerCase())) {
        const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'drey-artifact-media-'));
        scratch.push(temporaryDirectory);
        const mediaPath = path.join(temporaryDirectory, `artifact${path.extname(entry).toLowerCase()}`);
        writeFileSync(mediaPath, buffer);
        findings.push(...scanMedia(mediaPath, source, options));
      } else if (looksTextual(buffer, entry)) {
        findings.push(...scanText(buffer.toString('utf8'), source, options));
      }
    }
  } finally {
    for (const directory of scratch) rmSync(directory, { recursive: true, force: true });
  }
  return findings;
}

function scanPlaywrightReport(filename, options) {
  const html = readFileSync(filename, 'utf8');
  const payloads = [...html.matchAll(/data:application\/zip;base64,([A-Za-z0-9+/=]+)/gu)];
  const findings = scanText(
    html.replace(/data:application\/zip;base64,[A-Za-z0-9+/=]+/gu, 'data:application/zip;base64,[scanned]'),
    `${filename}#report-shell`,
    { ...options, scanMnemonic: false, scanPreviewPayload: false },
  );
  if (payloads.length !== 1) {
    addFinding(findings, filename, 'unexpected Playwright report payload count');
    return findings;
  }
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'drey-playwright-report-'));
  try {
    const reportZip = path.join(temporaryDirectory, 'report.zip');
    writeFileSync(reportZip, Buffer.from(payloads[0][1], 'base64'));
    findings.push(...scanZip(reportZip, `${filename}#embedded-report`, options));
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  return findings;
}

function walk(target, findings, options) {
  const metadata = lstatSync(target);
  if (metadata.isSymbolicLink()) {
    addFinding(findings, target, 'symbolic link in artifact output');
    return;
  }
  if (metadata.isDirectory()) {
    if (path.basename(target).startsWith('drey-e2e-profile-')) {
      addFinding(findings, target, 'retained browser profile');
      return;
    }
    for (const entry of readdirSync(target).sort()) walk(path.join(target, entry), findings, options);
    return;
  }
  if (!metadata.isFile()) return;
  // A heap snapshot is a verbatim dump of renderer or worker memory. The heap
  // suite streams and discards them, so one on disk means some other path
  // retained raw wallet memory; fail regardless of what a scan would find.
  if (HEAP_DUMP_EXTENSIONS.has(path.extname(target).toLowerCase())) {
    addFinding(findings, target, 'retained heap snapshot');
    return;
  }
  if (path.basename(target) === 'index.html' && path.basename(path.dirname(target)) === 'playwright-report') {
    findings.push(...scanPlaywrightReport(target, options));
    return;
  }
  if (path.extname(target).toLowerCase() === '.zip') {
    findings.push(...scanZip(target, target, options));
    return;
  }
  if (IMAGE_EXTENSIONS.has(path.extname(target).toLowerCase()) ||
      VIDEO_EXTENSIONS.has(path.extname(target).toLowerCase())) {
    findings.push(...scanMedia(target, target, options));
    return;
  }
  const buffer = readFileSync(target);
  if (looksTextual(buffer, target)) {
    const normalized = target.replaceAll('\\', '/');
    const playwrightViewerAsset = normalized.includes('/playwright-report/trace/assets/');
    findings.push(...scanText(buffer.toString('utf8'), target, {
      ...options,
      ...(playwrightViewerAsset ? { scanMnemonic: false, scanPreviewPayload: false } : {}),
    }));
  }
}

export function scanArtifactPaths(targets, options = {}) {
  const findings = [];
  for (const target of targets) {
    const resolved = path.resolve(target);
    if (existsSync(resolved)) walk(resolved, findings, options);
  }
  return findings;
}

function parseArguments(argv) {
  const targets = [];
  let allowlistPath = path.resolve(import.meta.dirname, '../tests/e2e/privacy-allowlist.json');
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--allowlist') {
      const next = argv[index + 1];
      if (!next) throw new Error('--allowlist requires a file path');
      allowlistPath = path.resolve(next);
      index += 1;
    } else {
      targets.push(value);
    }
  }
  return {
    allowlistPath,
    targets: targets.length > 0 ? targets : ['test-results/e2e', 'playwright-report'],
  };
}

function main() {
  const { allowlistPath, targets } = parseArguments(process.argv.slice(2));
  const parsed = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  if (!Array.isArray(parsed.walletData) || parsed.walletData.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${allowlistPath} must contain a walletData string array`);
  }
  if (!Array.isArray(parsed.inscriptionIds) || parsed.inscriptionIds.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${allowlistPath} must contain an inscriptionIds string array`);
  }
  const findings = scanArtifactPaths(targets, {
    allowlistedWalletData: parsed.walletData,
    allowlistedInscriptionIds: parsed.inscriptionIds,
  });
  if (findings.length > 0) {
    process.stderr.write('E2E artifact privacy audit failed:\n');
    for (const finding of findings) process.stderr.write(`- ${finding.kind}: ${finding.source}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`E2E artifact privacy audit passed (${targets.length} roots scanned).\n`);
}

const isDirectInvocation = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectInvocation) main();
