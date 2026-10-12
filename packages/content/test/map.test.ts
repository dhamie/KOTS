import { describe, expect, it } from "vitest";
import { BRIDGE, BRIDGES, buildCityLayout, CITY, CITY_GRID, DISTRICTS, neighbours, TERRITORIES, WATER, type Tile } from "../src";

const isLand = (x: number, y: number) => {
  const c = CITY.cells[y]?.[x];
  return c !== undefined && c !== WATER && c !== BRIDGE;
};

/** Tiles reachable from `start` moving only through tiles that satisfy `ok`. */
function flood(start: Tile, ok: (x: number, y: number) => boolean): Set<string> {
  const seen = new Set([`${start[0]},${start[1]}`]);
  const stack: Tile[] = [start];
  while (stack.length) {
    const [x, y] = stack.pop()!;
    for (const [nx, ny] of neighbours(x, y)) {
      const k = `${nx},${ny}`;
      if (!seen.has(k) && ok(nx, ny)) {
        seen.add(k);
        stack.push([nx, ny]);
      }
    }
  }
  return seen;
}

describe("city map content", () => {
  it("has unique territory codes and slugs, and every territory belongs to a known district", () => {
    expect(new Set(TERRITORIES.map((t) => t.code)).size).toBe(TERRITORIES.length);
    expect(new Set(TERRITORIES.map((t) => t.slug)).size).toBe(TERRITORIES.length);
    const districts = new Set<string>(DISTRICTS.map((d) => d.slug));
    for (const t of TERRITORIES) expect(districts.has(t.district), t.slug).toBe(true);
    for (const t of TERRITORIES) expect(t.code).toMatch(/^[A-Z]$/);
  });

  it("is a rectangular grid of known characters", () => {
    expect(() => buildCityLayout()).not.toThrow();
    expect(() => buildCityLayout(["T?"])).toThrow(/Unknown map character/);
    expect(() => buildCityLayout(["TT", "T"])).toThrow(/expected 2/);
  });

  it("every territory has land, forms one connected piece, and has no lake inside it", () => {
    for (const t of CITY.territories.values()) {
      expect(t.tiles.length, t.slug).toBeGreaterThanOrEqual(6);
      const reach = flood(t.tiles[0]!, (x, y) => CITY.cells[y]?.[x] === t.slug);
      expect(reach.size, `${t.slug} is split into pieces`).toBe(t.tiles.length);
      expect(CITY.cells[t.anchor[1]]![t.anchor[0]], `${t.slug} marker is off its land`).toBe(t.slug);
    }
  });

  it("every district has territories, and all districts are reachable over land and bridges", () => {
    for (const d of CITY.districts.values()) expect(d.territories.length, d.slug).toBeGreaterThan(0);
    const start = CITY.territories.values().next().value!.tiles[0]!;
    const reach = flood(start, (x, y) => isLand(x, y) || CITY.cells[y]?.[x] === BRIDGE);
    for (const t of CITY.territories.values()) expect(reach.has(`${t.tiles[0]![0]},${t.tiles[0]![1]}`), `${t.slug} unreachable`).toBe(true);
  });

  it("each bridge is named and joins two different districts", () => {
    expect(CITY.bridges.map((b) => b.name).sort()).toEqual(BRIDGES.map((b) => b.name).sort());
    for (const bridge of CITY.bridges) {
      const touched = new Set<string>();
      for (const [x, y] of bridge.tiles) {
        for (const [nx, ny] of neighbours(x, y)) {
          if (isLand(nx, ny)) touched.add(CITY.territories.get(CITY.cells[ny]![nx]!)!.district);
        }
      }
      expect(touched.size, bridge.name).toBe(2);
    }
  });

  it("territory borders are symmetric, and every territory borders another (claims spread from them)", () => {
    for (const t of CITY.territories.values()) {
      expect(t.borders.length, t.slug).toBeGreaterThan(0);
      expect(t.borders, t.slug).not.toContain(t.slug);
      for (const b of t.borders) expect(CITY.territories.get(b)!.borders, `${b} should border ${t.slug}`).toContain(t.slug);
    }
  });

  it("bridges make the territories at their two ends border each other", () => {
    const crossings = [...CITY.territories.values()].flatMap((t) =>
      t.borders.filter((b) => CITY.territories.get(b)!.district !== t.district && t.slug < b).map((b) => `${t.slug}~${b}`),
    );
    // Third Mainland, Carter and Eko, plus the one land border between the mainland districts.
    expect(crossings.sort()).toEqual(["akoka~obalende", "ebute-ero~iddo", "iddo~ijora", "idumota~ijora"]);
  });

  it("covers the map: about two dozen territories, the grid edge is water", () => {
    expect(TERRITORIES.length).toBeGreaterThanOrEqual(20);
    const h = CITY_GRID.length;
    const w = CITY_GRID[0]!.length;
    expect(CITY_GRID[h - 1]).toBe("~".repeat(w));
    for (let y = 0; y < h; y++) expect(CITY_GRID[y]![w - 1]).toBe("~");
  });
});
