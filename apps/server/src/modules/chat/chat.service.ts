import { Inject, Injectable } from "@nestjs/common";
import { CHAT } from "@kots/content";
import { checkFamilyAction } from "@kots/rules";
import type { ChatChannel, ChatMessage, ChatPage, ReportRequest } from "@kots/shared";
import { aliasedTable, and, desc, eq, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { AppError, badRequest, forbidden, notFound } from "../../common/errors";
import { SlidingWindow } from "../../common/rate-limit";
import { CONFIG } from "../../common/tokens";
import type { ServerConfig } from "../../config";
import { DB, type Database } from "../../db/db";
import { chatChannels, chatMessages, chatReads, playerBlocks, players } from "../../db/schema";
import type { DbOrTx } from "../../db/tx";
import { AccountsService } from "../auth/accounts.service";
import { MembershipsService } from "../families/memberships.service";
import { RealtimeService, rooms } from "../realtime/realtime.service";
import { ModerationService } from "./moderation.service";

type Channel = typeof chatChannels.$inferSelect;
const author = aliasedTable(players, "author");

const messageFields = {
  id: chatMessages.id,
  channelId: chatMessages.channelId,
  body: chatMessages.body,
  createdAt: chatMessages.createdAt,
  authorId: author.id,
  authorHandle: author.handle,
};
type MessageRow = { id: bigint; channelId: string; body: string; createdAt: Date; authorId: string | null; authorHandle: string | null };

const toDto = (r: MessageRow): ChatMessage => ({
  id: r.id.toString(),
  channelId: r.channelId,
  author: r.authorId && r.authorHandle ? { id: r.authorId, handle: r.authorHandle } : null,
  body: r.body,
  createdAt: r.createdAt.toISOString(),
});

/**
 * Family, public and direct chat. Chat never changes game state. Access is checked on every request against current
 * membership (family channels) or the channel's two players (direct); messages are stored, then pushed live.
 */
@Injectable()
export class ChatService {
  private readonly limiter: SlidingWindow;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CONFIG) config: ServerConfig,
    private readonly accounts: AccountsService,
    private readonly memberships: MembershipsService,
    private readonly moderation: ModerationService,
    private readonly realtime: RealtimeService,
  ) {
    this.limiter = new SlidingWindow(config.chatLimit);
  }

  // ── Channels ─────────────────────────────────────────────────────────────

  /**
   * The player's family channel (if in a family), the public channel, their family's diplomacy rooms (if their role
   * may talk), and their direct channels, with unread counts.
   */
  async channels(playerId: string): Promise<ChatChannel[]> {
    const member = await this.memberships.memberOf(playerId);
    const family = member ? await this.familyChannel(member.familyId) : null;
    const diplomat = member && checkFamilyAction(member.role, { kind: "diplomacy_talk" }).ok ? member.familyId : null;
    const other = aliasedTable(players, "other");
    const otherId = sql`case when ${chatChannels.playerA} = ${playerId} then ${chatChannels.playerB} else ${chatChannels.playerA} end`;
    const rows = await this.db
      .select({
        channel: chatChannels,
        otherId: other.id,
        otherHandle: other.handle,
        unread: sql<number>`(select count(*) from (
          select 1 from ${chatMessages} m
          where m.channel_id = ${chatChannels.id} and m.deleted_at is null
            and m.id > coalesce((select r.last_read_id from ${chatReads} r where r.player_id = ${playerId} and r.channel_id = ${chatChannels.id}), 0)
            and m.author_id is distinct from ${playerId}
            and not exists (select 1 from ${playerBlocks} b where b.blocker_id = ${playerId} and b.blocked_id = m.author_id)
          limit 99) x)`.mapWith(Number),
      })
      .from(chatChannels)
      .leftJoin(other, and(eq(chatChannels.kind, "direct"), eq(other.id, otherId)))
      .where(
        or(
          eq(chatChannels.kind, "public"),
          family ? eq(chatChannels.id, family.id) : undefined,
          and(eq(chatChannels.kind, "direct"), or(eq(chatChannels.playerA, playerId), eq(chatChannels.playerB, playerId))),
          diplomat ? and(eq(chatChannels.kind, "diplomacy"), or(eq(chatChannels.familyA, diplomat), eq(chatChannels.familyB, diplomat))) : undefined,
        ),
      )
      .orderBy(
        sql`case ${chatChannels.kind} when 'family' then 0 when 'public' then 1 when 'diplomacy' then 2 else 3 end`,
        sql`${chatChannels.lastMessageAt} desc nulls last`,
      )
      .limit(100);
    const fams = await this.memberships.familiesById([
      ...(member ? [member.familyId] : []),
      ...rows.flatMap(({ channel: c }) => (c.kind === "diplomacy" ? [c.familyA!, c.familyB!] : [])),
    ]);
    return rows.map(({ channel: c, otherId, otherHandle, unread }) => {
      const rival = c.kind === "diplomacy" ? fams.get(c.familyA === diplomat ? c.familyB! : c.familyA!) : undefined;
      return {
        id: c.id,
        kind: c.kind,
        name:
          c.kind === "family"
            ? (fams.get(member!.familyId)?.name ?? "Family")
            : c.kind === "public"
              ? CHAT.publicChannelName
              : rival
                ? `${rival.name} [${rival.tag}]`
                : (otherHandle ?? "unknown"),
        with: c.kind === "direct" && otherId && otherHandle ? { id: otherId, handle: otherHandle } : null,
        family: rival ? { id: rival.id, name: rival.name, tag: rival.tag } : null,
        unread,
        lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
      };
    });
  }

  /** Opens (or finds) the diplomacy room between the player's family and the family with this tag. */
  async openRoom(playerId: string, tag: string): Promise<ChatChannel> {
    const member = await this.memberships.memberOf(playerId);
    if (!member) throw forbidden("You need to be in a family to do that.");
    if (!checkFamilyAction(member.role, { kind: "diplomacy_talk" }).ok) throw forbidden("Your role doesn't allow that.");
    const target = await this.memberships.familyByTag(tag);
    if (!target) throw notFound("Family");
    if (target.id === member.familyId) throw badRequest("A family can't negotiate with itself.");
    const [a, b] = [member.familyId, target.id].sort() as [string, string];
    await this.db.insert(chatChannels).values({ kind: "diplomacy", familyA: a, familyB: b }).onConflictDoNothing();
    const [room] = await this.db
      .select({ id: chatChannels.id })
      .from(chatChannels)
      .where(and(eq(chatChannels.kind, "diplomacy"), eq(chatChannels.familyA, a), eq(chatChannels.familyB, b)));
    return (await this.channels(playerId)).find((c) => c.id === room!.id)!;
  }

  /** A diplomacy room the player may use now, with its two families. For the diplomacy module. */
  async requireRoom(db: DbOrTx, playerId: string, roomId: string): Promise<{ id: string; familyA: string; familyB: string }> {
    const c = await this.access(db, playerId, roomId, "Room");
    if (c.kind !== "diplomacy") throw notFound("Room");
    return { id: c.id, familyA: c.familyA!, familyB: c.familyB! };
  }

  /** Opens (or finds) the direct channel with another player. */
  async openDirect(playerId: string, handle: string): Promise<ChatChannel> {
    const target = await this.accounts.findPlayerByHandle(handle);
    if (!target) throw notFound("Player");
    if (target.id === playerId) throw badRequest("You can't message yourself.");
    if (await this.moderation.blockedEitherWay(this.db, playerId, target.id)) throw new AppError(403, "BLOCKED", "You can't message this player.");
    const [a, b] = [playerId, target.id].sort() as [string, string];
    await this.db.insert(chatChannels).values({ kind: "direct", playerA: a, playerB: b }).onConflictDoNothing();
    const [channel] = await this.db
      .select({ id: chatChannels.id })
      .from(chatChannels)
      .where(and(eq(chatChannels.kind, "direct"), eq(chatChannels.playerA, a), eq(chatChannels.playerB, b)));
    return (await this.channels(playerId)).find((c) => c.id === channel!.id)!;
  }

  // ── Messages ─────────────────────────────────────────────────────────────

  /** Newest first, without deleted messages or messages from players the reader has blocked. */
  async messages(playerId: string, channelId: string, before: string | undefined, limit: number): Promise<ChatPage> {
    await this.access(this.db, playerId, channelId);
    const rows = await this.db
      .select(messageFields)
      .from(chatMessages)
      .leftJoin(author, eq(author.id, chatMessages.authorId))
      .where(
        and(
          eq(chatMessages.channelId, channelId),
          isNull(chatMessages.deletedAt),
          before ? lt(chatMessages.id, BigInt(before)) : undefined,
          notExists(
            this.db
              .select({ one: sql`1` })
              .from(playerBlocks)
              .where(and(eq(playerBlocks.blockerId, playerId), eq(playerBlocks.blockedId, chatMessages.authorId))),
          ),
        ),
      )
      .orderBy(desc(chatMessages.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map(toDto);
    return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.id : null };
  }

  async send(playerId: string, channelId: string, body: string): Promise<ChatMessage> {
    if (!this.limiter.take(playerId)) {
      throw new AppError(429, "RATE_LIMITED", `You can send ${CHAT.rateLimit.messages} messages every ${CHAT.rateLimit.seconds} seconds. Slow down a little.`);
    }
    return this.db.transaction(async (tx) => {
      const channel = await this.access(tx, playerId, channelId);
      if (channel.kind === "direct") {
        const other = channel.playerA === playerId ? channel.playerB! : channel.playerA!;
        if (await this.moderation.blockedEitherWay(tx, playerId, other)) throw new AppError(403, "BLOCKED", "You can't message this player.");
      }
      const [row] = await tx.insert(chatMessages).values({ channelId, authorId: playerId, body }).returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });
      await tx.update(chatChannels).set({ lastMessageAt: row!.createdAt }).where(eq(chatChannels.id, channelId));
      const handle = (await this.accounts.findPlayerById(playerId, tx))!.handle;
      const message = toDto({ id: row!.id, channelId, body, createdAt: row!.createdAt, authorId: playerId, authorHandle: handle });
      await this.realtime.publish(tx, await this.roomsOf(tx, channel), { type: "chat.message", message });
      return message;
    });
  }

  async markRead(playerId: string, channelId: string, upTo: string): Promise<void> {
    await this.access(this.db, playerId, channelId);
    await this.db
      .insert(chatReads)
      .values({ playerId, channelId, lastReadId: BigInt(upTo) })
      .onConflictDoUpdate({ target: [chatReads.playerId, chatReads.channelId], set: { lastReadId: sql`greatest(${chatReads.lastReadId}, excluded.last_read_id)` } });
  }

  /** Authors can delete their own messages; moderators can delete any, which is audited and closes its reports. */
  async delete(playerId: string, messageId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [m] = await tx
        .select()
        .from(chatMessages)
        .where(and(eq(chatMessages.id, BigInt(messageId)), isNull(chatMessages.deletedAt)))
        .for("update");
      if (!m) throw notFound("Message");
      const own = m.authorId === playerId;
      if (!own) await this.moderation.requireModerator(playerId, tx);
      await tx.update(chatMessages).set({ deletedAt: new Date(), deletedBy: playerId }).where(eq(chatMessages.id, m.id));
      if (!own) {
        await this.moderation.audit(tx, playerId, "delete_message", "message", m.id.toString(), { authorId: m.authorId, body: m.body });
        await this.moderation.resolveReportsFor(tx, m.id, playerId);
      }
      const [channel] = await tx.select().from(chatChannels).where(eq(chatChannels.id, m.channelId));
      await this.realtime.publish(tx, await this.roomsOf(tx, channel!), { type: "chat.deleted", channelId: m.channelId, messageId: m.id.toString() });
    });
  }

  /** Reports a message the player can see. */
  async report(playerId: string, messageId: string, req: ReportRequest): Promise<void> {
    const [m] = await this.db
      .select()
      .from(chatMessages)
      .where(and(eq(chatMessages.id, BigInt(messageId)), isNull(chatMessages.deletedAt)));
    if (!m) throw notFound("Message");
    await this.access(this.db, playerId, m.channelId, "Message");
    if (m.authorId === playerId) throw badRequest("You can't report your own message.");
    await this.moderation.report(this.db, playerId, m.id, req.reason, req.note);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Finds or creates a family's channel. Family channels are made on first use. */
  private async familyChannel(familyId: string): Promise<Channel> {
    await this.db.insert(chatChannels).values({ kind: "family", familyId }).onConflictDoNothing();
    const [c] = await this.db
      .select()
      .from(chatChannels)
      .where(and(eq(chatChannels.kind, "family"), eq(chatChannels.familyId, familyId)));
    return c!;
  }

  /** The channel, if the player may read and write it now. A channel they can't use looks like one that doesn't exist. */
  private async access(db: DbOrTx, playerId: string, channelId: string, what = "Channel"): Promise<Channel> {
    const [c] = await db.select().from(chatChannels).where(eq(chatChannels.id, channelId));
    if (!c) throw notFound(what);
    if (c.kind === "public") return c;
    if (c.kind === "direct" && (c.playerA === playerId || c.playerB === playerId)) return c;
    if (c.kind === "family" && (await this.memberships.memberOf(playerId, db))?.familyId === c.familyId) return c;
    if (c.kind === "diplomacy") {
      const m = await this.memberships.memberOf(playerId, db);
      if (m && (m.familyId === c.familyA || m.familyId === c.familyB) && checkFamilyAction(m.role, { kind: "diplomacy_talk" }).ok) return c;
    }
    throw notFound(what);
  }

  /** Where a channel's live messages go. A diplomacy room reaches only the members of each family whose role may talk. */
  private async roomsOf(db: DbOrTx, c: Channel): Promise<string[]> {
    if (c.kind === "family") return [rooms.family(c.familyId!)];
    if (c.kind === "direct") return [rooms.player(c.playerA!), rooms.player(c.playerB!)];
    if (c.kind === "diplomacy") {
      const members = [...(await this.memberships.membersOf(c.familyA!, db)), ...(await this.memberships.membersOf(c.familyB!, db))];
      return members.filter((m) => checkFamilyAction(m.role, { kind: "diplomacy_talk" }).ok).map((m) => rooms.player(m.playerId));
    }
    return [rooms.public];
  }
}
