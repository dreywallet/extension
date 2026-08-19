import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const workspace = fileURLToPath(new URL('../..', import.meta.url));
const outputRoot = resolve(root, process.env.DREY_BUILD_OUTPUT_ROOT?.trim() || '.output');
const output = join(outputRoot, 'chrome-mv3');
const metadataPath = join(outputRoot, 'm8t-channel.json');
const epoch = new Date('1980-01-01T00:00:00.000Z');
const fixtureMode = process.argv.includes('--fixture');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Hidden directories (VCS state, build output, caches) are never source, so
// they stay out of the digest without having to be enumerated by name.
function filesBelow(directory, ignored = new Set()) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !(entry.isDirectory() && entry.name.startsWith('.')) && !ignored.has(entry.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`refusing to package symlink: ${path}`);
      return entry.isDirectory() ? filesBelow(path, ignored) : [path];
    })
    .sort();
}

function treeDigest(directory, ignoredNames) {
  const hash = createHash('sha256');
  for (const file of filesBelow(directory, ignoredNames)) {
    const name = relative(directory, file).replaceAll('\\', '/');
    hash.update(name).update('\0').update(readFileSync(file)).update('\0');
  }
  return hash.digest('hex');
}

function gitRevision(directory) {
  return execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

if (!statSync(output).isDirectory()) throw new Error('preview build output is missing; run build:preview first');
const channelConfiguration = JSON.parse(readFileSync(metadataPath, 'utf8'));
if (channelConfiguration.channel !== 'preview' || channelConfiguration.liveGatewayEnabled !== false) {
  throw new Error('refusing to package an output that is not a live-disabled preview build');
}
if (fixtureMode !== (channelConfiguration.syntheticPreviewAudit === true)) {
  throw new Error('synthetic preview build/package mode mismatch');
}
if (!fixtureMode && channelConfiguration.previewPackagingEnabled !== true) {
  throw new Error('preview packaging is blocked until the reviewed G2/G3 and Store gate lands in source');
}
for (const [environmentName, metadataName] of [
  ['DREY_PREVIEW_GATEWAY_ORIGIN', 'gatewayOrigin'],
  ['DREY_PREVIEW_GATEWAY_PUBLIC_KEY_HEX', 'gatewayPublicKeyHex'],
  ['DREY_PREVIEW_MANIFEST_PUBLIC_KEY', 'manifestPublicKey'],
]) {
  if (process.env[environmentName]?.trim() !== channelConfiguration[metadataName]) {
    throw new Error(`${environmentName} must be present and match the audited preview build`);
  }
}

const currentSourceBinding = {
  workspaceRevision: gitRevision(workspace),
  // Must exclude the same sibling repositories as the build:done hook in
  // wxt.config.ts, or the packaging-time recomputation can never match the
  // digest recorded at build time.
  workspaceContentDigest: treeDigest(workspace, new Set([
    'node_modules', 'prototype', 'playwright-report', 'test-results',
    'core', 'extension', 'gateway', 'hardware', 'mobile',
  ])),
  extensionRevision: gitRevision(root),
  extensionContentDigest: treeDigest(root, new Set([
    'node_modules', 'prototype', 'playwright-report', 'test-results',
  ])),
  gatewayRevision: gitRevision(join(workspace, 'gateway')),
  gatewayContentDigest: treeDigest(join(workspace, 'gateway'), new Set([
    'node_modules', 'prototype', 'playwright-report', 'test-results',
  ])),
  lockfileSha256: sha256(readFileSync(join(root, 'pnpm-lock.yaml'))),
};
const { buildOutputContentDigest, ...builtSourceBinding } = channelConfiguration.sourceBinding ?? {};
if (JSON.stringify(currentSourceBinding) !== JSON.stringify(builtSourceBinding)) {
  throw new Error('preview output is stale: rebuild after every extension, gateway, or lockfile change');
}
if (treeDigest(output, new Set()) !== buildOutputContentDigest) {
  throw new Error('preview output changed after build; rebuild before packaging');
}

// WXT copies the complete public directory for every channel. Remove the
// production icon family only after all real/synthetic packaging gates pass,
// so the audited preview ZIP contains beta identity assets exclusively.
rmSync(join(output, 'icon'), { recursive: true, force: true });

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const zipName = `drey-preview${fixtureMode ? '-fixture' : ''}-${packageJson.version}-chrome.zip`;
const zipPath = join(outputRoot, zipName);
const provenancePath = `${zipPath}.provenance.json`;
rmSync(zipPath, { force: true });
rmSync(provenancePath, { force: true });

const files = filesBelow(output);
for (const file of files) utimesSync(file, epoch, epoch);
const entries = files.map((file) => relative(output, file).replaceAll('\\', '/')).sort();
const zip = spawnSync('zip', ['-X', '-q', zipPath, ...entries], {
  cwd: output,
  encoding: 'utf8',
  env: { ...process.env, TZ: 'UTC' },
});
if (zip.status !== 0) throw new Error(`zip failed: ${zip.stderr || zip.stdout}`);

const manifest = JSON.parse(readFileSync(join(output, 'manifest.json'), 'utf8'));
const manifestBytes = readFileSync(join(output, 'manifest.json'));
const provenance = {
  schemaVersion: 2,
  syntheticFixture: fixtureMode,
  artifact: {
    file: basename(zipPath),
    sha256: sha256(readFileSync(zipPath)),
    contentDigest: treeDigest(output, new Set()),
    sizeBytes: lstatSync(zipPath).size,
    entryCount: entries.length,
    normalizedTimestamp: '1980-01-01T00:00:00.000Z',
  },
  workspace: {
    revision: channelConfiguration.sourceBinding.workspaceRevision,
    contentDigest: channelConfiguration.sourceBinding.workspaceContentDigest,
  },
  extension: {
    revision: channelConfiguration.sourceBinding.extensionRevision,
    contentDigest: channelConfiguration.sourceBinding.extensionContentDigest,
    buildOutputContentDigest: channelConfiguration.sourceBinding.buildOutputContentDigest,
  },
  lockfile: {
    file: 'pnpm-lock.yaml',
    sha256: sha256(readFileSync(join(root, 'pnpm-lock.yaml'))),
  },
  manifest: {
    sha256: sha256(manifestBytes),
    value: manifest,
  },
  fixture: {
    revision: channelConfiguration.sourceBinding.gatewayRevision,
    contentDigest: channelConfiguration.sourceBinding.gatewayContentDigest,
  },
  channelConfiguration,
};

writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx' });
console.log(`Preview package created: ${zipPath}`);
console.log(`Preview provenance created: ${provenancePath}`);
