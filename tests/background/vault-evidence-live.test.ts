/**
 * Live gateway probe for the Vault evidence source (Workstream C2).
 *
 * Skipped unless `DREY_VAULT_LIVE_PROBE=1`, because it performs real network
 * I/O against the approved production gateway. It exists because one C2 claim
 * cannot be established by any fixture: that a *genuinely signed* backend
 * response — real tips, a real classification revision, a real capability set —
 * is accepted by the coordinator's evidence projection, and that a real backend
 * offers the complete Full Sat Safety set the Vault requires. The committed dev
 * fixture advertises `standard_ordinals_safety` only, so against it a Vault is
 * correctly and permanently read-only.
 *
 * Strictly read-only and privacy-preserving: it sends a random request nonce and
 * nothing else — no address, no script hash, no wallet data — and it writes
 * nothing. It never funds, signs, or broadcasts.
 *
 *   DREY_VAULT_LIVE_PROBE=1 pnpm vitest run tests/background/vault-evidence-live.test.ts
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { verifyStatus } from '@drey/core/domain/gateway/verify';
import { VAULT_FULL_SAT_SAFETY_CAPABILITIES } from '@drey/core/domain/vault/multisig-asset-policy';
import { resolveBuildChannel } from '../../src/build/channel';
import { deriveVaultEvidenceSource } from '../../src/background/vault-evidence';

const enabled = process.env['DREY_VAULT_LIVE_PROBE'] === '1';

beforeAll(installTestCryptoProvider);

describe.skipIf(!enabled)('live gateway is a usable Vault evidence source', () => {
  it('verifies a signed status and accepts it as an evidence source', async () => {
    // The pilot channel's own compile-time bindings: the same origin and pinned
    // response key the unsigned-only mainnet coordinator would use.
    const pilot = resolveBuildChannel('pilot');
    if (pilot.network === 'regtest') throw new Error('pilot must not target regtest');
    const nonce = randomBytes(16).toString('hex');
    const response = await fetch(`${pilot.gatewayOrigin}/v1/status`, {
      headers: { 'x-squirrel-request-nonce': nonce },
      signal: AbortSignal.timeout(20_000),
    });
    expect(response.ok, `status HTTP ${response.status}`).toBe(true);
    const bodyBytes = new Uint8Array(await response.arrayBuffer());

    // The pilot channel's own compile-time binding, asserted against the host
    // it actually points at. This is the regression guard for the mismatch
    // that made the mainnet coordinator unusable: origin and response key are
    // separate bindings, and a build pinned to a key its host does not sign
    // with fails closed on every request rather than failing loudly at build.
    const nowMs = Date.now();
    const verified = verifyStatus({
      bodyBytes,
      publicKeyHex: pilot.gatewayPublicKeyHex,
      expectedNonce: nonce,
      expectedNetwork: pilot.network,
      allowedProtocolVersions: pilot.gatewayProtocolVersions,
      nowMs,
      maxSkewMs: 120_000,
    });
    expect(verified.ok, verified.ok ? '' : `signature/envelope: ${verified.reason}`).toBe(true);
    if (!verified.ok) return;
    const { status } = verified;

    // The capability claim: a real backend offers everything Full Sat Safety
    // needs. If this ever regresses, the Vault goes read-only rather than
    // guessing, which is the behaviour the fixture tests already cover.
    for (const capability of VAULT_FULL_SAT_SAFETY_CAPABILITIES) {
      expect(status.capabilities, capability).toContain(capability);
    }
    expect(status.eligibleSafetyModes).toContain('full_sat_safety');

    const derived = deriveVaultEvidenceSource({
      network: pilot.network,
      status,
      // The probe does not scan, so the scan half is taken from the same
      // verified envelope: what is being proven is that a real signed status is
      // internally coherent enough to anchor a scan describing the same block.
      scan: {
        instanceId: status.instanceId,
        classificationRevision: status.classificationRevision,
        coreTip: status.coreTip,
        indexTip: status.indexTip,
      },
      nowMs,
    });
    expect(derived.ok, derived.ok ? '' : `refused: ${derived.refusal}`).toBe(true);
    if (!derived.ok) return;
    expect(derived.source.coreTip.height).toBeGreaterThan(800_000);
    expect(derived.source.backendInstanceIdHash).toMatch(/^[0-9a-f]{64}$/u);
  });
});
