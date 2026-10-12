import type { TerritoryKind } from "@kots/content";

/** Placeholder art direction: warm dusk tones, muted ground, brighter markers. */
export const PALETTE = {
  background: 0x14110f,
  water: 0x1d3a4a,
  waterLight: 0x2a5568,
  bridge: 0x8c7b63,
  bridgeRail: 0xd6c3a0,
  territoryBorder: 0x1a140f,
  districtBorder: 0xe0b860,
  highlight: 0xffe08a,
  neutralMarker: 0x8c7b63,
  markerRing: 0x14110f,
  contested: 0xe0473a,
  label: "#f2e8d5",
  labelShadow: "#000000",
};

export const KIND_STYLE: Record<TerritoryKind, { ground: number; building: number; buildChance: number; height: [number, number]; glyph: string; label: string }> = {
  commercial: { ground: 0x6b5a3e, building: 0xb88a4a, buildChance: 0.75, height: [14, 34], glyph: "C", label: "Commercial" },
  residential: { ground: 0x4e5a3a, building: 0x9c7a5a, buildChance: 0.65, height: [8, 18], glyph: "R", label: "Residential" },
  logistics: { ground: 0x5a5148, building: 0x6f8aa0, buildChance: 0.5, height: [6, 12], glyph: "L", label: "Logistics" },
  industrial: { ground: 0x4f4a44, building: 0x857565, buildChance: 0.55, height: [10, 22], glyph: "I", label: "Industrial" },
  civic: { ground: 0x5c5a4a, building: 0xd8d0bc, buildChance: 0.45, height: [16, 28], glyph: "G", label: "Civic" },
  waterfront: { ground: 0x4c5a58, building: 0xa8b4b0, buildChance: 0.5, height: [10, 26], glyph: "W", label: "Waterfront" },
};

/** A stable, distinguishable colour per family, from its id. */
export function familyColour(familyId: string): number {
  let h = 0;
  for (let i = 0; i < familyId.length; i++) h = (h * 31 + familyId.charCodeAt(i)) >>> 0;
  return hslToRgb((h % 360) / 360, 0.65, 0.55);
}

function hslToRgb(h: number, s: number, l: number): number {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

/** Darkens a colour for the shaded faces of a block. */
export function shade(colour: number, factor: number): number {
  const r = Math.round(((colour >> 16) & 0xff) * factor);
  const g = Math.round(((colour >> 8) & 0xff) * factor);
  const b = Math.round((colour & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}
