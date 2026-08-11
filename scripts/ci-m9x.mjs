#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const reportPath = fileURLToPath(new URL('../playwright-report', import.meta.url));
const resultsPath = fileURLToPath(new URL('../test-results/e2e', import.meta.url));

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('pnpm', ['ci:m9p']);
// Relocated to @drey/core (ADR 0005); the drift test pins the sibling checkout
// to the exact tag this build resolves.
run('pnpm', ['-C', '../core', 'exec', 'vitest', 'run',
  'tests/transactions/ordinal-transfer.test.ts',
  'tests/transactions/plan-signing.test.ts',
]);
run('pnpm', ['exec', 'vitest', 'run',
  'tests/background/transaction-recovery.test.ts',
  'tests/background/recent-activity.test.ts',
  'tests/background/scan-service.test.ts',
  'tests/ui/transactions.test.tsx',
  'tests/ui/popup-shell.test.tsx',
  'tests/ui/approval.test.tsx',
  'tests/ui/i18n.test.ts',
]);

rmSync(reportPath, { recursive: true, force: true });
rmSync(resultsPath, { recursive: true, force: true });
const browser = spawnSync('pnpm', [
  'exec', 'playwright', 'test', 'tests/e2e/secret-visible.spec.ts',
  '--project=secret-safe', '--grep=@m9x',
], {
  cwd: root,
  env: { ...process.env, DREY_E2E_REPORT_MODE: 'secret-safe' },
  stdio: 'inherit',
});
if (browser.error) throw browser.error;
const audit = spawnSync(process.execPath, ['scripts/audit-e2e-artifacts.mjs'], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
});
if (audit.error) throw audit.error;
if (audit.status !== 0) {
  rmSync(reportPath, { recursive: true, force: true });
  rmSync(resultsPath, { recursive: true, force: true });
  process.stderr.write('Unsafe M9X E2E artifacts were removed and must not be uploaded.\n');
  process.exit(audit.status ?? 1);
}
if (browser.status !== 0) process.exit(browser.status ?? 1);
rmSync(reportPath, { recursive: true, force: true });
rmSync(resultsPath, { recursive: true, force: true });

process.stdout.write('\nM9X native Ordinals transfer and launch-UX gate passed.\n');
