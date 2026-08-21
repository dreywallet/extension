import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const buildRoot = fileURLToPath(new URL('../.output/regtest/chrome-mv3/', import.meta.url));
const manifestPath = fileURLToPath(new URL('../.output/regtest/chrome-mv3/manifest.json', import.meta.url));
const metadataPath = fileURLToPath(new URL('../.output/regtest/m8t-channel.json', import.meta.url));
const reportPath = fileURLToPath(new URL('../playwright-report', import.meta.url));
const resultsPath = fileURLToPath(new URL('../test-results/e2e', import.meta.url));

function assertBuild() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'));
  if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(['http://127.0.0.1:18480/*']) ||
      metadata.channel !== 'development' || metadata.network !== 'regtest' ||
      metadata.gatewayOrigin !== 'http://127.0.0.1:18480' ||
      metadata.vaultCoordinatorEnabled !== false) {
    throw new Error('regtest E2E requires the loopback-only development build with Vault coordination disabled');
  }
}

function run(command, args, environment = process.env) {
  const result = spawnSync(command, args, { cwd: root, env: environment, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

rmSync(reportPath, { recursive: true, force: true });
rmSync(resultsPath, { recursive: true, force: true });
assertBuild();

const status = run('pnpm', [
  'exec', 'playwright', 'test', '--config', 'playwright.regtest.config.ts', ...process.argv.slice(2),
], {
  ...process.env,
  DREY_E2E_EXTENSION_PATH: buildRoot,
  DREY_E2E_REPORT_MODE: 'secret-safe',
  // Playwright 1.61 writes an automatic ARIA snapshot on every failure even
  // when screenshots, video, and traces are off. Wallet pages can contain
  // addresses and inscription IDs, so secret-safe runs disable that attachment.
  PLAYWRIGHT_NO_COPY_PROMPT: '1',
});

// Run the existing privacy gate even though this project disables every
// automatic artifact. A future configuration regression must still fail and
// remove the complete output set.
const audit = run(process.execPath, ['scripts/audit-e2e-artifacts.mjs']);
if (audit !== 0) {
  rmSync(reportPath, { recursive: true, force: true });
  rmSync(resultsPath, { recursive: true, force: true });
  process.stderr.write('Unsafe regtest E2E artifacts were removed and must not be uploaded.\n');
  process.exit(audit);
}

rmSync(reportPath, { recursive: true, force: true });
rmSync(resultsPath, { recursive: true, force: true });
if (status !== 0) process.exit(status);
