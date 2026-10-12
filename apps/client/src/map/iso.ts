import type { CityLayout } from "@kots/content";

/** Isometric tile size in world pixels (2:1 diamonds). */
export const TILE_W = 64;
export const TILE_H = 32;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** World position of a tile's top corner. Tile (0,0) sits at x = 0; x grows to the south-east, y to the south-west. */
export function tileToWorld(tx: number, ty: number): Point {
  return { x: (tx - ty) * (TILE_W / 2), y: (tx + ty) * (TILE_H / 2) };
}

/** World position of a tile's centre. */
export function tileCentre(tx: number, ty: number): Point {
  const p = tileToWorld(tx, ty);
  return { x: p.x, y: p.y + TILE_H / 2 };
}

/** The tile containing a world point (inverse of tileToWorld). */
export function worldToTile(wx: number, wy: number): [number, number] {
  const a = wx / (TILE_W / 2);
  const b = wy / (TILE_H / 2);
  return [Math.floor((a + b) / 2), Math.floor((b - a) / 2)];
}

/** World rectangle covering a tile range (inclusive), from its four outer corners. */
export function tileBoundsToWorld(b: { minX: number; minY: number; maxX: number; maxY: number }): Rect {
  const corners = [tileToWorld(b.minX, b.minY), tileToWorld(b.maxX + 1, b.minY), tileToWorld(b.minX, b.maxY + 1), tileToWorld(b.maxX + 1, b.maxY + 1)];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Districts whose area overlaps the camera's view, in content order. Used to load only what's on screen. */
export function districtsInView(city: CityLayout, view: Rect): string[] {
  return [...city.districts.values()].filter((d) => intersects(tileBoundsToWorld(d.bounds), view)).map((d) => d.slug);
}

export type MarkerMode = "districts" | "territories";

/** Above this multiple of the fit-to-screen zoom, show one marker per territory instead of per district. */
export const TERRITORY_MARKER_ZOOM = 1.6;

export function markerMode(zoom: number, fitZoom: number): MarkerMode {
  return zoom / fitZoom >= TERRITORY_MARKER_ZOOM ? "territories" : "districts";
}
