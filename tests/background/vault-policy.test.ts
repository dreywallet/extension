/**
 * Workstream C1 exit gate, part one: the coordinator's policy composition
 * reproduces `core/vectors/vault-descriptors-v1` exactly, and refuses every
 * malformed policy shape ADR 0007 §§2-3 rules out.
 *
 * The conformance direction matters. These tests drive
 * `composeVaultPolicyRecord` — the same function the worker calls — with the
 * three signet signer origins core's own B0 vectors publish, and compare the
 * result against the B1 vector's committed `policyId`, both checksummed
 * descriptors, and its derived addresses. That is a genuine cross-check against
 * data Bitcoin Core independently verified offline, not two of our own
 * implementations agreeing with each other.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { beforeAll } from 'vitest';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import {
  VAULT_RECOVERY_KIT_TEXT_V1,
  type VaultSignerOriginV1,
} from '@drey/core/domain/vault/multisig-contracts';
import {
  VAULT_STANDALONE_TOOL_DIGEST_UNPUBLISHED,
  VAULT_STANDALONE_TOOL_RELEASE,
  buildVaultRecoveryKit,
  collidesWithHeldRole,
  composeVaultPolicyRecord,
  descriptorChecksumOf,
  summarizeVaultPolicy,
} from '../../src/background/vault-policy';

beforeAll(installTestCryptoProvider);

const require = createRequire(import.meta.url);

interface ContractsVector {
  records: Record<string, { signers: VaultSignerOriginV1[] }>;
}
interface DescriptorsVector {
  records: Record<
    string,
    {
      policyId: string;
      birthdayHeight: number;
      receiveDescriptor: string;
      changeDescriptor: string;
      outputs: Array<{ branch: string; index: number; address: string; witnessScriptHex: string }>;
    }
  >;
}

const contracts = require('@drey/core/vectors/vault-contracts-v1.json') as ContractsVector;
const descriptors = require('@drey/core/vectors/vault-descriptors-v1.json') as DescriptorsVector;

const SIGNET_SIGNERS = contracts.records['signet']!.signers as [
  VaultSignerOriginV1,
  VaultSignerOriginV1,
  VaultSignerOriginV1,
];
const SIGNET_EXPECTED = descriptors.records['signet']!;

const METADATA = {
  createdAtMs: '1735689600000',
  birthdayHeight: SIGNET_EXPECTED.birthdayHeight,
  vaultLabel: 'Conformance Vault',
  signerLabels: ['A', 'B', 'C'] as [string, string, string],
};

function compose(signers = SIGNET_SIGNERS) {
  return composeVaultPolicyRecord('signet', signers, METADATA);
}

describe('C1 policy composition reproduces core vault-descriptors-v1 (signet)', () => {
  it('reproduces the committed policyId and both checksummed descriptors', () => {
    const record = compose();
    expect(record.identity.policyId).toBe(SIGNET_EXPECTED.policyId);
    expect(record.identity.receiveDescriptor).toBe(SIGNET_EXPECTED.receiveDescriptor);
    expect(record.identity.changeDescriptor).toBe(SIGNET_EXPECTED.changeDescriptor);
  });

  it('surfaces the same checksums a human is asked to compare across devices', () => {
    const summary = summarizeVaultPolicy(compose());
    expect(summary.receiveChecksum).toBe(SIGNET_EXPECTED.receiveDescriptor.slice(-8));
    expect(summary.changeChecksum).toBe(SIGNET_EXPECTED.changeDescriptor.slice(-8));
    // The checksum really is the descriptor's own, not a recomputation that
    // could drift from the string actually shown and exported.
    expect(SIGNET_EXPECTED.receiveDescriptor.endsWith(`#${summary.receiveChecksum}`)).toBe(true);
  });

  it('derives the vector receive-0 address as the Vault first receive address', () => {
    const expected = SIGNET_EXPECTED.outputs.find(
      (output) => output.branch === 'receive' && output.index === 0,
    );
    expect(expected).toBeDefined();
    expect(summarizeVaultPolicy(compose()).firstReceiveAddress).toBe(expected!.address);
  });

  it('carries birthday and labels as metadata that cannot move policyId (ADR 0007 §4)', () => {
    const base = compose();
    const relabelled = composeVaultPolicyRecord('signet', SIGNET_SIGNERS, {
      ...METADATA,
      createdAtMs: '1767225600000',
      birthdayHeight: null,
      vaultLabel: 'Something else entirely',
      signerLabels: ['x', 'y', 'z'],
    });
    expect(relabelled.identity.policyId).toBe(base.identity.policyId);
    expect(relabelled.identity.receiveDescriptor).toBe(base.identity.receiveDescriptor);
  });
});

describe('C1 policy composition fails closed (ADR 0007 §§2-3)', () => {
  const [a, b, c] = SIGNET_SIGNERS;

  it('rejects reordered roles rather than silently re-sorting them', () => {
    // sortedmulti sorts derived child keys, but the A/B/C *source* order is what
    // makes the policy record canonical. Accepting a reorder would mint a second
    // policyId for the same three keys.
    expect(() => compose([b, a, c] as never)).toThrow();
    expect(() => compose([a, c, b] as never)).toThrow();
  });

  it('rejects a duplicated role — two copies of one signer are one vote', () => {
    expect(() => compose([a, b, b] as never)).toThrow();
    expect(() => compose([a, a, c] as never)).toThrow();
  });

  it('rejects a foreign key spliced into a real policy', () => {
    const foreign = contracts.records['mainnet']!.signers[2]!;
    expect(() => compose([a, b, { ...foreign, role: 'recovery-c' }] as never)).toThrow();
  });

  it('rejects a wrong-network policy and wrong-network members', () => {
    expect(() => composeVaultPolicyRecord('signet', contracts.records['mainnet']!.signers as never, METADATA)).toThrow();
    const mainnetC = contracts.records['mainnet']!.signers[2]!;
    expect(() => compose([a, b, mainnetC] as never)).toThrow();
  });

  it('rejects a fingerprint-only match: the xpub is what the policy commits to', () => {
    // The exact attack ADR 0007 §2 names — a record wearing a familiar
    // four-byte fingerprint but carrying somebody else's account key. Here it
    // is caught as a collision; in the worker the proof of possession over the
    // full origin refuses it first.
    const impostor: VaultSignerOriginV1 = {
      ...contracts.records['signet']!.signers[2]!,
      masterFingerprintHex: b!.masterFingerprintHex,
    };
    expect(collidesWithHeldRole(impostor, [b!])).toBe(true);
    expect(() => compose([a, b, impostor] as never)).toThrow();
  });

  it('treats a shared account xpub as a collision even under a different fingerprint', () => {
    const cloned: VaultSignerOriginV1 = { ...c!, masterFingerprintHex: 'deadbeef' };
    expect(collidesWithHeldRole(cloned, [c!])).toBe(true);
  });
});

describe('C1 recovery kit (ADR 0007 §6)', () => {
  it('binds the same policy identity, descriptors, and first address', () => {
    const record = compose();
    const kit = buildVaultRecoveryKit(record);
    expect(kit.policyId).toBe(SIGNET_EXPECTED.policyId);
    expect(kit.receiveDescriptor).toBe(SIGNET_EXPECTED.receiveDescriptor);
    expect(kit.changeDescriptor).toBe(SIGNET_EXPECTED.changeDescriptor);
    expect(kit.firstReceiveAddress).toBe(summarizeVaultPolicy(record).firstReceiveAddress);
  });

  it('names the published standalone recovery package by both digests', () => {
    const kit = buildVaultRecoveryKit(compose());
    // C7: a real, reproducible package now exists, so the kit names it. The
    // digests must reproduce from the pinned core tag — `tests/build/
    // vault-standalone-digest.test.ts` binds them to the pin, because a kit
    // whose digest does not reproduce is worse than one carrying the sentinel.
    expect(kit.standaloneToolSourceDigest).toBe(VAULT_STANDALONE_TOOL_RELEASE.sourceDigest);
    expect(kit.standaloneToolArtifactDigest).toBe(VAULT_STANDALONE_TOOL_RELEASE.artifactDigest);
    expect(kit.standaloneToolSourceDigest).not.toBe(VAULT_STANDALONE_TOOL_DIGEST_UNPUBLISHED);
    expect(kit.standaloneToolArtifactDigest).not.toBe(VAULT_STANDALONE_TOOL_DIGEST_UNPUBLISHED);
  });

  it('takes its prose from core, so writer and reader cannot drift apart', () => {
    const kit = buildVaultRecoveryKit(compose());
    expect(kit.compatibilityRequirements)
      .toEqual([...VAULT_RECOVERY_KIT_TEXT_V1.compatibilityRequirements]);
    expect(kit.recoveryInstructions).toBe(VAULT_RECOVERY_KIT_TEXT_V1.recoveryInstructions);
    expect(kit.rotationInstructions).toBe(VAULT_RECOVERY_KIT_TEXT_V1.rotationInstructions);
  });

  it('states both halves of the hardware-signer verification asymmetry', () => {
    const kit = buildVaultRecoveryKit(compose());
    const text = kit.compatibilityRequirements.join(' ');
    expect(text).toMatch(/two distinct logical roles/u);
    expect(text).toMatch(/Ordinals data source/u);
  });

  it('says plainly that deleting a role is not revocation', () => {
    expect(buildVaultRecoveryKit(compose()).rotationInstructions).toMatch(/not revocation/u);
  });
});

describe('descriptorChecksumOf', () => {
  it('returns the eight characters after the separator', () => {
    expect(descriptorChecksumOf(SIGNET_EXPECTED.receiveDescriptor)).toHaveLength(8);
    expect(
      SIGNET_EXPECTED.receiveDescriptor.slice(-9, -8),
    ).toBe('#');
  });
});
