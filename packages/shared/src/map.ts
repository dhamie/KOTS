import { z } from "zod";

/** `GET /api/map/districts`: the light city-level overview. Geometry ships with the client (packages/content). */
export const DistrictSummary = z.object({ slug: z.string(), territoryCount: z.number().int(), ownedCount: z.number().int() });
export const DistrictSummaryList = z.array(DistrictSummary);
export type DistrictSummary = z.infer<typeof DistrictSummary>;

/** The parts of a territory that change at runtime. Static fields (name, kind, base values) come from content. */
export const TerritoryState = z.object({
  slug: z.string(),
  owner: z.object({ id: z.uuid(), name: z.string(), tag: z.string() }).nullable(),
  /** The battle being fought over it, if any. */
  battleId: z.uuid().nullable(),
});
export type TerritoryState = z.infer<typeof TerritoryState>;

export const DistrictTerritories = z.object({ district: z.string(), territories: z.array(TerritoryState) });
export type DistrictTerritories = z.infer<typeof DistrictTerritories>;

export const TerritoriesQuery = z.strictObject({ district: z.string().regex(/^[a-z0-9-]{1,40}$/) });
