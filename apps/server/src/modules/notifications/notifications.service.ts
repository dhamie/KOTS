import { Inject, Injectable } from "@nestjs/common";
import { BATTLES, ROLE_PERMISSIONS, type FamilyPermission } from "@kots/content";
import type { Notification, NotificationPage } from "@kots/shared";
import { and, count, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { notFound } from "../../common/errors";
import { DB, type Database } from "../../db/db";
import { notifications } from "../../db/schema";
import type { DbOrTx } from "../../db/tx";
import { MembershipsService } from "../families/memberships.service";
import { RealtimeService, rooms } from "../realtime/realtime.service";

type Row = typeof notifications.$inferSelect;

/** A family activity entry (see ActivityService). */
export interface FamilyEvent {
  familyId: string;
  actorPlayerId: string | null;
  type: string;
  payload?: Record<string, unknown>;
}
type Target = Notification["target"];
type Payload = Record<string, unknown>;

interface Rule {
  /** Members whose role has this permission are told; "all" tells every member. */
  to: FamilyPermission | "all";
  target: Target;
  text: (p: Payload) => string;
}

/** Family activity that also notifies members. Keyed by activity type. */
const RULES: Record<string, Rule> = {
  "trade.received": { to: "trade.accept", target: "trade", text: (p) => `[${p.with}] sent your family a trade offer.` },
  "trade.executed": { to: "trade.propose", target: "trade", text: (p) => `[${p.with}] accepted your offer.` },
  "trade.declined": { to: "trade.propose", target: "trade", text: (p) => `[${p.with}] declined your offer.` },
  "trade.expired": { to: "trade.propose", target: "trade", text: (p) => `An offer between your family and [${p.with}] expired.` },
  "territory.neglected": { to: "treasury.view", target: "territory", text: (p) => `Upkeep on ${p.name} is overdue. Top up the treasury before it's lost.` },
  "territory.lost": { to: "treasury.view", target: "territory", text: (p) => `${p.name} was lost: its upkeep went unpaid.` },
  "henchman.unpaid": { to: "treasury.view", target: "henchmen", text: (p) => `${p.name}'s wages are overdue.` },
  "henchman.deserted": { to: "treasury.view", target: "henchmen", text: (p) => `${p.name} walked out over unpaid wages.` },
  "leadership.succeeded": { to: "all", target: "family", text: (p) => `${p.handle} is now Don: ${p.formerDon} was inactive.` },
  "proposal.received": { to: "diplomacy.talk", target: "diplomacy", text: (p) => `[${p.with}] proposed ${p.summary}.` },
  "proposal.signed": { to: "diplomacy.talk", target: "diplomacy", text: (p) => `[${p.with}] signed: ${p.summary}. It runs when your family signs.` },
  "proposal.executed": { to: "diplomacy.talk", target: "diplomacy", text: (p) => `Agreed with [${p.with}]: ${p.summary}.` },
  "proposal.declined": { to: "diplomacy.talk", target: "diplomacy", text: (p) => `[${p.with}] declined: ${p.summary}.` },
  "proposal.withdrawn": { to: "diplomacy.talk", target: "diplomacy", text: (p) => `[${p.with}] withdrew: ${p.summary}.` },
  "battle.attacked": {
    to: "all",
    target: "battle",
    text: (p) => `[${p.with}] declared a battle for ${p.name}. Round 1 is in ${BATTLES.preparationHours} hours: commit your henchmen.`,
  },
  "battle.round": { to: "war.command", target: "battle", text: (p) => `Round ${p.round} at ${p.name} against [${p.with}]: ${p.outcome === "draw" ? "a draw" : `you ${p.outcome}`}.` },
  "battle.won": { to: "all", target: "battle", text: (p) => `Victory at ${p.name} against [${p.with}].` },
  "battle.lost": { to: "all", target: "battle", text: (p) => `Defeat at ${p.name} against [${p.with}].` },
  "battle.cancelled": { to: "all", target: "battle", text: (p) => `The battle for ${p.name} with [${p.with}] was called off.` },
  "event.festival": {
    to: "treasury.view",
    target: "family",
    text: (p) => `A street festival in ${p.district} paid your family ₦${Number(p.amount).toLocaleString("en-NG")}.`,
  },
  "event.police_sweep": { to: "all", target: "henchmen", text: (p) => `A police sweep in ${p.district} rattled ${p.henchmen === 1 ? "one of your guards" : `${p.henchmen} of your guards`}: −${p.morale} morale.` },
  "admin.adjusted": {
    to: "treasury.view",
    target: "family",
    text: (p) => `An administrator ${Number(p.amount) > 0 ? "credited" : "debited"} your treasury ₦${Math.abs(Number(p.amount)).toLocaleString("en-NG")}: ${p.reason}`,
  },
  "proposal.expired": { to: "diplomacy.talk", target: "diplomacy", text: (p) => `A proposal with [${p.with}] expired: ${p.summary}.` },
};

const toDto = (r: Row): Notification => ({
  id: r.id.toString(),
  type: r.type,
  body: r.body,
  target: r.target as Target,
  read: r.readAt !== null,
  createdAt: r.createdAt.toISOString(),
});

/**
 * Per-player notifications. They're derived from family activity in the same transaction (ActivityService calls
 * fromActivity), so an event that happens once notifies once, and a retried job that writes nothing notifies no one.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly memberships: MembershipsService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Notifies the members an activity entry concerns. A family isn't told about what one of its own members did:
   * only about other families' actions and the server's sweeps. An invitation goes to the invited player.
   */
  async fromActivity(db: DbOrTx, e: FamilyEvent): Promise<void> {
    if (e.type === "member.invited") {
      const family = (await this.memberships.familiesById([e.familyId], db)).get(e.familyId)!;
      await this.notify(db, [String(e.payload?.playerId)], "member.invited", "invitation", `${family.name} [${family.tag}] invited you to join.`);
      return;
    }
    const rule = RULES[e.type];
    if (!rule) return;
    const members = await this.memberships.membersOf(e.familyId, db);
    if (e.actorPlayerId && members.some((m) => m.playerId === e.actorPlayerId)) return;
    const to = members.filter((m) => rule.to === "all" || ROLE_PERMISSIONS[m.role].includes(rule.to)).map((m) => m.playerId);
    await this.notify(db, to, e.type, rule.target, rule.text(e.payload ?? {}));
  }

  async page(playerId: string, before: string | undefined, limit: number): Promise<NotificationPage> {
    const rows = await this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.playerId, playerId), before ? lt(notifications.id, BigInt(before)) : undefined))
      .orderBy(desc(notifications.id))
      .limit(limit + 1);
    const [unread] = await this.db
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.playerId, playerId), isNull(notifications.readAt)));
    const items = rows.slice(0, limit).map(toDto);
    return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.id : null, unread: unread!.n };
  }

  async markRead(playerId: string, id: string): Promise<void> {
    const rows = await this.db
      .update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
      .where(and(eq(notifications.id, BigInt(id)), eq(notifications.playerId, playerId)))
      .returning({ id: notifications.id });
    if (rows.length === 0) throw notFound("Notification");
  }

  async markAllRead(playerId: string): Promise<void> {
    await this.db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(and(eq(notifications.playerId, playerId), isNull(notifications.readAt)));
  }

  private async notify(db: DbOrTx, playerIds: string[], type: string, target: Target, body: string): Promise<void> {
    if (playerIds.length === 0) return;
    const rows = await db
      .insert(notifications)
      .values(playerIds.map((playerId) => ({ playerId, type, target, body })))
      .returning();
    for (const r of rows) await this.realtime.publish(db, [rooms.player(r.playerId)], { type: "notification", notification: toDto(r) });
  }
}
