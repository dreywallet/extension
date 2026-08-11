/** Three distinct random positions in [0, 12), ascending (§7.1 verification). */
export function pickPositions(): [number, number, number] {
  const pool = Array.from({ length: 12 }, (_, i) => i);
  const rand = new Uint32Array(3);
  crypto.getRandomValues(rand);
  for (let i = 0; i < 3; i += 1) {
    const j = i + ((rand[i] ?? 0) % (12 - i));
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
