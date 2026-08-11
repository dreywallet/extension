/**
 * Workstream C5 exit gate: partial signing, combination, and finalization.
 *
 * The claims under test:
 *
 * - ADR 0007 §8 the capability gate is *consumed*, not merely expressible: a
 *   mainnet unsigned-only coordinator refuses to sign, combine, or finalize,
 *   and a signet full one permits all three;
 * - A+B, A+C, and B+C each produce a valid finalized transaction whose actual
 *   vsize is within the plan's upper bound, repeatably;
 * - duplicate logical roles and foreign keys are refused;
 * - a plain signed PSBT from a signer that knows nothing of the SQVB envelope
 *   combines and finalizes — the PSBT is the signing truth, the envelope is
 *   transport;
 * - the mutations `vault-psbt-v1.md` enumerates are refused through the
 *   coordinator's own entry points, not only inside core; and
 * - nothing broadcasts. A finalized transaction is a hex string that goes
 *   nowhere.
 *
 * All three roots are public disposable signet fixtures. Nothing is funded.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { Transaction } from '@scure/btc-signer';
import { bytesToHex, hexToBytes } from '@drey/core/domain/vault/encoding';
import { VaultAssetPolicyError } from '@drey/core/domain/vault/multisig-asset-policy';
import { vaultPsbtHash } from '@drey/core/domain/vault/multisig-encoding';
import type { VaultSignerRole } from '@drey/core/domain/vault/multisig-contracts';
import {
  assertVaultSigningAllowed,
  combineVaultPartialResults,
  combineVaultSignedPsbts,
  finalizeVaultTransaction,
  signVaultPlanAsRole,
  VaultSigningNotPermittedError,
} from '../../src/background/vault-signing';
import { mnemonicToSeed } from '@drey/core/domain/keys/mnemonic';
import { composeVaultPolicyRecord } from '../../src/background/vault-policy';
import { deriveVaultRoleOrigin } from '@drey/core/domain/vault/multisig-role';
import {
  FOREIGN_DESKTOP_MNEMONIC,
  foreignSignerRoot,
  signerOrigin,
  signerRoot,
} from '../fixtures/vault-peer-signers';
import {
  MAINNET_UNSIGNED_ONLY,
  SCENARIO_NOW_MS,
  SIGNET_FULL,
  scenarioPolicy,
  scenarioUtxo,
  scenarioWithdrawal,
} from '../fixtures/vault-signing-scenario';
import { thirdPartySignedPsbt } from '../helpers/third-party-signer';

beforeAll(installTestCryptoProvider);

const NOW = String(SCENARIO_NOW_MS);

function context(built = scenarioWithdrawal()) {
  return {
    capability: SIGNET_FULL,
    policy: scenarioPolicy(),
    plan: built.plan,
    evidence: built.evidence,
    nowMs: NOW,
  };
}

/** Sign as one role through the coordinator's own entry point. */
function signAs(role: VaultSignerRole, built = scenarioWithdrawal()) {
  return signVaultPlanAsRole({
    ...context(built),
    role,
    signerRoot: signerRoot(role),
    psbtHex: built.psbtHex,
  });
}

const QUORUMS: ReadonlyArray<[VaultSignerRole, VaultSignerRole]> = [
  ['desktop-a', 'mobile-b'],
  ['desktop-a', 'recovery-c'],
  ['mobile-b', 'recovery-c'],
];

describe('C5 capability gate (ADR 0007 §8, amended)', () => {
  // The loose end C0 left: `canSignVaultValue` existed and nothing consumed it,
  // so mainnet signing was prevented only by the absence of signing code.
  it('permits a signet full coordinator and refuses a mainnet unsigned-only one', () => {
    expect(() => assertVaultSigningAllowed(SIGNET_FULL)).not.toThrow();
    expect(() => assertVaultSigningAllowed(MAINNET_UNSIGNED_ONLY)).toThrow(
      VaultSigningNotPermittedError,
    );
  });

  it('refuses to sign, combine, or finalize on the unsigned-only pilot', () => {
    const built = scenarioWithdrawal();
    const signed = signAs('desktop-a', built);
    const other = signAs('mobile-b', built);
    const combined = combineVaultPartialResults({
      ...context(built),
      results: [signed, other],
    });
    // Every one of them is a perfectly valid signet operation. What refuses it
    // is the build's capability, and nothing in the arguments can change that.
    const pilot = { ...context(built), capability: MAINNET_UNSIGNED_ONLY };
    expect(() =>
      signVaultPlanAsRole({
        ...pilot,
        role: 'desktop-a',
        signerRoot: signerRoot('desktop-a'),
        psbtHex: built.psbtHex,
      }),
    ).toThrow(VaultSigningNotPermittedError);
    expect(() =>
      combineVaultPartialResults({ ...pilot, results: [signed, other] }),
    ).toThrow(VaultSigningNotPermittedError);
    expect(() =>
      combineVaultSignedPsbts({
        ...pilot,
        psbtHexes: [signed.signedPsbtHex, other.signedPsbtHex],
      }),
    ).toThrow(VaultSigningNotPermittedError);
    expect(() =>
      finalizeVaultTransaction({ ...pilot, psbtHex: combined.psbtHex }),
    ).toThrow(VaultSigningNotPermittedError);
  });

  it('refuses before touching a private key', () => {
    // The gate is the first statement in each entry point, so a refusal cannot
    // be a signature that was produced and then discarded.
    const built = scenarioWithdrawal();
    const root = signerRoot('desktop-a');
    const before = bytesToHex(root.privateKey!);
    expect(() =>
      signVaultPlanAsRole({
        ...context(built),
        capability: MAINNET_UNSIGNED_ONLY,
        role: 'desktop-a',
        signerRoot: root,
        psbtHex: built.psbtHex,
      }),
    ).toThrow(VaultSigningNotPermittedError);
    // Core wipes a signing root's derived children as it goes; an untouched
    // root still holds its own key.
    expect(bytesToHex(root.privateKey!)).toBe(before);
  });
});

describe('C5 two-role quorums (ADR 0007 §§2-3)', () => {
  it.each(QUORUMS)('finalizes %s + %s within the approved vsize bound', (first, second) => {
    const built = scenarioWithdrawal();
    const results = [signAs(first, built), signAs(second, built)];
    expect(results.map((result) => result.roleAdded)).toEqual([first, second]);

    const combined = combineVaultPartialResults({ ...context(built), results });
    expect(combined.roles).toEqual([first, second].sort());

    const final = finalizeVaultTransaction({ ...context(built), psbtHex: combined.psbtHex });
    expect(final.roles).toEqual([first, second].sort());
    // The bound reserves a maximum-length DER signature per input, so the real
    // transaction can only come in at or under it. Core asserts this too; it is
    // restated here because it is the C5 exit gate in so many words.
    expect(final.vsize).toBeLessThanOrEqual(built.plan.vsize);
    expect(final.txid).toMatch(/^[0-9a-f]{64}$/u);

    // The finalized bytes really are a spend of the planned prevouts.
    const tx = Transaction.fromRaw(hexToBytes(final.transactionHex));
    expect(bytesToHex(tx.unsignedTx)).toBe(built.plan.unsignedTransactionHex);
    expect(tx.inputsLength).toBe(built.plan.inputs.length);
  });

  it('is repeatable and deterministic for one quorum', () => {
    const first = scenarioWithdrawal();
    const second = scenarioWithdrawal();
    const finalize = (built: ReturnType<typeof scenarioWithdrawal>) =>
      finalizeVaultTransaction({
        ...context(built),
        psbtHex: combineVaultPartialResults({
          ...context(built),
          results: [signAs('desktop-a', built), signAs('mobile-b', built)],
        }).psbtHex,
      });
    expect(finalize(first).transactionHex).toBe(finalize(second).transactionHex);
    // Four full quorum signings plus two plan constructions. It clears the
    // default timeout alone and misses it under full-suite load, which is a
    // property of real secp256k1 work rather than of the assertion.
  }, 20_000);

  it('finalizes A+B when all three roles signed', () => {
    // `vault-psbt-v1.md`: with three signatures the quorum is deterministic.
    const built = scenarioWithdrawal();
    const combined = combineVaultPartialResults({
      ...context(built),
      results: [signAs('desktop-a', built), signAs('mobile-b', built), signAs('recovery-c', built)],
    });
    expect(combined.roles).toHaveLength(3);
    expect(
      finalizeVaultTransaction({ ...context(built), psbtHex: combined.psbtHex }).roles,
    ).toEqual(['desktop-a', 'mobile-b']);
  });

  it('signs a multi-input plan on every input or not at all', () => {
    const built = scenarioWithdrawal({
      utxos: [scenarioUtxo(0, '60000'), scenarioUtxo(1, '70000')],
      amountSats: '100000',
    });
    expect(built.plan.inputs.length).toBe(2);
    const final = finalizeVaultTransaction({
      ...context(built),
      psbtHex: combineVaultPartialResults({
        ...context(built),
        results: [signAs('desktop-a', built), signAs('recovery-c', built)],
      }).psbtHex,
    });
    expect(final.vsize).toBeLessThanOrEqual(built.plan.vsize);
  });
});

describe('C5 refuses what a quorum is not', () => {
  it('refuses a second signature from the same logical role', () => {
    const built = scenarioWithdrawal();
    const once = signAs('desktop-a', built);
    // The same role signing the already-signed PSBT: one root is one vote, and
    // a second device copy of it is still one vote.
    expect(() =>
      signVaultPlanAsRole({
        ...context(built),
        role: 'desktop-a',
        signerRoot: signerRoot('desktop-a'),
        psbtHex: once.signedPsbtHex,
      }),
    ).toThrow();
    expect(() =>
      combineVaultPartialResults({ ...context(built), results: [once, once] }),
    ).toThrow();
  });

  it('refuses a root that is not in this policy', () => {
    const built = scenarioWithdrawal();
    expect(() =>
      signVaultPlanAsRole({
        ...context(built),
        role: 'desktop-a',
        signerRoot: foreignSignerRoot(),
        psbtHex: built.psbtHex,
      }),
    ).toThrow(/origin|xpub|fingerprint/iu);
  });

  it('refuses a root that holds a different role of this same policy', () => {
    // Fingerprints are review labels (ADR §2). Claiming to be A while holding
    // B's key must fail on the complete origin, not pass on a label.
    const built = scenarioWithdrawal();
    expect(() =>
      signVaultPlanAsRole({
        ...context(built),
        role: 'desktop-a',
        signerRoot: signerRoot('mobile-b'),
        psbtHex: built.psbtHex,
      }),
    ).toThrow();
  });

  it('refuses to finalize below quorum', () => {
    const built = scenarioWithdrawal();
    const one = signAs('desktop-a', built);
    expect(() =>
      finalizeVaultTransaction({ ...context(built), psbtHex: one.signedPsbtHex }),
    ).toThrow(/quorum/iu);
  });

  it('refuses a result bound to a different plan', () => {
    const first = scenarioWithdrawal();
    const other = scenarioWithdrawal({ amountSats: '120000' });
    expect(other.plan.planDigest).not.toBe(first.plan.planDigest);
    expect(() =>
      combineVaultPartialResults({
        ...context(first),
        results: [signAs('desktop-a', first), signAs('mobile-b', other)],
      }),
    ).toThrow();
  });

  it('refuses signing outside the plan and evidence freshness windows', () => {
    const built = scenarioWithdrawal();
    for (const nowMs of [
      String(SCENARIO_NOW_MS - 1),
      String(BigInt(built.plan.expiresAtMs) + 1n),
    ]) {
      expect(() =>
        signVaultPlanAsRole({
          ...context(built),
          nowMs,
          role: 'desktop-a',
          signerRoot: signerRoot('desktop-a'),
          psbtHex: built.psbtHex,
        }),
      ).toThrow();
    }
  });

  it('refuses evidence that no longer matches the plan', () => {
    // The B3 wrapper runs before the key is used, so a stale or substituted
    // evidence set stops a signature rather than being noticed afterwards.
    const built = scenarioWithdrawal();
    // Genuinely stale rather than malformed: the evidence's own validity
    // window closes before the signing time, which is the case a signer meets
    // when a plan sits unapproved for too long.
    const stale = { ...built.evidence, validUntilMs: String(SCENARIO_NOW_MS - 1) };
    expect(() =>
      signVaultPlanAsRole({
        ...context(built),
        evidence: stale,
        role: 'desktop-a',
        signerRoot: signerRoot('desktop-a'),
        psbtHex: built.psbtHex,
      }),
    ).toThrow(VaultAssetPolicyError);
  });

  it('refuses a PSBT whose unsigned bytes were changed', () => {
    const built = scenarioWithdrawal();
    const tampered = Transaction.fromPSBT(hexToBytes(built.psbtHex), { PSBTVersion: 0 });
    const raw = Transaction.fromRaw(hexToBytes(built.plan.unsignedTransactionHex));
    // Redirect the destination to the change script: same shape, different
    // recipient. The plan's own bytes are what must be signed.
    const rebuilt = new Transaction({ PSBTVersion: 0, lowR: true });
    for (let index = 0; index < raw.inputsLength; index += 1) {
      const input = raw.getInput(index);
      rebuilt.addInput({ txid: input.txid!, index: input.index!, sequence: input.sequence! });
    }
    rebuilt.addOutput({
      script: raw.getOutput(1)!.script!,
      amount: raw.getOutput(0)!.amount!,
    });
    rebuilt.addOutput({ script: raw.getOutput(1)!.script!, amount: raw.getOutput(1)!.amount! });
    expect(bytesToHex(rebuilt.unsignedTx)).not.toBe(built.plan.unsignedTransactionHex);
    expect(tampered.inputsLength).toBe(raw.inputsLength);
    expect(() =>
      signVaultPlanAsRole({
        ...context(built),
        role: 'desktop-a',
        signerRoot: signerRoot('desktop-a'),
        psbtHex: bytesToHex(rebuilt.toPSBT(0)),
      }),
    ).toThrow();
  });
});

describe('C5 refuses every malformed signature vault-psbt-v1 enumerates', () => {
  // These are only expressible from a signer that is not core's: core's own
  // path cannot emit a high-S, non-ALL, or truncated signature. Reaching them
  // through the third-party door is the point — that door is the one place a
  // signature this coordinator did not produce can arrive.
  const defects = [
    ['a high-S signature', 'high-s'],
    ['SIGHASH_SINGLE', 'sighash-single'],
    ['SIGHASH_NONE', 'sighash-none'],
    ['a truncated DER body', 'truncated-der'],
    ['no appended sighash byte', 'no-sighash-byte'],
  ] as const;

  it.each(defects)('refuses %s', (_label, defect) => {
    const built = scenarioWithdrawal();
    const device = thirdPartySignedPsbt({
      policy: scenarioPolicy(),
      plan: built.plan,
      psbtHex: built.psbtHex,
      role: 'mobile-b',
      defect,
    });
    expect(() =>
      combineVaultSignedPsbts({
        ...context(built),
        psbtHexes: [signAs('desktop-a', built).signedPsbtHex, device.psbtHex],
      }),
    ).toThrow();
  });

  it('accepts the same signer with no defect, so the refusals are about the defect', () => {
    const built = scenarioWithdrawal();
    expect(
      combineVaultSignedPsbts({
        ...context(built),
        psbtHexes: [
          signAs('desktop-a', built).signedPsbtHex,
          thirdPartySignedPsbt({
            policy: scenarioPolicy(),
            plan: built.plan,
            psbtHex: built.psbtHex,
            role: 'mobile-b',
          }).psbtHex,
        ],
      }).roles,
    ).toEqual(['desktop-a', 'mobile-b']);
  });

  it('refuses a plan validated against a policy it does not belong to', () => {
    // Foreign policy: the same three-of-a-kind shape with a different role A,
    // so every identity binding has to catch it rather than the descriptor
    // merely looking wrong.
    const built = scenarioWithdrawal();
    const foreign = composeVaultPolicyRecord(
      'signet',
      [
        deriveVaultRoleOrigin(mnemonicToSeed(FOREIGN_DESKTOP_MNEMONIC), 'desktop-a', 'signet'),
        signerOrigin('mobile-b'),
        signerOrigin('recovery-c'),
      ],
      {
        createdAtMs: '1735689600000',
        birthdayHeight: 250_000,
        vaultLabel: 'Foreign Vault (signet test)',
        signerLabels: ['A', 'B', 'C'],
      },
    ).identity;
    expect(foreign.policyId).not.toBe(scenarioPolicy().policyId);
    expect(() =>
      signVaultPlanAsRole({
        ...context(built),
        policy: foreign,
        role: 'mobile-b',
        signerRoot: signerRoot('mobile-b'),
        psbtHex: built.psbtHex,
      }),
    ).toThrow();
  });
});

describe('C5 the plain-PSBT hardware door', () => {
  it('combines and finalizes a PSBT from a signer that never saw the envelope', () => {
    // The constraint the work plan states outright: the PSBT is the signing
    // truth and the SQVB envelope is transport. This signer produces a raw
    // PSBT with a partial signature and nothing else — no plan digest, no
    // canonical plan bytes, no SQVB record of any kind.
    const built = scenarioWithdrawal();
    const dreySide = signAs('desktop-a', built);
    const device = thirdPartySignedPsbt({
      policy: scenarioPolicy(),
      plan: built.plan,
      psbtHex: built.psbtHex,
      role: 'recovery-c',
    });
    expect(device.psbtHex).not.toBe(dreySide.signedPsbtHex);

    const combined = combineVaultSignedPsbts({
      ...context(built),
      psbtHexes: [dreySide.signedPsbtHex, device.psbtHex],
    });
    expect(combined.roles).toEqual(['desktop-a', 'recovery-c']);

    const final = finalizeVaultTransaction({ ...context(built), psbtHex: combined.psbtHex });
    expect(final.roles).toEqual(['desktop-a', 'recovery-c']);
    expect(final.vsize).toBeLessThanOrEqual(built.plan.vsize);
  });

  it('combines two third-party PSBTs with no Drey signer involved at all', () => {
    // The provider-independent shape: neither signature came from this
    // codebase's signing path.
    const built = scenarioWithdrawal();
    const combined = combineVaultSignedPsbts({
      ...context(built),
      psbtHexes: [
        thirdPartySignedPsbt({
          policy: scenarioPolicy(),
          plan: built.plan,
          psbtHex: built.psbtHex,
          role: 'mobile-b',
        }).psbtHex,
        thirdPartySignedPsbt({
          policy: scenarioPolicy(),
          plan: built.plan,
          psbtHex: built.psbtHex,
          role: 'recovery-c',
        }).psbtHex,
      ],
    });
    expect(
      finalizeVaultTransaction({ ...context(built), psbtHex: combined.psbtHex }).roles,
    ).toEqual(['mobile-b', 'recovery-c']);
  });

  it('still applies the full B3 asset policy to a plain PSBT', () => {
    // Dropping the envelope must not drop asset safety: the envelope never
    // provided it. The B3 validator runs over every incoming raw PSBT.
    const built = scenarioWithdrawal();
    const device = thirdPartySignedPsbt({
      policy: scenarioPolicy(),
      plan: built.plan,
      psbtHex: built.psbtHex,
      role: 'mobile-b',
    });
    expect(() =>
      combineVaultSignedPsbts({
        ...context(built),
        evidence: { ...built.evidence, validUntilMs: String(SCENARIO_NOW_MS - 1) },
        psbtHexes: [signAs('desktop-a', built).signedPsbtHex, device.psbtHex],
      }),
    ).toThrow(VaultAssetPolicyError);
  });

  it('refuses a plain PSBT signed by a key outside the policy', () => {
    const built = scenarioWithdrawal();
    expect(() =>
      combineVaultSignedPsbts({
        ...context(built),
        psbtHexes: [
          signAs('desktop-a', built).signedPsbtHex,
          thirdPartySignedPsbt({
            policy: scenarioPolicy(),
            plan: built.plan,
            psbtHex: built.psbtHex,
            role: 'recovery-c',
            signWith: foreignSignerRoot(),
          }).psbtHex,
        ],
      }),
    ).toThrow();
  });

  it('refuses two plain PSBTs carrying the same logical role', () => {
    const built = scenarioWithdrawal();
    const once = thirdPartySignedPsbt({
      policy: scenarioPolicy(),
      plan: built.plan,
      psbtHex: built.psbtHex,
      role: 'mobile-b',
    });
    expect(() =>
      combineVaultSignedPsbts({ ...context(built), psbtHexes: [once.psbtHex, once.psbtHex] }),
    ).toThrow();
  });
});

describe('C5 opens no broadcast path', () => {
  it('imports nothing that could send a transaction anywhere', () => {
    // Broadcast, replacement construction, and indeterminate-outcome handling
    // are C6. Asserted on the module's dependencies rather than on the words in
    // it: prose about what is deferred is exactly what a keyword scan would
    // trip over, while an import list is what actually bounds its reach.
    const source = readFileSync(
      new URL('../../src/background/vault-signing.ts', import.meta.url),
      'utf8',
    );
    const specifiers = [...source.matchAll(/from '([^']+)'/gu)].map((match) => match[1]!);
    expect(specifiers.sort()).toEqual([
      './vault-capability',
      '@drey/core/domain/vault/multisig-asset-policy',
      '@drey/core/domain/vault/multisig-contracts',
      '@drey/core/domain/vault/multisig-psbt',
      '@scure/bip32',
    ]);
    // ...and the raw B2 signing/finalization functions `vault-asset-policy-v1`
    // reserves for conformance and provider-independent recovery are not among
    // what it pulled from the one B2 module it does touch.
    for (const reserved of ['signVaultPartialSignature', 'finalizeVaultPsbt']) {
      expect(source, reserved).not.toContain(`  ${reserved},`);
    }
    // No network primitive of any kind.
    for (const global of ['fetch(', 'XMLHttpRequest', 'chrome.', 'navigator.']) {
      expect(source, global).not.toContain(global);
    }
  });

  it('returns a transaction that has been verified but not sent', () => {
    const built = scenarioWithdrawal();
    const final = finalizeVaultTransaction({
      ...context(built),
      psbtHex: combineVaultPartialResults({
        ...context(built),
        results: [signAs('desktop-a', built), signAs('mobile-b', built)],
      }).psbtHex,
    });
    // Everything the caller gets is inert data about a transaction nobody has
    // seen: hex, its ids, its size, and which roles approved it.
    expect(Object.keys(final).sort()).toEqual([
      'roles',
      'transactionHex',
      'txid',
      'version',
      'vsize',
      'wtxid',
    ]);
  });

  it('never lets a signature reach a PSBT hash the request did not name', () => {
    const built = scenarioWithdrawal();
    const result = signAs('desktop-a', built);
    expect(result.priorPsbtHash).toBe(vaultPsbtHash(built.psbtHex));
    expect(result.signedPsbtHash).toBe(vaultPsbtHash(result.signedPsbtHex));
    expect(result.planDigest).toBe(built.plan.planDigest);
  });
});
