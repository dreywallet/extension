import { defineConfig } from '@playwright/test';

/**
 * Real local-chain acceptance stays separate from the deterministic signet
 * fixture suite. It starts no web server, has one worker, and retains no
 * reporter or browser media because wallet creation necessarily handles a
 * fresh disposable recovery phrase.
 */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /regtest-.*\.spec\.ts/u,
  outputDir: './test-results/e2e/regtest-secret-safe',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    headless: true,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
  },
  projects: [{
    name: 'regtest-secret-safe',
    use: { screenshot: 'off', trace: 'off', video: 'off' },
  }],
});
