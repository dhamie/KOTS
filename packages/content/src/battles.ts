/** Territory battles (Phase 7). Formulas that use these live in packages/rules/src/battles.ts; see docs/BATTLES.md. */
export const BATTLES = {
  /** Between the declaration and round 1: both sides commit henchmen. */
  preparationHours: 6,
  /** Between rounds. */
  roundHours: 2,
  /** A battle lasts at most this many rounds. */
  rounds: 3,
  /** Paid by the attacker when declaring, in days of the territory's base upkeep. Refunded only if the battle is cancelled. */
  declarationFeeDays: 3,
  /** A family can't attack or be attacked until it is this old. */
  protectionDays: 3,
  /** After a battle between two families ends, neither can attack the other for this long. */
  pairCooldownHours: 24,
  /** Most henchmen one side can commit. */
  maxCommittedPerSide: 8,
  /** How long an injured henchman can't fight. */
  injuryHours: 24,
  /** The defender's strength is multiplied by 1 + this. */
  defenderBonus: 0.15,
  /** Each side's strength each round is multiplied by a seeded random factor in [1 - spread, 1 + spread]. */
  randomSpread: 0.15,
  /** A tactic that beats the other side's multiplies strength by `advantage`; one that loses, by `disadvantage`. */
  advantage: 1.25,
  disadvantage: 0.8,
  /** Chance (per 1000) that each fighter is injured in a round, by how the round went for their side. */
  injuryPerMille: { won: 100, draw: 200, lost: 350 },
  /** Morale change for every henchman who fought, when the battle ends. */
  moraleWin: 5,
  moraleLoss: -10,
} as const;

/** Each tactic beats the one it maps to: press overruns a flank, a flank turns a hold, a hold breaks a press. */
export const TACTICS = ["press", "hold", "flank"] as const;
export type Tactic = (typeof TACTICS)[number];
export const BEATS: Record<Tactic, Tactic> = { press: "flank", flank: "hold", hold: "press" };

/** What a side does in a round when its commanders sent no orders. */
export const DEFAULT_TACTIC = { attacker: "press", defender: "hold" } as const satisfies Record<string, Tactic>;
