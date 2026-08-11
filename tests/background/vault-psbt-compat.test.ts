/**
 * Hardware-signer compatibility probe (Workstream C5).
 *
 * The independent-work plan calls this out as the one thing worth checking
 * during C because it is cheap now and expensive later: B2's PSBT profile is
 * closed, and a device that adds a field, reorders maps, or emits a longer
 * signature could be rejected while producing a perfectly valid transaction.
 * Retrofitting that discovery after C ships costs a core re-tag and a spec
 * amendment.
 *
 * This suite does not change the profile. It records, executably, exactly what
 * a third-party signer may and may not do, so the answer is a test rather than
 * a recollection. Each case names the real firmware behaviour it models.
 *
 * Two findings are load-bearing enough to state up front:
 *
 *  - **The 72-byte witness reserve is exactly right, not merely generous.**
 *    Low-S is mandatory, so S is at most 32 bytes; a device that does no low-R
 *    grinding produces at most a 71-byte DER signature, which is 72 bytes with
 *    the sighash byte appended — precisely what the plan's vsize bound reserves
 *    per signature. A non-grinding signer is therefore accepted and lands at,
 *    not over, the bound.
 *  - **Echoing the full input map back is required, not optional.** The profile
 *    demands the witness UTXO, the sighash type, the witness script, and all
 *    three BIP32 derivations on every input. A signer that strips what it no
 *    longer needs — a common firmware economy — is rejected, and so is one that
 *    adds the non-witness UTXO some devices attach to segwit inputs.
 *
 * All material is public disposable signet fixture data. Nothing is broadcast.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { installTestCryptoProvider } from '../helpers/install-crypto-provider';
import { Transaction } from '@scure/btc-signer';
import { bytesToHex, hexToBytes } from '@drey/core/domain/vault/encoding';
import { validateVaultPsbt } from '@drey/core/domain/vault/multisig-psbt';
import {
  combineVaultSignedPsbts,
  finalizeVaultTransaction,
  signVaultPlanAsRole,
} from '../../src/background/vault-signing';
import { signerRoot } from '../fixtures/vault-peer-signers';
import {
  SCENARIO_NOW_MS,
  SIGNET_FULL,
  scenarioPolicy,
  scenarioWithdrawal,
} from '../fixtures/vault-signing-scenario';
import { thirdPartySignedPsbt } from '../helpers/third-party-signer';
import { editPsbt, entriesOfType, type PsbtEntry } from '../helpers/psbt-surgery';

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

/** The coordinator's own answer to "would you accept this PSBT?" */
function accepts(built: ReturnType<typeof scenarioWithdrawal>, psbtHex: string): boolean {
  try {
    validateVaultPsbt(scenarioPolicy(), built.plan, psbtHex);
    return true;
  } catch {
    return false;
  }
}

function shapeOf(built: ReturnType<typeof scenarioWithdrawal>) {
  return { inputCount: built.plan.inputs.length, outputCount: built.plan.outputs.length };
}

describe('probe: signature length (the low-R question)', () => {
  it('accepts a non-grinding signer, whose DER is one byte longer', () => {
    const built = scenarioWithdrawal();
    const grinding = thirdPartySignedPsbt({
      policy: scenarioPolicy(),
      plan: built.plan,
      psbtHex: built.psbtHex,
      role: 'mobile-b',
    });
    const nonGrinding = thirdPartySignedPsbt({
      policy: scenarioPolicy(),
      plan: built.plan,
      psbtHex: built.psbtHex,
      role: 'mobile-b',
      forceHighR: true,
    });
    // The case the work plan worried about: a 71-byte DER signature.
    expect(nonGrinding.derLengths).toEqual([71]);
    expect(grinding.derLengths[0]).toBeLessThanOrEqual(71);
    expect(accepts(built, nonGrinding.psbtHex)).toBe(true);
  });

  it('finalizes a non-grinding signature at, not over, the plan vsize bound', () => {
    // The bound reserves 72 witness bytes per signature: a 71-byte DER plus the
    // sighash byte. Low-S is mandatory, so 71 is the maximum a device can
    // produce and the reserve cannot be exceeded by a valid signature.
    const built = scenarioWithdrawal();
    const device = thirdPartySignedPsbt({
      policy: scenarioPolicy(),
      plan: built.plan,
      psbtHex: built.psbtHex,
      role: 'recovery-c',
      forceHighR: true,
    });
    const drey = signVaultPlanAsRole({
      ...context(built),
      role: 'desktop-a',
      signerRoot: signerRoot('desktop-a'),
      psbtHex: built.psbtHex,
    });
    const combined = combineVaultSignedPsbts({
      ...context(built),
      psbtHexes: [drey.signedPsbtHex, device.psbtHex],
    });
    const final = finalizeVaultTransaction({ ...context(built), psbtHex: combined.psbtHex });
    expect(final.vsize).toBeLessThanOrEqual(built.plan.vsize);

    // And the same quorum with two grinding signatures is smaller, which is
    // what makes the bound an upper bound rather than an equality.
    const grinding = thirdPartySignedPsbt({
      policy: scenarioPolicy(),
      plan: built.plan,
      psbtHex: built.psbtHex,
      role: 'recovery-c',
    });
    const lean = finalizeVaultTransaction({
      ...context(built),
      psbtHex: combineVaultSignedPsbts({
        ...context(built),
        psbtHexes: [drey.signedPsbtHex, grinding.psbtHex],
      }).psbtHex,
    });
    expect(lean.vsize).toBeLessThanOrEqual(final.vsize);
  });
});

describe('probe: map ordering', () => {
  it('accepts an input map whose entries arrive in a different order', () => {
    // Bitcoin Core is already known to preserve a different valid entry order
    // (`vault-psbt-v1.md`), and BIP174 imposes no ordering on key/value pairs
    // within a map. The profile checks key sets and cardinality, so order is
    // genuinely free — recorded here because a signer that sorts differently is
    // the single most likely benign difference.
    const built = scenarioWithdrawal();
    const reversed = editPsbt(built.psbtHex, shapeOf(built), (maps) => {
      maps.inputs = maps.inputs.map((map) => [...map].reverse());
    });
    expect(reversed).not.toBe(built.psbtHex);
    expect(accepts(built, reversed)).toBe(true);
  });

  it('combines a signed PSBT whose field types were reordered', () => {
    // Moving whole fields around — sighash before witness UTXO, say — survives
    // all the way through combination.
    const built = scenarioWithdrawal();
    const device = thirdPartySignedPsbt({
      policy: scenarioPolicy(),
      plan: built.plan,
      psbtHex: built.psbtHex,
      role: 'mobile-b',
    });
    const reordered = editPsbt(device.psbtHex, shapeOf(built), (maps) => {
      // Preserve the relative order of the three derivations; move everything
      // else. That distinction is the subject of the next case.
      maps.inputs = maps.inputs.map((map) => [
        ...map.filter((entry) => entry.key[0] !== 0x06).reverse(),
        ...entriesOfType(map, 0x06),
      ]);
    });
    expect(reordered).not.toBe(device.psbtHex);
    expect(accepts(built, reordered)).toBe(true);
    expect(
      combineVaultSignedPsbts({
        ...context(built),
        psbtHexes: [
          signVaultPlanAsRole({
            ...context(built),
            role: 'desktop-a',
            signerRoot: signerRoot('desktop-a'),
            psbtHex: built.psbtHex,
          }).signedPsbtHex,
          reordered,
        ],
      }).roles,
    ).toEqual(['desktop-a', 'mobile-b']);
  });

  it('FINDING: reordered BIP32 derivations validate but cannot be combined', () => {
    // The one asymmetry this probe found, recorded rather than fixed.
    //
    // `validateVaultPsbt` sorts both sides before comparing derivations, so a
    // PSBT whose three BIP32 entries arrive in a different order is inside the
    // profile and validates. `combineVaultPsbts` then compares a JSON snapshot
    // of each PSBT's parsed meaning, and that snapshot preserves *array* order
    // for `bip32Derivation` — so the same PSBT is refused at combination with
    // "combined PSBT signing meaning differs".
    //
    // A device is free to emit these in any order; BIP174 imposes none, and
    // core itself already treats the order as insignificant one function
    // earlier. The refusal is therefore a false negative rather than a safety
    // property, but it is core's to fix (a re-tag), it fails closed, and no
    // signer this coordinator currently talks to reorders them. Left as is,
    // with the behaviour pinned so a later core change is a deliberate one.
    const built = scenarioWithdrawal();
    const device = thirdPartySignedPsbt({
      policy: scenarioPolicy(),
      plan: built.plan,
      psbtHex: built.psbtHex,
      role: 'mobile-b',
    });
    const shuffled = editPsbt(device.psbtHex, shapeOf(built), (maps) => {
      maps.inputs = maps.inputs.map((map) => {
        const derivations = entriesOfType(map, 0x06);
        return [...map.filter((entry) => entry.key[0] !== 0x06), ...derivations.reverse()];
      });
    });
    // Inside the closed profile...
    expect(accepts(built, shuffled)).toBe(true);
    // ...and refused by the combiner all the same.
    expect(() =>
      combineVaultSignedPsbts({
        ...context(built),
        psbtHexes: [
          signVaultPlanAsRole({
            ...context(built),
            role: 'desktop-a',
            signerRoot: signerRoot('desktop-a'),
            psbtHex: built.psbtHex,
          }).signedPsbtHex,
          shuffled,
        ],
      }),
    ).toThrow(/signing meaning differs/u);
  });
});

describe('probe: fields a device might add', () => {
  it('rejects the non-witness UTXO some firmware attaches to a segwit input', () => {
    // The most consequential finding. Several signers require, or echo back,
    // PSBT_IN_NON_WITNESS_UTXO (0x00) even for a witness input. The profile
    // enumerates 0x01/0x03/0x05 and nothing else, so such a PSBT is refused.
    // Not changed here: accepting it would mean accepting a second, redundant
    // statement of the prevout, and the whole point of the closed profile is
    // that there is exactly one place each signing fact comes from.
    const built = scenarioWithdrawal();
    const prevTx = Transaction.fromRaw(hexToBytes(built.plan.unsignedTransactionHex));
    const withNonWitness = editPsbt(built.psbtHex, shapeOf(built), (maps) => {
      maps.inputs[0]!.push({ key: Uint8Array.of(0x00), value: prevTx.unsignedTx });
    });
    expect(accepts(built, withNonWitness)).toBe(false);
  });

  it('rejects a proprietary field, which is how devices carry vendor state', () => {
    const built = scenarioWithdrawal();
    const proprietary = editPsbt(built.psbtHex, shapeOf(built), (maps) => {
      maps.inputs[0]!.push({
        key: Uint8Array.of(0xfc, 0x04, 0x74, 0x65, 0x73, 0x74),
        value: Uint8Array.of(0x01),
      });
    });
    expect(accepts(built, proprietary)).toBe(false);
  });

  it('rejects a global xpub, which some coordinators add for their own display', () => {
    const built = scenarioWithdrawal();
    const globalXpub = editPsbt(built.psbtHex, shapeOf(built), (maps) => {
      maps.global.push({ key: Uint8Array.of(0x01, ...new Uint8Array(78)), value: new Uint8Array(4) });
    });
    expect(accepts(built, globalXpub)).toBe(false);
  });

  it('rejects signing metadata on the destination output', () => {
    // A device that helpfully annotates every output would fail here. Only a
    // current-policy Vault change output may carry a witness script and
    // derivations; annotating the destination would blur the one distinction
    // that says which output is ours.
    const built = scenarioWithdrawal();
    const changeIndex = built.plan.outputs.findIndex(
      (output) => output.purpose === 'vault-change',
    );
    expect(changeIndex).toBeGreaterThan(0);
    const annotated = editPsbt(built.psbtHex, shapeOf(built), (maps) => {
      maps.outputs[0] = [...maps.outputs[changeIndex]!];
    });
    expect(accepts(built, annotated)).toBe(false);
  });
});

describe('probe: fields a device might drop', () => {
  // Each case names the firmware economy it models: a signer that trusts the
  // coordinator for prevout values, one that assumes SIGHASH_ALL rather than
  // stating it, and one that returns only the fields it changed.
  const cases: Array<[string, number]> = [
    ['the witness UTXO', 0x01],
    ['the sighash type', 0x03],
    ['the witness script', 0x05],
  ];

  it.each(cases)('rejects a PSBT with %s removed', (_label, type) => {
    const built = scenarioWithdrawal();
    const stripped = editPsbt(built.psbtHex, shapeOf(built), (maps) => {
      maps.inputs[0] = maps.inputs[0]!.filter((entry) => entry.key[0] !== type);
    });
    expect(accepts(built, stripped)).toBe(false);
  });

  it('rejects a PSBT keeping only the signing role own derivation', () => {
    // A real economy: an airgapped device has no use for its co-signers'
    // derivation paths and may return only its own. The profile requires all
    // three on every input, because that is what proves the input is owned by
    // the complete policy rather than by one key.
    const built = scenarioWithdrawal();
    const device = thirdPartySignedPsbt({
      policy: scenarioPolicy(),
      plan: built.plan,
      psbtHex: built.psbtHex,
      role: 'mobile-b',
    });
    const ownOnly = editPsbt(device.psbtHex, shapeOf(built), (maps) => {
      maps.inputs = maps.inputs.map((map) => {
        const derivations = entriesOfType(map, 0x06);
        const keep: PsbtEntry[] = [derivations[1]!];
        return [...map.filter((entry) => entry.key[0] !== 0x06), ...keep];
      });
    });
    expect(accepts(built, ownOnly)).toBe(false);
  });

  it('rejects a duplicated derivation entry', () => {
    const built = scenarioWithdrawal();
    const duplicated = editPsbt(built.psbtHex, shapeOf(built), (maps) => {
      const derivations = entriesOfType(maps.inputs[0]!, 0x06);
      // A distinct key with an already-present origin: four entries where the
      // profile allows exactly three.
      maps.inputs[0]!.push({
        key: Uint8Array.of(0x06, ...new Uint8Array(33).fill(0x02)),
        value: derivations[0]!.value,
      });
    });
    expect(accepts(built, duplicated)).toBe(false);
  });
});

describe('probe: what the coordinator does with a rejection', () => {
  it('refuses to combine an out-of-profile PSBT rather than repairing it', () => {
    // The route a device's output would actually take. A coordinator that
    // silently normalized a foreign PSBT into the profile would be signing for
    // a transaction the device never reviewed in the form the device saw.
    const built = scenarioWithdrawal();
    const device = thirdPartySignedPsbt({
      policy: scenarioPolicy(),
      plan: built.plan,
      psbtHex: built.psbtHex,
      role: 'recovery-c',
    });
    const outOfProfile = editPsbt(device.psbtHex, shapeOf(built), (maps) => {
      maps.inputs[0]!.push({
        key: Uint8Array.of(0xfc, 0x03, 0x64, 0x65, 0x76),
        value: Uint8Array.of(0x01),
      });
    });
    const drey = signVaultPlanAsRole({
      ...context(built),
      role: 'desktop-a',
      signerRoot: signerRoot('desktop-a'),
      psbtHex: built.psbtHex,
    });
    expect(() =>
      combineVaultSignedPsbts({
        ...context(built),
        psbtHexes: [drey.signedPsbtHex, outOfProfile],
      }),
    ).toThrow();
    // ...and the same device's unmodified output combines, so the refusal is
    // about the extra field and not about the device.
    expect(
      combineVaultSignedPsbts({
        ...context(built),
        psbtHexes: [drey.signedPsbtHex, device.psbtHex],
      }).roles,
    ).toEqual(['desktop-a', 'recovery-c']);
  });

  it('round-trips its own PSBT through the surgery helper unchanged', () => {
    // Guards the probe itself: a helper that quietly rewrote bytes would make
    // every "rejected" result above meaningless.
    const built = scenarioWithdrawal();
    expect(editPsbt(built.psbtHex, shapeOf(built), () => undefined)).toBe(built.psbtHex);
    expect(bytesToHex(hexToBytes(built.psbtHex))).toBe(built.psbtHex);
  });
});
