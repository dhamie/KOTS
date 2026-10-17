import { Inject, Injectable } from "@nestjs/common";
import type { BlockList, Report } from "@kots/shared";
import { aliasedTable, and, asc, desc, eq, or } from "drizzle-orm";
import { badRequest, forbidden, notFound } from "../../common/errors";
import { DB, type Database } from "../../db/db";
import { chatChannels, chatMessages, messageReports, moderationActions, MODERATION_ACTIONS, playerBlocks, players } from "../../db/schema";
import type { DbOrTx } from "../../db/tx";
import { AccountsService } from "../auth/accounts.service";

/**
 * Blocks, reports and the moderator audit log. Moderators are players with `is_moderator` (npm run mod:grant);
 * every moderator action is written to moderation_actions in the same transaction as the action.
 */
@Injectable()
export class ModerationService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly accounts: AccountsService,
  ) {}

  // ── Blocks ───────────────────────────────────────────────────────────────

  async blocks(playerId: string): Promise<BlockList> {
    return this.db
      .select({ id: players.id, handle: players.handle })
      .from(playerBlocks)
      .innerJoin(players, eq(players.id, playerBlocks.blockedId))
      .where(eq(playerBlocks.blockerId, playerId))
      .orderBy(asc(players.handle));
  }

  async block(playerId: string, handle: string): Promise<BlockList> {
    const target = await this.accounts.findPlayerByHandle(handle);
    if (!target) throw notFound("Player");
    if (target.id === playerId) throw badRequest("You can't block yourself.");
    await this.db.insert(playerBlocks).values({ blockerId: playerId, blockedId: target.id }).onConflictDoNothing();
    return this.blocks(playerId);
  }

  async unblock(playerId: string, blockedId: string): Promise<void> {
    await this.db.delete(playerBlocks).where(and(eq(playerBlocks.blockerId, playerId), eq(playerBlocks.blockedId, blockedId)));
  }

  /** True if either player has blocked the other. */
  async blockedEitherWay(db: DbOrTx, a: string, b: string): Promise<boolean> {
    const rows = await db
      .select({ blocker: playerBlocks.blockerId })
      .from(playerBlocks)
      .where(
        or(and(eq(playerBlocks.blockerId, a), eq(playerBlocks.blockedId, b)), and(eq(playerBlocks.blockerId, b), eq(playerBlocks.blockedId, a))),
      )
      .limit(1);
    return rows.length > 0;
  }

  // ── Reports ──────────────────────────────────────────────────────────────

  /** One report per player per message; reporting again changes nothing. The caller checks the player can see it. */
  async report(db: DbOrTx, reporterId: string, messageId: bigint, reason: Report["reason"], note: string | undefined): Promise<void> {
    await db
      .insert(messageReports)
      .values({ messageId, reporterId, reason, note: note || null })
      .onConflictDoNothing();
  }

  /** Open reports, oldest first. Moderators only. */
  async openReports(moderatorId: string): Promise<Report[]> {
    await this.requireModerator(moderatorId);
    const reporter = aliasedTable(players, "reporter");
    const author = aliasedTable(players, "author");
    const rows = await this.db
      .select({
        id: messageReports.id,
        reason: messageReports.reason,
        note: messageReports.note,
        createdAt: messageReports.createdAt,
        reporterId: reporter.id,
        reporterHandle: reporter.handle,
        messageId: chatMessages.id,
        channelId: chatMessages.channelId,
        authorId: author.id,
        authorHandle: author.handle,
        body: chatMessages.body,
        messageCreatedAt: chatMessages.createdAt,
        channelKind: chatChannels.kind,
      })
      .from(messageReports)
      .innerJoin(chatMessages, eq(chatMessages.id, messageReports.messageId))
      .innerJoin(chatChannels, eq(chatChannels.id, chatMessages.channelId))
      .leftJoin(reporter, eq(reporter.id, messageReports.reporterId))
      .leftJoin(author, eq(author.id, chatMessages.authorId))
      .where(eq(messageReports.status, "open"))
      .orderBy(asc(messageReports.createdAt))
      .limit(100);
    return rows.map((r) => ({
      id: r.id,
      reason: r.reason,
      note: r.note,
      reporter: r.reporterId && r.reporterHandle ? { id: r.reporterId, handle: r.reporterHandle } : null,
      message: {
        id: r.messageId.toString(),
        channelId: r.channelId,
        author: r.authorId && r.authorHandle ? { id: r.authorId, handle: r.authorHandle } : null,
        body: r.body,
        createdAt: r.messageCreatedAt.toISOString(),
      },
      channelKind: r.channelKind,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async dismissReport(moderatorId: string, reportId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.requireModerator(moderatorId, tx);
      const [row] = await tx
        .update(messageReports)
        .set({ status: "dismissed", resolvedBy: moderatorId, resolvedAt: new Date() })
        .where(and(eq(messageReports.id, reportId), eq(messageReports.status, "open")))
        .returning({ id: messageReports.id });
      if (!row) throw notFound("Report");
      await this.audit(tx, moderatorId, "dismiss_report", "report", reportId);
    });
  }

  /** Closes a deleted message's open reports. */
  async resolveReportsFor(db: DbOrTx, messageId: bigint, moderatorId: string): Promise<void> {
    await db
      .update(messageReports)
      .set({ status: "actioned", resolvedBy: moderatorId, resolvedAt: new Date() })
      .where(and(eq(messageReports.messageId, messageId), eq(messageReports.status, "open")));
  }

  // ── Moderators ───────────────────────────────────────────────────────────

  async requireModerator(playerId: string, db: DbOrTx = this.db): Promise<void> {
    if (!(await this.accounts.isModerator(playerId, db))) throw forbidden("Moderators only.");
  }

  async audit(
    db: DbOrTx,
    moderatorId: string | null,
    action: (typeof MODERATION_ACTIONS)[number],
    targetType: string,
    targetId: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await db.insert(moderationActions).values({ moderatorId, action, targetType, targetId, details });
  }

  /** The audit entries about one target, newest first. */
  async auditFor(targetType: string, targetId: string, limit: number): Promise<(typeof moderationActions.$inferSelect)[]> {
    return this.db
      .select()
      .from(moderationActions)
      .where(and(eq(moderationActions.targetType, targetType), eq(moderationActions.targetId, targetId)))
      .orderBy(desc(moderationActions.id))
      .limit(limit);
  }
}
