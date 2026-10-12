/**
 * Seeded PRNG (mulberry32) for deterministic game rules.
 * The state is a plain serialisable object, so it can be stored with a battle and resumed exactly.
 */
export interface RngState {
  s: number;
}

export function createRng(seed: number): RngState {
  return { s: seed >>> 0 };
}

/** Advances the state and returns a uint32. */
export function nextUint32(rng: RngState): number {
  rng.s = (rng.s + 0x6d2b79f5) >>> 0;
  let t = rng.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/** Integer in [min, max] inclusive. Uses rejection sampling, so there is no modulo bias. */
export function nextInt(rng: RngState, min: number, max: number): number {
  if (!Number.isInteger(min) || !Number.isInteger(max) || max < min || max - min >= 2 ** 32) {
    throw new RangeError(`invalid range [${min}, ${max}]`);
  }
  const range = max - min + 1;
  const limit = 2 ** 32 - (2 ** 32 % range);
  let x = nextUint32(rng);
  while (x >= limit) x = nextUint32(rng);
  return min + (x % range);
}
