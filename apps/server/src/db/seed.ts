import { DISTRICTS, GOODS, MARKETS, TERRITORIES } from "@kots/content";
import { inArray, notInArray, sql } from "drizzle-orm";
import type { Database } from "./db";
import { districts, goods, npcMarketState, territories } from "./schema";

export interface SeedResult {
  districts: number;
  territories: number;
  /** Territories in the database that are no longer in content. Never deleted automatically: they may be owned. */
  stale: string[];
}

/**
 * Upserts districts and territories from packages/content by slug. Idempotent.
 * Only static fields are written; runtime state such as the owner is never touched.
 */
export async function seedMap(db: Database): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    const districtRows = await tx
      .insert(districts)
      .values(DISTRICTS.map((d) => ({ slug: d.slug, name: d.name })))
      .onConflictDoUpdate({ target: districts.slug, set: { name: sql`excluded.name` } })
      .returning({ id: districts.id, slug: districts.slug });
    const districtId = new Map(districtRows.map((d) => [d.slug, d.id]));

    await tx
      .insert(territories)
      .values(
        TERRITORIES.map((t) => ({
          slug: t.slug,
          districtId: districtId.get(t.district)!,
          name: t.name,
          kind: t.kind,
          baseIncome: t.baseIncome,
          baseUpkeep: t.baseUpkeep,
        })),
      )
      .onConflictDoUpdate({
        target: territories.slug,
        set: {
          districtId: sql`excluded.district_id`,
          name: sql`excluded.name`,
          kind: sql`excluded.kind`,
          baseIncome: sql`excluded.base_income`,
          baseUpkeep: sql`excluded.base_upkeep`,
        },
      });

    const stale = await tx
      .select({ slug: territories.slug })
      .from(territories)
      .where(notInArray(territories.slug, TERRITORIES.map((t) => t.slug)));
    return { districts: DISTRICTS.length, territories: TERRITORIES.length, stale: stale.map((s) => s.slug) };
  });
}

/**
 * Upserts goods from content and opens any missing market stock at its normal level. Idempotent; existing stock is
 * runtime state and is never reset. Run after seedMap: markets live in territories.
 */
export async function seedMarkets(db: Database): Promise<{ goods: number; markets: number }> {
  return db.transaction(async (tx) => {
    await tx
      .insert(goods)
      .values(GOODS.map((g) => ({ key: g.key, label: g.label })))
      .onConflictDoUpdate({ target: goods.key, set: { label: sql`excluded.label` } });
    const rows = await tx
      .select({ id: territories.id, slug: territories.slug })
      .from(territories)
      .where(inArray(territories.slug, MARKETS.map((m) => m.territory)));
    const territoryId = new Map(rows.map((r) => [r.slug, r.id]));
    await tx
      .insert(npcMarketState)
      .values(
        MARKETS.flatMap((m) =>
          GOODS.map((g) => ({ territoryId: territoryId.get(m.territory)!, good: g.key, stock: m.goods[g.key].normalStock })),
        ),
      )
      .onConflictDoNothing();
    return { goods: GOODS.length, markets: MARKETS.length };
  });
}
