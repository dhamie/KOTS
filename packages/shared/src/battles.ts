import { BATTLES, TACTICS } from "@kots/content";
import { z } from "zod";

const Timestamp = z.iso.datetime({ offset: true });
const FamilyRef = z.object({ id: z.uuid(), name: z.string(), tag: z.string() });
const Side = z.enum(["attacker", "defender"]);

export const Tactic = z.enum(TACTICS);

/** `POST /api/battles/:id/commit` and `/release`. */
export const CommitRequest = z.strictObject({ henchmen: z.array(z.uuid()).min(1).max(BATTLES.maxCommittedPerSide) });
export type CommitRequest = z.infer<typeof CommitRequest>;

/** `POST /api/battles/:id/orders`: the side's tactic for round `round` (the next one to be resolved). */
export const BattleOrderRequest = z.strictObject({ round: z.number().int().min(1).max(BATTLES.rounds), tactic: Tactic });
export type BattleOrderRequest = z.infer<typeof BattleOrderRequest>;

export const BattleFighter = z.object({
  id: z.uuid(),
  name: z.string(),
  archetype: z.string(),
  combat: z.number().int(),
  leadership: z.number().int(),
  discipline: z.number().int(),
  morale: z.number().int(),
  injured: z.boolean(),
});
export type BattleFighter = z.infer<typeof BattleFighter>;

/** One resolved round, as both sides see it. Fighter ids are the side's own only; the enemy's are counts. */
export const BattleRound = z.object({
  round: z.number().int(),
  tactics: z.object({ attacker: Tactic, defender: Tactic }),
  fighters: z.object({ attacker: z.number().int(), defender: z.number().int() }),
  roll: z.object({ attacker: z.number().int(), defender: z.number().int() }),
  strength: z.object({ attacker: z.number().int(), defender: z.number().int() }),
  winner: z.enum(["attacker", "defender", "draw"]),
  injured: z.object({ attacker: z.number().int(), defender: z.number().int() }),
});
export type BattleRound = z.infer<typeof BattleRound>;

export const BATTLE_STATUSES = ["preparing", "active", "resolved", "cancelled"] as const;

/** A battle as listed for a family. */
export const BattleSummary = z.object({
  id: z.uuid(),
  territory: z.object({ slug: z.string(), name: z.string() }),
  attacker: FamilyRef,
  defender: FamilyRef,
  status: z.enum(BATTLE_STATUSES),
  fee: z.number().int(),
  declaredAt: Timestamp,
  /** Rounds resolved so far, out of `rounds`. */
  currentRound: z.number().int(),
  rounds: z.number().int(),
  nextRoundAt: Timestamp.nullable(),
  winner: Side.nullable(),
  endReason: z.string().nullable(),
  endedAt: Timestamp.nullable(),
  points: z.object({ attacker: z.number().int(), defender: z.number().int() }),
  /** The viewer's side. */
  mySide: Side,
});
export type BattleSummary = z.infer<typeof BattleSummary>;
export const BattleList = z.array(BattleSummary);

/** `GET /api/battles/:id`, for members of either family. */
export const Battle = BattleSummary.extend({
  /** The viewer's side's committed henchmen; the other side shows only how many. */
  committed: z.array(BattleFighter),
  enemyCommitted: z.number().int(),
  /** The viewer's side's tactic for the next round, if sent. */
  nextOrder: Tactic.nullable(),
  report: z.array(BattleRound),
});
export type Battle = z.infer<typeof Battle>;

/** Why the viewer's family can't attack a territory right now. */
export const AttackRefusal = z.enum([
  "not_in_family",
  "missing_permission",
  /** Neutral, or the viewer's own. */
  "not_held",
  "contested",
  "already_fighting",
  "not_adjacent",
  "last_territory",
  "attacker_protected",
  "defender_protected",
  "ceasefire",
  "cooldown",
  "insufficient_funds",
]);
export type AttackRefusal = z.infer<typeof AttackRefusal>;

/** `GET /api/territories/:slug/attack`: what declaring on it would cost the viewer's family, and whether it may. */
export const AttackQuote = z.object({ fee: z.number().int(), refusal: AttackRefusal.nullable() });
export type AttackQuote = z.infer<typeof AttackQuote>;
