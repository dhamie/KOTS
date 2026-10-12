import { TRADES, type GoodKey } from "@kots/content";

const DAY_MS = 24 * 60 * 60 * 1000;
export const OFFER_TTL_MS = TRADES.offerTtlHours * 60 * 60 * 1000;

/** One item on one side of an offer: a quantity of a good, or cash. */
export type TradeItem = { good: GoodKey; quantity: number } | { cash: number };

export interface TradeTerms {
  /** What the offering family hands over. */
  gives: readonly TradeItem[];
  /** What it asks for in return. Either side may be empty (a gift or a request), but not both. */
  wants: readonly TradeItem[];
}

export type TermsCheck = { ok: true } | { ok: false; reason: "empty" | "too_many_items" | "repeated_item" | "too_much_cash" };

/** Whether an offer's terms make sense. Shapes and positive amounts are checked by the request schema. */
export function checkTerms(terms: TradeTerms): TermsCheck {
  if (terms.gives.length === 0 && terms.wants.length === 0) return { ok: false, reason: "empty" };
  for (const side of [terms.gives, terms.wants]) {
    if (side.length > TRADES.maxLinesPerSide) return { ok: false, reason: "too_many_items" };
    const keys = side.map((i) => ("cash" in i ? "cash" : i.good));
    if (new Set(keys).size !== keys.length) return { ok: false, reason: "repeated_item" };
    if (cashIn(side) > TRADES.maxCash) return { ok: false, reason: "too_much_cash" };
  }
  return { ok: true };
}

export const cashIn = (items: readonly TradeItem[]) => items.reduce((s, i) => s + ("cash" in i ? i.cash : 0), 0);

/** A family can trade once it is old enough (TRADES.minFamilyAgeDays). */
export const oldEnoughToTrade = (foundedAtMs: number, nowMs: number) => nowMs - foundedAtMs >= TRADES.minFamilyAgeDays * DAY_MS;
