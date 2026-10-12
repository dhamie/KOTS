import { CHAT, REPORT_REASONS } from "@kots/content";
import { z } from "zod";
import { Handle } from "./auth";

const Timestamp = z.iso.datetime({ offset: true });
/** Message and notification ids are bigserials, sent as strings. */
const SerialId = z.string().regex(/^\d{1,18}$/);
const PlayerRef = z.object({ id: z.uuid(), handle: z.string() });

export const CHANNEL_KINDS = ["family", "public", "direct", "diplomacy"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export const ChatChannel = z.object({
  id: z.uuid(),
  kind: z.enum(CHANNEL_KINDS),
  /** Family name, "Lagos", the other player's handle, or (diplomacy) the other family's name and tag. */
  name: z.string(),
  /** Direct channels: the other player. */
  with: PlayerRef.nullable(),
  /** Diplomacy rooms: the other family. */
  family: z.object({ id: z.uuid(), name: z.string(), tag: z.string() }).nullable(),
  /** Messages from others since the player last read the channel, capped at 99. */
  unread: z.number().int().min(0),
  lastMessageAt: Timestamp.nullable(),
});
export type ChatChannel = z.infer<typeof ChatChannel>;
export const ChatChannelList = z.array(ChatChannel);

export const ChatMessage = z.object({
  id: SerialId,
  channelId: z.uuid(),
  author: PlayerRef.nullable(),
  body: z.string(),
  createdAt: Timestamp,
});
export type ChatMessage = z.infer<typeof ChatMessage>;

/** Newest first. `nextCursor` is the id to pass as `before` for older messages. */
export const ChatPage = z.object({ items: z.array(ChatMessage), nextCursor: SerialId.nullable() });
export type ChatPage = z.infer<typeof ChatPage>;

export const ChatQuery = z.object({
  before: SerialId.optional(),
  limit: z.coerce.number().int().min(1).max(CHAT.pageSize).default(CHAT.pageSize),
});
export type ChatQuery = z.infer<typeof ChatQuery>;

export const MessageBody = z
  .string()
  .trim()
  .min(1, "Write something first.")
  .max(CHAT.maxMessageLength, `At most ${CHAT.maxMessageLength} characters.`)
  .refine((s) => !s.includes("\u0000"), "Invalid character.");

export const SendMessageRequest = z.strictObject({ body: MessageBody });
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

export const OpenDirectRequest = z.strictObject({ handle: Handle });
export type OpenDirectRequest = z.infer<typeof OpenDirectRequest>;

/** Marks the channel read up to and including message `upTo`. */
export const MarkReadRequest = z.strictObject({ upTo: SerialId });
export type MarkReadRequest = z.infer<typeof MarkReadRequest>;

// ── Moderation ─────────────────────────────────────────────────────────────

export const ReportRequest = z.strictObject({ reason: z.enum(REPORT_REASONS), note: z.string().trim().max(300).optional() });
export type ReportRequest = z.infer<typeof ReportRequest>;

export const BlockRequest = z.strictObject({ handle: Handle });
export type BlockRequest = z.infer<typeof BlockRequest>;
export const BlockList = z.array(PlayerRef);
export type BlockList = z.infer<typeof BlockList>;

/** An open report, as moderators see it. */
export const Report = z.object({
  id: z.uuid(),
  reason: z.enum(REPORT_REASONS),
  note: z.string().nullable(),
  reporter: PlayerRef.nullable(),
  message: ChatMessage,
  channelKind: z.enum(CHANNEL_KINDS),
  createdAt: Timestamp,
});
export type Report = z.infer<typeof Report>;
export const ReportList = z.array(Report);

// ── Notifications ──────────────────────────────────────────────────────────

/** What a notification points at, so the client can open the right panel. */
export const NOTIFICATION_TARGETS = ["invitation", "trade", "territory", "henchmen", "family", "diplomacy", "battle"] as const;

export const Notification = z.object({
  id: SerialId,
  type: z.string(),
  body: z.string(),
  target: z.enum(NOTIFICATION_TARGETS),
  read: z.boolean(),
  createdAt: Timestamp,
});
export type Notification = z.infer<typeof Notification>;

export const NotificationPage = z.object({ items: z.array(Notification), nextCursor: SerialId.nullable(), unread: z.number().int().min(0) });
export type NotificationPage = z.infer<typeof NotificationPage>;

export const NotificationQuery = z.object({
  before: SerialId.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type NotificationQuery = z.infer<typeof NotificationQuery>;

// ── Live events ────────────────────────────────────────────────────────────

/**
 * What the server pushes over Socket.IO (event name `event`). They are hints: anything missed while disconnected is
 * fetched again over HTTP, and `resync` asks the client to do that now.
 */
export type ServerEvent =
  | { type: "chat.message"; message: ChatMessage }
  | { type: "chat.deleted"; channelId: string; messageId: string }
  | { type: "notification"; notification: Notification }
  /** Something in the family changed (an activity entry was written): reload family views. */
  | { type: "family.changed" }
  /** The player's own membership or role changed: reload /me. */
  | { type: "me.changed" }
  /** A city event started or ended: reload the news. Sent to everyone. */
  | { type: "events.changed" }
  | { type: "resync" };

/** Socket.IO path, under /api so the same proxy rule covers it. */
export const SOCKET_PATH = "/api/socket.io";
