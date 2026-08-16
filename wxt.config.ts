import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'wxt';
import { resolveBuildChannel } from './src/build/channel';

const extensionRoot = fileURLToPath(new URL('.', import.meta.url));
const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const extensionVersion = JSON.parse(
  readFileSync(join(extensionRoot, 'package.json'), 'utf8'),
) as { version: string };
const ignoredDigestNames = new Set([
  'node_modules', 'prototype', 'playwright-report', 'test-results',
]);

// Hidden directories (VCS state, build output, caches) are never source, so
// they stay out of the digest without having to be enumerated by name.
function filesBelow(directory: string, ignored = ignoredDigestNames): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => !(entry.isDirectory() && entry.name.startsWith('.')) && !ignored.has(entry.name))
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(path, ignored) : [path];
    })
    .sort();
}

function treeDigest(directory: string, ignored = ignoredDigestNames): string {
  const hash = createHash('sha256');
  for (const file of filesBelow(directory, ignored)) {
    hash.update(relative(directory, file).replaceAll('\\', '/')).update('\0');
    hash.update(readFileSync(file)).update('\0');
  }
  return hash.digest('hex');
}

function revision(directory: string): string {
  return execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function optionalRevision(directory: string): string | null {
  try {
    return execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export default defineConfig({
  srcDir: 'src',
  // Every packaged channel has a dedicated output root supplied by its package
  // script. DREY_BUILD_OUTPUT_ROOT remains overridable for disposable CI builds.
  outDir: process.env['DREY_BUILD_OUTPUT_ROOT']?.trim() || '.output',
  // The persistent Chromium E2E harness loads this exact folder name under its
  // selected output root. Builds are serialized and clean it before use, so
  // channel suffixes add ambiguity without isolation.
  outDirTemplate: '{{browser}}-mv{{manifestVersion}}',
  modules: ['@wxt-dev/module-react'],
  manifest: ({ mode }) => {
    const channel = resolveBuildChannel(mode);
    return {
      name: channel.name,
      description: channel.description,
      // Square mark cropped from the interim logo (ADR 0002); sources live in
      // the workspace design/ directory. Files under <root>/public/.
      icons: channel.icons,
      ...(channel.manifestPublicKey ? { key: channel.manifestPublicKey } : {}),
      minimum_chrome_version: '116',
      // 'alarms' drives proactive unlock-session expiry (spec §7.4).
      permissions: ['storage', 'alarms', 'idle', 'sidePanel'],
      // Exactly the one gateway origin per channel (spec §25.3 minimum
      // permissions; §19.1 no silent fallback). Custom-gateway hosts arrive as
      // optional permissions at pairing time (§19.5), not here.
      host_permissions: [`${channel.gatewayOrigin}/*`],
      // Packaged libsodium WASM is instantiated in the worker; MV3 requires
      // 'wasm-unsafe-eval' to allow WebAssembly compilation (spec §5.1).
      content_security_policy: {
        extension_pages: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' ${channel.gatewayOrigin}; object-src 'none'; base-uri 'none';`,
        // Chrome ignores CSP navigate-to and reports an extension error for it.
        // Navigation remains blocked by the recognized sandbox directive, which
        // deliberately grants only scripts (no top-navigation capability).
        sandbox: "default-src 'none'; script-src 'self'; style-src 'self'; img-src data: blob:; connect-src 'none'; media-src blob:; object-src 'none'; frame-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts;",
      },
      sandbox: { pages: ['inscription-preview.html', 'inscription-media.html'] },
    };
  },
  vite: ({ mode }) => {
    const channel = resolveBuildChannel(mode);
    // WXT maps custom modes to NODE_ENV verbatim. Test and preview are still
    // packaged builds, so force Vite/React's production transform: no JSXDEV,
    // absolute source paths, refresh runtime, or development dependency graph.
    process.env.NODE_ENV = mode === 'development' ? 'development' : 'production';
    return {
      define: {
        __BUILD_CHANNEL__: JSON.stringify(channel.channel),
        __EXTENSION_VERSION__: JSON.stringify(extensionVersion.version),
        __LIVE_GATEWAY_ENABLED__: JSON.stringify(channel.liveGatewayEnabled),
        __GATEWAY_URL__: JSON.stringify(channel.gatewayOrigin),
        __GATEWAY_PUBKEY_HEX__: JSON.stringify(channel.gatewayPublicKeyHex),
        __GATEWAY_NETWORK__: JSON.stringify(channel.network),
        __GATEWAY_PROTOCOL_VERSIONS__: JSON.stringify(channel.gatewayProtocolVersions),
        __PASSKEY_ENROLLMENT_ENABLED__: JSON.stringify(channel.passkeyEnrollmentEnabled),
        __VAULT_COORDINATOR_ENABLED__: JSON.stringify(channel.vaultCoordinatorEnabled),
        __VAULT_COORDINATOR_MOVEMENT__: JSON.stringify(
          channel.vaultCoordinatorMovement ?? 'none',
        ),
      },
      resolve: {
        alias: {
          // libsodium-wrappers-sumo 0.7.x ships a broken ESM entry (its .mjs
          // imports ./libsodium-sumo.mjs, which lives in a separate package).
          // Point resolution at the intact CJS build — same fix as
          // vitest.config.ts, now needed for the worker bundle too.
          'libsodium-wrappers-sumo': fileURLToPath(
            new URL(
              './node_modules/libsodium-wrappers-sumo/dist/modules-sumo/libsodium-wrappers.js',
              import.meta.url,
            ),
          ),
        },
      },
    };
  },
  hooks: {
    'build:done': async (wxt) => {
      const channel = resolveBuildChannel(wxt.config.mode);
      const workspaceRevision = optionalRevision(workspaceRoot);
      const gatewayRoot = join(workspaceRoot, 'gateway');
      const gatewayRevision = optionalRevision(gatewayRoot);
      if (channel.channel === 'preview') {
        await cp(
          fileURLToPath(new URL('./src/build/icon-beta', import.meta.url)),
          `${wxt.config.outDir}/icon-beta`,
          { recursive: true },
        );
      }
      const metadataPath = join(wxt.config.outDir, '..', 'm8t-channel.json');
      await mkdir(join(wxt.config.outDir, '..'), { recursive: true });
      await writeFile(metadataPath, `${JSON.stringify({
        schemaVersion: 2,
        ...channel,
        sourceBinding: {
          // Public mirror clones intentionally lack the private coordination
          // repository and gateway sibling. An inspectable build records that
          // absence explicitly; production packaging still requires exact,
          // non-null revisions and content digests from the private workspace.
          workspaceRevision,
          workspaceContentDigest: workspaceRevision === null
            ? null
            : treeDigest(
                workspaceRoot,
                // The sibling repositories bound by their own revision/digest pairs
                // (extension, gateway) are excluded, as is the mobile repository:
                // it never contributes to extension artifacts, and its untracked
                // CocoaPods install contains framework directory symlinks that are
                // machine-specific and unreadable by the digest walk.
                new Set([...ignoredDigestNames, 'extension', 'gateway', 'mobile']),
              ),
          extensionRevision: revision(extensionRoot),
          extensionContentDigest: treeDigest(extensionRoot),
          gatewayRevision,
          gatewayContentDigest: gatewayRevision === null ? null : treeDigest(gatewayRoot),
          lockfileSha256: createHash('sha256')
            .update(readFileSync(join(extensionRoot, 'pnpm-lock.yaml')))
            .digest('hex'),
          buildOutputContentDigest: treeDigest(wxt.config.outDir),
        },
      }, null, 2)}\n`);
    },
  },
});
