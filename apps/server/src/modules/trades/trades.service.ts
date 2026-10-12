import { Inject, Injectable, Logger } from "@nestjs/common";
import { TRADES } from "@kots/content";
import { cashIn, checkTerms, goodDef, OFFER_TTL_MS, oldEnoughToTrade, type TradeItem } from "@kots/rules";
import type { OfferRequest, Trade, TradeBox, TradePage } from "@kots/shared";
import { and, asc, count, desc, eq, gt, inArray, lt, lte, ne, or } from "drizzle-orm";
import { CLOCK, type Clock } from "../../common/clock";
import { AppError, badRequest, conflict, forbidden, notFound } from "../../common/errors";
import { DB, type Database } from "../../db/db";
import { tradeLines, trades, type TradeStatus } from "../../db/schema";
import type { DbOrTx, Tx } from "../../db/tx";
import { ActivityService } from "../activity/activity.service";
import { MembershipsService, type FamilyFacts } from "../families/memberships.service";
import { InventoryService } from "../inventory/inventory.service";
import { InsufficientFunds, LedgerService, type PostingLine } from "../ledger/ledger.service";

type TradeRow = typeof trades.$inferSelect;

const TERMS_MESSAGE = {
  empty: "An offer needs something on at least one side.",
  too_many_items: `At most ${TRADES.maxLinesPerSide} items on each side.`,
  repeated_item: "List each good (and cash) once per side.",
  too_much_cash: `At most ₦${TRADES.maxCash.toLocaleString("en-NG")} on each side.`,
} as const;

const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;
const describeItem = (i: TradeItem) => ("cash" in i ? naira(i.cash) : `${i.quantity} ${goodDef(i.good).label.toLowerCase()}`);

/**
 * Trades between families. An offer reserves nothing; accepting re-checks everything and runs the exchange in one
 * transaction: both families (id order) → the acceptor's membership → the trade → inventory → treasuries.
 * Every inventory change happens under its family's row lock, so the order of stack updates within a trade doesn't matter.
 */
@Injectable()
export class TradesService {
  private readonly logger = new Logger(TradesService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly memberships: MembershipsService,
    private readonly inventory: InventoryService,
    private readonly ledger: LedgerService,
    private readonly activity: ActivityService,
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────────

  async list(viewerId: string, familyId: string, box: TradeBox, before: string | undefined, limit: number): Promise<TradePage> {
    await this.memberships.requireMemberOf(viewerId, familyId);
    const now = this.clock.now();
    const open = and(eq(trades.status, "open"), gt(trades.expiresAt, now));
    const where =
      box === "incoming"
        ? and(eq(trades.toFamilyId, familyId), open)
        : box === "outgoing"
          ? and(eq(trades.fromFamilyId, familyId), open)
          : and(or(eq(trades.fromFamilyId, familyId), eq(trades.toFamilyId, familyId)), ne(trades.status, "open"), before ? lt(trades.id, before) : undefined);
    const rows = await this.db
      .select()
      .from(trades)
      .where(where)
      .orderBy(desc(trades.id))
      .limit(limit + 1);
    const items = await this.toDtos(rows.slice(0, limit));
    return { items, nextCursor: box === "closed" && rows.length > limit ? items[items.length - 1]!.id : null };
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  async propose(actorId: string, familyId: string, req: OfferRequest): Promise<Trade> {
    const terms = checkTerms(req);
    if (!terms.ok) throw badRequest(TERMS_MESSAGE[terms.reason]);
    const now = this.clock.now();

    const id = await this.db.transaction(async (tx) => {
      const actor = await this.memberships.lockActing(tx, actorId, { kind: "propose_trade" });
      if (actor.familyId !== familyId) throw forbidden("You are not a member of this family.");
      const target = await this.memberships.familyByTag(req.to, tx);
      if (!target) throw notFound("Family");
      if (target.id === familyId) throw badRequest("A family can't trade with itself.");
      const own = (await this.memberships.familiesById([familyId], tx)).get(familyId)!;
      this.requireOldEnough([own, target], now);

      const [open] = await tx
        .select({ n: count() })
        .from(trades)
        .where(and(eq(trades.fromFamilyId, familyId), eq(trades.status, "open"), gt(trades.expiresAt, now)));
      if (open!.n >= TRADES.maxOpenOutgoing) {
        throw conflict("TOO_MANY_OFFERS", `Your family already has ${TRADES.maxOpenOutgoing} open offers. Cancel one or wait for an answer.`);
      }

      const [trade] = await tx
        .insert(trades)
        .values({ fromFamilyId: familyId, toFamilyId: target.id, createdBy: actorId, createdAt: now, expiresAt: new Date(now.getTime() + OFFER_TTL_MS) })
        .returning({ id: trades.id });
      const lines = [...req.gives.map((i) => ({ side: "gives" as const, i })), ...req.wants.map((i) => ({ side: "wants" as const, i }))];
      await tx.insert(tradeLines).values(
        lines.map(({ side, i }) => ({ tradeId: trade!.id, side, ...("cash" in i ? { cash: i.cash } : { good: i.good, quantity: i.quantity }) })),
      );
      const summary = { gives: req.gives.map(describeItem), wants: req.wants.map(describeItem) };
      await this.activity.record(tx, { familyId, actorPlayerId: actorId, type: "trade.offered", payload: { with: target.tag, ...summary } });
      await this.activity.record(tx, { familyId: target.id, actorPlayerId: actorId, type: "trade.received", payload: { with: own.tag, ...summary } });
      return trade!.id;
    });
    return this.one(id);
  }

  /** Runs the trade. Accepting a trade that was already executed returns it unchanged, so a retry is harmless. */
  async accept(actorId: string, tradeId: string): Promise<Trade> {
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      const [peek] = await tx.select().from(trades).where(eq(trades.id, tradeId));
      if (!peek) throw notFound("Trade");
      const { member, families } = await this.memberships.lockActingAmong(tx, actorId, [peek.fromFamilyId, peek.toFamilyId], { kind: "accept_trade" });
      if (member.familyId !== peek.toFamilyId) throw forbidden("Only the family the offer was made to can accept it.");
      const trade = await this.lock(tx, tradeId);
      if (trade.status === "executed") return;
      this.requireOpen(trade, now);
      const from = families.get(trade.fromFamilyId)!;
      const to = families.get(trade.toFamilyId)!;
      if (from.disbandedAt || to.disbandedAt) throw conflict("TRADE_CLOSED", "One of the families has disbanded.");
      this.requireOldEnough([from, to], now);

      const { gives, wants } = await this.linesOf(tx, trade.id);
      // Removals first, so a family swapping some of a good for more of it has room.
      for (const [items, giver] of [
        [gives, from],
        [wants, to],
      ] as const) {
        for (const i of items) if (!("cash" in i)) await this.moveGoods(() => this.inventory.remove(tx, giver.id, i.good, i.quantity), giver, i);
      }
      for (const [items, taker] of [
        [gives, to],
        [wants, from],
      ] as const) {
        for (const i of items) if (!("cash" in i)) await this.moveGoods(() => this.inventory.add(tx, taker.id, i.good, i.quantity), taker, i);
      }
      await this.moveCash(tx, trade, from, to, cashIn(gives), cashIn(wants), actorId);

      await tx.update(trades).set({ status: "executed", closedBy: actorId, closedAt: now }).where(and(eq(trades.id, trade.id), eq(trades.status, "open")));
      const summary = { gives: gives.map(describeItem), wants: wants.map(describeItem) };
      await this.activity.record(tx, { familyId: from.id, actorPlayerId: actorId, type: "trade.executed", payload: { with: to.tag, ...summary } });
      await this.activity.record(tx, { familyId: to.id, actorPlayerId: actorId, type: "trade.executed", payload: { with: from.tag, gives: summary.wants, wants: summary.gives } });
    });
    return this.one(tradeId);
  }

  async decline(actorId: string, tradeId: string): Promise<Trade> {
    return this.close(actorId, tradeId, "declined");
  }

  async cancel(actorId: string, tradeId: string): Promise<Trade> {
    return this.close(actorId, tradeId, "cancelled");
  }

  /**
   * Closes offers past their expiry. Rows locked by an accept in progress are skipped; the accept itself refuses an
   * expired offer, and the next sweep catches the row if it's still open.
   */
  async sweepExpired(now: Date = this.clock.now(), limit = 500): Promise<number> {
    const expired = await this.db.transaction(async (tx) => {
      const due = await tx
        .select({ id: trades.id })
        .from(trades)
        .where(and(eq(trades.status, "open"), lte(trades.expiresAt, now)))
        .orderBy(asc(trades.expiresAt))
        .limit(limit)
        .for("update", { skipLocked: true });
      if (due.length === 0) return [];
      const rows = await tx
        .update(trades)
        .set({ status: "expired", closedAt: now })
        .where(and(inArray(trades.id, due.map((d) => d.id)), eq(trades.status, "open")))
        .returning();
      const fams = await this.memberships.familiesById(rows.flatMap((r) => [r.fromFamilyId, r.toFamilyId]), tx);
      for (const r of rows) {
        await this.activity.record(tx, { familyId: r.fromFamilyId, actorPlayerId: null, type: "trade.expired", payload: { with: fams.get(r.toFamilyId)?.tag } });
        await this.activity.record(tx, { familyId: r.toFamilyId, actorPlayerId: null, type: "trade.expired", payload: { with: fams.get(r.fromFamilyId)?.tag } });
      }
      return rows;
    });
    if (expired.length > 0) this.logger.log(`trade expiry: ${expired.length} offers`);
    return expired.length;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Decline (by the receiving family) or cancel (by the offering family). Locks the family, then the trade. */
  private async close(actorId: string, tradeId: string, status: "declined" | "cancelled"): Promise<Trade> {
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      const actor = await this.memberships.lockActing(tx, actorId, { kind: status === "declined" ? "accept_trade" : "propose_trade" });
      const trade = await this.lock(tx, tradeId);
      const side = status === "declined" ? trade.toFamilyId : trade.fromFamilyId;
      if (actor.familyId !== side) {
        throw forbidden(status === "declined" ? "Only the family the offer was made to can decline it." : "Only the family that made the offer can cancel it.");
      }
      if (trade.status !== "open") throw conflict("TRADE_CLOSED", `This offer is already ${trade.status}.`);
      await tx.update(trades).set({ status, closedBy: actorId, closedAt: now }).where(and(eq(trades.id, trade.id), eq(trades.status, "open")));
      const other = trade.fromFamilyId === actor.familyId ? trade.toFamilyId : trade.fromFamilyId;
      const fams = await this.memberships.familiesById([actor.familyId, other], tx);
      const type = status === "declined" ? "trade.declined" : "trade.cancelled";
      await this.activity.record(tx, { familyId: actor.familyId, actorPlayerId: actorId, type, payload: { with: fams.get(other)?.tag } });
      await this.activity.record(tx, { familyId: other, actorPlayerId: actorId, type, payload: { with: fams.get(actor.familyId)?.tag } });
    });
    return this.one(tradeId);
  }

  private async lock(tx: Tx, tradeId: string): Promise<TradeRow> {
    const [t] = await tx.select().from(trades).where(eq(trades.id, tradeId)).for("update");
    if (!t) throw notFound("Trade");
    return t;
  }

  private requireOpen(t: TradeRow, now: Date): void {
    if (t.status !== "open") throw conflict("TRADE_CLOSED", `This offer is already ${t.status}.`);
    if (t.expiresAt.getTime() <= now.getTime()) throw conflict("TRADE_CLOSED", "This offer has expired.");
  }

  private requireOldEnough(fams: FamilyFacts[], now: Date): void {
    const young = fams.find((f) => !oldEnoughToTrade(f.foundedAt.getTime(), now.getTime()));
    if (young) throw conflict("TOO_NEW", `Families can trade once they are ${TRADES.minFamilyAgeDays} days old; ${young.name} [${young.tag}] isn't yet.`);
  }

  /** Runs an inventory change, naming the family in the error if it fails. */
  private async moveGoods(change: () => Promise<void>, family: FamilyFacts, item: TradeItem): Promise<void> {
    try {
      await change();
    } catch (err) {
      if (err instanceof AppError && err.code === "INSUFFICIENT_STOCK") throw conflict("INSUFFICIENT_STOCK", `${family.name} [${family.tag}] doesn't hold ${describeItem(item)}.`);
      if (err instanceof AppError && err.code === "STORAGE_FULL") throw conflict("STORAGE_FULL", `${family.name} [${family.tag}] has no room for ${describeItem(item)}.`);
      throw err;
    }
  }

  private async moveCash(tx: Tx, trade: TradeRow, from: FamilyFacts, to: FamilyFacts, fromPays: number, toPays: number, actorId: string): Promise<void> {
    if (fromPays === 0 && toPays === 0) return;
    const fromAccount = await this.ledger.treasuryId(tx, from.id);
    const toAccount = await this.ledger.treasuryId(tx, to.id);
    const lines: PostingLine[] = [];
    if (fromPays > 0) lines.push({ accountId: fromAccount, amount: -fromPays, reason: "trade" }, { accountId: toAccount, amount: fromPays, reason: "trade" });
    if (toPays > 0) lines.push({ accountId: toAccount, amount: -toPays, reason: "trade" }, { accountId: fromAccount, amount: toPays, reason: "trade" });
    try {
      await this.ledger.post(tx, { kind: "trade", idempotencyKey: `trade:${trade.id}`, actorPlayerId: actorId, ref: { type: "trade", id: trade.id }, lines });
    } catch (err) {
      if (!(err instanceof InsufficientFunds)) throw err;
      // Name the family that's short. Cash on both sides is netted, so only the net payer needs the money.
      const short = fromPays - toPays > 0 ? from : to;
      throw new AppError(409, "INSUFFICIENT_FUNDS", `${short.name} [${short.tag}] can't cover the cash in this trade.`);
    }
  }

  private async linesOf(db: DbOrTx, tradeId: string): Promise<{ gives: TradeItem[]; wants: TradeItem[] }> {
    return (await this.linesFor(db, [tradeId])).get(tradeId) ?? { gives: [], wants: [] };
  }

  private async linesFor(db: DbOrTx, ids: string[]): Promise<Map<string, { gives: TradeItem[]; wants: TradeItem[] }>> {
    const out = new Map<string, { gives: TradeItem[]; wants: TradeItem[] }>();
    if (ids.length === 0) return out;
    const rows = await db.select().from(tradeLines).where(inArray(tradeLines.tradeId, ids)).orderBy(asc(tradeLines.id));
    for (const r of rows) {
      const entry = out.get(r.tradeId) ?? { gives: [], wants: [] };
      entry[r.side].push(r.good ? { good: r.good, quantity: r.quantity! } : { cash: r.cash! });
      out.set(r.tradeId, entry);
    }
    return out;
  }

  private async one(id: string): Promise<Trade> {
    const [row] = await this.db.select().from(trades).where(eq(trades.id, id));
    return (await this.toDtos([row!]))[0]!;
  }

  private async toDtos(rows: TradeRow[]): Promise<Trade[]> {
    const lines = await this.linesFor(
      this.db,
      rows.map((r) => r.id),
    );
    const fams = await this.memberships.familiesById(rows.flatMap((r) => [r.fromFamilyId, r.toFamilyId]));
    const ref = (id: string) => {
      const f = fams.get(id)!;
      return { id: f.id, name: f.name, tag: f.tag };
    };
    return rows.map((r) => ({
      id: r.id,
      from: ref(r.fromFamilyId),
      to: ref(r.toFamilyId),
      ...(lines.get(r.id) ?? { gives: [], wants: [] }),
      status: r.status satisfies TradeStatus,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      closedAt: r.closedAt?.toISOString() ?? null,
    }));
  }
}
