import { Inject, Injectable } from "@nestjs/common";
import type { ActivityPage } from "@kots/shared";
import { and, desc, eq, lt } from "drizzle-orm";
import { DB, type Database } from "../../db/db";
import { activityLog, players } from "../../db/schema";
import type { DbOrTx } from "../../db/tx";
import { NotificationsService } from "../notifications/notifications.service";
import { RealtimeService, rooms } from "../realtime/realtime.service";

export interface ActivityRecord {
  familyId: string;
  actorPlayerId: string | null;
  type: string;
  payload?: Record<string, unknown>;
}

/**
 * Append-only family history. Callers record inside their own transaction, so history matches what happened.
 * Each entry also tells the family's browsers to refresh, and notifies the members it concerns, in that transaction.
 */
@Injectable()
export class ActivityService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
  ) {}

  async record(db: DbOrTx, entry: ActivityRecord): Promise<void> {
    await db.insert(activityLog).values({ ...entry, payload: entry.payload ?? {} });
    await this.notifications.fromActivity(db, entry);
    await this.realtime.publish(db, [rooms.family(entry.familyId)], { type: "family.changed" });
  }

  /** Newest first. `before` is the id of the last entry already seen. Authorisation is the caller's job. */
  async page(familyId: string, before: string | undefined, limit: number): Promise<ActivityPage> {
    const rows = await this.db
      .select({
        id: activityLog.id,
        type: activityLog.type,
        payload: activityLog.payload,
        createdAt: activityLog.createdAt,
        actorId: players.id,
        actorHandle: players.handle,
      })
      .from(activityLog)
      .leftJoin(players, eq(players.id, activityLog.actorPlayerId))
      .where(and(eq(activityLog.familyId, familyId), before ? lt(activityLog.id, BigInt(before)) : undefined))
      .orderBy(desc(activityLog.id))
      .limit(limit + 1);

    const items = rows.slice(0, limit).map((r) => ({
      id: r.id.toString(),
      type: r.type,
      actor: r.actorId && r.actorHandle ? { id: r.actorId, handle: r.actorHandle } : null,
      payload: r.payload,
      createdAt: r.createdAt.toISOString(),
    }));
    return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.id : null };
  }
}
