import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  PRODUCTION_MANIFEST_PUBLIC_KEY,
  PRODUCTION_GATEWAY_PUBLIC_KEY_HEX,
  PRODUCTION_PACKAGING_ENABLED,
  PRODUCTION_STORE_ITEM_ID,
  PUBLIC_FIXTURE_GATEWAY_KEY_HEX,
  PILOT_GATEWAY_PUBLIC_KEY_HEX,
  TEST_LOOPBACK_GATEWAY_ORIGIN,
  TEST_MANIFEST_PUBLIC_KEY,
  resolveBuildChannel,
} from '../../src/build/channel';
import { resolveVaultCoordinatorCapability } from '../../src/background/vault-capability';

const previewEnvironment = {
  DREY_SYNTHETIC_PREVIEW_AUDIT: '1',
  DREY_PREVIEW_GATEWAY_ORIGIN: 'https://signet-preview.squirrelsystems.net',
  DREY_PREVIEW_GATEWAY_PUBLIC_KEY_HEX:
    '709f2d86bd89c4536e57acc5a462fa8b7dfa62f35e9a6cd16fbb5fc786bca166',
  DREY_PREVIEW_MANIFEST_PUBLIC_KEY:
    'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsLdftrZkj2AO1uD9sb1DW8uT9s/RteJGhSTkkfDIyBaRPD52Z5gvJSgFq/n73z08XYKosypywU2UiIWyjRkfmzbY06KOdIdBfGCmB4LQpUJPvnVEmyEfigCzRz7hPuyEAcaubr5dPuDi0Im/zm03RZQMV4Z4vMZ0MNuqPs74HUhu1gy8l7vxQbnKrU1yi/TrpG0Wocv5kwMZnMTUbEEEeoQOG8jRzGa32nEuDxvVnp7ryA4s0RSsAl884iEZjUf4t548FWVkP9mOO0083eG93jXgd5j/BZgVhhPjRF/iH5mGzIJVkuDfeGJfTtX480hIjXdVSbgmOy5WoHTSMtevyQIDAQAB',
};

describe('build channel configuration', () => {
  it('ships transparent RGBA icons at every manifest size', () => {
    for (const size of [16, 32, 48, 128]) {
      const icon = readFileSync(
        new URL(`../../public/icon/${size}.png`, import.meta.url),
      );
      expect(icon.subarray(1, 4).toString('ascii')).toBe('PNG');
      expect(icon.readUInt32BE(16)).toBe(size);
      expect(icon.readUInt32BE(20)).toBe(size);
      expect(icon[24]).toBe(8);
      expect(icon[25]).toBe(6);
    }
  });

  it('writes every packaged channel to a separate stable output root', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts['build']).toContain('.output/production');
    expect(packageJson.scripts['build:next']).toBe(
      'DREY_BUILD_OUTPUT_ROOT=.output/next wxt build --mode production && ' +
      'node scripts/check-approval-gallery-isolation.mjs .output/next/chrome-mv3',
    );
    expect(packageJson.scripts['zip']).toBe(
      'DREY_BUILD_OUTPUT_ROOT=.output/production node scripts/package-production.mjs',
    );
    expect(packageJson.scripts['build:pilot']).toContain('DREY_BUILD_OUTPUT_ROOT=.output ');
    expect(packageJson.scripts['build:test']).toContain('.output/test');
    expect(packageJson.scripts['build:preview']).toContain('.output/preview');
    expect(new Set([
      packageJson.scripts['build'],
      packageJson.scripts['build:next'],
      packageJson.scripts['build:pilot'],
      packageJson.scripts['build:test'],
      packageJson.scripts['build:preview'],
    ]).size).toBe(5);
    expect(packageJson.scripts['zip:next']).toBeUndefined();
  });

  it('keeps clean-profile browser checks pinned to the canonical pilot artifact', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts: Record<string, string> };
    const lifecycleScript = readFileSync(
      new URL('../../scripts/test-pilot-browser-lifecycle.mjs', import.meta.url),
      'utf8',
    );
    expect(packageJson.scripts['test:pilot:browsers'])
      .toBe('node scripts/test-pilot-browser-lifecycle.mjs');
    expect(lifecycleScript).toContain("const artifact = join(root, '.output', 'chrome-mv3')");
    expect(lifecycleScript).toContain("assert.equal(manifest.name, 'Drey PILOT')");
    expect(lifecycleScript).toContain(
      "assert.deepEqual(manifest.host_permissions, ['https://wallet-api.squirrelsystems.net/*'])",
    );
    expect(lifecycleScript).not.toContain('.output/test');
    expect(lifecycleScript).not.toContain('build:test');
  });

  it('rejects modes outside the exhaustive channel set', () => {
    expect(() => resolveBuildChannel('staging')).toThrow(/unsupported WXT build mode/u);
    expect(() => resolveBuildChannel('')).toThrow(
      /development \| test \| preview \| pilot \| production/u,
    );
  });

  it('pins test builds to signet, loopback, fixture verification, and a stable ID', () => {
    const channel = resolveBuildChannel('test');
    expect(channel).toMatchObject({
      channel: 'test',
      network: 'signet',
      gatewayOrigin: TEST_LOOPBACK_GATEWAY_ORIGIN,
      gatewayPublicKeyHex: PUBLIC_FIXTURE_GATEWAY_KEY_HEX,
      gatewayProtocolVersions: [1, 2],
      liveGatewayEnabled: true,
      manifestPublicKey: TEST_MANIFEST_PUBLIC_KEY,
    });
  });

  it('offers passkey enrollment only on channels with a pinned manifest key (A0 §1)', () => {
    for (const mode of ['development', 'test', 'preview', 'pilot', 'production'] as const) {
      const channel = resolveBuildChannel(mode, previewEnvironment);
      // Invariant, not a per-channel table: enrollment requires the stable
      // extension ID (and thus WebAuthn RP identity) a manifest key pins.
      expect(channel.passkeyEnrollmentEnabled, mode).toBe(channel.manifestPublicKey !== undefined);
    }
    expect(resolveBuildChannel('development').passkeyEnrollmentEnabled).toBe(false);
    expect(resolveBuildChannel('pilot').passkeyEnrollmentEnabled).toBe(false);
    expect(resolveBuildChannel('test').passkeyEnrollmentEnabled).toBe(true);
  });

  it('ships reviewed Vault authority in production while preview remains excluded', () => {
    expect(resolveBuildChannel('development').vaultCoordinatorEnabled).toBe(true);
    expect(resolveBuildChannel('test').vaultCoordinatorEnabled).toBe(true);
    expect(resolveBuildChannel('pilot').vaultCoordinatorEnabled).toBe(true);
    expect(resolveBuildChannel('preview', previewEnvironment).vaultCoordinatorEnabled).toBe(false);
    expect(resolveBuildChannel('production').vaultCoordinatorEnabled).toBe(true);
    expect(resolveBuildChannel('production').vaultCoordinatorMovement).toBe('production-mainnet');
  });

  it('binds reviewed production-mainnet authority to mainnet channels', () => {
    for (const mode of ['development', 'test', 'preview', 'pilot', 'production'] as const) {
      const channel = resolveBuildChannel(mode, previewEnvironment);
      if (channel.vaultCoordinatorMovement === 'full') {
        expect(channel.network, mode).toBe('signet');
      }
      if (channel.vaultCoordinatorMovement === 'production-mainnet') {
        expect(channel.network, mode).toBe('mainnet');
        expect(['pilot', 'production'], mode).toContain(mode);
      }
      // A movement without a coordinator is meaningless, and a coordinator with
      // no movement could not answer its own status op.
      expect(channel.vaultCoordinatorMovement !== null, mode).toBe(
        channel.vaultCoordinatorEnabled,
      );
      // Whatever a channel names must be one of the three pairings the ADR
      // permits; nothing else composes into a capability at all.
      if (channel.vaultCoordinatorMovement !== null) {
        expect(
          resolveVaultCoordinatorCapability(channel.network, channel.vaultCoordinatorMovement),
          mode,
        ).toBeDefined();
      }
    }
    expect(resolveBuildChannel('pilot').network).toBe('mainnet');
    expect(resolveBuildChannel('pilot').vaultCoordinatorMovement).toBe('production-mainnet');
    expect(resolveBuildChannel('development').vaultCoordinatorMovement).toBe('full');
    expect(resolveBuildChannel('test').vaultCoordinatorMovement).toBe('full');
  });

  it('cannot be given a Vault coordinator or movement through the environment', () => {
    // The flags are switch-case literals. Nothing in BuildEnvironment — nor any
    // stray variable — may turn a coordinator on for a shippable channel, or
    // widen the movement of the mainnet pilot that legitimately has one.
    const hostile = {
      ...previewEnvironment,
      DREY_VAULT_COORDINATOR: '1',
      DREY_VAULT_COORDINATOR_ENABLED: 'true',
      DREY_VAULT_COORDINATOR_MOVEMENT: 'full',
      VAULT_COORDINATOR: 'mainnet',
    } as Record<string, string>;
    expect(resolveBuildChannel('preview', hostile).vaultCoordinatorEnabled).toBe(false);
    expect(resolveBuildChannel('preview', hostile).vaultCoordinatorMovement).toBeNull();
    expect(resolveBuildChannel('production', hostile).vaultCoordinatorMovement).toBe('production-mainnet');
    expect(resolveBuildChannel('pilot', hostile).vaultCoordinatorMovement).toBe('production-mainnet');
  });

  it('preserves the production mainnet configuration', () => {
    expect(resolveBuildChannel('production')).toMatchObject({
      channel: 'production',
      name: 'Drey',
      network: 'mainnet',
      gatewayOrigin: 'https://wallet-api.squirrelsystems.net',
      gatewayPublicKeyHex: PRODUCTION_GATEWAY_PUBLIC_KEY_HEX,
      liveGatewayEnabled: true,
      productionPackagingEnabled: true,
      gatewayProtocolVersions: [2],
      disposableMainnetPilot: false,
      manifestPublicKey: PRODUCTION_MANIFEST_PUBLIC_KEY,
      storeItemId: PRODUCTION_STORE_ITEM_ID,
    });
    expect(PRODUCTION_MANIFEST_PUBLIC_KEY).toBe(
      'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq6G2Zadw7QPHhDoRL9+Z5f+i+fSMCbui/xt4DHIF78f/+tb3Tf0RG3WS6MWM6CYpX8IftPdXHnWah/mvkMkJq4nvNo08nWThk9cuEXJ66KMP2cj9dAu8wMDHn5rTNysspahoq66f3MfCFWvT1dysJYf+NWRQV/yyEBx97pTuqHcST4NZ1WiHhCcaD8H/SakJ71yOZM0ksdwsbuGZdvqb+3j+atP0oP3T1oAalACFrbkempicjwvqF7cy9j3O1LsI0+19HmEWsCZpZTMv6/md7NS2xmhDM+OPU3YPaa9HAYerElJfTe/6pl9aFTp3DjuVnDq6rPLIY4C1Ikf10qEY/wIDAQAB',
    );
    expect(PRODUCTION_STORE_ITEM_ID).toBe('kngidlmmbfmnoeimngkajdlbdenlhgof');
    expect(PRODUCTION_PACKAGING_ENABLED).toBe(true);
  });

  it('keeps production identity and packaging source-gated', () => {
    const packageScript = readFileSync(
      new URL('../../scripts/package-production.mjs', import.meta.url),
      'utf8',
    );
    const auditScript = readFileSync(
      new URL('../../scripts/audit-production.mjs', import.meta.url),
      'utf8',
    );
    const aggregateGate = readFileSync(
      new URL('../../scripts/ci-m8t.mjs', import.meta.url),
      'utf8',
    );
    expect(packageScript).toContain('productionPackagingEnabled !== true');
    expect(packageScript).toContain('must have an exact reviewed release tag');
    expect(packageScript).toContain('must not reuse the fixture or pilot identity');
    expect(packageScript).toContain('Store item ID does not match the manifest public key');
    expect(auditScript).toContain('production provenance sidecar is missing');
    expect(auditScript).toContain('production ZIP timestamps are not normalized');
    expect(aggregateGate).toContain(
      "expectFailure: !productionPackagingEnabled",
    );
  });

  it('creates a self-contained pilot build pinned to the key its host actually signs with', () => {
    // The approved host runs in production phase, so it signs with the
    // production key. A pilot build pinned to PILOT_GATEWAY_PUBLIC_KEY_HEX
    // could not verify a single response and every live surface would sit
    // permanently read-only — a fail-closed build, not a safer one.
    const pilot = resolveBuildChannel('pilot');
    expect(pilot).toMatchObject({
      channel: 'pilot', name: 'Drey PILOT', network: 'mainnet',
      description: 'DISPOSABLE MAINNET VALIDATION — MANUAL TEST WALLET ONLY',
      gatewayOrigin: 'https://wallet-api.squirrelsystems.net',
      gatewayPublicKeyHex: PRODUCTION_GATEWAY_PUBLIC_KEY_HEX, gatewayProtocolVersions: [2],
      liveGatewayEnabled: true, disposableMainnetPilot: true,
    });
    const auditScript = readFileSync(
      new URL('../../scripts/audit-production.mjs', import.meta.url),
      'utf8',
    );
    expect(auditScript).toContain(pilot.description);
    // Retained for a future pilot-phase deployment, and still never the
    // fixture key. Re-bind it when such a gateway exists.
    expect(PILOT_GATEWAY_PUBLIC_KEY_HEX).toMatch(/^[0-9a-f]{64}$/u);
    expect(PILOT_GATEWAY_PUBLIC_KEY_HEX).not.toBe(PUBLIC_FIXTURE_GATEWAY_KEY_HEX);
    expect(PILOT_GATEWAY_PUBLIC_KEY_HEX).not.toBe(PRODUCTION_GATEWAY_PUBLIC_KEY_HEX);
  });

  it('requires every preview binding', () => {
    expect(() => resolveBuildChannel('preview', {})).toThrow('DREY_PREVIEW_GATEWAY_ORIGIN');
    expect(() => resolveBuildChannel('preview', {
      DREY_PREVIEW_GATEWAY_ORIGIN: previewEnvironment.DREY_PREVIEW_GATEWAY_ORIGIN,
    })).toThrow('DREY_PREVIEW_GATEWAY_PUBLIC_KEY_HEX');
    expect(() => resolveBuildChannel('preview', {
      DREY_PREVIEW_GATEWAY_ORIGIN: previewEnvironment.DREY_PREVIEW_GATEWAY_ORIGIN,
      DREY_PREVIEW_GATEWAY_PUBLIC_KEY_HEX: previewEnvironment.DREY_PREVIEW_GATEWAY_PUBLIC_KEY_HEX,
    })).toThrow('DREY_PREVIEW_MANIFEST_PUBLIC_KEY');
  });

  it('rejects preview fallback to production, loopback, and public fixture identities', () => {
    expect(() => resolveBuildChannel('preview', {
      ...previewEnvironment,
      DREY_PREVIEW_GATEWAY_ORIGIN: 'https://wallet-api.squirrelsystems.net',
    })).toThrow(/dedicated to preview/u);
    expect(() => resolveBuildChannel('preview', {
      ...previewEnvironment,
      DREY_PREVIEW_GATEWAY_ORIGIN: 'http://127.0.0.1:8080',
    })).toThrow(/HTTPS origin/u);
    expect(() => resolveBuildChannel('preview', {
      ...previewEnvironment,
      DREY_PREVIEW_GATEWAY_PUBLIC_KEY_HEX: PUBLIC_FIXTURE_GATEWAY_KEY_HEX,
    })).toThrow(/must not reuse/u);
    expect(() => resolveBuildChannel('preview', {
      ...previewEnvironment,
      DREY_PREVIEW_MANIFEST_PUBLIC_KEY: TEST_MANIFEST_PUBLIC_KEY,
    })).toThrow(/preview Store item/u);
  });

  it('cannot enable preview gateway networking from the environment', () => {
    const channel = resolveBuildChannel('preview', {
      ...previewEnvironment,
      LIVE_GATEWAY_ENABLED: 'true',
    } as typeof previewEnvironment);
    expect(channel.liveGatewayEnabled).toBe(false);
    expect(channel.previewPackagingEnabled).toBe(false);
    expect(channel.syntheticPreviewAudit).toBe(true);
    expect(channel.name).toBe('Drey BETA');
    expect(channel.icons[128]).toBe('/icon-beta/128.png');
  });
});
