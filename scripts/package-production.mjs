import { execFileSync, spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash, createPublicKey } from 'node:crypto';
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
const gateway = join(workspace, 'gateway');
const outputRoot = resolve(root, process.env.DREY_BUILD_OUTPUT_ROOT?.trim() || '.output/production');
const output = join(outputRoot, 'chrome-mv3');
const metadataPath = join(outputRoot, 'm8t-channel.json');
const epoch = new Date('1980-01-01T00:00:00.000Z');
const ignored = new Set([
  'node_modules', 'prototype', 'playwright-report', 'test-results',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Hidden directories (VCS state, build output, caches) are never source, so
// they stay out of the digest without having to be enumerated by name.
function filesBelow(directory, ignoredNames = new Set()) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !(entry.isDirectory() && entry.name.startsWith('.')) && !ignoredNames.has(entry.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`refusing to package symlink: ${path}`);
      return entry.isDirectory() ? filesBelow(path, ignoredNames) : [path];
    })
    .sort();
}

function treeDigest(directory, ignoredNames = new Set()) {
  const hash = createHash('sha256');
  for (const file of filesBelow(directory, ignoredNames)) {
    hash.update(relative(directory, file).replaceAll('\\', '/')).update('\0');
    hash.update(readFileSync(file)).update('\0');
  }
  return hash.digest('hex');
}

function git(directory, args) {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
}

function requireCleanTaggedRevision(directory, name) {
  if (git(directory, ['status', '--porcelain']) !== '') {
    throw new Error(`${name} worktree must be clean before production packaging`);
  }
  const revision = git(directory, ['rev-parse', 'HEAD']);
  let tag;
  try {
    tag = git(directory, ['describe', '--exact-match', '--tags', revision]);
  } catch {
    throw new Error(`${name} revision ${revision} must have an exact reviewed release tag`);
  }
  return { revision, tag };
}

function extensionId(publicKeyBase64) {
  const der = Buffer.from(publicKeyBase64, 'base64');
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'rsa') throw new Error('production manifest key must be RSA SPKI');
  return [...createHash('sha256').update(der).digest().subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode('a'.charCodeAt(0) + nibble))
    .join('');
}

if (!statSync(output).isDirectory()) {
  throw new Error('production build output is missing; run pnpm build first');
}
const channelConfiguration = JSON.parse(readFileSync(metadataPath, 'utf8'));
if (channelConfiguration.channel !== 'production' ||
    channelConfiguration.network !== 'mainnet' ||
    channelConfiguration.liveGatewayEnabled !== true) {
  throw new Error('refusing to package output that is not the live mainnet production channel');
}
if (channelConfiguration.productionPackagingEnabled !== true) {
  throw new Error('production packaging is blocked until the reviewed identity and release gate land in source');
}
if (!/^[0-9a-f]{64}$/u.test(channelConfiguration.gatewayPublicKeyHex)) {
  throw new Error('production response public key is missing or malformed');
}
if (channelConfiguration.gatewayPublicKeyHex ===
    '0aa651b5015967c85f088bdbf82b210daf3bd1f5fc0ae35bafc523b029e96ca3' ||
    channelConfiguration.gatewayPublicKeyHex ===
    'eac4a676a0440c4da3909190dcd93f5a42d6291279bb8db9f0841891dec0cb7c') {
  throw new Error('production response key must not reuse the fixture or pilot identity');
}
if (typeof channelConfiguration.manifestPublicKey !== 'string' ||
    typeof channelConfiguration.storeItemId !== 'string') {
  throw new Error('production Store manifest identity is missing');
}
const derivedExtensionId = extensionId(channelConfiguration.manifestPublicKey);
if (derivedExtensionId !== channelConfiguration.storeItemId) {
  throw new Error('production Store item ID does not match the manifest public key');
}

const release = {
  workspace: requireCleanTaggedRevision(workspace, 'workspace'),
  extension: requireCleanTaggedRevision(root, 'extension'),
  gateway: requireCleanTaggedRevision(gateway, 'gateway'),
};
const currentSourceBinding = {
  workspaceRevision: release.workspace.revision,
  // Must exclude the same sibling repositories as the build:done hook in
  // wxt.config.ts, or the packaging-time recomputation can never match the
  // digest recorded at build time.
  workspaceContentDigest: treeDigest(
    workspace,
    new Set([...ignored, 'core', 'extension', 'gateway', 'hardware', 'mobile']),
  ),
  extensionRevision: release.extension.revision,
  extensionContentDigest: treeDigest(root, ignored),
  gatewayRevision: release.gateway.revision,
  gatewayContentDigest: treeDigest(gateway, ignored),
  lockfileSha256: sha256(readFileSync(join(root, 'pnpm-lock.yaml'))),
};
const { buildOutputContentDigest, ...builtSourceBinding } =
  channelConfiguration.sourceBinding ?? {};
if (JSON.stringify(currentSourceBinding) !== JSON.stringify(builtSourceBinding)) {
  throw new Error('production output is stale: rebuild from the exact clean tagged revisions');
}
if (treeDigest(output) !== buildOutputContentDigest) {
  throw new Error('production output changed after build; rebuild before packaging');
}

const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const zipPath = join(outputRoot, `${packageJson.name}-${packageJson.version}-chrome.zip`);
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

const manifestBytes = readFileSync(join(output, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
if (manifest.key !== channelConfiguration.manifestPublicKey) {
  throw new Error('built manifest key differs from the reviewed production identity');
}
const provenance = {
  schemaVersion: 1,
  channel: 'production',
  artifact: {
    file: basename(zipPath),
    sha256: sha256(readFileSync(zipPath)),
    contentDigest: treeDigest(output),
    sizeBytes: lstatSync(zipPath).size,
    entryCount: entries.length,
    normalizedTimestamp: '1980-01-01T00:00:00.000Z',
  },
  workspace: {
    ...release.workspace,
    contentDigest: channelConfiguration.sourceBinding.workspaceContentDigest,
  },
  extension: {
    ...release.extension,
    contentDigest: channelConfiguration.sourceBinding.extensionContentDigest,
    buildOutputContentDigest: channelConfiguration.sourceBinding.buildOutputContentDigest,
  },
  gateway: {
    ...release.gateway,
    contentDigest: channelConfiguration.sourceBinding.gatewayContentDigest,
  },
  lockfile: {
    file: 'pnpm-lock.yaml',
    sha256: sha256(readFileSync(join(root, 'pnpm-lock.yaml'))),
  },
  manifest: {
    sha256: sha256(manifestBytes),
    extensionId: derivedExtensionId,
    publicKeySha256: sha256(Buffer.from(channelConfiguration.manifestPublicKey, 'base64')),
    value: manifest,
  },
  channelConfiguration,
};

writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx' });
console.log(`Production package created: ${zipPath}`);
console.log(`Production provenance created: ${provenancePath}`);
