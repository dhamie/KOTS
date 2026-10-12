import { BATTLES, BEATS, type Tactic } from "@kots/content";
import { hashSeed } from "./henchmen";
import { createRng, nextInt } from "./rng";

export type Side = "attacker" | "defender";
export const SIDES = ["attacker", "defender"] as const satisfies readonly Side[];

/** What a henchman brings to a battle, snapshotted when it starts. */
export interface Fighter {
  id: string;
  combat: number;
  leadership: number;
  discipline: number;
  morale: number;
}

/** Everything the next round depends on, apart from the orders and the seed. Plain data, stored with the battle. */
export interface BattleState {
  /** Fighters still able to fight, in id order. */
  fit: Record<Side, Fighter[]>;
  /** Ids of fighters injured so far. */
  injured: Record<Side, string[]>;
  /** Rounds won. */
  points: Record<Side, number>;
  /** Rounds resolved so far. */
  round: number;
}

/** One round's input: each side's tactic, and fighters no longer with the family (they left between rounds). */
export interface RoundInput {
  tactics: Record<Side, Tactic>;
  absent: string[];
}

export interface RoundResult {
  round: number;
  tactics: Record<Side, Tactic>;
  absent: string[];
  /** How many fought for each side. */
  fighters: Record<Side, number>;
  /** Random factor per side, in thousandths (-150 means 15% weaker). */
  roll: Record<Side, number>;
  strength: Record<Side, number>;
  winner: Side | "draw";
  injured: Record<Side, string[]>;
}

const byId = (a: Fighter, b: Fighter) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const other = (side: Side): Side => (side === "attacker" ? "defender" : "attacker");

export function initialState(attacker: readonly Fighter[], defender: readonly Fighter[]): BattleState {
  return {
    fit: { attacker: [...attacker].sort(byId), defender: [...defender].sort(byId) },
    injured: { attacker: [], defender: [] },
    points: { attacker: 0, defender: 0 },
    round: 0,
  };
}

/**
 * A side's strength before tactics, the defender's bonus and the roll: each fighter's combat, steadied by
 * discipline (×0.5 to ×1), lifted by the side's best leader (up to ×1.5) and scaled by average morale (×0.75 to ×1).
 */
export function baseStrength(fighters: readonly Fighter[]): number {
  if (fighters.length === 0) return 0;
  const combat = fighters.reduce((s, f) => s + f.combat * (0.5 + f.discipline / 200), 0);
  const leadership = 1 + Math.max(...fighters.map((f) => f.leadership)) / 200;
  const morale = 0.75 + fighters.reduce((s, f) => s + f.morale, 0) / fighters.length / 400;
  return combat * leadership * morale;
}

/** The multiplier a tactic gets against the other side's. */
export function tacticFactor(mine: Tactic, theirs: Tactic): number {
  if (BEATS[mine] === theirs) return BATTLES.advantage;
  if (BEATS[theirs] === mine) return BATTLES.disadvantage;
  return 1;
}

/** Resolves the next round. Pure: the same state, input and seed always give the same result. */
export function resolveRound(state: BattleState, input: RoundInput, seed: number): { state: BattleState; result: RoundResult } {
  const round = state.round + 1;
  const rng = createRng(hashSeed(`${seed}:${round}`));
  const absent = new Set(input.absent);
  const fit = { attacker: state.fit.attacker.filter((f) => !absent.has(f.id)), defender: state.fit.defender.filter((f) => !absent.has(f.id)) };
  const spread = Math.round(BATTLES.randomSpread * 1000);

  const roll = { attacker: nextInt(rng, -spread, spread), defender: nextInt(rng, -spread, spread) };
  const strength = { attacker: 0, defender: 0 };
  for (const side of SIDES) {
    const bonus = side === "defender" ? 1 + BATTLES.defenderBonus : 1;
    const raw = baseStrength(fit[side]) * tacticFactor(input.tactics[side], input.tactics[other(side)]) * bonus * (1 + roll[side] / 1000);
    strength[side] = Math.round(raw);
  }
  const winner: Side | "draw" = strength.attacker > strength.defender ? "attacker" : strength.defender > strength.attacker ? "defender" : "draw";

  const injured: Record<Side, string[]> = { attacker: [], defender: [] };
  for (const side of SIDES) {
    const outcome = winner === "draw" ? "draw" : winner === side ? "won" : "lost";
    for (const f of fit[side]) if (nextInt(rng, 0, 999) < BATTLES.injuryPerMille[outcome]) injured[side].push(f.id);
  }

  const next: BattleState = {
    fit: {
      attacker: fit.attacker.filter((f) => !injured.attacker.includes(f.id)),
      defender: fit.defender.filter((f) => !injured.defender.includes(f.id)),
    },
    injured: { attacker: [...state.injured.attacker, ...injured.attacker], defender: [...state.injured.defender, ...injured.defender] },
    points: {
      attacker: state.points.attacker + (winner === "attacker" ? 1 : 0),
      defender: state.points.defender + (winner === "defender" ? 1 : 0),
    },
    round,
  };
  return {
    state: next,
    result: {
      round,
      tactics: input.tactics,
      absent: [...input.absent],
      fighters: { attacker: fit.attacker.length, defender: fit.defender.length },
      roll,
      strength,
      winner,
      injured,
    },
  };
}

/** Over after the last round, or when a side has nobody left who can fight. */
export function battleOver(state: BattleState): boolean {
  return state.round >= BATTLES.rounds || (state.round > 0 && (state.fit.attacker.length === 0 || state.fit.defender.length === 0));
}

/**
 * Who won a finished battle: a side left standing against nobody wins; otherwise most rounds won. A tie goes to the
 * defender, who keeps the territory.
 */
export function battleWinner(state: BattleState): Side {
  const [a, d] = [state.fit.attacker.length, state.fit.defender.length];
  if (a > 0 && d === 0) return "attacker";
  if (d > 0 && a === 0) return "defender";
  return state.points.attacker > state.points.defender ? "attacker" : "defender";
}

/** Replays a battle from its starting state, seed and each round's input. Used to check stored reports. */
export function replay(initial: BattleState, seed: number, rounds: readonly RoundInput[]): RoundResult[] {
  let state = initial;
  const results: RoundResult[] = [];
  for (const input of rounds) {
    const step = resolveRound(state, input, seed);
    state = step.state;
    results.push(step.result);
  }
  return results;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
export const PREPARATION_MS = BATTLES.preparationHours * HOUR_MS;
export const ROUND_MS = BATTLES.roundHours * HOUR_MS;
export const INJURY_MS = BATTLES.injuryHours * HOUR_MS;
export const PAIR_COOLDOWN_MS = BATTLES.pairCooldownHours * HOUR_MS;

/** What declaring on a territory costs the attacker. */
export const declarationFee = (baseUpkeep: number) => baseUpkeep * BATTLES.declarationFeeDays;

/** New families can't attack or be attacked until they are BATTLES.protectionDays old. */
export const isProtected = (foundedAtMs: number, nowMs: number) => nowMs - foundedAtMs < BATTLES.protectionDays * DAY_MS;

export interface DeclarationFacts {
  /** Territories bordering the target (bridges count). */
  targetBorders: readonly string[];
  attackerHeld: readonly string[];
  defenderHeldCount: number;
  attackerFoundedAtMs: number;
  defenderFoundedAtMs: number;
  nowMs: number;
  ceasefire: boolean;
  /** A battle between these two families ended within the cooldown. */
  recentBattle: boolean;
}

export type DeclarationRefusal = "not_adjacent" | "last_territory" | "attacker_protected" | "defender_protected" | "ceasefire" | "cooldown";

/** Whether a family may declare on a territory another family holds. Ownership, contest and money are checked by the server. */
export function checkDeclaration(f: DeclarationFacts): { ok: true } | { ok: false; reason: DeclarationRefusal } {
  if (!f.targetBorders.some((b) => f.attackerHeld.includes(b))) return { ok: false, reason: "not_adjacent" };
  if (f.defenderHeldCount <= 1) return { ok: false, reason: "last_territory" };
  if (isProtected(f.attackerFoundedAtMs, f.nowMs)) return { ok: false, reason: "attacker_protected" };
  if (isProtected(f.defenderFoundedAtMs, f.nowMs)) return { ok: false, reason: "defender_protected" };
  if (f.ceasefire) return { ok: false, reason: "ceasefire" };
  if (f.recentBattle) return { ok: false, reason: "cooldown" };
  return { ok: true };
}
