import { buildCityLayout, CITY } from "@kots/content";
import { describe, expect, it } from "vitest";
import { districtsInView, markerMode, TILE_H, tileBoundsToWorld, tileCentre, tileToWorld, worldToTile } from "../src/map/iso";

describe("isometric projection", () => {
  it("places tiles on a 2:1 diamond lattice", () => {
    expect(tileToWorld(0, 0)).toEqual({ x: 0, y: 0 });
    expect(tileToWorld(1, 0)).toEqual({ x: 32, y: 16 });
    expect(tileToWorld(0, 1)).toEqual({ x: -32, y: 16 });
  });

  it("round-trips every tile's centre and points near its corners", () => {
    for (let ty = 0; ty < CITY.height; ty++) {
      for (let tx = 0; tx < CITY.width; tx++) {
        const c = tileCentre(tx, ty);
        expect(worldToTile(c.x, c.y)).toEqual([tx, ty]);
        // Just inside the top and bottom corners still belongs to the same tile.
        expect(worldToTile(c.x, c.y - TILE_H / 2 + 1)).toEqual([tx, ty]);
        expect(worldToTile(c.x, c.y + TILE_H / 2 - 1)).toEqual([tx, ty]);
      }
    }
  });

  it("tile bounds become a world rectangle that contains every tile centre in range", () => {
    const r = tileBoundsToWorld({ minX: 2, minY: 3, maxX: 5, maxY: 9 });
    for (let x = 2; x <= 5; x++) {
      for (let y = 3; y <= 9; y++) {
        const c = tileCentre(x, y);
        expect(c.x).toBeGreaterThan(r.x);
        expect(c.x).toBeLessThan(r.x + r.width);
        expect(c.y).toBeGreaterThan(r.y);
        expect(c.y).toBeLessThan(r.y + r.height);
      }
    }
  });
});

describe("viewport", () => {
  it("a view of the whole city sees every district; a view on one territory sees its district", () => {
    const all = tileBoundsToWorld({ minX: 0, minY: 0, maxX: CITY.width - 1, maxY: CITY.height - 1 });
    expect(districtsInView(CITY, all).sort()).toEqual([...CITY.districts.keys()].sort());

    const balogun = CITY.territories.get("balogun")!;
    const c = tileCentre(...balogun.anchor);
    expect(districtsInView(CITY, { x: c.x - 10, y: c.y - 10, width: 20, height: 20 })).toEqual(["lagos-island"]);
  });

  it("a view out over open water sees nothing", () => {
    const layout = buildCityLayout();
    const far = tileCentre(39, 0); // north-east lagoon corner
    expect(districtsInView(layout, { x: far.x - 5, y: far.y - 5, width: 10, height: 10 })).toEqual([]);
  });
});

describe("marker mode", () => {
  it("shows districts when zoomed out and territories when zoomed in", () => {
    expect(markerMode(0.5, 0.5)).toBe("districts");
    expect(markerMode(0.79, 0.5)).toBe("districts");
    expect(markerMode(0.8, 0.5)).toBe("territories");
  });
});
