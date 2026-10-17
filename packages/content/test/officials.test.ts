import { describe, expect, it } from "vitest";
import { DISTRICTS, EVENT_DEFS, OFFICES, OFFICIAL_TRAITS, OFFICIALS, officialOf } from "../src";

describe("officials content", () => {
  it("has unique ids and exactly one official per office in every district", () => {
    expect(new Set(OFFICIALS.map((o) => o.id)).size).toBe(OFFICIALS.length);
    for (const d of DISTRICTS) {
      for (const office of OFFICES) {
        expect(OFFICIALS.filter((o) => o.district === d.slug && o.office === office), `${d.slug} ${office}`).toHaveLength(1);
      }
    }
    expect(OFFICIALS).toHaveLength(DISTRICTS.length * OFFICES.length);
  });

  it("gives every official every trait as a whole number from 0 to 100", () => {
    for (const o of OFFICIALS) {
      expect(Object.keys(o.traits).sort(), o.id).toEqual([...OFFICIAL_TRAITS].sort());
      for (const t of OFFICIAL_TRAITS) {
        expect(Number.isInteger(o.traits[t]), `${o.id} ${t}`).toBe(true);
        expect(o.traits[t]).toBeGreaterThanOrEqual(0);
        expect(o.traits[t]).toBeLessThanOrEqual(100);
      }
    }
  });

  it("only sways district events, through offices every district has", () => {
    for (const def of Object.values(EVENT_DEFS)) {
      if (!("swayedBy" in def)) continue;
      expect(def.scope).toBe("district");
      for (const d of DISTRICTS) expect(officialOf(d.slug, def.swayedBy.office)).toBeDefined();
    }
  });
});
