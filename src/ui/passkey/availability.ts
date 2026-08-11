/**
 * UI-side passkey gating (A0 §4 steps 1–2).
 *
 * The channel gate is compile-time: only builds with a pinned manifest key —
 * a stable extension ID and therefore a stable WebAuthn RP — may offer
 * enrollment (A0 §1). The worker enforces the same gate independently via its
 * injected passkeyRpOrigin; this helper only decides whether the settings
 * surface renders at all. The typeof guard keeps non-WXT contexts (vitest
 * without the define, tooling) fail-closed instead of throwing.
 */
export function passkeyChannelEnabled(): boolean {
  return typeof __PASSKEY_ENROLLMENT_ENABLED__ !== 'undefined' && __PASSKEY_ENROLLMENT_ENABLED__;
}

/** Channel gate plus the page-level WebAuthn surface check (ladder step 1). */
export function passkeySettingsAvailable(): boolean {
  return passkeyChannelEnabled() && typeof PublicKeyCredential !== 'undefined';
}
