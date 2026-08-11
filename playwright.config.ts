import { defineConfig } from '@playwright/test';
import path from 'node:path';

const extensionRoot = path.resolve(import.meta.dirname);
const secretSafeReport = process.env['DREY_E2E_REPORT_MODE'] === 'secret-safe';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  outputDir: './test-results/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  forbidOnly: Boolean(process.env['CI']),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: secretSafeReport
    ? [['list']]
    : [
        ['list'],
        ['html', { outputFolder: 'playwright-report', open: 'never' }],
      ],
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: 'extension',
      testIgnore: ['**/secret-visible.spec.ts', '**/heap-secrets.spec.ts'],
      outputDir: './test-results/e2e/extension',
    },
    {
      // Onboarding necessarily handles a disposable recovery phrase and app
      // password, and the heap scan holds both in the runner process to search
      // for them. Automatic artifacts are disabled for the whole project.
      name: 'secret-safe',
      testMatch: ['**/secret-visible.spec.ts', '**/heap-secrets.spec.ts'],
      retries: 0,
      outputDir: './test-results/e2e/secret-safe',
      use: { screenshot: 'off', trace: 'off', video: 'off' },
    },
  ],
  webServer: [
    {
      command: 'pnpm dev:e2e',
      cwd: path.resolve(extensionRoot, '../gateway'),
      url: 'http://127.0.0.1:18080/__e2e/health',
      reuseExistingServer: true,
      timeout: 15_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'node tests/e2e/dapp/server.mjs',
      cwd: extensionRoot,
      url: 'http://127.0.0.1:4173/health',
      reuseExistingServer: false,
      timeout: 10_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
