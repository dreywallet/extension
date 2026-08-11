import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outputRoot = resolve(root, process.env.DREY_BUILD_OUTPUT_ROOT?.trim() || '.output');
const packageVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const fixtureZip = join(outputRoot, `drey-preview-fixture-${packageVersion}-chrome.zip`);
const fixtureProvenance = `${fixtureZip}.provenance.json`;
const metadataPath = join(outputRoot, 'm8t-channel.json');
const outputDirectory = join(outputRoot, 'chrome-mv3');

// Public, non-secret fixture identities. DREY_SYNTHETIC_PREVIEW_AUDIT marks the
// output in metadata/provenance and the real zip:preview command refuses it.
const fixtureEnvironment = {
  ...process.env,
  DREY_SYNTHETIC_PREVIEW_AUDIT: '1',
  DREY_PREVIEW_GATEWAY_ORIGIN: 'https://drey-preview-fixture.invalid',
  DREY_PREVIEW_GATEWAY_PUBLIC_KEY_HEX:
    '709f2d86bd89c4536e57acc5a462fa8b7dfa62f35e9a6cd16fbb5fc786bca166',
  DREY_PREVIEW_MANIFEST_PUBLIC_KEY:
    'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsLdftrZkj2AO1uD9sb1DW8uT9s/RteJGhSTkkfDIyBaRPD52Z5gvJSgFq/n73z08XYKosypywU2UiIWyjRkfmzbY06KOdIdBfGCmB4LQpUJPvnVEmyEfigCzRz7hPuyEAcaubr5dPuDi0Im/zm03RZQMV4Z4vMZ0MNuqPs74HUhu1gy8l7vxQbnKrU1yi/TrpG0Wocv5kwMZnMTUbEEEeoQOG8jRzGa32nEuDxvVnp7ryA4s0RSsAl884iEZjUf4t548FWVkP9mOO0083eG93jXgd5j/BZgVhhPjRF/iH5mGzIJVkuDfeGJfTtX480hIjXdVSbgmOy5WoHTSMtevyQIDAQAB',
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: fixtureEnvironment,
    stdio: options.quiet ? 'pipe' : 'inherit',
    encoding: options.quiet ? 'utf8' : undefined,
  });
  if (result.error) throw result.error;
  if (options.expectFailure) {
    if (result.status === 0) throw new Error(`${command} ${args.join(' ')} unexpectedly succeeded`);
    return result;
  }
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed`);
  return result;
}

function digest() {
  return createHash('sha256').update(readFileSync(fixtureZip)).digest('hex');
}

function assertAuditRejectsSymlink(path, target) {
  symlinkSync(target, path);
  try {
    const result = run(process.execPath, [
      'scripts/audit-production.mjs', '--channel', 'preview', '--require-zip', '--fixture',
    ], { expectFailure: true, quiet: true });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    if (!output.includes('refusing to audit symlink')) {
      throw new Error(`production audit failed for the wrong reason:\n${output}`);
    }
  } finally {
    rmSync(path, { force: true });
  }
}

try {
  run('pnpm', ['build:preview']);
  assertAuditRejectsSymlink(join(outputDirectory, 'fixture-audit-symlink'), 'manifest.json');
  assertAuditRejectsSymlink(
    join(outputDirectory, 'chunks', 'fixture-audit-symlink'),
    '../manifest.json',
  );
  run(process.execPath, ['scripts/package-preview.mjs'], { expectFailure: true, quiet: true });
  const metadataText = readFileSync(metadataPath, 'utf8');
  const staleMetadata = JSON.parse(metadataText);
  staleMetadata.sourceBinding.extensionContentDigest = '00'.repeat(32);
  writeFileSync(metadataPath, `${JSON.stringify(staleMetadata, null, 2)}\n`);
  run(process.execPath, ['scripts/package-preview.mjs', '--fixture'], { expectFailure: true, quiet: true });
  writeFileSync(metadataPath, metadataText);
  const tamperPath = `${outputDirectory}/fixture-tamper.txt`;
  writeFileSync(tamperPath, 'synthetic tamper probe\n');
  run(process.execPath, ['scripts/package-preview.mjs', '--fixture'], { expectFailure: true, quiet: true });
  rmSync(tamperPath, { force: true });
  run(process.execPath, ['scripts/package-preview.mjs', '--fixture']);
  const first = digest();
  writeFileSync(tamperPath, 'synthetic tamper probe\n');
  run('zip', ['-q', fixtureZip, 'fixture-tamper.txt'], { quiet: true, cwd: outputDirectory });
  rmSync(tamperPath, { force: true });
  run(process.execPath, [
    'scripts/audit-production.mjs', '--channel', 'preview', '--require-zip', '--fixture',
  ], { expectFailure: true, quiet: true });
  run('pnpm', ['build:preview']);
  run(process.execPath, ['scripts/package-preview.mjs', '--fixture']);
  const second = digest();
  if (first !== second) throw new Error(`preview fixture ZIP is not deterministic: ${first} != ${second}`);
  run(process.execPath, ['scripts/audit-production.mjs', '--channel', 'preview', '--require-zip', '--fixture']);
  process.stdout.write(`Synthetic preview packaging audit passed twice with SHA-256 ${first}.\n`);
} finally {
  rmSync(fixtureZip, { force: true });
  rmSync(fixtureProvenance, { force: true });
  run('pnpm', ['build:test']);
}
