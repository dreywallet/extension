import { createPublicKey } from 'node:crypto';
// Type-only: the movement vocabulary belongs to the coordinator's own module,
// and restating it here would be a second list to keep in agreement.
import type { VaultCoordinatorMovement } from '../background/vault-capability';

export const BUILD_MODES = ['development', 'test', 'preview', 'pilot', 'production'] as const;

export type BuildChannel = (typeof BUILD_MODES)[number];

export interface BuildEnvironment {
  DREY_PREVIEW_GATEWAY_ORIGIN?: string;
  DREY_PREVIEW_GATEWAY_PUBLIC_KEY_HEX?: string;
  DREY_PREVIEW_MANIFEST_PUBLIC_KEY?: string;
  DREY_SYNTHETIC_PREVIEW_AUDIT?: string;
}

export interface BuildChannelConfiguration {
  channel: BuildChannel;
  name: string;
  description: string;
  network: 'mainnet' | 'signet';
  gatewayOrigin: string;
  gatewayPublicKeyHex: string;
  gatewayProtocolVersions: readonly (1 | 2)[];
  liveGatewayEnabled: boolean;
  productionPackagingEnabled: boolean;
  previewPackagingEnabled: boolean;
  syntheticPreviewAudit: boolean;
  disposableMainnetPilot: boolean;
  /**
   * Whether passkey enrollment may be offered (ADR 0007 §5, A0 §1): true only
   * for channels with a pinned manifest key, whose extension ID — and thus
   * WebAuthn RP identity — is stable. Development and pilot builds have no
   * key, so their RP identity floats per checkout/machine and an enrollment
   * would orphan itself; they must never offer it.
   */
  passkeyEnrollmentEnabled: boolean;
  /**
   * Whether the two-tier Vault coordinator exists in this build (ADR 0007 §8).
   * Production has explicit reviewed mainnet authority; test has signet
   * authority; development and preview remain disabled. This is a switch-case
   * literal and is never read from runtime input.
   */
  vaultCoordinatorEnabled: boolean;
  /**
   * What that coordinator may move (ADR 0007 §8), or null when the channel has
   * no coordinator at all.
   *
   * The split from `vaultCoordinatorEnabled` exists so a coordinator can
   * exercise mainnet — the network the deployed gateway actually serves, and
   * the only source of real tips, revisions, and classification evidence —
   * under a movement rule chosen separately from the network.
   *
   * `full` is the signet test authority. `production-mainnet` is the reviewed
   * production authority; permanent transaction-integrity and Full Sat Safety
   * rules govern it, without a temporary monetary rollout ceiling.
   *
   * The invariants, asserted in `tests/build/channel.test.ts` and again in the
   * production audit: `full` implies signet, `production-mainnet` implies mainnet,
   * and a movement without a coordinator —
   * or a coordinator without a movement — is not configurable.
   */
  vaultCoordinatorMovement: VaultCoordinatorMovement | null;
  manifestPublicKey?: string;
  storeItemId?: string;
  icons: Readonly<Record<16 | 32 | 48 | 128, string>>;
}

export const PRODUCTION_GATEWAY_ORIGIN = 'https://wallet-api.squirrelsystems.net';
export const PRODUCTION_GATEWAY_PUBLIC_KEY_HEX = 'daabf22693c9b33b7d541877468e200110c2303847fb173bd07c90054852177f';
// Public values only. The Store public key independently derives the exact
// item ID below. Production packaging remains source-gated separately.
export const PRODUCTION_MANIFEST_PUBLIC_KEY = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq6G2Zadw7QPHhDoRL9+Z5f+i+fSMCbui/xt4DHIF78f/+tb3Tf0RG3WS6MWM6CYpX8IftPdXHnWah/mvkMkJq4nvNo08nWThk9cuEXJ66KMP2cj9dAu8wMDHn5rTNysspahoq66f3MfCFWvT1dysJYf+NWRQV/yyEBx97pTuqHcST4NZ1WiHhCcaD8H/SakJ71yOZM0ksdwsbuGZdvqb+3j+atP0oP3T1oAalACFrbkempicjwvqF7cy9j3O1LsI0+19HmEWsCZpZTMv6/md7NS2xmhDM+OPU3YPaa9HAYerElJfTe/6pl9aFTp3DjuVnDq6rPLIY4C1Ikf10qEY/wIDAQAB';
export const PRODUCTION_STORE_ITEM_ID = 'kngidlmmbfmnoeimngkajdlbdenlhgof';
/**
 * Public verification key for a separately deployed pilot-phase gateway.
 *
 * Retained but no longer bound to a channel. The approved host runs at
 * `gateway_release_phase=production` and signs with the production key, so a
 * `pilot` build pinned to this one could not verify a single response and every
 * live surface — the Vault coordinator included — would sit permanently
 * read-only. The pilot channel now pins the production key: it is the same
 * host serving the same mainnet data, and the key separation only ever meant
 * something for a pilot-phase deployment that does not currently exist.
 *
 * Re-bind this the moment a pilot-phase gateway is deployed; until then a
 * channel pointing at it is a fail-closed build, not a safer one.
 */
export const PILOT_GATEWAY_PUBLIC_KEY_HEX =
  'eac4a676a0440c4da3909190dcd93f5a42d6291279bb8db9f0841891dec0cb7c';
export const LOOPBACK_GATEWAY_ORIGIN = 'http://127.0.0.1:8080';
export const TEST_LOOPBACK_GATEWAY_ORIGIN = 'http://127.0.0.1:18080';

// Same Ed25519 public key as tests/fixtures/gateway/dev-public-key.json. It is
// public test material only; the signing key remains confined to the gateway
// fixture process.
export const PUBLIC_FIXTURE_GATEWAY_KEY_HEX =
  '0aa651b5015967c85f088bdbf82b210daf3bd1f5fc0ae35bafc523b029e96ca3';

// Public SPKI DER, base64 encoded. Chrome hashes this manifest key into a
// stable test-only extension ID. No corresponding private key is committed or
// required to load the unpacked test build.
export const TEST_MANIFEST_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAynfTj/R/H7JnEYmAJ5XLqdIozN1ONnTB2WufLVF6YwjenggPAv74qevM/meXoXLkyLviywedDYvHt6okrMiVyeOT0KR+DO3XlxSB0VwrTEROnGyQCA2Yx1navQjykkIBUAKYhjXq/bbDzNyqXfkVDvs5X+MlHEv7UtPrkdffU8c7u+b3a1ycXjnUgVMTpZxXYEPnFrg235Ii8Ax9uTToAQs+Sds7rw/BQ23F+vdWTOIycdTnC+p9+GCDVrsrSKcr9OdfZH66ILAOQH8uiZCihOfv5rR1ukp4qyFOU0InzU7qQRdrbHhYZ2KlPz13IuniZeBk/OkrHI5pHfKpB29VsQIDAQAB';

// G2/G3 and Store ownership are external gates. This must change in reviewed
// source before the real zip:preview command can create a distributable file.
export const PREVIEW_PACKAGING_ENABLED = false;
export const PRODUCTION_PACKAGING_ENABLED = true;

const PRODUCTION_ICONS = {
  16: '/icon/16.png',
  32: '/icon/32.png',
  48: '/icon/48.png',
  128: '/icon/128.png',
} as const;

const PREVIEW_ICONS = {
  16: '/icon-beta/16.png',
  32: '/icon-beta/32.png',
  48: '/icon-beta/48.png',
  128: '/icon-beta/128.png',
} as const;

function required(environment: BuildEnvironment, name: keyof BuildEnvironment): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`preview build requires ${name}`);
  return value;
}

function previewOrigin(environment: BuildEnvironment): string {
  const raw = required(environment, 'DREY_PREVIEW_GATEWAY_ORIGIN');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('DREY_PREVIEW_GATEWAY_ORIGIN must be a valid HTTPS origin');
  }
  if (parsed.protocol !== 'https:' || parsed.origin !== raw || parsed.username || parsed.password) {
    throw new Error('DREY_PREVIEW_GATEWAY_ORIGIN must be an HTTPS origin with no path, query, or credentials');
  }
  if (raw === PRODUCTION_GATEWAY_ORIGIN || parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
    throw new Error('DREY_PREVIEW_GATEWAY_ORIGIN must be dedicated to preview');
  }
  const synthetic = environment.DREY_SYNTHETIC_PREVIEW_AUDIT === '1';
  if (!synthetic && /(?:\.example|\.invalid|\.test|\.localhost|\.local)$/u.test(parsed.hostname)) {
    throw new Error('DREY_PREVIEW_GATEWAY_ORIGIN must not use a reserved or local hostname');
  }
  return raw;
}

function previewGatewayKey(environment: BuildEnvironment): string {
  const value = required(environment, 'DREY_PREVIEW_GATEWAY_PUBLIC_KEY_HEX').toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error('DREY_PREVIEW_GATEWAY_PUBLIC_KEY_HEX must be a 32-byte Ed25519 public key');
  }
  if (value === PUBLIC_FIXTURE_GATEWAY_KEY_HEX) {
    throw new Error('DREY_PREVIEW_GATEWAY_PUBLIC_KEY_HEX must not reuse the public fixture key');
  }
  if (environment.DREY_SYNTHETIC_PREVIEW_AUDIT !== '1' && new Set(value.match(/../gu)).size < 8) {
    throw new Error('DREY_PREVIEW_GATEWAY_PUBLIC_KEY_HEX looks like placeholder material');
  }
  return value;
}

function previewManifestKey(environment: BuildEnvironment): string {
  const value = required(environment, 'DREY_PREVIEW_MANIFEST_PUBLIC_KEY');
  if (value === TEST_MANIFEST_PUBLIC_KEY) {
    throw new Error('DREY_PREVIEW_MANIFEST_PUBLIC_KEY must be the preview Store item public key');
  }
  if (value.length < 128 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error('DREY_PREVIEW_MANIFEST_PUBLIC_KEY must be a base64-encoded public key');
  }
  try {
    const key = createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not RSA');
  } catch {
    throw new Error('DREY_PREVIEW_MANIFEST_PUBLIC_KEY must be a valid RSA SPKI public key');
  }
  return value;
}

export function resolveBuildChannel(
  mode: string,
  environment: BuildEnvironment = process.env,
): BuildChannelConfiguration {
  switch (mode) {
    case 'development':
      return {
        channel: mode,
        name: 'Drey',
        description: 'Non-custodial Bitcoin and Ordinals wallet',
        network: 'signet',
        gatewayOrigin: LOOPBACK_GATEWAY_ORIGIN,
        gatewayPublicKeyHex: PUBLIC_FIXTURE_GATEWAY_KEY_HEX,
        gatewayProtocolVersions: [1, 2],
        liveGatewayEnabled: true,
        productionPackagingEnabled: false,
        previewPackagingEnabled: false,
        syntheticPreviewAudit: false,
        disposableMainnetPilot: false,
        passkeyEnrollmentEnabled: false,
        vaultCoordinatorEnabled: true,
        vaultCoordinatorMovement: 'full',
        icons: PRODUCTION_ICONS,
      };
    case 'test':
      return {
        channel: mode,
        name: 'Drey Test',
        description: 'Drey automated test wallet — signet and disposable wallets only',
        network: 'signet',
        gatewayOrigin: TEST_LOOPBACK_GATEWAY_ORIGIN,
        gatewayPublicKeyHex: PUBLIC_FIXTURE_GATEWAY_KEY_HEX,
        gatewayProtocolVersions: [1, 2],
        liveGatewayEnabled: true,
        productionPackagingEnabled: false,
        previewPackagingEnabled: false,
        syntheticPreviewAudit: false,
        disposableMainnetPilot: false,
        passkeyEnrollmentEnabled: true,
        vaultCoordinatorEnabled: true,
        vaultCoordinatorMovement: 'full',
        manifestPublicKey: TEST_MANIFEST_PUBLIC_KEY,
        icons: PRODUCTION_ICONS,
      };
    case 'preview':
      return {
        channel: mode,
        name: 'Drey BETA',
        description: 'THIS EXTENSION IS FOR BETA TESTING — signet and disposable wallets only',
        network: 'signet',
        gatewayOrigin: previewOrigin(environment),
        gatewayPublicKeyHex: previewGatewayKey(environment),
        gatewayProtocolVersions: [2],
        // Deliberately not sourced from the environment. G2/G3 must land as a
        // reviewed code change before preview builds can perform gateway I/O.
        liveGatewayEnabled: false,
        productionPackagingEnabled: false,
        previewPackagingEnabled: PREVIEW_PACKAGING_ENABLED,
        syntheticPreviewAudit: environment.DREY_SYNTHETIC_PREVIEW_AUDIT === '1',
        disposableMainnetPilot: false,
        passkeyEnrollmentEnabled: true,
        vaultCoordinatorEnabled: false,
        vaultCoordinatorMovement: null,
        manifestPublicKey: previewManifestKey(environment),
        icons: PREVIEW_ICONS,
      };
    case 'pilot':
      return {
        channel: mode,
        name: 'Drey PILOT',
        description: 'DISPOSABLE MAINNET VALIDATION — MANUAL TEST WALLET ONLY',
        network: 'mainnet',
        gatewayOrigin: PRODUCTION_GATEWAY_ORIGIN,
        // The approved host is in production phase and signs with the
        // production key. Pinning the pilot key here would fail every
        // signature — see PILOT_GATEWAY_PUBLIC_KEY_HEX above.
        gatewayPublicKeyHex: PRODUCTION_GATEWAY_PUBLIC_KEY_HEX,
        gatewayProtocolVersions: [2],
        liveGatewayEnabled: true,
        productionPackagingEnabled: false,
        previewPackagingEnabled: false,
        syntheticPreviewAudit: false,
        disposableMainnetPilot: true,
        passkeyEnrollmentEnabled: false,
        // Same reviewed mainnet semantics as production, retained only for the
        // explicitly disposable operator test wallet. It is never packaged.
        vaultCoordinatorEnabled: true,
        vaultCoordinatorMovement: 'production-mainnet',
        icons: PRODUCTION_ICONS,
      };
    case 'production':
      return {
        channel: mode,
        name: 'Drey',
        description: 'Non-custodial Bitcoin and Ordinals wallet',
        network: 'mainnet',
        gatewayOrigin: PRODUCTION_GATEWAY_ORIGIN,
        gatewayPublicKeyHex: PRODUCTION_GATEWAY_PUBLIC_KEY_HEX,
        gatewayProtocolVersions: [2],
        liveGatewayEnabled: true,
        productionPackagingEnabled: PRODUCTION_PACKAGING_ENABLED,
        previewPackagingEnabled: false,
        syntheticPreviewAudit: false,
        disposableMainnetPilot: false,
        passkeyEnrollmentEnabled: true,
        vaultCoordinatorEnabled: true,
        vaultCoordinatorMovement: 'production-mainnet',
        ...(PRODUCTION_MANIFEST_PUBLIC_KEY
          ? { manifestPublicKey: PRODUCTION_MANIFEST_PUBLIC_KEY }
          : {}),
        ...(PRODUCTION_STORE_ITEM_ID ? { storeItemId: PRODUCTION_STORE_ITEM_ID } : {}),
        icons: PRODUCTION_ICONS,
      };
    default:
      throw new Error(
        `unsupported WXT build mode ${JSON.stringify(mode)}; expected ${BUILD_MODES.join(' | ')}`,
      );
  }
}
