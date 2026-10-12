import { describe, expect, it } from "vitest";
import { createRng, nextInt, nextUint32 } from "../src";

function sequence(seed: number, n: number): number[] {
  const rng = createRng(seed);
  return Array.from({ length: n }, () => nextUint32(rng));
}

describe("seeded rng", () => {
  it("produces the same sequence for the same seed", () => {
    expect(sequence(12345, 100)).toEqual(sequence(12345, 100));
  });

  it("produces different sequences for different seeds", () => {
    expect(sequence(1, 20)).not.toEqual(sequence(2, 20));
  });

  it("matches known mulberry32 output, so the algorithm can't drift unnoticed", () => {
    expect(sequence(0, 3)).toEqual([1144304738, 1416247, 958946056]);
  });

  it("resumes identically after a JSON round trip of its state", () => {
    const a = createRng(99);
    for (let i = 0; i < 10; i++) nextUint32(a);
    const b = JSON.parse(JSON.stringify(a)) as typeof a;
    expect(Array.from({ length: 20 }, () => nextUint32(a))).toEqual(Array.from({ length: 20 }, () => nextUint32(b)));
  });

  it("nextInt stays within bounds and hits every value", () => {
    const rng = createRng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const v = nextInt(rng, -3, 3);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThanOrEqual(3);
      seen.add(v);
    }
    expect(seen.size).toBe(7);
  });

  it("nextInt rejects invalid ranges", () => {
    const rng = createRng(1);
    expect(() => nextInt(rng, 5, 4)).toThrow(RangeError);
    expect(() => nextInt(rng, 0, 1.5)).toThrow(RangeError);
  });
});
