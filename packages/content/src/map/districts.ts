export interface DistrictDef {
  slug: string;
  name: string;
  blurb: string;
}

export const DISTRICTS = [
  { slug: "yaba-ebute-metta", name: "Yaba & Ebute Metta", blurb: "Mainland markets, crowded streets and the rail yards at Otto and Iddo." },
  { slug: "lagos-island", name: "Lagos Island", blurb: "The old city: the great markets, the Marina and the money on Broad Street." },
  { slug: "apapa", name: "Apapa", blurb: "The ports. Everything that enters Lagos by sea passes through here." },
] as const satisfies readonly DistrictDef[];

export type DistrictSlug = (typeof DISTRICTS)[number]["slug"];
