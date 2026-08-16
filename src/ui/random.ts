/** Three distinct random positions in [0, wordCount), ascending (§7.1 verification). */
export function pickPositions(wordCount = 12): [number, number, number] {
  if (!Number.isInteger(wordCount) || wordCount < 3) {
    throw new RangeError('wordCount must be an integer of at least 3');
  }
  const pool = Array.from({ length: wordCount }, (_, i) => i);
  const rand = new Uint32Array(3);
  crypto.getRandomValues(rand);
  for (let i = 0; i < 3; i += 1) {
    const j = i + ((rand[i] ?? 0) % (wordCount - i));
    const a = pool[i] as number;
    pool[i] = pool[j] as number;
    pool[j] = a;
  }
  return [pool[0] as number, pool[1] as number, pool[2] as number].sort((x, y) => x - y) as [
    number,
    number,
    number,
  ];
}
