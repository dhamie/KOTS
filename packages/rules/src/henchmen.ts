import { ARCHETYPES, FIRST_NAMES, HENCHMAN_ATTRIBUTES, NICKNAMES, RECRUITMENT, TRAITS, type HenchmanAttribute } from "@kots/content";
import { createRng, nextInt, type RngState } from "./rng";

const DAY_MS = 24 * 60 * 60 * 1000;
const OFFSET_MS = RECRUITMENT.boardUtcOffsetHours * 60 * 60 * 1000;

/** The recruitment day (days since the epoch, in Lagos time) that `nowMs` falls in. */
export function boardDay(nowMs: number): number {
  return Math.floor((nowMs + OFFSET_MS) / DAY_MS);
}

/** When the board for `day` is replaced: the next Lagos midnight. */
export function boardResetsAt(day: number): number {
  return (day + 1) * DAY_MS - OFFSET_MS;
}

export interface Candidate {
  slot: number;
  archetype: string;
  name: string;
  attributes: Record<HenchmanAttribute, number>;
  traits: string[];
  hireCost: number;
  wage: number;
}

/** FNV-1a: a stable 32-bit hash, so a board can be seeded from text. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const pick = <T>(rng: RngState, list: readonly T[]): T => list[nextInt(rng, 0, list.length - 1)]!;

function pickArchetype(rng: RngState) {
  const total = ARCHETYPES.reduce((s, a) => s + a.weight, 0);
  let roll = nextInt(rng, 1, total);
  for (const a of ARCHETYPES) {
    roll -= a.weight;
    if (roll <= 0) return a;
  }
  return ARCHETYPES[ARCHETYPES.length - 1]!;
}

function pickUnused<T>(rng: RngState, list: readonly T[], used: Set<T>): T {
  const free = list.filter((x) => !used.has(x));
  const choice = pick(rng, free.length > 0 ? free : list);
  used.add(choice);
  return choice;
}

const roundTo = (n: number, step: number) => Math.round(n / step) * step;

/**
 * A family's recruitment board for one day. Pure and deterministic: the server recomputes it on hire, so the
 * board needs no table, and each slot can only be hired once (its key is family + day + slot).
 */
export function generateBoard(familyId: string, day: number): Candidate[] {
  const rng = createRng(hashSeed(`${familyId}:${day}`));
  const board: Candidate[] = [];
  const firstNames = new Set<string>();
  const nicknames = new Set<string>();
  for (let slot = 0; slot < RECRUITMENT.boardSize; slot++) {
    const a = pickArchetype(rng);
    const attributes = {} as Record<HenchmanAttribute, number>;
    let quality = 0;
    for (const attr of HENCHMAN_ATTRIBUTES) {
      const [min, max] = a.ranges[attr];
      attributes[attr] = nextInt(rng, min, max);
      quality += max === min ? 0.5 : (attributes[attr] - min) / (max - min);
    }
    // 0.8× for the worst possible roll, 1.2× for the best.
    const price = 0.8 + 0.4 * (quality / HENCHMAN_ATTRIBUTES.length);
    const traits = [pick(rng, TRAITS)];
    if (nextInt(rng, 0, 1) === 1) {
      const second = pick(rng, TRAITS);
      if (second !== traits[0]) traits.push(second);
    }
    // No two candidates on one board share a first name or a nickname.
    const first = pickUnused(rng, FIRST_NAMES, firstNames);
    const nick = pickUnused(rng, NICKNAMES, nicknames);
    board.push({
      slot,
      archetype: a.key,
      name: `${first} "${nick}"`,
      attributes,
      traits,
      hireCost: roundTo(a.hireCost * price, 50),
      wage: roundTo(a.wage * price, 10),
    });
  }
  return board;
}

/** Morale after a wage period is paid, or the first time one goes unpaid. */
export function moraleAfter(morale: number, paid: boolean): number {
  const next = paid ? morale + RECRUITMENT.paidMoraleGain : morale - RECRUITMENT.unpaidMoralePenalty;
  return Math.max(0, Math.min(100, next));
}
