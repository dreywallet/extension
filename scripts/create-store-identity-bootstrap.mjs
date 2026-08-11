import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outputRoot = join(root, '.output', 'store-identity-bootstrap');
const stagingRoot = join(outputRoot, 'staging');
const zipPath = join(outputRoot, 'drey-store-identity-bootstrap-0.0.0.1.zip');
const comparisonZipPath = join(outputRoot, 'drey-store-identity-bootstrap-0.0.0.1.comparison.zip');
const provenancePath = `${zipPath}.provenance.json`;
const epoch = new Date('1980-01-01T00:00:00.000Z');
const allowDirty = process.argv.includes('--allow-dirty');
const iconSizes = ['16', '32', '48', '128'];
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function git(args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function createZip(target, entries) {
  rmSync(target, { force: true });
  const zip = spawnSync('zip', ['-X', '-q', target, ...entries], {
    cwd: stagingRoot,
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC' },
  });
  if (zip.status !== 0) throw new Error(`zip failed: ${zip.stderr || zip.stdout}`);
}

const worktreeStatus = git(['status', '--porcelain']);
if (worktreeStatus !== '' && !allowDirty) {
  throw new Error(
    'extension worktree must be clean; commit reviewed bootstrap source before creating the upload artifact',
  );
}

rmSync(stagingRoot, { recursive: true, force: true });
rmSync(provenancePath, { force: true });
mkdirSync(join(stagingRoot, 'icon'), { recursive: true });

const manifest = {
  manifest_version: 3,
  name: 'Drey Store Identity Bootstrap - DO NOT PUBLISH',
  version: '0.0.0.1',
  description: 'Inert draft used only to reserve the Drey production Store identity. Do not publish.',
  icons: Object.fromEntries(iconSizes.map((size) => [size, `icon/${size}.png`])),
};
const manifestPath = join(stagingRoot, 'manifest.json');
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });

for (const size of iconSizes) {
  copyFileSync(join(root, 'public', 'icon', `${size}.png`), join(stagingRoot, 'icon', `${size}.png`));
}

const files = [
  manifestPath,
  ...iconSizes.map((size) => join(stagingRoot, 'icon', `${size}.png`)),
].sort();
for (const file of files) utimesSync(file, epoch, epoch);
const entries = files.map((file) => relative(stagingRoot, file).replaceAll('\\', '/')).sort();

try {
  createZip(zipPath, entries);
  createZip(comparisonZipPath, entries);
  assert(
    sha256(readFileSync(zipPath)) === sha256(readFileSync(comparisonZipPath)),
    'identity-bootstrap ZIP is not deterministic across two builds',
  );

  const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n');
  assert(JSON.stringify(listing) === JSON.stringify(entries), 'identity-bootstrap ZIP entries differ');
  assert(listing.every((name) => !name.endsWith('/')), 'identity-bootstrap ZIP contains directories');
  assert(
    JSON.stringify(listing) === JSON.stringify([...listing].sort()),
    'identity-bootstrap ZIP entries are not sorted',
  );
  for (const name of listing) {
    const archived = execFileSync('unzip', ['-p', zipPath, name]);
    assert(
      archived.equals(readFileSync(join(stagingRoot, name))),
      `identity-bootstrap ZIP bytes differ for ${name}`,
    );
  }

  const verboseListing = execFileSync('unzip', ['-Z', '-v', zipPath], { encoding: 'utf8' });
  const normalizedTimes =
    verboseListing.match(/file last modified on \(DOS date\/time\):\s+1980 Jan 1 00:00:00/gu) ?? [];
  assert(
    normalizedTimes.length === listing.length,
    'identity-bootstrap ZIP timestamps are not normalized',
  );

  const archivedManifestBytes = execFileSync('unzip', ['-p', zipPath, 'manifest.json']);
  const archivedManifest = JSON.parse(archivedManifestBytes.toString('utf8'));
  assert(
    JSON.stringify(archivedManifest) === JSON.stringify(manifest),
    'identity-bootstrap manifest changed during packaging',
  );
  assert(
    JSON.stringify(Object.keys(archivedManifest).sort()) ===
      JSON.stringify(['description', 'icons', 'manifest_version', 'name', 'version']),
    'identity-bootstrap manifest contains an unexpected capability',
  );
  assert(
    !listing.some((name) => /\.(?:js|mjs|cjs|html|wasm|map)$/u.test(name)),
    'identity-bootstrap ZIP contains executable or web content',
  );
  assert(
    !JSON.stringify(archivedManifest).includes('://'),
    'identity-bootstrap manifest contains a network origin',
  );

  const iconEvidence = Object.fromEntries(iconSizes.map((size) => {
    const path = join(stagingRoot, 'icon', `${size}.png`);
    return [size, {
      file: `icon/${size}.png`,
      sha256: sha256(readFileSync(path)),
    }];
  }));
  const provenance = {
    schemaVersion: 1,
    purpose: 'chrome_web_store_identity_bootstrap',
    publicationAllowed: false,
    warning: 'UNPUBLISHED IDENTITY BOOTSTRAP ONLY - NOT A PRODUCTION RELEASE',
    artifact: {
      file: basename(zipPath),
      sha256: sha256(readFileSync(zipPath)),
      sizeBytes: lstatSync(zipPath).size,
      entries,
      normalizedTimestamp: '1980-01-01T00:00:00.000Z',
      deterministicBuildsCompared: 2,
    },
    manifest: {
      sha256: sha256(archivedManifestBytes),
      value: manifest,
    },
    source: {
      extensionRevision: git(['rev-parse', 'HEAD']),
      extensionWorktreeDirty: worktreeStatus !== '',
      script: 'scripts/create-store-identity-bootstrap.mjs',
      scriptSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
      icons: iconEvidence,
    },
  };
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx' });

  console.log(`Store identity bootstrap created: ${zipPath}`);
  console.log(`Store identity bootstrap SHA-256: ${provenance.artifact.sha256}`);
  console.log(`Store identity bootstrap provenance: ${provenancePath}`);
  console.log('Audit passed: inert MV3 manifest, five sorted files, no executable content or network origin.');
} finally {
  rmSync(comparisonZipPath, { force: true });
  rmSync(stagingRoot, { recursive: true, force: true });
}
