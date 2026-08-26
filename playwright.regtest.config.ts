import { defineConfig } from '@playwright/test';

const dappPort = process.env.DREY_E2E_DAPP_PORT ?? '4173';
if (!/^[1-9][0-9]{0,4}$/u.test(dappPort) || Number(dappPort) > 65_535) {
  throw new Error('DREY_E2E_DAPP_PORT must be a valid TCP port');
}

/**
 * Real local-chain acceptance stays separate from the deterministic signet
 * fixture suite. The provider page is a static fixture bound to loopback; the
 * gateway and chain remain owned by the separate regtest stack. The suite has
 * one worker and retains no reporter or browser media because wallet creation
 * necessarily handles a fresh disposable recovery phrase.
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
  webServer: {
    command: 'node tests/e2e/dapp/server.mjs',
    url: `http://127.0.0.1:${dappPort}/health`,
    reuseExistingServer: false,
    timeout: 10_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
