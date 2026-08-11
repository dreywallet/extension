/**
 * Build-channel constants injected via Vite `define` (wxt.config.ts).
 * The WXT configuration resolves exactly one compile-time channel. Preview
 * hard-codes live gateway access off; pilot is pinned to the approved mainnet
 * gateway and public response key.
 */
declare const __BUILD_CHANNEL__: 'development' | 'test' | 'preview' | 'pilot' | 'production';
declare const __EXTENSION_VERSION__: string;
declare const __LIVE_GATEWAY_ENABLED__: boolean;
declare const __GATEWAY_URL__: string;
declare const __GATEWAY_PUBKEY_HEX__: string;
declare const __GATEWAY_NETWORK__: 'mainnet' | 'signet';
declare const __GATEWAY_PROTOCOL_VERSIONS__: readonly (1 | 2)[];
/** True only on channels with a pinned manifest key (stable WebAuthn RP identity). */
declare const __PASSKEY_ENROLLMENT_ENABLED__: boolean;
/**
 * Compile-time two-tier Vault coordinator authority (ADR 0007 §8). Production
 * and test may enable it; nothing at runtime can change it.
 */
declare const __VAULT_COORDINATOR_ENABLED__: boolean;
/**
 * What that coordinator may move (ADR 0007 §8): `full` on the signet test
 * channels, `production-mainnet` on reviewed mainnet channels, `none` where there is no
 * coordinator. `unsigned-only` remains a legal pairing with no channel.
 */
declare const __VAULT_COORDINATOR_MOVEMENT__: 'full' | 'unsigned-only' | 'production-mainnet' | 'none';
