/**
 * A stand-in for a signer running somebody else's firmware (Workstream C5).
 *
 * This deliberately does NOT go through `vault-signing.ts`, core's B2 signer,
 * or anything else in the Drey signing path. It does what an airgapped
 * third-party device does and no more: parse the PSBT, compute the BIP143
 * witness-v0 sighash, produce an ECDSA signature over it, put the signature in
 * `PSBT_IN_PARTIAL_SIG`, and hand the PSBT back. It has no idea what a plan
 * digest, an SQVB envelope, a classification, or an inscription is.
 *
 * That is the whole point. If the coordinator only accepted PSBTs its own
 * signer produced, the "PSBT is the signing truth, envelope is transport" rule
 * would be untested prose, and a hardware role C could not be added later
 * without a core re-tag.
 *
 * `lowR` is the interesting knob. Drey's own path grinds for a low R value, so
 * its DER signatures are 70 bytes plus the sighash byte. A device that does not
 * grind produces 71 bytes plus the sighash byte roughly half the time, which is
 * exactly the case the work plan flags as cheap to check now and expensive to
 * discover later.
 *
 * All keys here are the public disposable signet fixture roots.
 */
import { HDKey } from '@scure/bip32';
import { SigHash, Transaction } from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes } from '@drey/core/domain/vault/encoding';
import type {
  VaultPolicyIdentityV1,
  VaultSignerRole,
  VaultUnsignedPlanV1,
} from '@drey/core/domain/vault/multisig-contracts';
import { VAULT_ROLES } from '@drey/core/domain/vault/multisig-contracts';
import { signerRoot } from '../fixtures/vault-peer-signers';

export interface ThirdPartySignature {
  psbtHex: string;
  /** DER lengths actually produced, one per input, excluding the sighash byte. */
  derLengths: number[];
}

/**
 * Sign every input of `psbtHex` as one logical role, the way a foreign device
 * would.
 *
 * `signWith` overrides the key, so a test can model a device holding a root
 * that is not in the policy at all. `forceHighR` searches deterministically for
 * a signature whose R component needs 33 bytes, modelling a device that does no
 * low-R grinding; without it the ordinary RFC6979 signature is used, whatever
 * length that turns out to be.
 */
export function thirdPartySignedPsbt(input: {
  policy: VaultPolicyIdentityV1;
  plan: VaultUnsignedPlanV1;
  psbtHex: string;
  role: VaultSignerRole;
  signWith?: HDKey;
  forceHighR?: boolean;
  /**
   * Malformations a broken or hostile signer could produce. Each one is a
   * negative case `vault-psbt-v1.md` enumerates, reachable only from a signer
   * that is not core's — which is the only reason they are expressible here.
   */
  defect?: 'high-s' | 'sighash-single' | 'sighash-none' | 'truncated-der' | 'no-sighash-byte';
}): ThirdPartySignature {
  const origin = input.policy.signers[VAULT_ROLES.indexOf(input.role)]!;
  const root = input.signWith ?? signerRoot(input.role);
  const account = root.derive(origin.originPath);
  const tx = Transaction.fromPSBT(hexToBytes(input.psbtHex), { PSBTVersion: 0 });
  const derLengths: number[] = [];

  for (let index = 0; index < input.plan.inputs.length; index += 1) {
    const planned = input.plan.inputs[index]!;
    const child = account
      .deriveChild(planned.branch === 'receive' ? 0 : 1)
      .deriveChild(planned.derivationIndex);
    const message = tx.preimageWitnessV0(
      index,
      hexToBytes(planned.witnessScriptHex),
      SigHash.ALL,
      BigInt(planned.valueSats),
    );
    const der = signDer(message, child.privateKey!, input.forceHighR === true, input.defect);
    derLengths.push(der.length);
    const existing = tx.getInput(index).partialSig ?? [];
    tx.updateInput(
      index,
      { partialSig: [...existing, [child.publicKey!, appendSighash(der, input.defect)]] },
      true,
    );
    child.wipePrivateData();
  }
  account.wipePrivateData();
  return { psbtHex: bytesToHex(tx.toPSBT(0)), derLengths };
}

/**
 * A strict-DER, low-S signature.
 *
 * Low-S is not a stylistic choice a device gets to skip — consensus-adjacent
 * policy and core's own verifier both require it — so this always normalizes S
 * and varies only R, which is exactly the axis a grinding device controls.
 */
function signDer(
  message: Uint8Array,
  privateKey: Uint8Array,
  forceHighR: boolean,
  defect?: string,
): Uint8Array {
  for (let counter = 0; counter < 256; counter += 1) {
    const signature = secp256k1.sign(message, privateKey, {
      prehash: false,
      lowS: true,
      // A fixed first attempt keeps the ordinary case deterministic; later
      // attempts walk a counter so the search itself is reproducible.
      ...(counter === 0 ? {} : { extraEntropy: counterEntropy(counter) }),
    });
    // A high-S signature is the same point mirrored: s' = n - s. It verifies
    // under plain ECDSA and is refused by every low-S policy, including core's.
    const emitted =
      defect === 'high-s'
        ? new secp256k1.Signature(signature.r, CURVE_ORDER - signature.s)
        : signature;
    const der = emitted.toDERRawBytes();
    if (defect === 'truncated-der') return der.slice(0, der.length - 2);
    // 71 DER bytes means a 33-byte R, i.e. the high-R case a grinding signer
    // would have thrown away. 70 means it already had a low R.
    if (!forceHighR || der.length === 71) return der;
  }
  throw new Error('no high-R signature found; the search bound is too small');
}

/** The sighash byte a device appends — or, for a defect, the wrong one. */
function appendSighash(der: Uint8Array, defect?: string): Uint8Array {
  if (defect === 'no-sighash-byte') return Uint8Array.from(der);
  const byte =
    defect === 'sighash-single'
      ? SigHash.SINGLE
      : defect === 'sighash-none'
        ? SigHash.NONE
        : SigHash.ALL;
  return Uint8Array.from([...der, byte]);
}

const CURVE_ORDER = secp256k1.CURVE.n;

function counterEntropy(counter: number): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes[31] = counter & 0xff;
  bytes[30] = (counter >> 8) & 0xff;
  return bytes;
}
