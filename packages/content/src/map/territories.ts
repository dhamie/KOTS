import type { DistrictSlug } from "./districts";

export const TERRITORY_KINDS = ["commercial", "residential", "logistics", "industrial", "civic", "waterfront"] as const;
export type TerritoryKind = (typeof TERRITORY_KINDS)[number];

export interface TerritoryDef {
  /** The character used for this territory in CITY_GRID. */
  code: string;
  slug: string;
  name: string;
  district: DistrictSlug;
  kind: TerritoryKind;
  /** ₦ per day before modifiers (used from Phase 4). */
  baseIncome: number;
  /** ₦ per day before modifiers (used from Phase 4). */
  baseUpkeep: number;
  description: string;
}

/** Real places are setting only; every organisation and event in the game is fictional. */
export const TERRITORIES: readonly TerritoryDef[] = [
  // Yaba & Ebute Metta
  { code: "T", slug: "tejuosho", name: "Tejuosho Market", district: "yaba-ebute-metta", kind: "commercial", baseIncome: 900, baseUpkeep: 400, description: "A sprawling market where anything can be found for the right price." },
  { code: "K", slug: "akoka", name: "Akoka", district: "yaba-ebute-metta", kind: "residential", baseIncome: 500, baseUpkeep: 200, description: "Student quarters by the lagoon, at the foot of Third Mainland Bridge." },
  { code: "G", slug: "alagomeji", name: "Alagomeji", district: "yaba-ebute-metta", kind: "residential", baseIncome: 450, baseUpkeep: 180, description: "Quiet streets with long memories." },
  { code: "S", slug: "sabo", name: "Sabo", district: "yaba-ebute-metta", kind: "commercial", baseIncome: 800, baseUpkeep: 350, description: "Busy junctions, shops and the traffic that feeds them." },
  { code: "E", slug: "ebute-metta", name: "Ebute Metta", district: "yaba-ebute-metta", kind: "residential", baseIncome: 550, baseUpkeep: 220, description: "Old railway town, dense and well connected." },
  { code: "O", slug: "oyingbo", name: "Oyingbo Market", district: "yaba-ebute-metta", kind: "commercial", baseIncome: 850, baseUpkeep: 380, description: "Foodstuff arrives here from all over the country." },
  { code: "M", slug: "otto", name: "Otto", district: "yaba-ebute-metta", kind: "industrial", baseIncome: 700, baseUpkeep: 320, description: "Rail yards and workshops along the creek." },
  { code: "D", slug: "iddo", name: "Iddo Terminal", district: "yaba-ebute-metta", kind: "logistics", baseIncome: 750, baseUpkeep: 330, description: "Train terminus and the mainland end of Carter Bridge." },
  // Lagos Island
  { code: "R", slug: "ebute-ero", name: "Ebute Ero", district: "lagos-island", kind: "commercial", baseIncome: 850, baseUpkeep: 380, description: "Lagoon-side market where Carter Bridge comes ashore." },
  { code: "B", slug: "obalende", name: "Obalende", district: "lagos-island", kind: "logistics", baseIncome: 800, baseUpkeep: 360, description: "Motor parks and the island end of Third Mainland Bridge." },
  { code: "I", slug: "idumota", name: "Idumota", district: "lagos-island", kind: "commercial", baseIncome: 1000, baseUpkeep: 450, description: "The commercial heart of the island; every road here is a business." },
  { code: "U", slug: "balogun", name: "Balogun Market", district: "lagos-island", kind: "commercial", baseIncome: 1100, baseUpkeep: 500, description: "Fabrics, electronics and a hundred side deals a minute." },
  { code: "X", slug: "isale-eko", name: "Isale Eko", district: "lagos-island", kind: "residential", baseIncome: 600, baseUpkeep: 250, description: "The old town. Families here have long memories and longer loyalties." },
  { code: "N", slug: "marina", name: "Marina", district: "lagos-island", kind: "waterfront", baseIncome: 900, baseUpkeep: 420, description: "Jetties and offices facing the harbour." },
  { code: "Q", slug: "tinubu-square", name: "Tinubu Square", district: "lagos-island", kind: "civic", baseIncome: 650, baseUpkeep: 400, description: "Courts and government offices; influence is the real currency." },
  { code: "F", slug: "broad-street", name: "Broad Street", district: "lagos-island", kind: "commercial", baseIncome: 1200, baseUpkeep: 550, description: "Banks and trading houses. Money moves quietly here." },
  // Apapa
  { code: "J", slug: "ijora", name: "Ijora", district: "apapa", kind: "industrial", baseIncome: 650, baseUpkeep: 300, description: "Causeway, depots and the mainland end of Eko Bridge." },
  { code: "Z", slug: "ajegunle", name: "Ajegunle", district: "apapa", kind: "residential", baseIncome: 500, baseUpkeep: 200, description: "Crowded, proud and never quiet." },
  { code: "V", slug: "liverpool-road", name: "Liverpool Road", district: "apapa", kind: "industrial", baseIncome: 700, baseUpkeep: 320, description: "Warehouses and tank farms behind the port." },
  { code: "P", slug: "apapa-gra", name: "Apapa GRA", district: "apapa", kind: "residential", baseIncome: 750, baseUpkeep: 350, description: "Leafy streets where shipping money lives." },
  { code: "W", slug: "apapa-wharf", name: "Apapa Wharf", district: "apapa", kind: "logistics", baseIncome: 1200, baseUpkeep: 600, description: "The main port. Containers, cranes and customs." },
  { code: "Y", slug: "kirikiri", name: "Kirikiri", district: "apapa", kind: "industrial", baseIncome: 600, baseUpkeep: 280, description: "Jetties, fuel depots and a famous prison down the road." },
  { code: "C", slug: "tin-can", name: "Tin Can Island", district: "apapa", kind: "logistics", baseIncome: 1000, baseUpkeep: 500, description: "The second port, busy day and night." },
];

export interface BridgeDef {
  name: string;
  /** Any tile of the bridge, to name the `=` run that contains it. */
  at: readonly [number, number];
}

export const BRIDGES: readonly BridgeDef[] = [
  { name: "Third Mainland Bridge", at: [20, 3] },
  { name: "Carter Bridge", at: [19, 14] },
  { name: "Eko Bridge", at: [19, 20] },
];
