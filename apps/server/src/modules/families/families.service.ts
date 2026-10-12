import { Inject, Injectable } from "@nestjs/common";
import { ECONOMY, FORMER_DON_ROLE, INVITATION_TTL_DAYS, NEW_MEMBER_ROLE, ROLE_PERMISSIONS, ROLE_RANK, type FamilyPermission, type FamilyRole } from "@kots/content";
import { checkFamilyAction, pickSuccessor, type FamilyAction } from "@kots/rules";
import type { ActivityPage, FamilyDetail, Invitation } from "@kots/shared";
import { aliasedTable, and, count, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { CLOCK, type Clock } from "../../common/clock";
import { AppError, badRequest, conflict, forbidden, notFound, uniqueViolation } from "../../common/errors";
import { DB, type Database } from "../../db/db";
import { families, familyInvitations, familyMemberships, players } from "../../db/schema";
import type { DbOrTx, Tx } from "../../db/tx";
import { ActivityService } from "../activity/activity.service";
import { AccountsService } from "../auth/accounts.service";
import { HenchmenService } from "../henchmen/henchmen.service";
import { LedgerService } from "../ledger/ledger.service";
import { RealtimeService } from "../realtime/realtime.service";
import { TerritoriesService } from "../territories/territories.service";

type Membership = typeof familyMemberships.$inferSelect;

export interface MembershipSummary {
  family: { id: string; name: string; tag: string };
  role: FamilyRole;
  permissions: FamilyPermission[];
}

const REFUSALS = {
  missing_permission: "Your role doesn't allow that.",
  rank: "You can only manage members ranked below you, and only give roles below your own.",
  invalid_role: "That role change isn't allowed.",
} as const;

/**
 * Families, memberships and invitations.
 * Every write runs in one transaction that locks rows in this order: families → family_invitations →
 * family_memberships (sorted by player_id), then re-checks permissions against the locked rows.
 */
@Injectable()
export class FamiliesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly accounts: AccountsService,
    private readonly activity: ActivityService,
    private readonly ledger: LedgerService,
    private readonly territories: TerritoriesService,
    private readonly henchmen: HenchmenService,
    private readonly realtime: RealtimeService,
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────────

  async membershipOf(playerId: string): Promise<MembershipSummary | null> {
    const [row] = await this.db
      .select({ role: familyMemberships.role, id: families.id, name: families.name, tag: families.tag })
      .from(familyMemberships)
      .innerJoin(families, eq(families.id, familyMemberships.familyId))
      .where(eq(familyMemberships.playerId, playerId));
    if (!row) return null;
    return { family: { id: row.id, name: row.name, tag: row.tag }, role: row.role, permissions: [...ROLE_PERMISSIONS[row.role]] };
  }

  async getFamily(familyId: string): Promise<FamilyDetail> {
    const [family] = await this.db
      .select()
      .from(families)
      .where(and(eq(families.id, familyId), isNull(families.disbandedAt)));
    if (!family) throw notFound("Family");
    const members = await this.db
      .select({ playerId: players.id, handle: players.handle, role: familyMemberships.role, joinedAt: familyMemberships.joinedAt })
      .from(familyMemberships)
      .innerJoin(players, eq(players.id, familyMemberships.playerId))
      .where(eq(familyMemberships.familyId, familyId));
    members.sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.joinedAt.getTime() - b.joinedAt.getTime());
    return {
      id: family.id,
      name: family.name,
      tag: family.tag,
      stage: family.stage,
      foundedAt: family.foundedAt.toISOString(),
      members: members.map((m) => ({ ...m, joinedAt: m.joinedAt.toISOString() })),
    };
  }

  async activityPage(actorId: string, familyId: string, before: string | undefined, limit: number): Promise<ActivityPage> {
    const [actor] = await this.db.select().from(familyMemberships).where(eq(familyMemberships.playerId, actorId));
    if (!actor || actor.familyId !== familyId) throw forbidden("You are not a member of this family.");
    this.authorize(actor.role, { kind: "view_activity" });
    return this.activity.page(familyId, before, limit);
  }

  /** Open invitations sent by a family. Visible to members who can invite. */
  async familyInvitations(actorId: string, familyId: string): Promise<Invitation[]> {
    const [actor] = await this.db.select().from(familyMemberships).where(eq(familyMemberships.playerId, actorId));
    if (!actor || actor.familyId !== familyId) throw forbidden("You are not a member of this family.");
    this.authorize(actor.role, { kind: "invite" });
    return this.openInvitations(eq(familyInvitations.familyId, familyId));
  }

  /** Open invitations addressed to a player. */
  async invitationsFor(playerId: string): Promise<Invitation[]> {
    return this.openInvitations(eq(familyInvitations.playerId, playerId));
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  async create(actorId: string, name: string, tag: string): Promise<FamilyDetail> {
    let familyId: string;
    try {
      familyId = await this.db.transaction(async (tx) => {
        const existing = await this.lockMembers(tx, [actorId]);
        if (existing.size > 0) throw conflict("ALREADY_IN_FAMILY", "Leave your current family first.");
        const [family] = await tx.insert(families).values({ name, tag }).returning({ id: families.id });
        await tx.insert(familyMemberships).values({ playerId: actorId, familyId: family!.id, role: "don" });
        const treasury = await this.ledger.openTreasury(tx, family!.id);
        await this.ledger.post(tx, {
          kind: "grant",
          idempotencyKey: `grant:${family!.id}`,
          actorPlayerId: actorId,
          ref: { type: "family", id: family!.id },
          lines: [
            { accountId: treasury, amount: ECONOMY.startingGrant, reason: "starting_grant" },
            { accountId: await this.ledger.systemAccount("grants", tx), amount: -ECONOMY.startingGrant, reason: "starting_grant" },
          ],
        });
        await this.activity.record(tx, { familyId: family!.id, actorPlayerId: actorId, type: "family.created", payload: { name, tag } });
        await this.realtime.playerChanged(tx, actorId);
        return family!.id;
      });
    } catch (err) {
      const constraint = uniqueViolation(err);
      if (constraint === "families_name_active_unique") throw conflict("FAMILY_NAME_TAKEN", "That family name is taken.");
      if (constraint === "families_tag_active_unique") throw conflict("FAMILY_TAG_TAKEN", "That tag is taken.");
      if (constraint === "family_memberships_pkey") throw conflict("ALREADY_IN_FAMILY", "Leave your current family first.");
      throw err;
    }
    return this.getFamily(familyId);
  }

  async invite(actorId: string, familyId: string, handle: string): Promise<Invitation> {
    const target = await this.accounts.findPlayerByHandle(handle);
    if (!target) throw notFound("Player");
    let invitationId: string;
    try {
      invitationId = await this.db.transaction(async (tx) => {
        await this.lockFamily(tx, familyId, "share");
        const members = await this.lockMembers(tx, [actorId, target.id]);
        const actor = this.requireMember(members, actorId, familyId);
        this.authorize(actor.role, { kind: "invite" });
        if (members.get(target.id)?.familyId === familyId) throw conflict("ALREADY_MEMBER", `${target.handle} is already in the family.`);

        // A stale pending invitation would block the new one through the one-pending index.
        await tx
          .update(familyInvitations)
          .set({ status: "expired" })
          .where(
            and(
              eq(familyInvitations.familyId, familyId),
              eq(familyInvitations.playerId, target.id),
              eq(familyInvitations.status, "pending"),
              lte(familyInvitations.expiresAt, sql`now()`),
            ),
          );
        const [inv] = await tx
          .insert(familyInvitations)
          .values({
            familyId,
            playerId: target.id,
            invitedByPlayerId: actorId,
            expiresAt: sql`now() + make_interval(days => ${INVITATION_TTL_DAYS})`,
          })
          .returning({ id: familyInvitations.id });
        await this.activity.record(tx, { familyId, actorPlayerId: actorId, type: "member.invited", payload: { playerId: target.id, handle: target.handle } });
        return inv!.id;
      });
    } catch (err) {
      if (uniqueViolation(err) === "family_invitations_one_pending") throw conflict("ALREADY_INVITED", `${target.handle} already has an open invitation.`);
      throw err;
    }
    const [invitation] = await this.openInvitations(eq(familyInvitations.id, invitationId));
    return invitation!;
  }

  async revokeInvitation(actorId: string, familyId: string, invitationId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lockFamily(tx, familyId, "share");
      const inv = await this.lockPendingInvitation(tx, and(eq(familyInvitations.id, invitationId), eq(familyInvitations.familyId, familyId)));
      const actor = this.requireMember(await this.lockMembers(tx, [actorId]), actorId, familyId);
      this.authorize(actor.role, { kind: "invite" });
      await tx.update(familyInvitations).set({ status: "revoked", respondedAt: sql`now()` }).where(eq(familyInvitations.id, inv.id));
      await this.activity.record(tx, { familyId, actorPlayerId: actorId, type: "invitation.revoked", payload: { playerId: inv.playerId } });
    });
  }

  async acceptInvitation(playerId: string, invitationId: string): Promise<FamilyDetail> {
    // Read the family id first (no lock) so locks can be taken in the standard order.
    const [peek] = await this.db
      .select({ familyId: familyInvitations.familyId })
      .from(familyInvitations)
      .where(and(eq(familyInvitations.id, invitationId), eq(familyInvitations.playerId, playerId)));
    if (!peek) throw notFound("Invitation");
    try {
      await this.db.transaction(async (tx) => {
        await this.lockFamily(tx, peek.familyId, "share", "Invitation");
        const inv = await this.lockPendingInvitation(tx, and(eq(familyInvitations.id, invitationId), eq(familyInvitations.playerId, playerId)));
        if (inv.expiresAt.getTime() <= Date.now()) throw new AppError(410, "INVITATION_EXPIRED", "That invitation has expired.");
        // The primary key on player_id makes a second simultaneous accept fail here.
        await tx.insert(familyMemberships).values({ playerId, familyId: inv.familyId, role: NEW_MEMBER_ROLE });
        await tx.update(familyInvitations).set({ status: "accepted", respondedAt: sql`now()` }).where(eq(familyInvitations.id, inv.id));
        await this.activity.record(tx, { familyId: inv.familyId, actorPlayerId: playerId, type: "member.joined", payload: { invitedBy: inv.invitedByPlayerId } });
        await this.realtime.playerChanged(tx, playerId);
      });
    } catch (err) {
      if (uniqueViolation(err) === "family_memberships_pkey") throw conflict("ALREADY_IN_FAMILY", "Leave your current family first.");
      throw err;
    }
    return this.getFamily(peek.familyId);
  }

  async declineInvitation(playerId: string, invitationId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const inv = await this.lockPendingInvitation(tx, and(eq(familyInvitations.id, invitationId), eq(familyInvitations.playerId, playerId)));
      await tx.update(familyInvitations).set({ status: "declined", respondedAt: sql`now()` }).where(eq(familyInvitations.id, inv.id));
      await this.activity.record(tx, { familyId: inv.familyId, actorPlayerId: playerId, type: "invitation.declined" });
    });
  }

  async setRole(actorId: string, familyId: string, targetId: string, newRole: FamilyRole): Promise<FamilyDetail> {
    await this.db.transaction(async (tx) => {
      const members = await this.lockMembers(tx, [actorId, targetId]);
      const actor = this.requireMember(members, actorId, familyId);
      const target = this.requireTarget(members, targetId, familyId);
      this.authorize(actor.role, { kind: "set_role", target: target.role, newRole });
      await tx.update(familyMemberships).set({ role: newRole }).where(eq(familyMemberships.playerId, targetId));
      await this.activity.record(tx, {
        familyId,
        actorPlayerId: actorId,
        type: "member.role_changed",
        payload: { playerId: targetId, handle: await this.handleOf(targetId, tx), from: target.role, to: newRole },
      });
      await this.realtime.playerChanged(tx, targetId);
    });
    return this.getFamily(familyId);
  }

  async kick(actorId: string, familyId: string, targetId: string): Promise<FamilyDetail> {
    await this.db.transaction(async (tx) => {
      const members = await this.lockMembers(tx, [actorId, targetId]);
      const actor = this.requireMember(members, actorId, familyId);
      const target = this.requireTarget(members, targetId, familyId);
      this.authorize(actor.role, { kind: "kick", target: target.role });
      await tx.delete(familyMemberships).where(eq(familyMemberships.playerId, targetId));
      await this.activity.record(tx, { familyId, actorPlayerId: actorId, type: "member.kicked", payload: { playerId: targetId, handle: await this.handleOf(targetId, tx) } });
      await this.realtime.playerChanged(tx, targetId);
    });
    return this.getFamily(familyId);
  }

  async leave(actorId: string, familyId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const actor = this.requireMember(await this.lockMembers(tx, [actorId]), actorId, familyId);
      if (actor.role === "don") throw conflict("DON_MUST_TRANSFER", "Transfer leadership first, or disband the family if you're the last member.");
      await tx.delete(familyMemberships).where(eq(familyMemberships.playerId, actorId));
      await this.activity.record(tx, { familyId, actorPlayerId: actorId, type: "member.left" });
      await this.realtime.playerChanged(tx, actorId);
    });
  }

  async transferLeadership(actorId: string, familyId: string, targetId: string): Promise<FamilyDetail> {
    if (actorId === targetId) throw badRequest("You are already the Don.");
    await this.db.transaction(async (tx) => {
      const members = await this.lockMembers(tx, [actorId, targetId]);
      const actor = this.requireMember(members, actorId, familyId);
      this.authorize(actor.role, { kind: "transfer_leadership" });
      this.requireTarget(members, targetId, familyId);
      // Demote first: the one-Don index is checked per statement.
      await tx.update(familyMemberships).set({ role: FORMER_DON_ROLE }).where(eq(familyMemberships.playerId, actorId));
      await tx.update(familyMemberships).set({ role: "don" }).where(eq(familyMemberships.playerId, targetId));
      await this.activity.record(tx, { familyId, actorPlayerId: actorId, type: "leadership.transferred", payload: { playerId: targetId, handle: await this.handleOf(targetId, tx) } });
      await this.realtime.playerChanged(tx, actorId);
      await this.realtime.playerChanged(tx, targetId);
    });
    return this.getFamily(familyId);
  }

  async disband(actorId: string, familyId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lockFamily(tx, familyId, "no key update");
      const actor = this.requireMember(await this.lockMembers(tx, [actorId]), actorId, familyId);
      this.authorize(actor.role, { kind: "disband" });
      const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(familyMemberships).where(eq(familyMemberships.familyId, familyId));
      if (n > 1) throw conflict("FAMILY_NOT_EMPTY", "Only a family with no other members can be disbanded.");
      await tx
        .update(familyInvitations)
        .set({ status: "revoked", respondedAt: sql`now()` })
        .where(and(eq(familyInvitations.familyId, familyId), eq(familyInvitations.status, "pending")));
      await tx.delete(familyMemberships).where(eq(familyMemberships.familyId, familyId));
      await this.territories.releaseAll(tx, familyId, actorId);
      await this.henchmen.dismissAll(tx, familyId);
      await this.ledger.closeTreasury(tx, familyId, actorId);
      await tx.update(families).set({ disbandedAt: sql`now()` }).where(eq(families.id, familyId));
      await this.activity.record(tx, { familyId, actorPlayerId: actorId, type: "family.disbanded" });
      await this.realtime.playerChanged(tx, actorId);
    });
  }

  // ── Scheduled ────────────────────────────────────────────────────────────

  /**
   * Replaces Dons who have been inactive for ECONOMY.donInactiveDays with the most senior active member
   * (see pickSuccessor). Run by the worker. Returns how many families changed leader.
   */
  async succeedInactiveDons(now: Date = this.clock.now()): Promise<number> {
    const cutoff = new Date(now.getTime() - ECONOMY.donInactiveDays * 24 * 60 * 60 * 1000);
    const stale = await this.db
      .select({ familyId: familyMemberships.familyId })
      .from(familyMemberships)
      .innerJoin(players, eq(players.id, familyMemberships.playerId))
      .innerJoin(families, eq(families.id, familyMemberships.familyId))
      .where(and(eq(familyMemberships.role, "don"), lte(players.lastActiveAt, cutoff), isNull(families.disbandedAt)));

    let changed = 0;
    for (const { familyId } of stale) {
      const done = await this.db.transaction(async (tx) => {
        await this.lockFamily(tx, familyId, "no key update");
        const ids = (await tx.select({ id: familyMemberships.playerId }).from(familyMemberships).where(eq(familyMemberships.familyId, familyId))).map((r) => r.id);
        const members = await this.lockMembers(tx, ids);
        const people = new Map(
          (await tx.select({ id: players.id, handle: players.handle, lastActiveAt: players.lastActiveAt }).from(players).where(inArray(players.id, ids))).map(
            (p) => [p.id, p],
          ),
        );
        const candidates = [...members.values()]
          .filter((m) => m.familyId === familyId)
          .map((m) => ({ playerId: m.playerId, role: m.role, joinedAtMs: m.joinedAt.getTime(), lastActiveAtMs: people.get(m.playerId)!.lastActiveAt.getTime() }));
        const don = candidates.find((m) => m.role === "don");
        if (!don) return false;
        const successor = pickSuccessor(don, candidates, now.getTime());
        if (!successor) return false;
        await tx.update(familyMemberships).set({ role: FORMER_DON_ROLE }).where(eq(familyMemberships.playerId, don.playerId));
        await tx.update(familyMemberships).set({ role: "don" }).where(eq(familyMemberships.playerId, successor));
        await this.activity.record(tx, {
          familyId,
          actorPlayerId: null,
          type: "leadership.succeeded",
          payload: { playerId: successor, handle: people.get(successor)!.handle, formerDon: people.get(don.playerId)!.handle },
        });
        await this.realtime.playerChanged(tx, don.playerId);
        await this.realtime.playerChanged(tx, successor);
        return true;
      });
      if (done) changed++;
    }
    return changed;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private authorize(role: FamilyRole, action: FamilyAction): void {
    const check = checkFamilyAction(role, action);
    if (!check.ok) throw forbidden(REFUSALS[check.reason]);
  }

  /**
   * `no key update` rather than `update`: it excludes other writers just the same, but doesn't block the foreign-key
   * checks of rows that reference the family (activity entries written by sweeps), which would deadlock.
   */
  private async lockFamily(tx: Tx, familyId: string, mode: "share" | "no key update", what = "Family"): Promise<void> {
    const rows = await tx
      .select({ id: families.id })
      .from(families)
      .where(and(eq(families.id, familyId), isNull(families.disbandedAt)))
      .for(mode);
    if (rows.length === 0) throw notFound(what);
  }

  private async lockPendingInvitation(tx: Tx, where: ReturnType<typeof and>) {
    const [inv] = await tx
      .select()
      .from(familyInvitations)
      .where(and(where, eq(familyInvitations.status, "pending")))
      .for("update");
    if (!inv) throw notFound("Invitation");
    return inv;
  }

  /** Locks the given players' membership rows (those that exist) in player_id order, to avoid deadlocks. */
  private async lockMembers(tx: Tx, playerIds: string[]): Promise<Map<string, Membership>> {
    const rows = await tx
      .select()
      .from(familyMemberships)
      .where(inArray(familyMemberships.playerId, playerIds))
      .orderBy(familyMemberships.playerId)
      .for("update");
    return new Map(rows.map((r) => [r.playerId, r]));
  }

  private requireMember(members: Map<string, Membership>, playerId: string, familyId: string): Membership {
    const m = members.get(playerId);
    if (!m || m.familyId !== familyId) throw forbidden("You are not a member of this family.");
    return m;
  }

  private requireTarget(members: Map<string, Membership>, playerId: string, familyId: string): Membership {
    const m = members.get(playerId);
    if (!m || m.familyId !== familyId) throw notFound("Member");
    return m;
  }

  /** Pass the transaction when inside one: a second pool connection per transaction can exhaust the pool. */
  private async handleOf(playerId: string, db: DbOrTx): Promise<string> {
    return (await this.accounts.findPlayerById(playerId, db))?.handle ?? "unknown";
  }

  private async openInvitations(where: ReturnType<typeof eq>): Promise<Invitation[]> {
    const invited = aliasedTable(players, "invited");
    const inviter = aliasedTable(players, "inviter");
    const rows = await this.db
      .select({
        id: familyInvitations.id,
        createdAt: familyInvitations.createdAt,
        expiresAt: familyInvitations.expiresAt,
        familyId: families.id,
        familyName: families.name,
        familyTag: families.tag,
        playerId: invited.id,
        playerHandle: invited.handle,
        inviterId: inviter.id,
        inviterHandle: inviter.handle,
      })
      .from(familyInvitations)
      .innerJoin(families, eq(families.id, familyInvitations.familyId))
      .innerJoin(invited, eq(invited.id, familyInvitations.playerId))
      .innerJoin(inviter, eq(inviter.id, familyInvitations.invitedByPlayerId))
      .where(and(where, eq(familyInvitations.status, "pending"), gt(familyInvitations.expiresAt, sql`now()`), isNull(families.disbandedAt)))
      .orderBy(familyInvitations.createdAt);
    return rows.map((r) => ({
      id: r.id,
      family: { id: r.familyId, name: r.familyName, tag: r.familyTag },
      player: { id: r.playerId, handle: r.playerHandle },
      invitedBy: { id: r.inviterId, handle: r.inviterHandle },
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
    }));
  }
}
