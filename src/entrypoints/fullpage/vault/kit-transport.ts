/**
 * Transport encodings for the ADR 0007 §6 public recovery kit — the pure half
 * of download/QR/print, kept out of the component so the encodings are
 * unit-testable against the standalone tool's actual reader contract.
 *
 * The kit is public, non-spending material by construction; these functions
 * only re-encode `kitHex`, so nothing here can reach a secret. The receiving
 * end is `read-kit --kit <file>` in core's standalone recovery package, whose
 * `verifyKitHex` strips all whitespace and accepts either hex case — which is
 * what makes both a line-wrapped printout and uppercase QR frames reassemble
 * into a readable kit by simple concatenation.
 */

/**
 * Frame label prefix. Every character used by a frame — this header, digits,
 * space, `/`, `:`, and uppercase hex — is in the QR alphanumeric charset
 * (ISO/IEC 18004 §7.4.4), so the encoder never falls back to byte mode and
 * each frame keeps roughly 1.8x the capacity it would otherwise have.
 */
export const VAULT_KIT_QR_HEADER = 'DREY-VAULT-KIT-V1';

/**
 * Uppercase-hex characters per frame. Alphanumeric capacity at medium error
 * correction tops out near 3,391 characters (version 40); staying well under
 * half of that keeps every frame at a module density phone cameras read
 * reliably at laptop-screen size.
 */
export const VAULT_KIT_QR_CHUNK = 1600;

export interface VaultKitQrFrame {
  /** 1-based, as shown to the human ordering paper parts. */
  index: number;
  count: number;
  /** The exact string to encode: `HEADER index/count: CHUNK`. */
  text: string;
}

/**
 * Split the kit into ordered, self-labelling QR frames. A frame names its own
 * position and the total, so a missing or duplicated part is visible at
 * reassembly time rather than producing a kit whose checksum simply fails.
 */
export function vaultKitQrFrames(kitHex: string): VaultKitQrFrame[] {
  const upper = kitHex.toUpperCase();
  const count = Math.max(1, Math.ceil(upper.length / VAULT_KIT_QR_CHUNK));
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    count,
    text: `${VAULT_KIT_QR_HEADER} ${i + 1}/${count}: ${upper.slice(
      i * VAULT_KIT_QR_CHUNK,
      (i + 1) * VAULT_KIT_QR_CHUNK,
    )}`,
  }));
}

/**
 * Recover the kit hex from scanned frame texts, in any scan order. Exported
 * for the tests that prove frames reassemble byte-for-byte; the extension
 * itself never re-imports a kit this way.
 */
export function vaultKitFromQrFrames(texts: readonly string[]): string {
  const parts = texts.map((text) => {
    const match = /^DREY-VAULT-KIT-V1 (\d+)\/(\d+): ([0-9A-F]+)$/u.exec(text);
    if (match === null) throw new Error('not a recovery kit QR frame');
    return { index: Number(match[1]), count: Number(match[2]), chunk: match[3]! };
  });
  const count = parts[0]?.count ?? 0;
  if (parts.length !== count || parts.some((part) => part.count !== count)) {
    throw new Error('recovery kit QR frames are missing or mixed');
  }
  const ordered = [...parts].sort((a, b) => a.index - b.index);
  if (ordered.some((part, i) => part.index !== i + 1)) {
    throw new Error('recovery kit QR frames are missing or duplicated');
  }
  return ordered.map((part) => part.chunk).join('').toLowerCase();
}

/** The download's suggested name, tied to the policy it describes. */
export function vaultKitFileName(policyId: string): string {
  return `drey-vault-recovery-kit-${policyId.slice(0, 12)}.hex`;
}

/**
 * The downloaded file's exact bytes: the lowercase hex and one newline —
 * precisely the shape `read-kit --kit <file>` consumes.
 */
export function vaultKitFileBody(kitHex: string): string {
  return `${kitHex.toLowerCase()}\n`;
}
