import { Inject, Injectable } from "@nestjs/common";
import type { DistrictSummary, DistrictTerritories } from "@kots/shared";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { notFound } from "../../common/errors";
import { DB, type Database } from "../../db/db";
import { districts, families, territories } from "../../db/schema";

/** Read side of the map. Every query is bounded: the city overview, or one district at a time. */
@Injectable()
export class MapService {
  /** Prepared once (Phase 10b): every map view runs these. */
  private readonly summaries;
  private readonly inDistrict;

  constructor(@Inject(DB) private readonly db: Database) {
    this.summaries = this.db
      .select({ slug: districts.slug, territoryCount: count(territories.id), ownedCount: count(territories.ownerFamilyId) })
      .from(districts)
      .leftJoin(territories, eq(territories.districtId, districts.id))
      .groupBy(districts.id, districts.slug)
      .orderBy(districts.slug)
      .prepare("map_district_summaries");
    this.inDistrict = this.db
      .select({ slug: territories.slug, battleId: territories.contestedBattleId, ownerId: families.id, ownerName: families.name, ownerTag: families.tag })
      .from(territories)
      // A disbanded family can't hold territory; treat any leftover reference as neutral.
      .leftJoin(families, and(eq(families.id, territories.ownerFamilyId), isNull(families.disbandedAt)))
      .innerJoin(districts, eq(districts.id, territories.districtId))
      .where(eq(districts.slug, sql.placeholder("slug")))
      .orderBy(territories.slug)
      .prepare("map_district_territories");
  }

  async districtSummaries(): Promise<DistrictSummary[]> {
    return this.summaries.execute();
  }

  async districtTerritories(slug: string): Promise<DistrictTerritories> {
    const rows = await this.inDistrict.execute({ slug });
    // Every district has territories, so no rows means no such district.
    if (rows.length === 0) throw notFound("District");
    return {
      district: slug,
      territories: rows.map((r) => ({
        slug: r.slug,
        owner: r.ownerId && r.ownerName && r.ownerTag ? { id: r.ownerId, name: r.ownerName, tag: r.ownerTag } : null,
        battleId: r.battleId,
      })),
    };
  }
}
