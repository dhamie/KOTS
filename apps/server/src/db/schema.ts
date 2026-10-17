// Drizzle table definitions. Tables are added by the phase that first needs them (see docs/ARCHITECTURE.md §4).
// Lock order for multi-row work: families (by id) → family_invitations → family_memberships (by player_id)
// → trades → proposals → battles → world_events → territories (by id) → henchmen (by id) → inventory_stacks (by good) → npc_market_state (by territory, good)
// → currency_accounts (by id).
import { EVENT_SCOPES, EVENT_TYPES, FAMILY_ROLES, PROPOSAL_KINDS, TACTICS, REPORT_REASONS, TERRITORY_KINDS, type FamilyRole, type GoodKey, type ProposalKind, type ReportReason, type Tactic, type TerritoryKind, type EventScope, type EventType } from "@kots/content";
import { sql } from "drizzle-orm";
import { type AnyPgColumn, bigint, bigserial, boolean, check, customType, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { uuidv7 } from "../common/uuid";

/** Case-insensitive text (Postgres `citext` extension, created in migration 0000). */
const citext = customType<{ data: string }>({ dataType: () => "citext" });

const id = () => uuid("id").primaryKey().$defaultFn(uuidv7);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const sqlList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(", "));
const roleList = sqlList(FAMILY_ROLES);

export const users = pgTable(
  "users",
  {
    id: id(),
    email: citext("email").notNull().unique("users_email_unique"),
    passwordHash: text("password_hash").notNull(),
    status: text("status").notNull().default("active"),
    createdAt: createdAt(),
  },
  (t) => [check("users_status_check", sql`${t.status} in ('active', 'banned')`)],
);

/** `id` is the SHA-256 of the cookie token; the raw token is never stored. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

export const players = pgTable("players", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .unique("players_user_id_unique")
    .references(() => users.id, { onDelete: "cascade" }),
  handle: citext("handle").notNull().unique("players_handle_unique"),
  createdAt: createdAt(),
  /** Refreshed with the session (at most hourly). Used for Don succession. */
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
  /** Set with `npm run mod:grant`. Moderators can delete any chat message and review reports. */
  isModerator: boolean("is_moderator").notNull().default(false),
});

export const families = pgTable(
  "families",
  {
    id: id(),
    name: citext("name").notNull(),
    tag: citext("tag").notNull(),
    stage: text("stage").notNull().default("street_crew"),
    foundedAt: timestamp("founded_at", { withTimezone: true }).notNull().defaultNow(),
    disbandedAt: timestamp("disbanded_at", { withTimezone: true }),
  },
  (t) => [
    // Names and tags are only reserved while the family exists.
    uniqueIndex("families_name_active_unique").on(t.name).where(sql`${t.disbandedAt} is null`),
    uniqueIndex("families_tag_active_unique").on(t.tag).where(sql`${t.disbandedAt} is null`),
  ],
);

/** Primary key on player_id: a player is in at most one family. */
export const familyMemberships = pgTable(
  "family_memberships",
  {
    playerId: uuid("player_id")
      .primaryKey()
      .references(() => players.id, { onDelete: "cascade" }),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id),
    role: text("role").$type<FamilyRole>().notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("family_memberships_family_idx").on(t.familyId, t.role),
    uniqueIndex("family_memberships_one_don").on(t.familyId).where(sql`${t.role} = 'don'`),
    check("family_memberships_role_check", sql`${t.role} in (${roleList})`),
  ],
);

export const familyInvitations = pgTable(
  "family_invitations",
  {
    id: id(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    invitedByPlayerId: uuid("invited_by_player_id")
      .notNull()
      .references(() => players.id),
    status: text("status").notNull().default("pending"),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("family_invitations_one_pending").on(t.familyId, t.playerId).where(sql`${t.status} = 'pending'`),
    index("family_invitations_player_idx").on(t.playerId, t.status),
    check("family_invitations_status_check", sql`${t.status} in ('pending', 'accepted', 'declined', 'revoked', 'expired')`),
  ],
);

export const activityLog = pgTable(
  "activity_log",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id),
    actorPlayerId: uuid("actor_player_id").references(() => players.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("activity_log_family_idx").on(t.familyId, t.id.desc())],
);

/** Static rows seeded from packages/content (npm run db:seed); runtime state lives alongside. */
export const districts = pgTable("districts", {
  id: id(),
  slug: text("slug").notNull().unique("districts_slug_unique"),
  name: text("name").notNull(),
});

export const TERRITORY_STATES = ["stable", "neglected"] as const;
export type TerritoryState = (typeof TERRITORY_STATES)[number];

export const territories = pgTable(
  "territories",
  {
    id: id(),
    slug: text("slug").notNull().unique("territories_slug_unique"),
    districtId: uuid("district_id")
      .notNull()
      .references(() => districts.id),
    name: text("name").notNull(),
    kind: text("kind").$type<TerritoryKind>().notNull(),
    baseIncome: integer("base_income").notNull(),
    baseUpkeep: integer("base_upkeep").notNull(),
    /** Null means neutral. The three fields below are set exactly when there is an owner. */
    ownerFamilyId: uuid("owner_family_id").references(() => families.id),
    ownedSince: timestamp("owned_since", { withTimezone: true }),
    /** End of the period already paid for. Upkeep state is derived from this (see rules/economy.ts). */
    upkeepPaidUntil: timestamp("upkeep_paid_until", { withTimezone: true }),
    state: text("state").$type<TerritoryState>().notNull().default("stable"),
    /** When the upkeep sweep last looked at this row; stops one sweep retrying an unpaid row in a loop. */
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
    /** The battle being fought over it, if any. A contested territory can't be abandoned or transferred. */
    contestedBattleId: uuid("contested_battle_id").references((): AnyPgColumn => battles.id),
  },
  (t) => [
    index("territories_district_idx").on(t.districtId),
    index("territories_owner_idx").on(t.ownerFamilyId),
    index("territories_upkeep_due_idx").on(t.upkeepPaidUntil).where(sql`${t.ownerFamilyId} is not null`),
    check("territories_kind_check", sql`${t.kind} in (${sqlList(TERRITORY_KINDS)})`),
    check("territories_base_values_check", sql`${t.baseIncome} >= 0 and ${t.baseUpkeep} >= 0`),
    check("territories_state_check", sql`${t.state} in (${sqlList(TERRITORY_STATES)})`),
    check(
      "territories_owner_fields_check",
      sql`(${t.ownerFamilyId} is null) = (${t.upkeepPaidUntil} is null) and (${t.ownerFamilyId} is null) = (${t.ownedSince} is null)`,
    ),
    check("territories_contested_check", sql`${t.contestedBattleId} is null or ${t.ownerFamilyId} is not null`),
  ],
);

export const OWNERSHIP_CAUSES = ["claim", "abandon", "lapsed", "disband", "transfer", "battle"] as const;
export type OwnershipCause = (typeof OWNERSHIP_CAUSES)[number];

export const territoryOwnershipHistory = pgTable(
  "territory_ownership_history",
  {
    id: id(),
    territoryId: uuid("territory_id")
      .notNull()
      .references(() => territories.id),
    fromFamilyId: uuid("from_family_id").references(() => families.id),
    toFamilyId: uuid("to_family_id").references(() => families.id),
    cause: text("cause").$type<OwnershipCause>().notNull(),
    actorPlayerId: uuid("actor_player_id").references(() => players.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("territory_ownership_history_territory_idx").on(t.territoryId, t.createdAt.desc()),
    check("territory_ownership_history_cause_check", sql`${t.cause} in (${sqlList(OWNERSHIP_CAUSES)})`),
  ],
);

// ── Ledger: only modules/ledger writes these tables. ──────────────────────

export const ACCOUNT_KINDS = ["family_treasury", "system"] as const;

/** Money is whole ₦ in a bigint. A family treasury can never go below zero. System accounts don't track a balance. */
export const currencyAccounts = pgTable(
  "currency_accounts",
  {
    id: id(),
    kind: text("kind").$type<(typeof ACCOUNT_KINDS)[number]>().notNull(),
    familyId: uuid("family_id")
      .unique("currency_accounts_family_unique")
      .references(() => families.id),
    /** Name of a system account, e.g. `territory_income`. */
    code: text("code").unique("currency_accounts_code_unique"),
    balance: bigint("balance", { mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    check("currency_accounts_kind_check", sql`${t.kind} in (${sqlList(ACCOUNT_KINDS)})`),
    check(
      "currency_accounts_owner_check",
      sql`(${t.kind} = 'family_treasury' and ${t.familyId} is not null and ${t.code} is null) or (${t.kind} = 'system' and ${t.code} is not null and ${t.familyId} is null)`,
    ),
    check("currency_accounts_balance_check", sql`${t.balance} >= 0 or ${t.kind} = 'system'`),
  ],
);

export const LEDGER_KINDS = ["grant", "territory_claim", "upkeep", "disband", "recruitment", "wage", "purchase", "sale", "trade", "transfer", "battle", "event", "admin_adjust"] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];

export const ledgerTransactions = pgTable(
  "ledger_transactions",
  {
    id: id(),
    kind: text("kind").$type<LedgerKind>().notNull(),
    /** Unique, so a retried job or request can never post the same movement twice. */
    idempotencyKey: text("idempotency_key").notNull().unique("ledger_transactions_idempotency_unique"),
    actorPlayerId: uuid("actor_player_id").references(() => players.id, { onDelete: "set null" }),
    refType: text("ref_type"),
    refId: text("ref_id"),
    createdAt: createdAt(),
  },
  (t) => [check("ledger_transactions_kind_check", sql`${t.kind} in (${sqlList(LEDGER_KINDS)})`)],
);

/** The entries of one transaction sum to zero. `balance_after` is null for system accounts. */
export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => ledgerTransactions.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => currencyAccounts.id),
    amount: bigint("amount", { mode: "number" }).notNull(),
    balanceAfter: bigint("balance_after", { mode: "number" }),
    /** What the line is for, e.g. `territory_income` or `claim_fee`. */
    reason: text("reason").notNull(),
  },
  (t) => [
    index("ledger_entries_account_idx").on(t.accountId, t.id.desc()),
    index("ledger_entries_transaction_idx").on(t.transactionId),
    check("ledger_entries_amount_check", sql`${t.amount} <> 0`),
  ],
);

// ── Henchmen ──────────────────────────────────────────────────────────────

export const HENCHMAN_STATUSES = ["active", "deserted", "dismissed"] as const;
export type HenchmanStatus = (typeof HENCHMAN_STATUSES)[number];

const attribute = (name: string) => integer(name).notNull();

/** NPC henchmen. Archetypes, names and traits come from content; the rolled attributes are stored. */
export const henchmen = pgTable(
  "henchmen",
  {
    id: id(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id),
    /** `{family}:{board day}:{slot}`. Unique, so a board candidate can only be hired once. */
    recruitKey: text("recruit_key").notNull().unique("henchmen_recruit_key_unique"),
    archetype: text("archetype").notNull(),
    name: text("name").notNull(),
    combat: attribute("combat"),
    leadership: attribute("leadership"),
    discipline: attribute("discipline"),
    negotiation: attribute("negotiation"),
    logistics: attribute("logistics"),
    reliability: attribute("reliability"),
    loyalty: attribute("loyalty"),
    morale: integer("morale").notNull(),
    traits: jsonb("traits").$type<string[]>().notNull().default([]),
    status: text("status").$type<HenchmanStatus>().notNull().default("active"),
    assignedTerritoryId: uuid("assigned_territory_id").references(() => territories.id),
    hireCost: integer("hire_cost").notNull(),
    wage: integer("wage").notNull(),
    /** End of the paid wage period; null once the henchman has left. */
    wagePaidUntil: timestamp("wage_paid_until", { withTimezone: true }),
    /** True from the first failed wage payment until one succeeds, so morale drops once per lapse. */
    wageOverdue: boolean("wage_overdue").notNull().default(false),
    /** When the wage sweep last looked at this row (see territories.last_evaluated_at). */
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
    hiredAt: timestamp("hired_at", { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    /** Can't fight until then (Phase 7). */
    injuredUntil: timestamp("injured_until", { withTimezone: true }),
    /** The battle this henchman is committed to; while set, they can't be reassigned or dismissed. */
    battleId: uuid("battle_id").references((): AnyPgColumn => battles.id),
  },
  (t) => [
    index("henchmen_family_idx").on(t.familyId, t.status),
    index("henchmen_territory_idx").on(t.assignedTerritoryId),
    index("henchmen_wage_due_idx").on(t.wagePaidUntil).where(sql`${t.status} = 'active'`),
    index("henchmen_battle_idx").on(t.battleId).where(sql`${t.battleId} is not null`),
    check("henchmen_status_check", sql`${t.status} in (${sqlList(HENCHMAN_STATUSES)})`),
    check(
      "henchmen_attributes_check",
      sql`least(${t.combat}, ${t.leadership}, ${t.discipline}, ${t.negotiation}, ${t.logistics}, ${t.reliability}, ${t.loyalty}) >= 1 and greatest(${t.combat}, ${t.leadership}, ${t.discipline}, ${t.negotiation}, ${t.logistics}, ${t.reliability}, ${t.loyalty}) <= 100`,
    ),
    check("henchmen_morale_check", sql`${t.morale} between 0 and 100`),
    check("henchmen_money_check", sql`${t.hireCost} >= 0 and ${t.wage} >= 0`),
    // Active henchmen have a wage schedule; those who left have none and guard nothing.
    check(
      "henchmen_active_fields_check",
      sql`(${t.status} = 'active') = (${t.wagePaidUntil} is not null) and (${t.status} = 'active' or (${t.assignedTerritoryId} is null and ${t.battleId} is null))`,
    ),
  ],
);

// ── Goods, inventory and the NPC market ───────────────────────────────────

/** Seeded from packages/content (npm run db:seed) so other tables can reference goods. */
export const goods = pgTable("goods", {
  key: text("key").$type<GoodKey>().primaryKey(),
  label: text("label").notNull(),
});

/** What a family holds. A missing row means none. */
export const inventoryStacks = pgTable(
  "inventory_stacks",
  {
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id),
    good: text("good")
      .$type<GoodKey>()
      .notNull()
      .references(() => goods.key),
    quantity: integer("quantity").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.familyId, t.good] }), check("inventory_stacks_quantity_check", sql`${t.quantity} >= 0`)],
);

/** Each market's stock of each good. Prices aren't stored: they're computed from stock (rules/market.ts). */
export const npcMarketState = pgTable(
  "npc_market_state",
  {
    territoryId: uuid("territory_id")
      .notNull()
      .references(() => territories.id),
    good: text("good")
      .$type<GoodKey>()
      .notNull()
      .references(() => goods.key),
    stock: integer("stock").notNull(),
    /** The last drift step applied (rules `driftStep`); a step is applied only if it is newer. */
    driftStep: integer("drift_step").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.territoryId, t.good] }), check("npc_market_state_stock_check", sql`${t.stock} >= 0`)],
);

export const ORDER_SIDES = ["buy", "sell"] as const;

/** One filled market order. `(family_id, request_key)` is unique, so a retried request fills once. */
export const marketOrders = pgTable(
  "market_orders",
  {
    id: id(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id),
    territoryId: uuid("territory_id")
      .notNull()
      .references(() => territories.id),
    good: text("good")
      .$type<GoodKey>()
      .notNull()
      .references(() => goods.key),
    side: text("side").$type<(typeof ORDER_SIDES)[number]>().notNull(),
    quantity: integer("quantity").notNull(),
    total: integer("total").notNull(),
    actorPlayerId: uuid("actor_player_id").references(() => players.id, { onDelete: "set null" }),
    /** The client's Idempotency-Key header. */
    requestKey: text("request_key").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("market_orders_request_unique").on(t.familyId, t.requestKey),
    check("market_orders_side_check", sql`${t.side} in (${sqlList(ORDER_SIDES)})`),
    check("market_orders_amounts_check", sql`${t.quantity} > 0 and ${t.total} > 0`),
  ],
);

// ── Trades between families ───────────────────────────────────────────────

export const TRADE_STATUSES = ["open", "executed", "declined", "cancelled", "expired"] as const;
export type TradeStatus = (typeof TRADE_STATUSES)[number];

/** An offer from one family to another. Accepting runs it at once; status only ever leaves `open` once. */
export const trades = pgTable(
  "trades",
  {
    id: id(),
    fromFamilyId: uuid("from_family_id")
      .notNull()
      .references(() => families.id),
    toFamilyId: uuid("to_family_id")
      .notNull()
      .references(() => families.id),
    status: text("status").$type<TradeStatus>().notNull().default("open"),
    createdBy: uuid("created_by").references(() => players.id, { onDelete: "set null" }),
    closedBy: uuid("closed_by").references(() => players.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** The client's Idempotency-Key header (Phase 9b); null on offers made before it. */
    requestKey: text("request_key"),
  },
  (t) => [
    uniqueIndex("trades_request_unique").on(t.fromFamilyId, t.requestKey),
    index("trades_from_idx").on(t.fromFamilyId, t.id.desc()),
    index("trades_to_idx").on(t.toFamilyId, t.id.desc()),
    index("trades_expiry_idx").on(t.expiresAt).where(sql`${t.status} = 'open'`),
    check("trades_status_check", sql`${t.status} in (${sqlList(TRADE_STATUSES)})`),
    check("trades_families_check", sql`${t.fromFamilyId} <> ${t.toFamilyId}`),
    check("trades_closed_check", sql`(${t.status} = 'open') = (${t.closedAt} is null)`),
  ],
);

export const TRADE_SIDES = ["gives", "wants"] as const;

/** One item of an offer: a good and quantity, or cash. `gives` is what the offering family hands over. */
export const tradeLines = pgTable(
  "trade_lines",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    tradeId: uuid("trade_id")
      .notNull()
      .references(() => trades.id),
    side: text("side").$type<(typeof TRADE_SIDES)[number]>().notNull(),
    good: text("good")
      .$type<GoodKey>()
      .references(() => goods.key),
    quantity: integer("quantity"),
    cash: bigint("cash", { mode: "number" }),
  },
  (t) => [
    index("trade_lines_trade_idx").on(t.tradeId),
    check("trade_lines_side_check", sql`${t.side} in (${sqlList(TRADE_SIDES)})`),
    check(
      "trade_lines_item_check",
      sql`(${t.good} is not null and ${t.quantity} > 0 and ${t.cash} is null) or (${t.good} is null and ${t.quantity} is null and ${t.cash} > 0)`,
    ),
  ],
);

// ── Chat ──────────────────────────────────────────────────────────────────

export const CHANNEL_KINDS = ["family", "public", "direct", "diplomacy"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/**
 * A chat channel. Family channels have `family_id` and are open to its current members (checked on every request);
 * direct channels have their two players in `player_a` < `player_b`; diplomacy rooms have their two families in
 * `family_a` < `family_b`; the one public channel is created by migration 0007.
 */
export const chatChannels = pgTable(
  "chat_channels",
  {
    id: id(),
    kind: text("kind").$type<ChannelKind>().notNull(),
    familyId: uuid("family_id").references(() => families.id),
    playerA: uuid("player_a").references(() => players.id, { onDelete: "cascade" }),
    playerB: uuid("player_b").references(() => players.id, { onDelete: "cascade" }),
    familyA: uuid("family_a").references(() => families.id),
    familyB: uuid("family_b").references(() => families.id),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("chat_channels_family_unique").on(t.familyId).where(sql`${t.kind} = 'family'`),
    uniqueIndex("chat_channels_direct_unique").on(t.playerA, t.playerB).where(sql`${t.kind} = 'direct'`),
    uniqueIndex("chat_channels_public_unique").on(t.kind).where(sql`${t.kind} = 'public'`),
    uniqueIndex("chat_channels_diplomacy_unique").on(t.familyA, t.familyB).where(sql`${t.kind} = 'diplomacy'`),
    index("chat_channels_family_b_idx").on(t.familyB).where(sql`${t.kind} = 'diplomacy'`),
    index("chat_channels_player_b_idx").on(t.playerB).where(sql`${t.kind} = 'direct'`),
    check("chat_channels_kind_check", sql`${t.kind} in (${sqlList(CHANNEL_KINDS)})`),
    check(
      "chat_channels_fields_check",
      sql`(${t.familyA} is null) = (${t.familyB} is null) and (
           (${t.kind} = 'family' and ${t.familyId} is not null and ${t.playerA} is null and ${t.playerB} is null and ${t.familyA} is null)
        or (${t.kind} = 'direct' and ${t.familyId} is null and ${t.playerA} < ${t.playerB} and ${t.familyA} is null)
        or (${t.kind} = 'public' and ${t.familyId} is null and ${t.playerA} is null and ${t.playerB} is null and ${t.familyA} is null)
        or (${t.kind} = 'diplomacy' and ${t.familyId} is null and ${t.playerA} is null and ${t.playerB} is null and ${t.familyA} < ${t.familyB}))`,
    ),
  ],
);

/** Messages are deleted softly, so reports and the moderation log still point at them. */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => chatChannels.id),
    authorId: uuid("author_id").references(() => players.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: createdAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by").references(() => players.id, { onDelete: "set null" }),
  },
  (t) => [
    index("chat_messages_channel_idx").on(t.channelId, t.id.desc()),
    check("chat_messages_body_check", sql`char_length(${t.body}) between 1 and 500`),
  ],
);

/** How far each player has read each channel; drives unread counts. */
export const chatReads = pgTable(
  "chat_reads",
  {
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => chatChannels.id),
    lastReadId: bigint("last_read_id", { mode: "bigint" }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.playerId, t.channelId] })],
);

/** `blocker` doesn't see `blocked`'s messages, and the two can't message each other directly. */
export const playerBlocks = pgTable(
  "player_blocks",
  {
    blockerId: uuid("blocker_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    blockedId: uuid("blocked_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] }), index("player_blocks_blocked_idx").on(t.blockedId), check("player_blocks_self_check", sql`${t.blockerId} <> ${t.blockedId}`)],
);

export const REPORT_STATUSES = ["open", "actioned", "dismissed"] as const;

/** One report per player per message. */
export const messageReports = pgTable(
  "message_reports",
  {
    id: id(),
    messageId: bigint("message_id", { mode: "bigint" })
      .notNull()
      .references(() => chatMessages.id),
    reporterId: uuid("reporter_id").references(() => players.id, { onDelete: "set null" }),
    reason: text("reason").$type<ReportReason>().notNull(),
    note: text("note"),
    status: text("status").$type<(typeof REPORT_STATUSES)[number]>().notNull().default("open"),
    createdAt: createdAt(),
    resolvedBy: uuid("resolved_by").references(() => players.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("message_reports_once").on(t.messageId, t.reporterId),
    index("message_reports_open_idx").on(t.createdAt).where(sql`${t.status} = 'open'`),
    check("message_reports_reason_check", sql`${t.reason} in (${sqlList(REPORT_REASONS)})`),
    check("message_reports_status_check", sql`${t.status} in (${sqlList(REPORT_STATUSES)})`),
  ],
);

export const MODERATION_ACTIONS = ["grant_moderator", "revoke_moderator", "delete_message", "dismiss_report", "trigger_event", "ban_player", "unban_player", "adjust_treasury"] as const;

/** Append-only audit log of moderator actions. `moderator_id` is null for actions run from the command line. */
export const moderationActions = pgTable(
  "moderation_actions",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    moderatorId: uuid("moderator_id").references(() => players.id, { onDelete: "set null" }),
    action: text("action").$type<(typeof MODERATION_ACTIONS)[number]>().notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [check("moderation_actions_action_check", sql`${t.action} in (${sqlList(MODERATION_ACTIONS)})`)],
);

// ── Notifications ─────────────────────────────────────────────────────────

/** Per-player notifications, written in the same transaction as the event they describe. */
export const notifications = pgTable(
  "notifications",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    playerId: uuid("player_id")
      .notNull()
      .references(() => players.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    target: text("target").notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [index("notifications_player_idx").on(t.playerId, t.id.desc()), index("notifications_unread_idx").on(t.playerId).where(sql`${t.readAt} is null`)],
);

// ── Diplomacy ─────────────────────────────────────────────────────────────

export const PROPOSAL_STATUSES = ["open", "executed", "declined", "withdrawn", "expired"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/**
 * A proposal made in a diplomacy room, from one of its families to the other. Terms never change after creation;
 * it runs when both families have signed, and its status leaves `open` only once.
 */
export const proposals = pgTable(
  "proposals",
  {
    id: id(),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => chatChannels.id),
    fromFamilyId: uuid("from_family_id")
      .notNull()
      .references(() => families.id),
    toFamilyId: uuid("to_family_id")
      .notNull()
      .references(() => families.id),
    kind: text("kind").$type<ProposalKind>().notNull(),
    /** Validated by the shared `ProposalTerms` schema and rules `checkProposalTerms`. */
    terms: jsonb("terms").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<ProposalStatus>().notNull().default("open"),
    createdBy: uuid("created_by").references(() => players.id, { onDelete: "set null" }),
    closedBy: uuid("closed_by").references(() => players.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** The client's Idempotency-Key header (Phase 9b); null on proposals made before it. */
    requestKey: text("request_key"),
  },
  (t) => [
    uniqueIndex("proposals_request_unique").on(t.fromFamilyId, t.requestKey),
    index("proposals_channel_idx").on(t.channelId, t.id.desc()),
    index("proposals_expiry_idx").on(t.expiresAt).where(sql`${t.status} = 'open'`),
    check("proposals_kind_check", sql`${t.kind} in (${sqlList(PROPOSAL_KINDS)})`),
    check("proposals_status_check", sql`${t.status} in (${sqlList(PROPOSAL_STATUSES)})`),
    check("proposals_families_check", sql`${t.fromFamilyId} <> ${t.toFamilyId}`),
    check("proposals_closed_check", sql`(${t.status} = 'open') = (${t.closedAt} is null)`),
  ],
);

/** One signature per family per proposal (the primary key), so a family can't sign twice. */
export const proposalSignatures = pgTable(
  "proposal_signatures",
  {
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id),
    familyId: uuid("family_id")
      .notNull()
      .references(() => families.id),
    signedBy: uuid("signed_by").references(() => players.id, { onDelete: "set null" }),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.proposalId, t.familyId] })],
);

/** An agreed ceasefire between two families (`family_a` < `family_b`). Enforced by battles from Phase 7. */
export const ceasefires = pgTable(
  "ceasefires",
  {
    id: id(),
    familyA: uuid("family_a")
      .notNull()
      .references(() => families.id),
    familyB: uuid("family_b")
      .notNull()
      .references(() => families.id),
    proposalId: uuid("proposal_id")
      .notNull()
      .unique("ceasefires_proposal_unique")
      .references(() => proposals.id),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("ceasefires_pair_idx").on(t.familyA, t.familyB, t.endsAt.desc()),
    check("ceasefires_families_check", sql`${t.familyA} < ${t.familyB}`),
    check("ceasefires_period_check", sql`${t.startsAt} < ${t.endsAt}`),
  ],
);

// ── Battles ───────────────────────────────────────────────────────────────

export const BATTLE_STATUSES = ["preparing", "active", "resolved", "cancelled"] as const;
export type BattleStatus = (typeof BATTLE_STATUSES)[number];
export const BATTLE_SIDES = ["attacker", "defender"] as const;

/**
 * A battle for one territory between its holder and an attacking family. Rounds are resolved by the worker's sweep
 * when `next_round_at` passes; `state` is the rules' BattleState after `current_round` rounds, and the battle can be
 * replayed from `initial_state`, `seed` and the round inputs in battle_rounds.
 */
export const battles = pgTable(
  "battles",
  {
    id: id(),
    territoryId: uuid("territory_id")
      .notNull()
      .references(() => territories.id),
    attackerFamilyId: uuid("attacker_family_id")
      .notNull()
      .references(() => families.id),
    defenderFamilyId: uuid("defender_family_id")
      .notNull()
      .references(() => families.id),
    status: text("status").$type<BattleStatus>().notNull().default("preparing"),
    seed: integer("seed").notNull(),
    fee: integer("fee").notNull(),
    declaredBy: uuid("declared_by").references(() => players.id, { onDelete: "set null" }),
    declaredAt: timestamp("declared_at", { withTimezone: true }).notNull(),
    currentRound: integer("current_round").notNull().default(0),
    nextRoundAt: timestamp("next_round_at", { withTimezone: true }),
    initialState: jsonb("initial_state").$type<Record<string, unknown>>(),
    state: jsonb("state").$type<Record<string, unknown>>(),
    winner: text("winner").$type<(typeof BATTLE_SIDES)[number]>(),
    /** Why it ended early: `withdrawn`, `territory_lost`, `disbanded`. */
    endReason: text("end_reason"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    // One live battle per territory, and one live battle per attacking family.
    uniqueIndex("battles_territory_live_unique").on(t.territoryId).where(sql`${t.status} in ('preparing', 'active')`),
    uniqueIndex("battles_attacker_live_unique").on(t.attackerFamilyId).where(sql`${t.status} in ('preparing', 'active')`),
    index("battles_due_idx").on(t.nextRoundAt).where(sql`${t.status} in ('preparing', 'active')`),
    index("battles_attacker_idx").on(t.attackerFamilyId, t.declaredAt.desc()),
    index("battles_defender_idx").on(t.defenderFamilyId, t.declaredAt.desc()),
    check("battles_status_check", sql`${t.status} in (${sqlList(BATTLE_STATUSES)})`),
    check("battles_families_check", sql`${t.attackerFamilyId} <> ${t.defenderFamilyId}`),
    check("battles_live_check", sql`(${t.status} in ('preparing', 'active')) = (${t.nextRoundAt} is not null) and (${t.status} in ('preparing', 'active')) = (${t.endedAt} is null)`),
    check("battles_winner_check", sql`(${t.status} = 'resolved') = (${t.winner} is not null) and (${t.winner} is null or ${t.winner} in (${sqlList(BATTLE_SIDES)}))`),
    check("battles_fee_check", sql`${t.fee} >= 0 and ${t.currentRound} >= 0`),
  ],
);

/** A side's tactic for a round. Can be changed until the round is resolved. */
export const battleOrders = pgTable(
  "battle_orders",
  {
    battleId: uuid("battle_id")
      .notNull()
      .references(() => battles.id),
    roundNo: integer("round_no").notNull(),
    side: text("side").$type<(typeof BATTLE_SIDES)[number]>().notNull(),
    tactic: text("tactic").$type<Tactic>().notNull(),
    submittedBy: uuid("submitted_by").references(() => players.id, { onDelete: "set null" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.battleId, t.roundNo, t.side] }),
    check("battle_orders_side_check", sql`${t.side} in (${sqlList(BATTLE_SIDES)})`),
    check("battle_orders_tactic_check", sql`${t.tactic} in (${sqlList(TACTICS)})`),
  ],
);

/** A resolved round. The primary key means a round can only be resolved once. `input` + the battle's seed replay it. */
export const battleRounds = pgTable(
  "battle_rounds",
  {
    battleId: uuid("battle_id")
      .notNull()
      .references(() => battles.id),
    roundNo: integer("round_no").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.battleId, t.roundNo] })],
);

// ── City events ───────────────────────────────────────────────────────────

export const WORLD_EVENT_STATES = ["scheduled", "active", "expired"] as const;
export type WorldEventState = (typeof WORLD_EVENT_STATES)[number];

/**
 * A city event (Phase 8). Its effect (`payload`, the rules' PlannedEvent) is applied once, in the transaction that
 * moves it from `scheduled` to `active`; it shows as news until `expires_at`. `dedupe_key` stops a retried job
 * creating it twice.
 */
export const worldEvents = pgTable(
  "world_events",
  {
    id: id(),
    type: text("type").$type<EventType>().notNull(),
    scope: text("scope").$type<EventScope>().notNull(),
    /** A market or district slug; null for the whole city. */
    scopeId: text("scope_id"),
    state: text("state").$type<WorldEventState>().notNull().default("scheduled"),
    seed: bigint("seed", { mode: "number" }).notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    dedupeKey: text("dedupe_key").notNull().unique("world_events_dedupe_key_unique"),
    createdAt: createdAt(),
  },
  (t) => [
    index("world_events_due_idx").on(t.startsAt).where(sql`${t.state} = 'scheduled'`),
    index("world_events_active_idx").on(t.expiresAt).where(sql`${t.state} = 'active'`),
    index("world_events_news_idx").on(t.startsAt.desc()),
    check("world_events_type_check", sql`${t.type} in (${sqlList(EVENT_TYPES)})`),
    check("world_events_scope_check", sql`${t.scope} in (${sqlList(EVENT_SCOPES)})`),
    check("world_events_state_check", sql`${t.state} in (${sqlList(WORLD_EVENT_STATES)})`),
    check("world_events_period_check", sql`${t.expiresAt} > ${t.startsAt}`),
  ],
);
