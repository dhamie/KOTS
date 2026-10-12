import { ECONOMY } from "@kots/content";
import { describe, expect, it } from "vitest";
import { checkClaim, claimQuote, GRACE_MS, territoryUpkeep, UPKEEP_PERIOD_MS, upkeepStatus } from "../src";

describe("territoryUpkeep", () => {
  it("is the base upkeep for a family's only territory", () => {
    expect(territoryUpkeep(400, 1)).toBe(400);
  });

  it("rises 10% per other territory held, rounded to whole naira", () => {
    expect(territoryUpkeep(400, 2)).toBe(440);
    expect(territoryUpkeep(400, 11)).toBe(800);
    expect(territoryUpkeep(333, 2)).toBe(366);
  });
});

describe("claimQuote", () => {
  it("waives the fee when the family holds nothing", () => {
    expect(claimQuote(400, 0)).toEqual({ fee: 0, firstUpkeep: 400, total: 400 });
  });

  it("charges five days of base upkeep plus the first period at the new holding size", () => {
    expect(claimQuote(400, 1)).toEqual({ fee: 2000, firstUpkeep: 440, total: 2440 });
    expect(claimQuote(400, 3).firstUpkeep).toBe(territoryUpkeep(400, 4));
    expect(ECONOMY.claimFeeDays).toBe(5);
  });
});

describe("checkClaim", () => {
  it("allows a first claim anywhere", () => {
    expect(checkClaim(["a"], [])).toEqual({ ok: true });
  });

  it("then requires a border with a held territory", () => {
    expect(checkClaim(["a", "b"], ["b", "z"])).toEqual({ ok: true });
    expect(checkClaim(["a", "b"], ["z"])).toEqual({ ok: false, reason: "not_adjacent" });
  });
});

describe("upkeepStatus", () => {
  const paidUntil = 1_000_000_000_000;

  it("is paid until the period ends, due through the grace period, then lapsed", () => {
    expect(upkeepStatus(paidUntil, paidUntil - 1)).toBe("paid");
    expect(upkeepStatus(paidUntil, paidUntil)).toBe("due");
    expect(upkeepStatus(paidUntil, paidUntil + GRACE_MS - 1)).toBe("due");
    expect(upkeepStatus(paidUntil, paidUntil + GRACE_MS)).toBe("lapsed");
  });

  it("uses a 24 h period and a 48 h grace period", () => {
    expect(UPKEEP_PERIOD_MS).toBe(24 * 3600_000);
    expect(GRACE_MS).toBe(48 * 3600_000);
  });
});
