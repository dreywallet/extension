import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const forwarded = process.argv.slice(2);
const reportPath = fileURLToPath(new URL('../playwright-report', import.meta.url));
const resultsPath = fileURLToPath(new URL('../test-results/e2e', import.meta.url));

rmSync(reportPath, { recursive: true, force: true });
rmSync(resultsPath, { recursive: true, force: true });

function run(args, environment = process.env) {
  const result = spawnSync('pnpm', ['exec', 'playwright', 'test', ...args], {
    cwd: root,
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// Non-secret tests retain failure-only screenshots/video/traces and produce the
// HTML report. Secret-visible onboarding runs separately with list output only,
// so Playwright cannot embed its DOM/error context in that report.
const normalStatus = run(['--project', 'extension', ...forwarded], {
  ...process.env,
  DREY_E2E_REPORT_MODE: 'html',
});
const secretStatus = run(['--project', 'secret-safe', ...forwarded], {
  ...process.env,
  DREY_E2E_REPORT_MODE: 'secret-safe',
});

// This gate runs even when either browser invocation fails. If privacy cannot
// be proven, delete all retained browser artifacts before returning failure.
const audit = spawnSync(process.execPath, ['scripts/audit-e2e-artifacts.mjs'], {
  cwd: root,
  stdio: 'inherit',
});
if (audit.error) throw audit.error;
if (audit.status !== 0) {
  rmSync(reportPath, { recursive: true, force: true });
  rmSync(resultsPath, { recursive: true, force: true });
  process.stderr.write('Unsafe E2E artifacts were removed and must not be uploaded.\n');
  process.exit(audit.status ?? 1);
}
if (normalStatus !== 0 || secretStatus !== 0) process.exit(normalStatus || secretStatus);
rmSync(reportPath, { recursive: true, force: true });
rmSync(resultsPath, { recursive: true, force: true });
