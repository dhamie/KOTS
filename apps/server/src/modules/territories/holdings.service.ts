import { Inject, Injectable } from "@nestjs/common";
import type { TerritoryKind } from "@kots/content";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { forbidden, notFound } from "../../common/errors";
import { DB, type Database } from "../../db/db";
import { territories } from "../../db/schema";
import type { DbOrTx, Tx } from "../../db/tx";

/**
 * Ownership checks for modules that put things on a family's territory (henchmen) or depend on what it holds
 * (storage, markets).
 * Kept apart from TerritoriesService, which calls those modules when a territory changes hands.
 */
@Injectable()
export class HoldingsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Locks the territory (FOR SHARE: it can't change hands until the caller commits) and returns its id. */
  async lockHeld(tx: Tx, slug: string, familyId: string): Promise<string> {
    const [t] = await tx.select({ id: territories.id, owner: territories.ownerFamilyId }).from(territories).where(eq(territories.slug, slug)).for("share");
    if (!t) throw notFound("Territory");
    if (t.owner !== familyId) throw forbidden("Your family doesn't hold that territory.");
    return t.id;
  }

  /** A territory's name, current owner, base upkeep and the battle over it, unlocked. */
  async ownerOf(slug: string, db: DbOrTx = this.db): Promise<{ name: string; owner: string | null; baseUpkeep: number; battleId: string | null } | null> {
    const [t] = await db
      .select({ name: territories.name, owner: territories.ownerFamilyId, baseUpkeep: territories.baseUpkeep, battleId: territories.contestedBattleId })
      .from(territories)
      .where(eq(territories.slug, slug));
    return t ?? null;
  }

  /** Slugs of the territories a family holds. */
  async slugsHeld(familyId: string, db: DbOrTx = this.db): Promise<string[]> {
    return (await db.select({ slug: territories.slug }).from(territories).where(eq(territories.ownerFamilyId, familyId))).map((r) => r.slug);
  }

  /** Slugs by territory id, for display. */
  async slugsOf(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.select({ id: territories.id, slug: territories.slug }).from(territories).where(inArray(territories.id, ids));
    return new Map(rows.map((r) => [r.id, r.slug]));
  }

  /** The kinds of the territories a family holds, one entry per territory. */
  async kindsHeld(familyId: string, db: DbOrTx = this.db): Promise<TerritoryKind[]> {
    const rows = await db.select({ kind: territories.kind }).from(territories).where(eq(territories.ownerFamilyId, familyId));
    return rows.map((r) => r.kind);
  }

  /** The held territories among `slugs`, locked FOR SHARE (they can't change hands until the caller commits), in id order. */
  async lockHeldAmong(tx: Tx, slugs: readonly string[]): Promise<{ id: string; name: string; owner: string; baseIncome: number }[]> {
    const rows = await tx
      .select({ id: territories.id, name: territories.name, owner: territories.ownerFamilyId, baseIncome: territories.baseIncome })
      .from(territories)
      .where(and(inArray(territories.slug, [...slugs]), isNotNull(territories.ownerFamilyId)))
      .orderBy(asc(territories.id))
      .for("share");
    return rows.map((r) => ({ ...r, owner: r.owner! }));
  }

  /** Territory ids by slug, for the slugs that exist. */
  async idsOf(slugs: readonly string[], db: DbOrTx = this.db): Promise<Map<string, string>> {
    if (slugs.length === 0) return new Map();
    const rows = await db.select({ id: territories.id, slug: territories.slug }).from(territories).where(inArray(territories.slug, [...slugs]));
    return new Map(rows.map((r) => [r.slug, r.id]));
  }
}
