/**
 * Seedable pseudo-random generator for reproducible / auditable evolution.
 *
 * The evolution engine's mutation, crossover, selection, and exploration all
 * draw from an injectable `() => number` in [0, 1). Default is `Math.random`;
 * pass a seed for a deterministic, replayable stream (ADR-0023 requires
 * evolution to be auditable — issue #451).
 */

export type Rng = () => number;

/**
 * mulberry32 — a fast, well-distributed 32-bit seedable PRNG.
 * Same seed → same sequence, across processes and platforms.
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * In-place Fisher-Yates shuffle using the supplied RNG. Unbiased, unlike
 * `Array.sort(() => rng() - 0.5)`.
 */
export function shuffleInPlace<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}
