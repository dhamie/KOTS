import { Inject, Injectable, Logger } from "@nestjs/common";
import { GOODS, MARKETS, type GoodKey } from "@kots/content";
import { askPrice, bidPrice, driftStep, driftStock, goodDef, marketGood, maxStock, quoteOrder } from "@kots/rules";
import type { Market, MarketOrder, OrderRequest } from "@kots/shared";
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { CLOCK, type Clock } from "../../common/clock";
import { AppError, badRequest, conflict, notFound } from "../../common/errors";
import { DB, type Database } from "../../db/db";
import { marketOrders, npcMarketState } from "../../db/schema";
import type { Tx } from "../../db/tx";
import { ActivityService } from "../activity/activity.service";
import { MembershipsService } from "../families/memberships.service";
import { InventoryService } from "../inventory/inventory.service";
import { InsufficientFunds, LedgerService } from "../ledger/ledger.service";
import { HoldingsService } from "../territories/holdings.service";

type OrderRow = typeof marketOrders.$inferSelect;

const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;

/**
 * The NPC markets: one per district, each with a stock of every good. Prices are computed from stock (rules/market.ts).
 * An order runs in one transaction: family → inventory → market stock → treasury, the schema's lock order.
 */
@Injectable()
export class MarketService {
  private readonly logger = new Logger(MarketService.name);
  /** Market slug → territory id. Territory ids never change, so this is loaded once. */
  private ids: Map<string, string> | undefined;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly memberships: MembershipsService,
    private readonly holdings: HoldingsService,
    private readonly inventory: InventoryService,
    private readonly ledger: LedgerService,
    private readonly activity: ActivityService,
  ) {}

  async market(slug: string): Promise<Market> {
    const territoryId = await this.marketId(slug);
    const rows = await this.db.select().from(npcMarketState).where(eq(npcMarketState.territoryId, territoryId));
    const stock = new Map(rows.map((r) => [r.good, r.stock]));
    return {
      market: slug,
      goods: GOODS.map((good) => {
        const mg = marketGood(slug, good.key)!;
        const s = stock.get(good.key) ?? 0;
        return { good: good.key, stock: s, maxStock: maxStock(mg), buyPrice: askPrice(good, mg, s), sellPrice: bidPrice(good, mg, s) };
      }),
    };
  }

  async order(actorId: string, slug: string, requestKey: string, req: OrderRequest): Promise<MarketOrder> {
    const territoryId = await this.marketId(slug);
    const good = goodDef(req.good);
    const mg = marketGood(slug, req.good)!;
    const now = this.clock.now();

    const id = await this.db.transaction(async (tx) => {
      const actor = await this.memberships.lockActing(tx, actorId, { kind: "trade_market" });
      const familyId = actor.familyId;
      // Orders by one family run one at a time (its row is locked), so this check can't race a retry.
      const [prior] = await tx
        .select()
        .from(marketOrders)
        .where(and(eq(marketOrders.familyId, familyId), eq(marketOrders.requestKey, requestKey)));
      if (prior) {
        const same = prior.territoryId === territoryId && prior.good === req.good && prior.side === req.side && prior.quantity === req.quantity;
        if (!same) throw badRequest("That Idempotency-Key was already used for a different order.");
        return prior.id;
      }

      if (req.side === "buy") await this.inventory.add(tx, familyId, req.good, req.quantity);
      else await this.inventory.remove(tx, familyId, req.good, req.quantity);

      const [state] = await tx
        .select({ stock: npcMarketState.stock })
        .from(npcMarketState)
        .where(and(eq(npcMarketState.territoryId, territoryId), eq(npcMarketState.good, req.good)))
        .for("update");
      if (!state) throw notFound("Market");
      const quote = quoteOrder(req.side, good, mg, state.stock, req.quantity);
      if (!quote.ok) {
        throw quote.reason === "insufficient_stock"
          ? conflict("INSUFFICIENT_STOCK", `The market only has ${state.stock} ${good.label.toLowerCase()} left.`)
          : conflict("MARKET_FULL", `The market won't take that much more ${good.label.toLowerCase()}.`);
      }
      const beyondLimit = req.side === "buy" ? quote.total > req.limitTotal : quote.total < req.limitTotal;
      if (beyondLimit) {
        throw new AppError(409, "PRICE_CHANGED", `The price has moved: that order is now ${naira(quote.total)}.`, { total: quote.total });
      }
      await tx
        .update(npcMarketState)
        .set({ stock: quote.stockAfter, updatedAt: now })
        .where(and(eq(npcMarketState.territoryId, territoryId), eq(npcMarketState.good, req.good)));

      const [order] = await tx
        .insert(marketOrders)
        .values({ familyId, territoryId, good: req.good, side: req.side, quantity: req.quantity, total: quote.total, actorPlayerId: actorId, requestKey, createdAt: now })
        .returning({ id: marketOrders.id });
      const treasury = await this.ledger.treasuryId(tx, familyId);
      const market = await this.ledger.systemAccount("market", tx);
      const flow = req.side === "buy" ? -quote.total : quote.total;
      try {
        await this.ledger.post(tx, {
          kind: req.side === "buy" ? "purchase" : "sale",
          idempotencyKey: `market:${order!.id}`,
          actorPlayerId: actorId,
          ref: { type: "market_order", id: order!.id },
          lines: [
            { accountId: treasury, amount: flow, reason: req.side === "buy" ? "market_purchase" : "market_sale" },
            { accountId: market, amount: -flow, reason: req.side === "buy" ? "market_purchase" : "market_sale" },
          ],
        });
      } catch (err) {
        if (err instanceof InsufficientFunds) {
          throw new AppError(409, "INSUFFICIENT_FUNDS", `That order costs ${naira(quote.total)}, more than the treasury holds.`);
        }
        throw err;
      }
      await this.activity.record(tx, {
        familyId,
        actorPlayerId: actorId,
        type: req.side === "buy" ? "market.bought" : "market.sold",
        payload: { market: slug, good: req.good, quantity: req.quantity, total: quote.total },
      });
      return order!.id;
    });
    const [row] = await this.db.select().from(marketOrders).where(eq(marketOrders.id, id));
    return this.toDto(row!, slug);
  }

  /**
   * Moves every market's stock one drift step back toward normal (rules `driftStock`). A row is updated only if its
   * last step is older than the current one, so a retried or overlapping run changes nothing twice. Rows locked by
   * an order in progress are skipped and caught by the next run.
   */
  async sweepDrift(now: Date = this.clock.now()): Promise<number> {
    const step = driftStep(now.getTime());
    const slugById = new Map([...(await this.marketIds()).entries()].map(([slug, id]) => [id, slug]));
    const moved = await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(npcMarketState)
        .where(lt(npcMarketState.driftStep, step))
        .orderBy(asc(npcMarketState.territoryId), asc(npcMarketState.good))
        .for("update", { skipLocked: true });
      let n = 0;
      for (const r of rows) {
        const slug = slugById.get(r.territoryId);
        const mg = slug ? marketGood(slug, r.good) : undefined;
        if (!slug || !mg) continue;
        const stock = driftStock(slug, goodDef(r.good), mg, r.stock, step);
        await tx
          .update(npcMarketState)
          .set({ stock, driftStep: step, updatedAt: now })
          .where(and(eq(npcMarketState.territoryId, r.territoryId), eq(npcMarketState.good, r.good)));
        n++;
      }
      return n;
    });
    if (moved > 0) this.logger.log(`market drift: step ${step}, ${moved} rows`);
    return moved;
  }

  /**
   * A city event cuts the stock of one good at some markets to `stockLeftPct` percent. Called by EventsService inside
   * its transaction; drift brings the stock back.
   */
  async shock(tx: Tx, slugs: readonly string[], good: GoodKey, stockLeftPct: number, now: Date): Promise<void> {
    const ids = [...(await this.holdings.idsOf(slugs, tx)).values()];
    if (ids.length === 0) return;
    const rows = await tx
      .select({ territoryId: npcMarketState.territoryId })
      .from(npcMarketState)
      .where(and(inArray(npcMarketState.territoryId, ids), eq(npcMarketState.good, good)))
      .orderBy(asc(npcMarketState.territoryId))
      .for("update");
    if (rows.length === 0) return;
    await tx
      .update(npcMarketState)
      .set({ stock: sql`(${npcMarketState.stock} * ${stockLeftPct}) / 100`, updatedAt: now })
      .where(and(inArray(npcMarketState.territoryId, rows.map((r) => r.territoryId)), eq(npcMarketState.good, good)));
  }

  private async marketIds(): Promise<Map<string, string>> {
    if (this.ids) return this.ids;
    const ids = await this.holdings.idsOf(MARKETS.map((m) => m.territory));
    // Cached only once the map is seeded, so a lookup before seeding doesn't stick.
    if (ids.size === MARKETS.length) this.ids = ids;
    return ids;
  }

  private async marketId(slug: string): Promise<string> {
    const id = (await this.marketIds()).get(slug);
    if (!id) throw notFound("Market");
    return id;
  }

  private toDto(o: OrderRow, market: string): MarketOrder {
    return { id: o.id, market, good: o.good, side: o.side, quantity: o.quantity, total: o.total, createdAt: o.createdAt.toISOString() };
  }
}
