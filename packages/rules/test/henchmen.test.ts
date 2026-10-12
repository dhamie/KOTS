import { ARCHETYPES, FAMILY_ROLES, HENCHMAN_ATTRIBUTES, RECRUITMENT } from "@kots/content";
import { describe, expect, it } from "vitest";
import { boardDay, boardResetsAt, checkFamilyAction, generateBoard, hashSeed, moraleAfter } from "../src";

const FAMILY = "0192f3a4-0000-7000-8000-000000000001";

describe("generateBoard", () => {
  it("is the same for the same family and day, and differs across days and families", () => {
    expect(generateBoard(FAMILY, 20_000)).toEqual(generateBoard(FAMILY, 20_000));
    expect(generateBoard(FAMILY, 20_001)).not.toEqual(generateBoard(FAMILY, 20_000));
    expect(generateBoard(FAMILY.replace(/1$/, "2"), 20_000)).not.toEqual(generateBoard(FAMILY, 20_000));
  });

  it("has boardSize candidates whose attributes sit inside their archetype's ranges", () => {
    for (let day = 0; day < 200; day++) {
      const board = generateBoard(FAMILY, day);
      expect(board.map((c) => c.slot)).toEqual([...Array(RECRUITMENT.boardSize).keys()]);
      for (const c of board) {
        const a = ARCHETYPES.find((x) => x.key === c.archetype)!;
        expect(a, c.archetype).toBeDefined();
        for (const attr of HENCHMAN_ATTRIBUTES) {
          expect(c.attributes[attr]).toBeGreaterThanOrEqual(a.ranges[attr][0]);
          expect(c.attributes[attr]).toBeLessThanOrEqual(a.ranges[attr][1]);
        }
        // Prices stay within ±20% of the archetype's, after rounding.
        expect(c.hireCost).toBeGreaterThanOrEqual(a.hireCost * 0.8 - 25);
        expect(c.hireCost).toBeLessThanOrEqual(a.hireCost * 1.2 + 25);
        expect(c.wage).toBeGreaterThanOrEqual(a.wage * 0.8 - 5);
        expect(c.wage).toBeLessThanOrEqual(a.wage * 1.2 + 5);
        expect(c.traits.length).toBeGreaterThanOrEqual(1);
        expect(new Set(c.traits).size).toBe(c.traits.length);
      }
      const [firsts, nicks] = [board.map((c) => c.name.split(" ")[0]), board.map((c) => c.name.split('"')[1])];
      expect(new Set(firsts).size, `day ${day}`).toBe(board.length);
      expect(new Set(nicks).size, `day ${day}`).toBe(board.length);
    }
  });

  it("shows every archetype over time", () => {
    const seen = new Set<string>();
    for (let day = 0; day < 100; day++) for (const c of generateBoard(FAMILY, day)) seen.add(c.archetype);
    expect([...seen].sort()).toEqual(ARCHETYPES.map((a) => a.key).sort());
  });

  it("hashSeed is stable (a change would reshuffle every live board)", () => {
    expect(hashSeed("")).toBe(0x811c9dc5);
    expect(hashSeed("a")).toBe(0xe40c292c);
  });
});

describe("board day", () => {
  it("turns over at midnight Lagos time (23:00 UTC)", () => {
    const lateUtc = Date.UTC(2026, 9, 10, 22, 59, 59);
    const lagosMidnight = Date.UTC(2026, 9, 10, 23, 0, 0);
    expect(boardDay(lagosMidnight)).toBe(boardDay(lateUtc) + 1);
    expect(boardResetsAt(boardDay(lateUtc))).toBe(lagosMidnight);
  });
});

describe("moraleAfter", () => {
  it("rises a little when paid, drops when unpaid, and stays within 0–100", () => {
    expect(moraleAfter(70, true)).toBe(75);
    expect(moraleAfter(98, true)).toBe(100);
    expect(moraleAfter(70, false)).toBe(45);
    expect(moraleAfter(10, false)).toBe(0);
  });
});

describe("henchman permissions", () => {
  const who = (kind: "recruit_henchman" | "assign_henchman" | "dismiss_henchman") => FAMILY_ROLES.filter((r) => checkFamilyAction(r, { kind }).ok);
  it("recruit: don, underboss, capo, quartermaster; assign: don, underboss, capo; dismiss: don, underboss", () => {
    expect(who("recruit_henchman")).toEqual(["don", "underboss", "capo", "quartermaster"]);
    expect(who("assign_henchman")).toEqual(["don", "underboss", "capo"]);
    expect(who("dismiss_henchman")).toEqual(["don", "underboss"]);
  });
});
