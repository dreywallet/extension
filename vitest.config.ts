import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const extensionVersion = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

export default defineConfig({
  // TSX in UI tests is transformed by esbuild's automatic JSX runtime — no
  // react plugin needed (it also drags in incompatible vite-8 types).
  esbuild: { jsx: 'automatic' },
  define: {
    __EXTENSION_VERSION__: JSON.stringify(extensionVersion.version),
    // Unit/UI tests exercise the passkey-capable path; channel gating itself
    // is covered by tests/build/channel.test.ts against resolveBuildChannel.
    __PASSKEY_ENROLLMENT_ENABLED__: JSON.stringify(true),
    // Same rationale for the Workstream C Vault coordinator: unit/UI tests
    // exercise the enabled (signet, test-only) path, while the channel gate
    // itself is proven in tests/build/channel.test.ts.
    __VAULT_COORDINATOR_ENABLED__: JSON.stringify(true),
  },
  resolve: {
    alias: {
      // libsodium-wrappers-sumo 0.7.x ships a broken ESM entry: its .mjs
      // imports ./libsodium-sumo.mjs, which actually lives in the separate
      // libsodium-sumo package. Point module resolution at the intact CJS
      // build. The same alias will be needed in wxt.config.ts when the vault
      // is first imported from an extension entrypoint.
      'libsodium-wrappers-sumo': fileURLToPath(
        new URL('./node_modules/libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js', import.meta.url),
      ),
    },
  },
  test: {
    // Keep CPU-heavy signing cases from starving Vitest's worker-reporting
    // channel on shared release runners.
    maxWorkers: 4,
    // @drey/core ships raw TypeScript source; vitest externalizes node_modules
    // by default and Node cannot execute the .ts files, so inline the package.
    server: { deps: { inline: [/@drey\/core/] } },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/**/*.test.{ts,tsx}'],
          exclude: ['tests/ui/**', 'prototype/**', 'node_modules/**'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'ui',
          include: ['tests/ui/**/*.test.{ts,tsx}'],
          exclude: ['prototype/**', 'node_modules/**'],
          environment: 'jsdom',
        },
      },
    ],
  },
});
