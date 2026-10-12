import { Inject, Injectable } from "@nestjs/common";
import type { DistrictSummary, DistrictTerritories } from "@kots/shared";
import { and, count, eq, isNull } from "drizzle-orm";
import { notFound } from "../../common/errors";
import { DB, type Database } from "../../db/db";
import { districts, families, territories } from "../../db/schema";

/** Read side of the map. Every query is bounded: the city overview, or one district at a time. */
@Injectable()
export class MapService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async districtSummaries(): Promise<DistrictSummary[]> {
    const rows = await this.db
      .select({ slug: districts.slug, territoryCount: count(territories.id), ownedCount: count(territories.ownerFamilyId) })
      .from(districts)
      .leftJoin(territories, eq(territories.districtId, districts.id))
      .groupBy(districts.id, districts.slug)
      .orderBy(districts.slug);
    return rows;
  }

  async districtTerritories(slug: string): Promise<DistrictTerritories> {
    const [district] = await this.db.select({ id: districts.id }).from(districts).where(eq(districts.slug, slug));
    if (!district) throw notFound("District");
    const rows = await this.db
      .select({ slug: territories.slug, battleId: territories.contestedBattleId, ownerId: families.id, ownerName: families.name, ownerTag: families.tag })
      .from(territories)
      // A disbanded family can't hold territory; treat any leftover reference as neutral.
      .leftJoin(families, and(eq(families.id, territories.ownerFamilyId), isNull(families.disbandedAt)))
      .where(eq(territories.districtId, district.id))
      .orderBy(territories.slug);
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
