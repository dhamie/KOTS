import { DISTRICTS, EVENT_DEFS, EVENT_TYPES, EVENTS, MARKETS } from "@kots/content";
import { describe, expect, it } from "vitest";
import { eligibleTypes, eventScopeIds, planEvent, rollEvent } from "../src";

const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const seeds = Array.from({ length: 500 }, (_, i) => i * 7919 + 1);

describe("planEvent", () => {
  it("is the same for the same type, seed and scope", () => {
    for (const type of EVENT_TYPES) expect(planEvent(type, 42)).toEqual(planEvent(type, 42));
  });

  it("covers a place of the right kind, and keeps effects within their ranges", () => {
    for (const seed of seeds) {
      const port = planEvent("port_congestion", seed);
      expect(MARKETS.map((m) => m.territory)).toContain(port.scopeId);
      expect(EVENT_DEFS.port_congestion.goods).toContain(port.type === "port_congestion" && port.good);
      const fuel = planEvent("fuel_scarcity", seed);
      expect(fuel.scopeId).toBeNull();
      for (const [e, [min, max]] of [
        [port, EVENT_DEFS.port_congestion.stockLeftPct],
        [fuel, EVENT_DEFS.fuel_scarcity.stockLeftPct],
      ] as const) {
        const pct = "stockLeftPct" in e ? e.stockLeftPct : -1;
        expect(pct).toBeGreaterThanOrEqual(min);
        expect(pct).toBeLessThanOrEqual(max);
      }
      const sweep = planEvent("police_sweep", seed);
      expect(DISTRICTS.map((d) => d.slug as string)).toContain(sweep.scopeId);
      const loss = sweep.type === "police_sweep" ? sweep.moraleLoss : 0;
      expect(loss).toBeGreaterThanOrEqual(EVENT_DEFS.police_sweep.moraleLoss[0]);
      expect(loss).toBeLessThanOrEqual(EVENT_DEFS.police_sweep.moraleLoss[1]);
      expect(planEvent("street_festival", seed)).toMatchObject({ incomeDays: EVENT_DEFS.street_festival.incomeDays });
    }
  });

  it("uses the given scope, and refuses one the type can't cover", () => {
    expect(planEvent("street_festival", 1, "apapa").scopeId).toBe("apapa");
    expect(planEvent("port_congestion", 1, "balogun").scopeId).toBe("balogun");
    expect(() => planEvent("street_festival", 1, "balogun")).toThrow(RangeError);
    expect(() => planEvent("fuel_scarcity", 1, "apapa")).toThrow(RangeError);
    expect(eventScopeIds("fuel_scarcity")).toEqual([]);
  });
});

describe("rollEvent", () => {
  it("is the same for the same inputs", () => {
    for (const seed of seeds.slice(0, 50)) expect(rollEvent(seed, NOW, [], 0)).toEqual(rollEvent(seed, NOW, [], 0));
  });

  it("starts an event on roughly the configured share of hours", () => {
    const started = seeds.filter((s) => rollEvent(s, NOW, [], 0) !== null).length;
    const expected = (seeds.length * EVENTS.chancePerHourPct) / 100;
    expect(Math.abs(started - expected)).toBeLessThan(expected * 0.3);
  });

  it("starts nothing while the most events are current", () => {
    expect(seeds.every((s) => rollEvent(s, NOW, [], EVENTS.maxActive) === null)).toBe(true);
  });

  it("skips a type until its cooldown has passed", () => {
    const cooldown = EVENT_DEFS.street_festival.cooldownHours * HOUR;
    const past = [{ type: "street_festival" as const, startsAtMs: NOW - cooldown + 1 }];
    expect(eligibleTypes(NOW, past)).not.toContain("street_festival");
    expect(eligibleTypes(NOW + 1, past)).toContain("street_festival");
    expect(seeds.map((s) => rollEvent(s, NOW, past, 0)?.type).filter((t) => t === "street_festival")).toEqual([]);
  });

  it("starts nothing when every type is cooling down", () => {
    const past = EVENT_TYPES.map((type) => ({ type, startsAtMs: NOW }));
    expect(seeds.every((s) => rollEvent(s, NOW, past, 0) === null)).toBe(true);
  });

  it("can pick every type", () => {
    expect(new Set(seeds.map((s) => rollEvent(s, NOW, [], 0)?.type).filter(Boolean))).toEqual(new Set(EVENT_TYPES));
  });
});
