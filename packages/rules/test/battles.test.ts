import { BATTLES, TACTICS, type Tactic } from "@kots/content";
import { describe, expect, it } from "vitest";
import {
  baseStrength,
  battleOver,
  battleWinner,
  checkDeclaration,
  createRng,
  initialState,
  nextInt,
  replay,
  resolveRound,
  tacticFactor,
  type BattleState,
  type DeclarationFacts,
  type Fighter,
  type RoundInput,
} from "../src";

const fighter = (id: string, over: Partial<Fighter> = {}): Fighter => ({ id, combat: 60, leadership: 40, discipline: 50, morale: 70, ...over });
const squad = (prefix: string, n: number, over: Partial<Fighter> = {}) => Array.from({ length: n }, (_, i) => fighter(`${prefix}${i}`, over));
const input = (attacker: Tactic, defender: Tactic, absent: string[] = []): RoundInput => ({ tactics: { attacker, defender }, absent });

/** Plays a whole battle with random tactics and returns the inputs and the final state. */
function playOut(seed: number, attackers: Fighter[], defenders: Fighter[]): { inputs: RoundInput[]; state: BattleState } {
  const pick = createRng(seed ^ 0x5bd1e995);
  let state = initialState(attackers, defenders);
  const inputs: RoundInput[] = [];
  while (!battleOver(state)) {
    const i = input(TACTICS[nextInt(pick, 0, 2)]!, TACTICS[nextInt(pick, 0, 2)]!);
    inputs.push(i);
    state = resolveRound(state, i, seed).state;
  }
  return { inputs, state };
}

describe("strength", () => {
  it("grows with combat, discipline, leadership and morale, and is zero for nobody", () => {
    const base = baseStrength(squad("a", 3));
    expect(baseStrength([])).toBe(0);
    expect(baseStrength(squad("a", 3, { combat: 80 }))).toBeGreaterThan(base);
    expect(baseStrength(squad("a", 3, { discipline: 90 }))).toBeGreaterThan(base);
    expect(baseStrength(squad("a", 3, { morale: 100 }))).toBeGreaterThan(base);
    expect(baseStrength([...squad("a", 2), fighter("leader", { leadership: 95 })])).toBeGreaterThan(base);
    expect(baseStrength(squad("a", 4))).toBeGreaterThan(base);
  });

  it("each tactic beats exactly one other and loses to exactly one other", () => {
    for (const t of TACTICS) {
      const vs = TACTICS.map((o) => tacticFactor(t, o));
      expect(vs.filter((x) => x === BATTLES.advantage)).toHaveLength(1);
      expect(vs.filter((x) => x === BATTLES.disadvantage)).toHaveLength(1);
      expect(tacticFactor(t, t)).toBe(1);
    }
    expect([tacticFactor("press", "flank"), tacticFactor("flank", "hold"), tacticFactor("hold", "press")]).toEqual([BATTLES.advantage, BATTLES.advantage, BATTLES.advantage]);
  });
});

describe("resolving rounds", () => {
  it("is deterministic: the same state, input and seed give the same result, and different seeds differ", () => {
    const state = initialState(squad("a", 5), squad("d", 5));
    const one = resolveRound(state, input("press", "hold"), 42);
    expect(resolveRound(state, input("press", "hold"), 42)).toEqual(one);
    const others = [1, 2, 3, 4, 5].map((s) => resolveRound(state, input("press", "hold"), s).result.roll);
    expect(new Set(others.map((r) => `${r.attacker}:${r.defender}`)).size).toBeGreaterThan(1);
    // The input state is not changed.
    expect(state).toEqual(initialState(squad("a", 5), squad("d", 5)));
  });

  it("replaying the inputs reproduces every round exactly", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const initial = initialState(squad("a", 4, { combat: 55 + seed }), squad("d", 3));
      let state = initial;
      const stored = [];
      const inputs: RoundInput[] = [];
      while (!battleOver(state)) {
        const i = input(TACTICS[seed % 3]!, TACTICS[(seed + state.round) % 3]!, state.round === 1 ? ["a0"] : []);
        inputs.push(i);
        const step = resolveRound(state, i, seed * 7919);
        state = step.state;
        stored.push(step.result);
      }
      expect(replay(initial, seed * 7919, inputs)).toEqual(stored);
    }
  });

  it("a side with nobody scores zero and loses the round; absent fighters don't fight", () => {
    const r = resolveRound(initialState([], squad("d", 2)), input("press", "hold"), 7);
    expect([r.result.strength.attacker, r.result.winner, battleOver(r.state), battleWinner(r.state)]).toEqual([0, "defender", true, "defender"]);
    const without = resolveRound(initialState(squad("a", 3), squad("d", 3)), input("press", "hold", ["a0", "a1"]), 7);
    expect(without.result.fighters).toEqual({ attacker: 1, defender: 3 });
  });
});

describe("invariants over many battles", () => {
  it("never injures more than fought, never injures anyone twice, never goes negative, and always ends within the round limit", () => {
    for (let seed = 1; seed <= 500; seed++) {
      const a = squad("a", 1 + (seed % 8), { combat: 20 + (seed % 70) });
      const d = squad("d", 1 + ((seed * 7) % 8), { discipline: 10 + (seed % 80) });
      const { inputs, state } = playOut(seed, a, d);
      expect(inputs.length).toBeLessThanOrEqual(BATTLES.rounds);
      const results = replay(initialState(a, d), seed, inputs);
      for (const r of results) {
        expect(r.strength.attacker).toBeGreaterThanOrEqual(0);
        expect(r.strength.defender).toBeGreaterThanOrEqual(0);
        expect(r.injured.attacker.length).toBeLessThanOrEqual(r.fighters.attacker);
        expect(r.injured.defender.length).toBeLessThanOrEqual(r.fighters.defender);
        expect(Math.abs(r.roll.attacker)).toBeLessThanOrEqual(BATTLES.randomSpread * 1000);
      }
      expect(new Set(state.injured.attacker).size).toBe(state.injured.attacker.length);
      expect(state.injured.attacker.length + state.fit.attacker.length).toBe(a.length);
      expect(state.injured.defender.length + state.fit.defender.length).toBe(d.length);
      expect(state.points.attacker + state.points.defender).toBeLessThanOrEqual(state.round);
    }
  });
});

describe("balance", () => {
  const winRate = (attackers: Fighter[], defenders: Fighter[], trials = 2000) => {
    let wins = 0;
    for (let seed = 1; seed <= trials; seed++) {
      if (resolveRound(initialState(attackers, defenders), input("hold", "hold"), seed).result.winner === "attacker") wins++;
    }
    return wins / trials;
  };

  it("equal sides favour the defender; an attacker about 15% stronger has even odds; a much stronger one almost always wins", () => {
    expect(winRate(squad("a", 4), squad("d", 4))).toBeLessThan(0.2);
    // Same squad, 15% more combat each: roughly the defender's bonus.
    const even = winRate(squad("a", 4, { combat: 69 }), squad("d", 4));
    expect(even).toBeGreaterThan(0.35);
    expect(even).toBeLessThan(0.65);
    expect(winRate(squad("a", 8), squad("d", 3))).toBeGreaterThan(0.95);
  });

  it("the right tactic turns an even round", () => {
    const a = squad("a", 4, { combat: 69 });
    const d = squad("d", 4);
    let withAdvantage = 0;
    for (let seed = 1; seed <= 1000; seed++) if (resolveRound(initialState(a, d), input("flank", "hold"), seed).result.winner === "attacker") withAdvantage++;
    expect(withAdvantage / 1000).toBeGreaterThan(0.9);
  });
});

describe("declaring", () => {
  const DAY = 86_400_000;
  const facts = (over: Partial<DeclarationFacts> = {}): DeclarationFacts => ({
    targetBorders: ["sabo", "akoka"],
    attackerHeld: ["akoka"],
    defenderHeldCount: 2,
    attackerFoundedAtMs: 0,
    defenderFoundedAtMs: 0,
    nowMs: 10 * DAY,
    ceasefire: false,
    recentBattle: false,
    ...over,
  });

  it("allows a bordering attack on a family with more than one territory, between established families", () => {
    expect(checkDeclaration(facts())).toEqual({ ok: true });
  });

  it("refuses for each reason", () => {
    expect(checkDeclaration(facts({ attackerHeld: [] }))).toEqual({ ok: false, reason: "not_adjacent" });
    expect(checkDeclaration(facts({ attackerHeld: ["marina"] }))).toEqual({ ok: false, reason: "not_adjacent" });
    expect(checkDeclaration(facts({ defenderHeldCount: 1 }))).toEqual({ ok: false, reason: "last_territory" });
    expect(checkDeclaration(facts({ attackerFoundedAtMs: 9 * DAY }))).toEqual({ ok: false, reason: "attacker_protected" });
    expect(checkDeclaration(facts({ defenderFoundedAtMs: 8 * DAY }))).toEqual({ ok: false, reason: "defender_protected" });
    expect(checkDeclaration(facts({ ceasefire: true }))).toEqual({ ok: false, reason: "ceasefire" });
    expect(checkDeclaration(facts({ recentBattle: true }))).toEqual({ ok: false, reason: "cooldown" });
  });
});
