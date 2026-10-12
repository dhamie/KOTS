import { FAMILY_ROLES, TRADES } from "@kots/content";
import { describe, expect, it } from "vitest";
import { cashIn, checkFamilyAction, checkTerms, oldEnoughToTrade } from "../src";

const DAY = 24 * 60 * 60 * 1000;

describe("checkTerms", () => {
  it("accepts swaps, sales, gifts and requests", () => {
    expect(checkTerms({ gives: [{ good: "fuel", quantity: 10 }], wants: [{ cash: 1500 }] })).toEqual({ ok: true });
    expect(checkTerms({ gives: [{ good: "fuel", quantity: 10 }, { cash: 5 }], wants: [{ good: "fuel", quantity: 3 }] })).toEqual({ ok: true });
    expect(checkTerms({ gives: [{ cash: 100 }], wants: [] })).toEqual({ ok: true });
    expect(checkTerms({ gives: [], wants: [{ good: "contraband", quantity: 1 }] })).toEqual({ ok: true });
  });

  it("refuses an empty offer", () => {
    expect(checkTerms({ gives: [], wants: [] })).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses too many items, or the same item twice on one side", () => {
    const six = Array.from({ length: TRADES.maxLinesPerSide + 1 }, (_, i) => ({ cash: i + 1 }));
    expect(checkTerms({ gives: six, wants: [] })).toEqual({ ok: false, reason: "too_many_items" });
    expect(checkTerms({ gives: [], wants: [{ good: "fuel", quantity: 1 }, { good: "fuel", quantity: 2 }] })).toEqual({ ok: false, reason: "repeated_item" });
    expect(checkTerms({ gives: [{ cash: 1 }, { cash: 2 }], wants: [] })).toEqual({ ok: false, reason: "repeated_item" });
  });

  it("caps cash per side", () => {
    expect(checkTerms({ gives: [{ cash: TRADES.maxCash }], wants: [] })).toEqual({ ok: true });
    expect(checkTerms({ gives: [{ cash: TRADES.maxCash + 1 }], wants: [] })).toEqual({ ok: false, reason: "too_much_cash" });
    expect(cashIn([{ cash: 3 }, { good: "fuel", quantity: 9 }])).toBe(3);
  });
});

describe("oldEnoughToTrade", () => {
  it("needs the minimum age, to the millisecond", () => {
    const age = TRADES.minFamilyAgeDays * DAY;
    expect(oldEnoughToTrade(0, age - 1)).toBe(false);
    expect(oldEnoughToTrade(0, age)).toBe(true);
  });
});

describe("trade permissions", () => {
  it("are for the don, underboss and quartermaster", () => {
    for (const kind of ["propose_trade", "accept_trade"] as const) {
      expect(FAMILY_ROLES.filter((r) => checkFamilyAction(r, { kind }).ok)).toEqual(["don", "underboss", "quartermaster"]);
    }
  });
});
