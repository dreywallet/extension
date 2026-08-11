/**
 * Deterministic account identity art.
 *
 * This is an identity and disambiguation aid, never a safety control. A passive
 * visual indicator does not defend against substitution: users do not reliably
 * notice one is *missing* during a routine task, which is why site-authentication
 * images were retired from online banking. So no surface may present a mark as
 * verifying an account, and it never replaces or shortens a displayed address.
 *
 * The seed is normally an `acct_<network>_<sha256>` account id, which is already
 * a domain-separated hash over the account's xpubs
 * (`core/src/domain/accounts/public-account.ts`). That makes a mark a property of
 * the wallet rather than of this installation: restoring the same recovery
 * phrase elsewhere reproduces the same marks. Any stable string works, so vaults
 * can share the component.
 *
 * Pure geometry — no React, no DOM, no browser API — so the rules stay
 * unit-testable without rendering, matching the split `ui/utxo-presentation.ts`
 * and `domain/transactions/sat-flow-layout.ts` already use.
 */

/**
 * Cells per side. Five is a deliberate ceiling rather than a placeholder: the
 * mark has to stay legible at 16px in the account menu, and denser grids turn
 * to mush at that size. Mirroring spends 15 bits of entropy on 25 cells, which
 * is ample for telling apart the handful of accounts one wallet holds.
 */
const GRID = 5;

export interface AccountMarkModel {
  /** Cells per side. Also the SVG viewBox extent, so the path is in cell units. */
  readonly size: number;
  /** Row-major fill state, length `size * size`. */
  readonly cells: readonly boolean[];
  /** Filled cells as one SVG path, horizontal runs merged into single rects. */
  readonly path: string;
}

/**
 * FNV-1a over the seed, then xorshift32. Not a cryptographic primitive and not
 * required to be one — the account id it consumes is already a SHA-256, and this
 * only spreads those bits over a grid. Taking a high bit avoids xorshift32's
 * weakly distributed low bit.
 */
function bitSource(seed: string): () => boolean {
  let state = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }
  // xorshift32 is absorbing at zero, so a zero seed needs a non-zero substitute.
  state = (state >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return ((state >>> 24) & 1) === 1;
  };
}

/**
 * Merge horizontally adjacent cells into one rect per run. This is what makes
 * the mark read as a block lattice rather than as loose pixels, and it keeps the
 * output to a single path. Same construction as `components/QrCode.tsx`.
 */
function pathFor(cells: readonly boolean[], size: number): string {
  const parts: string[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size;) {
      if (cells[y * size + x] !== true) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < size && cells[y * size + x] === true) x += 1;
      parts.push(`M${start} ${y}h${x - start}v1H${start}z`);
    }
  }
  return parts.join('');
}

/**
 * Build the mark for `seed`. Mirrored horizontally, because the symmetry is what
 * lets the eye read a shape it can remember instead of noise.
 */
export function accountMark(seed: string, size: number = GRID): AccountMarkModel {
  const nextBit = bitSource(seed);
  const half = Math.ceil(size / 2);
  const cells: boolean[] = new Array<boolean>(size * size).fill(false);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < half; x += 1) {
      const filled = nextBit();
      cells[y * size + x] = filled;
      cells[y * size + (size - 1 - x)] = filled;
    }
  }
  // A uniform grid is a blank or solid square — rare, but it would read as a
  // rendering failure rather than as an identity. Break it deterministically.
  const filledCount = cells.filter(Boolean).length;
  if (filledCount === 0 || filledCount === cells.length) {
    const centre = Math.floor(cells.length / 2);
    cells[centre] = filledCount === 0;
  }
  return { size, cells, path: pathFor(cells, size) };
}
