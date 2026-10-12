import { CITY, DIPLOMACY } from "@kots/content";
import { describe, expect, it } from "vitest";
import { canReceive, checkFamilyAction, checkProposalTerms } from "../src";

describe("proposal terms", () => {
  it("accepts the listed ceasefire lengths only", () => {
    for (const hours of DIPLOMACY.ceasefireHours) expect(checkProposalTerms({ kind: "ceasefire", hours })).toEqual({ ok: true });
    expect(checkProposalTerms({ kind: "ceasefire", hours: 5 })).toEqual({ ok: false, reason: "bad_length" });
  });

  it("needs a real territory and a whole, capped, non-negative price", () => {
    const t = { kind: "territory_transfer" as const, territory: "balogun", giver: "proposer" as const };
    expect(checkProposalTerms({ ...t, price: 0 })).toEqual({ ok: true });
    expect(checkProposalTerms({ ...t, price: DIPLOMACY.maxPrice })).toEqual({ ok: true });
    expect(checkProposalTerms({ ...t, price: DIPLOMACY.maxPrice + 1 })).toEqual({ ok: false, reason: "bad_price" });
    expect(checkProposalTerms({ ...t, price: -1 })).toEqual({ ok: false, reason: "bad_price" });
    expect(checkProposalTerms({ ...t, price: 1.5 })).toEqual({ ok: false, reason: "bad_price" });
    expect(checkProposalTerms({ ...t, territory: "atlantis", price: 0 })).toEqual({ ok: false, reason: "unknown_territory" });
  });
});

describe("receiving a territory", () => {
  it("follows the claim rule: anywhere for a family with no land, otherwise it must border theirs", () => {
    const borders = CITY.territories.get("balogun")!.borders;
    const far = [...CITY.territories.keys()].find((s) => s !== "balogun" && !borders.includes(s))!;
    expect(canReceive("balogun", [])).toBe(true);
    expect(canReceive("balogun", [borders[0]!])).toBe(true);
    expect(canReceive("balogun", [far])).toBe(false);
  });
});

describe("diplomacy permissions", () => {
  it("Don and Underboss talk, propose and sign; a Consigliere talks and proposes; others do none", () => {
    const can = (role: Parameters<typeof checkFamilyAction>[0], kind: "diplomacy_talk" | "diplomacy_propose" | "diplomacy_sign") => checkFamilyAction(role, { kind }).ok;
    for (const role of ["don", "underboss"] as const) expect([can(role, "diplomacy_talk"), can(role, "diplomacy_propose"), can(role, "diplomacy_sign")]).toEqual([true, true, true]);
    expect([can("consigliere", "diplomacy_talk"), can("consigliere", "diplomacy_propose"), can("consigliere", "diplomacy_sign")]).toEqual([true, true, false]);
    for (const role of ["capo", "enforcer", "fixer", "quartermaster", "associate"] as const) expect(can(role, "diplomacy_talk")).toBe(false);
  });
});
