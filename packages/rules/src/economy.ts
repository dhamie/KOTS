import { ECONOMY } from "@kots/content";

const HOUR_MS = 60 * 60 * 1000;
export const UPKEEP_PERIOD_MS = ECONOMY.upkeepPeriodHours * HOUR_MS;
export const GRACE_MS = ECONOMY.graceHours * HOUR_MS;

/** One territory's upkeep per period when its family holds `held` territories in total (this one included). */
export function territoryUpkeep(baseUpkeep: number, held: number): number {
  return Math.round(baseUpkeep * (1 + ECONOMY.upkeepGrowthPerTerritory * Math.max(0, held - 1)));
}

export interface ClaimQuote {
  fee: number;
  /** The first period's upkeep, paid up front. */
  firstUpkeep: number;
  total: number;
}

/** What claiming costs a family that currently holds `heldBefore` territories. The first holding has no fee. */
export function claimQuote(baseUpkeep: number, heldBefore: number): ClaimQuote {
  const fee = heldBefore === 0 ? 0 : baseUpkeep * ECONOMY.claimFeeDays;
  const firstUpkeep = territoryUpkeep(baseUpkeep, heldBefore + 1);
  return { fee, firstUpkeep, total: fee + firstUpkeep };
}

export type ClaimCheck = { ok: true } | { ok: false; reason: "not_adjacent" };

/** A family's first territory can be anywhere; after that it must border one it holds (bridges count). */
export function checkClaim(targetBorders: readonly string[], held: readonly string[]): ClaimCheck {
  if (held.length === 0 || targetBorders.some((b) => held.includes(b))) return { ok: true };
  return { ok: false, reason: "not_adjacent" };
}

/**
 * Where a held territory stands at `now`, given the end of its paid period:
 * `paid` until then, `due` (neglected) through the grace period, then `lapsed` (it returns to neutral).
 */
export function upkeepStatus(paidUntilMs: number, nowMs: number): "paid" | "due" | "lapsed" {
  if (nowMs < paidUntilMs) return "paid";
  return nowMs < paidUntilMs + GRACE_MS ? "due" : "lapsed";
}
