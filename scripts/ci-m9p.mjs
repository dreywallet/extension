#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const reportPath = fileURLToPath(new URL('../playwright-report', import.meta.url));
const resultsPath = fileURLToPath(new URL('../test-results/e2e', import.meta.url));

rmSync(reportPath, { recursive: true, force: true });
rmSync(resultsPath, { recursive: true, force: true });

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('pnpm', ['exec', 'vitest', 'run',
  'tests/background/scan-service.test.ts',
  'tests/ui/approval.test.tsx',
  'tests/ui/transactions.test.tsx',
  'tests/e2e/privacy-scanner.test.ts',
]);
// Relocated to @drey/core (ADR 0005); the drift test pins the sibling checkout
// to the exact tag this build resolves.
run('pnpm', ['-C', '../core', 'exec', 'vitest', 'run',
  'tests/gateway/inscription-preview.test.ts',
  'tests/transactions/inscription-effects.test.ts',
]);
run('pnpm', ['typecheck']);
run('pnpm', ['lint']);
run('pnpm', ['build:test']);
run('pnpm', ['audit:test']);

rmSync(reportPath, { recursive: true, force: true });
rmSync(resultsPath, { recursive: true, force: true });
const ordinaryBrowser = spawnSync('pnpm', [
  'exec', 'playwright', 'test', 'tests/e2e/m9p-preview.spec.ts', '--project=extension',
], { cwd: root, env: { ...process.env, DREY_E2E_REPORT_MODE: 'html' }, stdio: 'inherit' });
if (ordinaryBrowser.error) throw ordinaryBrowser.error;
const secretSafeBrowser = spawnSync('pnpm', [
  'exec', 'playwright', 'test', 'tests/e2e/secret-visible.spec.ts', '--project=secret-safe', '--grep=@m9p',
], { cwd: root, env: { ...process.env, DREY_E2E_REPORT_MODE: 'secret-safe' }, stdio: 'inherit' });
if (secretSafeBrowser.error) throw secretSafeBrowser.error;
const audit = spawnSync(process.execPath, ['scripts/audit-e2e-artifacts.mjs'], {
  cwd: root, env: process.env, stdio: 'inherit',
});
if (audit.error) throw audit.error;
if (audit.status !== 0) {
  rmSync(reportPath, { recursive: true, force: true });
  rmSync(resultsPath, { recursive: true, force: true });
  process.stderr.write('Unsafe M9P E2E artifacts were removed and must not be uploaded.\n');
  process.exit(audit.status ?? 1);
}
if (ordinaryBrowser.status !== 0 || secretSafeBrowser.status !== 0) {
  process.exit(ordinaryBrowser.status || secretSafeBrowser.status || 1);
}
rmSync(reportPath, { recursive: true, force: true });
rmSync(resultsPath, { recursive: true, force: true });
