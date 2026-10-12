import { GOODS, MARKET, MARKETS, STORAGE, type GoodKey } from "@kots/content";
import { askPrice, bidPrice, DRIFT_STEP_MS, goodDef, marketGood, quoteOrder } from "@kots/rules";
import { Inventory, Market, MarketOrder } from "@kots/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../src/common/uuid";
import { seedMap, seedMarkets } from "../src/db/seed";
import { MarketService } from "../src/modules/market/market.service";
import { economyHelpers } from "./economy-helpers";
import { newPlayer, resetTestDatabase, startApi, TestClock, type TestApi } from "./helpers";

let api: TestApi;
const clock = new TestClock();

beforeAll(async () => {
  await resetTestDatabase();
  api = await startApi(undefined, clock);
  await seedMap(api.db);
  await seedMarkets(api.db);
});

afterAll(async () => {
  await api?.close();
});

const { rows, family, balance, setBalance, expectLedgerConsistent, expectMarketConsistent } = economyHelpers(() => api, "Market");

type Client = Awaited<ReturnType<typeof family>>["don"]["client"];
type Side = "buy" | "sell";

const market = async (c: Client, slug: string) => Market.parse((await c.get(`/markets/${slug}`)).body);
const stockOf = async (c: Client, slug: string, good: GoodKey) => (await market(c, slug)).goods.find((g) => g.good === good)!.stock;
const inventory = async (c: Client, familyId: string) => Inventory.parse((await c.get(`/families/${familyId}/inventory`)).body);
const held = async (c: Client, familyId: string, good: GoodKey) => (await inventory(c, familyId)).items.find((i) => i.good === good)?.quantity ?? 0;

/** Posts an order with its own Idempotency-Key unless one is given. */
const order = (c: Client, slug: string, body: { side: Side; good: GoodKey; quantity: number; limitTotal: number }, key: string = uuidv7()) =>
  c.post(`/markets/${slug}/orders`, body, { "idempotency-key": key });

/** What the order costs (buy) or pays (sell) at the market's current stock, per the shared rules. */
async function quote(c: Client, slug: string, side: Side, good: GoodKey, quantity: number): Promise<number> {
  const q = quoteOrder(side, goodDef(good), marketGood(slug, good)!, await stockOf(c, slug, good), quantity);
  if (!q.ok) throw new Error(q.reason);
  return q.total;
}

/** An order at exactly the current quote. */
async function trade(c: Client, slug: string, side: Side, good: GoodKey, quantity: number) {
  return order(c, slug, { side, good, quantity, limitTotal: await quote(c, slug, side, good, quantity) });
}

const setStock = (slug: string, good: GoodKey, stock: number) =>
  api.db.execute(sql`update npc_market_state set stock = ${stock} where good = ${good} and territory_id = (select id from territories where slug = ${slug})`);

describe("viewing a market", () => {
  it("shows every good at its normal stock, priced by the shared rules, to any player", async () => {
    const outsider = await newPlayer(api.base);
    const m = await market(outsider.client, "tejuosho");
    expect(m.goods.map((g) => g.good)).toEqual(GOODS.map((g) => g.key));
    for (const g of m.goods) {
      const mg = marketGood("tejuosho", g.good)!;
      expect(g.stock).toBe(mg.normalStock);
      expect(g.maxStock).toBe(mg.normalStock * MARKET.maxStockFactor);
      expect(g.buyPrice).toBe(askPrice(goodDef(g.good), mg, g.stock));
      expect(g.sellPrice).toBe(bidPrice(goodDef(g.good), mg, g.stock));
      expect(g.sellPrice).toBeLessThan(g.buyPrice);
    }
    expect((await outsider.client.get("/markets/marina")).status).toBe(404);
    expect((await outsider.client.get("/markets/NOT_A_SLUG")).status).toBe(404);
  });

  it("re-seeding never resets live stock", async () => {
    const c = (await newPlayer(api.base)).client;
    await setStock("balogun", "fuel", 123);
    await seedMarkets(api.db);
    expect(await stockOf(c, "balogun", "fuel")).toBe(123);
    await setStock("balogun", "fuel", marketGood("balogun", "fuel")!.normalStock);
  });
});

describe("buying and selling", () => {
  it("a buy moves stock into the family's storage and money into the market, all in one ledger posting", async () => {
    const f = await family();
    const c = f.don.client;
    const before = await stockOf(c, "apapa-wharf", "imported_goods");
    const total = await quote(c, "apapa-wharf", "buy", "imported_goods", 10);
    const res = await order(c, "apapa-wharf", { side: "buy", good: "imported_goods", quantity: 10, limitTotal: total });
    expect(res.status).toBe(200);
    expect(MarketOrder.parse(res.body)).toMatchObject({ market: "apapa-wharf", good: "imported_goods", side: "buy", quantity: 10, total });
    expect(await stockOf(c, "apapa-wharf", "imported_goods")).toBe(before - 10);
    expect(await inventory(c, f.id)).toEqual({ capacity: STORAGE.base, used: 10, items: [{ good: "imported_goods", quantity: 10 }] });
    expect(await balance(c, f.id)).toBe(20_000 - total);

    const [entry] = (await c.get(`/families/${f.id}/treasury/entries`)).body.items;
    expect(entry).toMatchObject({ kind: "purchase", reason: "market_purchase", amount: -total, ref: { type: "market_order", id: res.body.id } });
    const activity = (await c.get(`/families/${f.id}/activity`)).body.items;
    expect(activity[0]).toMatchObject({ type: "market.bought", payload: { market: "apapa-wharf", good: "imported_goods", quantity: 10, total } });
    await expectLedgerConsistent();
    await expectMarketConsistent();
  });

  it("selling elsewhere pays the family, and can turn a profit", async () => {
    const f = await family();
    const c = f.don.client;
    const cost = (await trade(c, "apapa-wharf", "buy", "imported_goods", 20)).body.total as number;
    const sold = await trade(c, "balogun", "sell", "imported_goods", 20);
    expect(sold.status).toBe(200);
    expect(sold.body.total).toBeGreaterThan(cost);
    expect(await held(c, f.id, "imported_goods")).toBe(0);
    expect(await balance(c, f.id)).toBe(20_000 - cost + sold.body.total);
    expect((await c.get(`/families/${f.id}/treasury/entries`)).body.items[0]).toMatchObject({ kind: "sale", reason: "market_sale", amount: sold.body.total });
    await expectLedgerConsistent();
    await expectMarketConsistent();
  });

  it("is for the don, underboss and quartermaster", async () => {
    const f = await family(["quartermaster", "capo", "associate"]);
    const [qm, capo, assoc] = f.members;
    expect((await trade(capo!.client, "tejuosho", "buy", "fuel", 1)).status).toBe(403);
    expect((await trade(assoc!.client, "tejuosho", "buy", "fuel", 1)).status).toBe(403);
    expect((await trade(qm!.client, "tejuosho", "buy", "fuel", 1)).status).toBe(200);
    const loner = await newPlayer(api.base);
    expect((await trade(loner.client, "tejuosho", "buy", "fuel", 1)).status).toBe(403);
    // Inventory is for members only.
    expect((await loner.client.get(`/families/${f.id}/inventory`)).status).toBe(403);
    expect(await held(assoc!.client, f.id, "fuel")).toBe(1);
  });

  it("refuses an order whose price moved past the family's limit, changing nothing", async () => {
    const f = await family();
    const c = f.don.client;
    const total = await quote(c, "tejuosho", "buy", "electronics", 5);
    const stock = await stockOf(c, "tejuosho", "electronics");
    const res = await order(c, "tejuosho", { side: "buy", good: "electronics", quantity: 5, limitTotal: total - 1 });
    expect([res.status, res.body.code, res.body.details]).toEqual([409, "PRICE_CHANGED", { total }]);
    await trade(c, "tejuosho", "buy", "electronics", 5);
    const payout = await quote(c, "tejuosho", "sell", "electronics", 5);
    const sell = await order(c, "tejuosho", { side: "sell", good: "electronics", quantity: 5, limitTotal: payout + 1 });
    expect([sell.status, sell.body.code]).toEqual([409, "PRICE_CHANGED"]);
    expect(await held(c, f.id, "electronics")).toBe(5);
    expect(await stockOf(c, "tejuosho", "electronics")).toBe(stock - 5);
  });

  it("refuses more than storage holds; holding territory adds space", async () => {
    const f = await family();
    const c = f.don.client;
    await setBalance(f.id, 100_000);
    expect((await trade(c, "apapa-wharf", "buy", "fuel", STORAGE.base)).status).toBe(200);
    const full = await trade(c, "apapa-wharf", "buy", "fuel", 1);
    expect([full.status, full.body.code]).toEqual([409, "STORAGE_FULL"]);

    expect((await c.post("/territories/tin-can/claim")).status).toBe(200); // logistics
    expect((await inventory(c, f.id)).capacity).toBe(STORAGE.base + STORAGE.perTerritory.logistics);
    expect((await trade(c, "apapa-wharf", "buy", "textiles", STORAGE.perTerritory.logistics)).status).toBe(200);
    expect((await trade(c, "apapa-wharf", "buy", "textiles", 1)).body.code).toBe("STORAGE_FULL");

    // Losing the space destroys nothing; it only stops further buying.
    expect((await c.post("/territories/tin-can/abandon")).status).toBe(204);
    expect(await inventory(c, f.id)).toMatchObject({ capacity: STORAGE.base, used: STORAGE.base + STORAGE.perTerritory.logistics });
    expect((await trade(c, "apapa-wharf", "sell", "textiles", 10)).status).toBe(200);
    await expectMarketConsistent();
  });

  it("refuses to sell what the family doesn't hold, to buy what the market doesn't have, or to flood a market", async () => {
    const f = await family();
    const c = f.don.client;
    const sell = await order(c, "balogun", { side: "sell", good: "contraband", quantity: 1, limitTotal: 1 });
    expect([sell.status, sell.body.code]).toEqual([409, "INSUFFICIENT_STOCK"]);

    await setStock("balogun", "textiles", 3);
    const buy = await order(c, "balogun", { side: "buy", good: "textiles", quantity: 4, limitTotal: 1_000_000 });
    expect([buy.status, buy.body.code]).toEqual([409, "INSUFFICIENT_STOCK"]);

    await trade(c, "tejuosho", "buy", "textiles", 10);
    const max = marketGood("balogun", "textiles")!.normalStock * MARKET.maxStockFactor;
    await setStock("balogun", "textiles", max - 5);
    const flood = await order(c, "balogun", { side: "sell", good: "textiles", quantity: 6, limitTotal: 1 });
    expect([flood.status, flood.body.code]).toEqual([409, "MARKET_FULL"]);
    expect(await held(c, f.id, "textiles")).toBe(10);
    await setStock("balogun", "textiles", marketGood("balogun", "textiles")!.normalStock);
  });

  it("refuses an order the treasury can't cover, changing nothing", async () => {
    const f = await family();
    const c = f.don.client;
    await setBalance(f.id, 500);
    const stock = await stockOf(c, "tejuosho", "contraband");
    const res = await trade(c, "tejuosho", "buy", "contraband", 1);
    expect([res.status, res.body.code]).toEqual([409, "INSUFFICIENT_FUNDS"]);
    expect(await stockOf(c, "tejuosho", "contraband")).toBe(stock);
    expect(await inventory(c, f.id)).toMatchObject({ used: 0, items: [] });
    expect(await balance(c, f.id)).toBe(500);
  });

  it("validates the order and the Idempotency-Key header", async () => {
    const f = await family();
    const c = f.don.client;
    const body = { side: "buy", good: "fuel", quantity: 1, limitTotal: 1000 };
    expect((await c.post("/markets/tejuosho/orders", body)).status).toBe(400);
    expect((await c.post("/markets/tejuosho/orders", body, { "idempotency-key": "short" })).status).toBe(400);
    for (const bad of [{ ...body, quantity: 0 }, { ...body, quantity: MARKET.maxOrderQuantity + 1 }, { ...body, good: "gold" }, { ...body, side: "steal" }, { ...body, price: 1 }]) {
      expect((await c.post("/markets/tejuosho/orders", bad, { "idempotency-key": uuidv7() })).status).toBe(400);
    }
    expect((await c.post("/markets/marina/orders", body, { "idempotency-key": uuidv7() })).status).toBe(404);
  });
});

describe("retries", () => {
  it("the same Idempotency-Key fills an order once and returns the same receipt", async () => {
    const f = await family();
    const c = f.don.client;
    const key = uuidv7();
    const body = { side: "buy" as const, good: "fuel" as const, quantity: 4, limitTotal: await quote(c, "tejuosho", "buy", "fuel", 4) };
    const first = await order(c, "tejuosho", body, key);
    const again = await order(c, "tejuosho", body, key);
    expect(first.status).toBe(200);
    expect(again.body).toEqual(first.body);
    expect(await held(c, f.id, "fuel")).toBe(4);
    const changed = await order(c, "tejuosho", { ...body, quantity: 5 }, key);
    expect([changed.status, changed.body.code]).toEqual([400, "VALIDATION_FAILED"]);
    // Keys belong to a family: another family can use the same one.
    const g = await family();
    expect((await order(g.don.client, "tejuosho", { ...body, limitTotal: 10_000 }, key)).status).toBe(200);
    await expectMarketConsistent();
  });

  it("a key whose order was refused can be retried", async () => {
    const f = await family();
    const c = f.don.client;
    const key = uuidv7();
    const total = await quote(c, "tejuosho", "buy", "fuel", 2);
    expect((await order(c, "tejuosho", { side: "buy", good: "fuel", quantity: 2, limitTotal: total - 1 }, key)).body.code).toBe("PRICE_CHANGED");
    expect((await order(c, "tejuosho", { side: "buy", good: "fuel", quantity: 2, limitTotal: total }, key)).status).toBe(200);
  });

  it("five simultaneous copies of one request fill it once", async () => {
    const f = await family();
    const c = f.don.client;
    const key = uuidv7();
    const body = { side: "buy" as const, good: "textiles" as const, quantity: 3, limitTotal: 10_000 };
    const results = await Promise.all(Array.from({ length: 5 }, () => order(c, "tejuosho", body, key)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(await held(c, f.id, "textiles")).toBe(3);
    expect(await rows(sql`select id from market_orders where family_id = ${f.id}`)).toHaveLength(1);
    await expectLedgerConsistent();
  });
});

describe("concurrency", () => {
  it("twenty families racing for scarce stock: it sells out exactly, and goods and money add up", async () => {
    const families = await Promise.all(Array.from({ length: 20 }, () => family()));
    await setStock("apapa-wharf", "contraband", 30);
    const results = await Promise.all(
      families.map((f) => order(f.don.client, "apapa-wharf", { side: "buy", good: "contraband", quantity: 3, limitTotal: 1_000_000 })),
    );
    const filled = results.filter((r) => r.status === 200);
    expect(filled).toHaveLength(10);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === "INSUFFICIENT_STOCK")).toBe(true);
    expect(await stockOf(families[0]!.don.client, "apapa-wharf", "contraband")).toBe(0);
    // Units are priced one at a time from the stock, so together the fills cost exactly one 30-unit order.
    const all = quoteOrder("buy", goodDef("contraband"), marketGood("apapa-wharf", "contraband")!, 30, 30);
    expect(filled.reduce((s, r) => s + (r.body.total as number), 0)).toBe(all.ok && all.total);
    await expectLedgerConsistent();
    await expectMarketConsistent();
    await setStock("apapa-wharf", "contraband", marketGood("apapa-wharf", "contraband")!.normalStock);
  });

  it("one family buying and selling at once never loses goods or money", async () => {
    const f = await family();
    const c = f.don.client;
    await trade(c, "tejuosho", "buy", "fuel", 20);
    const results = await Promise.all([
      ...Array.from({ length: 5 }, () => order(c, "tejuosho", { side: "sell", good: "fuel", quantity: 4, limitTotal: 1 })),
      ...Array.from({ length: 5 }, () => order(c, "tejuosho", { side: "buy", good: "fuel", quantity: 2, limitTotal: 10_000 })),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await held(c, f.id, "fuel")).toBe(20 - 20 + 10);
    await expectLedgerConsistent();
    await expectMarketConsistent();
  });
});

describe("market drift", () => {
  const drift = (at: Date) => api.app.get(MarketService).sweepDrift(at);
  const wharf = MARKETS.find((m) => m.territory === "apapa-wharf")!;

  it("moves stock toward normal once per step, however often it runs", async () => {
    const c = (await newPlayer(api.base)).client;
    const normal = wharf.goods.electronics.normalStock;
    await setStock("apapa-wharf", "electronics", 20);
    // A fixed step, not the current time: the wobble is seeded by the step, so a moving start made this test pass or
    // fail depending on the half-hour it ran in.
    const at = new Date(Date.UTC(2026, 0, 1) + 60_000);
    expect(await drift(at)).toBe(MARKETS.length * GOODS.length);
    const once = await stockOf(c, "apapa-wharf", "electronics");
    expect(once).toBeGreaterThan(20);
    // Same step again, even concurrently: nothing more moves.
    expect(await Promise.all([drift(at), drift(at)])).toEqual([0, 0]);
    expect(await stockOf(c, "apapa-wharf", "electronics")).toBe(once);

    let stock = once;
    for (let i = 1; i <= 40; i++) {
      await drift(new Date(at.getTime() + i * DRIFT_STEP_MS));
      stock = await stockOf(c, "apapa-wharf", "electronics");
    }
    expect(Math.abs(stock - normal)).toBeLessThan(normal * 0.1);
    await expectMarketConsistent();
  });
});
