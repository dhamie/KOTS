import { Inject, Injectable } from "@nestjs/common";
import type { FamilyRole } from "@kots/content";
import { checkFamilyAction, type FamilyAction } from "@kots/rules";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { forbidden } from "../../common/errors";
import { DB, type Database } from "../../db/db";
import { families, familyMemberships } from "../../db/schema";
import type { DbOrTx, Tx } from "../../db/tx";

export interface ActingMember {
  playerId: string;
  familyId: string;
  role: FamilyRole;
}

export interface FamilyFacts {
  id: string;
  name: string;
  tag: string;
  foundedAt: Date;
  disbandedAt: Date | null;
}

const facts = { id: families.id, name: families.name, tag: families.tag, foundedAt: families.foundedAt, disbandedAt: families.disbandedAt };

/**
 * Membership and family checks for other modules that act on behalf of a family (territories, henchmen, market, trades).
 * Kept apart from FamiliesService so those modules can depend on it without a cycle.
 */
@Injectable()
export class MembershipsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** The player's membership, unlocked. For reads. */
  async memberOf(playerId: string, db: DbOrTx = this.db): Promise<ActingMember | null> {
    const [row] = await db
      .select({ familyId: familyMemberships.familyId, role: familyMemberships.role })
      .from(familyMemberships)
      .where(eq(familyMemberships.playerId, playerId));
    return row ? { playerId, ...row } : null;
  }

  /** A family's members and their roles, unlocked. */
  async membersOf(familyId: string, db: DbOrTx = this.db): Promise<{ playerId: string; role: FamilyRole }[]> {
    return db.select({ playerId: familyMemberships.playerId, role: familyMemberships.role }).from(familyMemberships).where(eq(familyMemberships.familyId, familyId));
  }

  /** Throws 403 unless the player is a member of `familyId`. */
  async requireMemberOf(playerId: string, familyId: string): Promise<ActingMember> {
    const m = await this.memberOf(playerId);
    if (!m || m.familyId !== familyId) throw forbidden("You are not a member of this family.");
    return m;
  }

  /**
   * Locks the player's family row (FOR NO KEY UPDATE, so one family's actions run one at a time) and then
   * their membership row, and checks the action against the locked role. Follows the schema's lock order.
   */
  async lockActing(tx: Tx, playerId: string, action: FamilyAction): Promise<ActingMember> {
    // Through the transaction: a second pool connection per transaction can exhaust the pool under load.
    const peek = await this.memberOf(playerId, tx);
    if (!peek) throw forbidden("You need to be in a family to do that.");
    await tx
      .select({ id: families.id })
      .from(families)
      .where(and(eq(families.id, peek.familyId), isNull(families.disbandedAt)))
      // Not plain `update`: that would also block foreign-key checks on rows referencing the family (activity
      // entries written for it by another family's action or a sweep), and two such actions would deadlock.
      .for("no key update");
    const [locked] = await tx
      .select({ familyId: familyMemberships.familyId, role: familyMemberships.role })
      .from(familyMemberships)
      .where(and(eq(familyMemberships.playerId, playerId), eq(familyMemberships.familyId, peek.familyId)))
      .for("update");
    // Left, or moved family, between the peek and the lock.
    if (!locked) throw forbidden("You need to be in a family to do that.");
    if (!checkFamilyAction(locked.role, action).ok) throw forbidden("Your role doesn't allow that.");
    return { playerId, ...locked };
  }

  /**
   * Like lockActing, for an action that involves several families (a trade): locks all of them in id order, then the
   * player's membership, which must be in one of them. Returns the member and the locked families by id.
   */
  async lockActingAmong(tx: Tx, playerId: string, familyIds: readonly string[], action: FamilyAction): Promise<{ member: ActingMember; families: Map<string, FamilyFacts> }> {
    const ids = [...new Set(familyIds)].sort();
    const rows = await tx.select(facts).from(families).where(inArray(families.id, ids)).orderBy(asc(families.id)).for("no key update");
    const [locked] = await tx
      .select({ familyId: familyMemberships.familyId, role: familyMemberships.role })
      .from(familyMemberships)
      .where(and(eq(familyMemberships.playerId, playerId), inArray(familyMemberships.familyId, ids)))
      .for("update");
    if (!locked) throw forbidden("You are not a member of either family.");
    if (!checkFamilyAction(locked.role, action).ok) throw forbidden("Your role doesn't allow that.");
    return { member: { playerId, ...locked }, families: new Map(rows.map((r) => [r.id, r])) };
  }

  /** Locks families (FOR NO KEY UPDATE, in id order) for work that isn't any player's action, such as a battle round. */
  async lockFamilies(tx: Tx, familyIds: readonly string[]): Promise<Map<string, FamilyFacts>> {
    const ids = [...new Set(familyIds)].sort();
    const rows = await tx.select(facts).from(families).where(inArray(families.id, ids)).orderBy(asc(families.id)).for("no key update");
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** An active family, by tag (case-insensitive). */
  async familyByTag(tag: string, db: DbOrTx = this.db): Promise<FamilyFacts | null> {
    const [row] = await db
      .select(facts)
      .from(families)
      .where(and(eq(families.tag, tag), isNull(families.disbandedAt)));
    return row ?? null;
  }

  /** Families by id, active or not, for display and checks. */
  async familiesById(ids: readonly string[], db: DbOrTx = this.db): Promise<Map<string, FamilyFacts>> {
    if (ids.length === 0) return new Map();
    const rows = await db.select(facts).from(families).where(inArray(families.id, [...new Set(ids)]));
    return new Map(rows.map((r) => [r.id, r]));
  }
}
