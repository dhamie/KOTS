import { DISTRICTS, type DistrictSlug } from "./districts";
import { CITY_GRID } from "./grid";
import { BRIDGES, TERRITORIES, type TerritoryDef } from "./territories";

export type Tile = readonly [x: number, y: number];

export interface TerritoryLayout extends TerritoryDef {
  tiles: Tile[];
  /** Where the territory's marker sits: the territory tile closest to its centre. */
  anchor: Tile;
  /** Slugs of territories that share an edge with this one or are joined to it by a bridge, sorted. */
  borders: string[];
}

export interface DistrictLayout {
  slug: DistrictSlug;
  name: string;
  blurb: string;
  territories: string[];
  /** Inclusive tile bounds. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  anchor: Tile;
}

export interface BridgeLayout {
  name: string;
  tiles: Tile[];
}

export interface CityLayout {
  width: number;
  height: number;
  /** Territory slug per tile, or "water" / "bridge". Indexed [y][x]. */
  cells: string[][];
  territories: Map<string, TerritoryLayout>;
  districts: Map<string, DistrictLayout>;
  bridges: BridgeLayout[];
}

export const WATER = "water";
export const BRIDGE = "bridge";

/** Parses CITY_GRID into tiles per territory, district bounds and bridges. Throws on unknown characters. */
export function buildCityLayout(grid: readonly string[] = CITY_GRID, territories: readonly TerritoryDef[] = TERRITORIES): CityLayout {
  const height = grid.length;
  const width = grid[0]?.length ?? 0;
  const byCode = new Map(territories.map((t) => [t.code, t]));
  const tilesBySlug = new Map<string, Tile[]>(territories.map((t) => [t.slug, []]));
  const cells: string[][] = [];

  grid.forEach((row, y) => {
    if (row.length !== width) throw new Error(`CITY_GRID row ${y} has ${row.length} tiles, expected ${width}`);
    cells.push(
      [...row].map((ch, x) => {
        if (ch === "~") return WATER;
        if (ch === "=") return BRIDGE;
        const t = byCode.get(ch);
        if (!t) throw new Error(`Unknown map character '${ch}' at (${x}, ${y})`);
        tilesBySlug.get(t.slug)!.push([x, y]);
        return t.slug;
      }),
    );
  });

  const bridges = findBridges(cells);
  const borders = bordersOf(cells, bridges);
  const territoryLayouts = new Map<string, TerritoryLayout>();
  for (const t of territories) {
    const tiles = tilesBySlug.get(t.slug)!;
    territoryLayouts.set(t.slug, { ...t, tiles, anchor: anchorOf(tiles), borders: [...(borders.get(t.slug) ?? [])].sort() });
  }

  const districts = new Map<string, DistrictLayout>();
  for (const d of DISTRICTS) {
    const own = territories.filter((t) => t.district === d.slug);
    const tiles = own.flatMap((t) => tilesBySlug.get(t.slug)!);
    const xs = tiles.map(([x]) => x);
    const ys = tiles.map(([, y]) => y);
    districts.set(d.slug, {
      slug: d.slug,
      name: d.name,
      blurb: d.blurb,
      territories: own.map((t) => t.slug),
      bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
      anchor: anchorOf(tiles),
    });
  }

  return { width, height, cells, territories: territoryLayouts, districts, bridges };
}

/** Which territories touch: over a shared tile edge, or through the two ends of a bridge. */
function bordersOf(cells: string[][], bridges: BridgeLayout[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    if (!out.has(a)) out.set(a, new Set());
    if (!out.has(b)) out.set(b, new Set());
    out.get(a)!.add(b);
    out.get(b)!.add(a);
  };
  const isTerritory = (c: string | undefined): c is string => c !== undefined && c !== WATER && c !== BRIDGE;
  cells.forEach((row, y) =>
    row.forEach((cell, x) => {
      if (!isTerritory(cell)) return;
      for (const [nx, ny] of neighbours(x, y)) {
        const other = cells[ny]?.[nx];
        if (isTerritory(other)) link(cell, other);
      }
    }),
  );
  for (const bridge of bridges) {
    const ends = new Set<string>();
    for (const [x, y] of bridge.tiles) {
      for (const [nx, ny] of neighbours(x, y)) {
        const other = cells[ny]?.[nx];
        if (isTerritory(other)) ends.add(other);
      }
    }
    for (const a of ends) for (const b of ends) link(a, b);
  }
  return out;
}

function anchorOf(tiles: Tile[]): Tile {
  if (tiles.length === 0) return [0, 0];
  const cx = tiles.reduce((s, [x]) => s + x, 0) / tiles.length;
  const cy = tiles.reduce((s, [, y]) => s + y, 0) / tiles.length;
  let best = tiles[0]!;
  let bestD = Infinity;
  for (const t of tiles) {
    const d = (t[0] - cx) ** 2 + (t[1] - cy) ** 2;
    if (d < bestD) [best, bestD] = [t, d];
  }
  return best;
}

/** Groups connected `=` tiles and names each run from BRIDGES. */
function findBridges(cells: string[][]): BridgeLayout[] {
  const seen = new Set<string>();
  const runs: Tile[][] = [];
  cells.forEach((row, y) =>
    row.forEach((cell, x) => {
      if (cell !== BRIDGE || seen.has(`${x},${y}`)) return;
      const run: Tile[] = [];
      const stack: Tile[] = [[x, y]];
      seen.add(`${x},${y}`);
      while (stack.length) {
        const [cx, cy] = stack.pop()!;
        run.push([cx, cy]);
        for (const [nx, ny] of neighbours(cx, cy)) {
          if (cells[ny]?.[nx] === BRIDGE && !seen.has(`${nx},${ny}`)) {
            seen.add(`${nx},${ny}`);
            stack.push([nx, ny]);
          }
        }
      }
      runs.push(run);
    }),
  );
  return runs.map((tiles) => ({
    name: BRIDGES.find((b) => tiles.some(([x, y]) => x === b.at[0] && y === b.at[1]))?.name ?? "Unnamed bridge",
    tiles,
  }));
}

export function neighbours(x: number, y: number): Tile[] {
  return [
    [x + 1, y],
    [x - 1, y],
    [x, y + 1],
    [x, y - 1],
  ];
}

/** The parsed city, built once. */
export const CITY: CityLayout = buildCityLayout();
