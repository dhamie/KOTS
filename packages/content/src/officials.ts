import type { DistrictSlug } from "./map";

/**
 * NPC officials (Phase 8b). Every official, office and story is fictional and abstract. For now they only have
 * profiles and sway which district some events hit (see packages/rules/src/events.ts); players can't act on them
 * yet. See docs/OFFICIALS.md.
 */
export const OFFICES = ["area_chairman", "area_commander"] as const;
export type Office = (typeof OFFICES)[number];

export const OFFICE_DEFS = {
  area_chairman: { label: "Area Chairman", blurb: "Runs the district's civic life: markets, permits and celebrations." },
  area_commander: { label: "Area Commander", blurb: "Keeps order on the district's streets." },
} as const satisfies Record<Office, { label: string; blurb: string }>;

export const OFFICIAL_TRAITS = ["integrity", "ambition", "loyalty", "selfInterest"] as const;
export type OfficialTrait = (typeof OFFICIAL_TRAITS)[number];

export const OFFICIAL_TRAIT_LABELS: Record<OfficialTrait, string> = {
  integrity: "Integrity",
  ambition: "Ambition",
  loyalty: "Loyalty",
  selfInterest: "Self-interest",
};

export interface OfficialDef {
  id: string;
  name: string;
  office: Office;
  district: DistrictSlug;
  bio: string;
  /** Each 0–100. */
  traits: Record<OfficialTrait, number>;
}

export const OFFICIALS = [
  {
    id: "funmi-okafor",
    name: "Funmi Okafor",
    office: "area_chairman",
    district: "yaba-ebute-metta",
    bio: "A former schoolteacher who won on a promise to clean up the markets. Keeps her own ledger and checks it twice.",
    traits: { integrity: 84, ambition: 55, loyalty: 60, selfInterest: 20 },
  },
  {
    id: "tunde-ashiru",
    name: "Tunde Ashiru",
    office: "area_commander",
    district: "yaba-ebute-metta",
    bio: "Twenty years on the Mainland beat. Prefers a quiet district to a famous one.",
    traits: { integrity: 50, ambition: 30, loyalty: 75, selfInterest: 55 },
  },
  {
    id: "rasaki-oduya",
    name: "Rasaki Oduya",
    office: "area_chairman",
    district: "lagos-island",
    bio: "Born above a shop on the Marina. Never misses a ribbon to cut or a crowd to address.",
    traits: { integrity: 35, ambition: 90, loyalty: 40, selfInterest: 70 },
  },
  {
    id: "ngozi-eze",
    name: "Ngozi Eze",
    office: "area_commander",
    district: "lagos-island",
    bio: "New to the Island and keen to show it. Answers to the book and nobody else.",
    traits: { integrity: 88, ambition: 80, loyalty: 50, selfInterest: 15 },
  },
  {
    id: "dele-martins",
    name: "Dele Martins",
    office: "area_chairman",
    district: "apapa",
    bio: "Made his name in shipping before politics. Knows every warehouse owner by first name.",
    traits: { integrity: 45, ambition: 40, loyalty: 70, selfInterest: 65 },
  },
  {
    id: "kunle-abiodun",
    name: "Kunle Abiodun",
    office: "area_commander",
    district: "apapa",
    bio: "Runs the port district by routine. Sees a lot, says little.",
    traits: { integrity: 40, ambition: 45, loyalty: 65, selfInterest: 60 },
  },
] as const satisfies readonly OfficialDef[];

export const OFFICIALS_TUNING = {
  /** Officials with at least this integrity can't be bought. Shown on profiles; no mechanic uses it yet. */
  unbuyableIntegrity: 80,
  /** Added to an official's sway on an event (see EVENT_DEFS `swayedBy`), so no district's chance is ever zero. */
  baseSway: 50,
} as const;

/** The official holding `office` in `district`. Every district has one of each (a content test checks this). */
export function officialOf(district: string, office: Office): OfficialDef | undefined {
  return OFFICIALS.find((o) => o.district === district && o.office === office);
}

export const canBeBought = (official: OfficialDef) => official.traits.integrity < OFFICIALS_TUNING.unbuyableIntegrity;
