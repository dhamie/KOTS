import { STORAGE, TRADES, type GoodKey } from "@kots/content";
import { OFFER_TTL_MS } from "@kots/rules";
import { Inventory, Trade, TradePage, type TradeItem } from "@kots/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../src/common/uuid";
import { seedMap, seedMarkets } from "../src/db/seed";
import { TradesService } from "../src/modules/trades/trades.service";
import { economyHelpers } from "./economy-helpers";
import { newPlayer, resetTestDatabase, startApi, TestClock, type TestApi, keyed } from "./helpers";

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

const { rows, family, balance, setBalance, expectLedgerConsistent, expectMarketConsistent, ageForTrading } = economyHelpers(() => api, "Trades");

type Fam = Awaited<ReturnType<typeof family>>;
type Client = Fam["don"]["client"];

/** A family old enough to trade. */
async function trader(roles: Parameters<typeof family>[0] = []): Promise<Fam> {
  const f = await family(roles);
  await ageForTrading(f.id);
  return f;
}

const buy = (c: Client, good: GoodKey, quantity: number) =>
  c.post("/markets/apapa-wharf/orders", { side: "buy", good, quantity, limitTotal: 1_000_000 }, { "idempotency-key": uuidv7() });
const held = async (c: Client, familyId: string, good: GoodKey) =>
  Inventory.parse((await c.get(`/families/${familyId}/inventory`)).body).items.find((i) => i.good === good)?.quantity ?? 0;
const offer = (from: Fam, to: Fam, gives: TradeItem[], wants: TradeItem[], c: Client = from.don.client) =>
  c.post(`/families/${from.id}/trades`, { to: to.tag, gives, wants }, keyed());
const box = async (c: Client, familyId: string, which: "incoming" | "outgoing" | "closed", query = "") =>
  TradePage.parse((await c.get(`/families/${familyId}/trades?box=${which}${query}`)).body);
const sweep = (at: Date = clock.now()) => api.app.get(TradesService).sweepExpired(at);

describe("making an offer", () => {
  it("is refused while either family is younger than the minimum age", async () => {
    const young = await family();
    const old = await trader();
    expect((await offer(young, old, [{ cash: 100 }], [])).body.code).toBe("TOO_NEW");
    const res = await offer(old, young, [{ cash: 100 }], []);
    expect([res.status, res.body.code]).toEqual([409, "TOO_NEW"]);
    expect(res.body.message).toContain(`[${young.tag}]`);
  });

  it("shows up for both families and in both activity logs", async () => {
    const a = await trader();
    const b = await trader();
    const res = await offer(a, b, [{ good: "fuel", quantity: 10 }], [{ cash: 1500 }]);
    expect(res.status).toBe(201);
    const t = Trade.parse(res.body);
    expect(t).toMatchObject({ from: { id: a.id }, to: { id: b.id }, gives: [{ good: "fuel", quantity: 10 }], wants: [{ cash: 1500 }], status: "open", closedAt: null });
    expect(new Date(t.expiresAt).getTime() - new Date(t.createdAt).getTime()).toBe(OFFER_TTL_MS);
    expect((await box(a.don.client, a.id, "outgoing")).items.map((i) => i.id)).toEqual([t.id]);
    expect((await box(b.don.client, b.id, "incoming")).items.map((i) => i.id)).toEqual([t.id]);
    expect((await box(b.don.client, b.id, "outgoing")).items).toEqual([]);
    expect((await a.don.client.get(`/families/${a.id}/activity`)).body.items[0]).toMatchObject({ type: "trade.offered", payload: { with: b.tag, gives: ["10 fuel"], wants: ["₦1,500"] } });
    expect((await b.don.client.get(`/families/${b.id}/activity`)).body.items[0]).toMatchObject({ type: "trade.received", payload: { with: a.tag } });
    // Offers are visible to members only.
    const outsider = await newPlayer(api.base);
    expect((await outsider.client.get(`/families/${a.id}/trades?box=outgoing`)).status).toBe(403);
  });

  it("checks the terms, the target and the open-offer limit", async () => {
    const a = await trader();
    const b = await trader();
    expect((await offer(a, b, [], [])).status).toBe(400);
    expect((await offer(a, b, [{ good: "fuel", quantity: 1 }, { good: "fuel", quantity: 2 }], [])).status).toBe(400);
    expect((await offer(a, b, [{ good: "fuel", quantity: 0 }], [])).status).toBe(400);
    expect((await offer(a, b, [{ good: "gold" as GoodKey, quantity: 1 }], [])).status).toBe(400);
    expect((await offer(a, b, [{ cash: TRADES.maxCash + 1 }], [])).status).toBe(400);
    expect((await offer(a, a, [{ cash: 1 }], [])).status).toBe(400);
    expect((await a.don.client.post(`/families/${a.id}/trades`, { to: "ZZZZZ", gives: [{ cash: 1 }], wants: [] }, keyed())).status).toBe(404);
    for (let i = 0; i < TRADES.maxOpenOutgoing; i++) expect((await offer(a, b, [{ cash: i + 1 }], [])).status).toBe(201);
    const over = await offer(a, b, [{ cash: 99 }], []);
    expect([over.status, over.body.code]).toEqual([409, "TOO_MANY_OFFERS"]);
  });

  it("is for the don, underboss and quartermaster", async () => {
    const a = await trader(["capo", "quartermaster"]);
    const b = await trader();
    const [capo, qm] = a.members;
    expect((await offer(a, b, [{ cash: 1 }], [], capo!.client)).status).toBe(403);
    expect((await offer(a, b, [{ cash: 1 }], [], qm!.client)).status).toBe(201);
  });
});

describe("accepting", () => {
  it("swaps goods for cash in one go; accepting again changes nothing", async () => {
    const a = await trader();
    const b = await trader();
    expect((await buy(a.don.client, "electronics", 10)).status).toBe(200);
    const aBefore = await balance(a.don.client, a.id);
    const t = (await offer(a, b, [{ good: "electronics", quantity: 10 }], [{ cash: 7000 }])).body;
    const res = await b.don.client.post(`/trades/${t.id}/accept`);
    expect(res.status).toBe(200);
    expect(Trade.parse(res.body)).toMatchObject({ status: "executed" });
    expect(await held(a.don.client, a.id, "electronics")).toBe(0);
    expect(await held(b.don.client, b.id, "electronics")).toBe(10);
    expect(await balance(a.don.client, a.id)).toBe(aBefore + 7000);
    expect(await balance(b.don.client, b.id)).toBe(20_000 - 7000);

    const again = await b.don.client.post(`/trades/${t.id}/accept`);
    expect([again.status, again.body.status]).toEqual([200, "executed"]);
    expect(await held(b.don.client, b.id, "electronics")).toBe(10);
    expect(await rows(sql`select id from ledger_transactions where idempotency_key = ${`trade:${t.id}`}`)).toHaveLength(1);
    expect((await b.don.client.get(`/families/${b.id}/treasury/entries`)).body.items[0]).toMatchObject({ kind: "trade", amount: -7000, ref: { type: "trade", id: t.id } });
    expect((await b.don.client.get(`/families/${b.id}/activity`)).body.items[0]).toMatchObject({ type: "trade.executed", payload: { with: a.tag, gives: ["₦7,000"], wants: ["10 electronics"] } });
    expect((await box(a.don.client, a.id, "closed")).items.map((i) => i.id)).toEqual([t.id]);
    expect((await box(a.don.client, a.id, "outgoing")).items).toEqual([]);
    await expectLedgerConsistent();
    await expectMarketConsistent();
  });

  it("re-checks at acceptance: a short side moves nothing and the offer stays open", async () => {
    const a = await trader();
    const b = await trader();
    const t = (await offer(a, b, [{ good: "textiles", quantity: 5 }], [{ cash: 900 }])).body;
    const short = await b.don.client.post(`/trades/${t.id}/accept`);
    expect([short.status, short.body.code]).toEqual([409, "INSUFFICIENT_STOCK"]);
    expect(short.body.message).toContain(`[${a.tag}]`);

    await buy(a.don.client, "textiles", 5);
    await setBalance(b.id, 899);
    const broke = await b.don.client.post(`/trades/${t.id}/accept`);
    expect([broke.status, broke.body.code]).toEqual([409, "INSUFFICIENT_FUNDS"]);
    expect(broke.body.message).toContain(`[${b.tag}]`);
    expect(await held(a.don.client, a.id, "textiles")).toBe(5);
    expect(await held(b.don.client, b.id, "textiles")).toBe(0);
    expect((await box(b.don.client, b.id, "incoming")).items.map((i) => i.id)).toEqual([t.id]);

    await setBalance(b.id, 900);
    expect((await b.don.client.post(`/trades/${t.id}/accept`)).status).toBe(200);
    expect(await balance(b.don.client, b.id)).toBe(0);
    await expectLedgerConsistent();
    await expectMarketConsistent();
  });

  it("refuses goods the receiver has no room for; removing first makes room for a swap", async () => {
    const a = await trader();
    const b = await trader();
    await setBalance(a.id, 100_000);
    await setBalance(b.id, 100_000);
    await buy(a.don.client, "fuel", 10);
    await buy(b.don.client, "textiles", STORAGE.base);
    const full = (await offer(a, b, [{ good: "fuel", quantity: 10 }], [])).body;
    const res = await b.don.client.post(`/trades/${full.id}/accept`);
    expect([res.status, res.body.code]).toEqual([409, "STORAGE_FULL"]);
    expect(res.body.message).toContain(`[${b.tag}]`);

    // b is full, but hands over 10 textiles before taking 10 fuel.
    const swap = (await offer(a, b, [{ good: "fuel", quantity: 10 }], [{ good: "textiles", quantity: 10 }])).body;
    expect((await b.don.client.post(`/trades/${swap.id}/accept`)).status).toBe(200);
    expect(await held(b.don.client, b.id, "fuel")).toBe(10);
    expect(await held(a.don.client, a.id, "textiles")).toBe(10);
    await expectMarketConsistent();
  });

  it("nets cash on both sides, and runs gifts and requests", async () => {
    const a = await trader();
    const b = await trader();
    await setBalance(a.id, 300);
    // a pays 1,000 and receives 800: only the net 200 needs to be in its treasury.
    const both = (await offer(a, b, [{ cash: 1000 }], [{ cash: 800 }])).body;
    expect((await b.don.client.post(`/trades/${both.id}/accept`)).status).toBe(200);
    expect(await balance(a.don.client, a.id)).toBe(100);
    expect(await balance(b.don.client, b.id)).toBe(20_200);

    const gift = (await offer(b, a, [{ cash: 5000 }], [])).body;
    expect((await a.don.client.post(`/trades/${gift.id}/accept`)).status).toBe(200);
    expect(await balance(a.don.client, a.id)).toBe(5100);
    await buy(b.don.client, "contraband", 2);
    const request = (await offer(a, b, [], [{ good: "contraband", quantity: 2 }])).body;
    expect((await b.don.client.post(`/trades/${request.id}/accept`)).status).toBe(200);
    expect(await held(a.don.client, a.id, "contraband")).toBe(2);
    await expectLedgerConsistent();
    await expectMarketConsistent();
  });

  it("is only for the receiving family's don, underboss or quartermaster", async () => {
    const a = await trader();
    const b = await trader(["capo", "quartermaster"]);
    const [capo, qm] = b.members;
    const t = (await offer(a, b, [{ cash: 10 }], [])).body;
    expect((await a.don.client.post(`/trades/${t.id}/accept`)).status).toBe(403);
    expect((await capo!.client.post(`/trades/${t.id}/accept`)).status).toBe(403);
    expect((await (await newPlayer(api.base)).client.post(`/trades/${t.id}/accept`)).status).toBe(403);
    expect((await qm!.client.post(`/trades/${t.id}/accept`)).status).toBe(200);
    expect((await b.don.client.post(`/trades/${uuidv7()}/accept`)).status).toBe(404);
  });

  it("is refused once a family has disbanded", async () => {
    const a = await trader();
    const b = await trader();
    const t = (await offer(a, b, [{ cash: 10 }], [])).body;
    expect((await a.don.client.delete(`/families/${a.id}`)).status).toBe(204);
    const res = await b.don.client.post(`/trades/${t.id}/accept`);
    expect([res.status, res.body.code]).toEqual([409, "TRADE_CLOSED"]);
  });
});

describe("closing offers", () => {
  it("the receiver declines, the sender cancels, and a closed offer can't be accepted", async () => {
    const a = await trader();
    const b = await trader();
    const t1 = (await offer(a, b, [{ cash: 10 }], [])).body;
    const t2 = (await offer(a, b, [{ cash: 20 }], [])).body;
    expect((await a.don.client.post(`/trades/${t1.id}/decline`)).status).toBe(403);
    expect((await b.don.client.post(`/trades/${t2.id}/cancel`)).status).toBe(403);
    expect((await b.don.client.post(`/trades/${t1.id}/decline`)).body.status).toBe("declined");
    expect((await a.don.client.post(`/trades/${t2.id}/cancel`)).body.status).toBe("cancelled");
    for (const [c, id, action] of [
      [b.don.client, t1.id, "accept"],
      [b.don.client, t2.id, "accept"],
      [a.don.client, t1.id, "cancel"],
      [b.don.client, t2.id, "decline"],
    ] as const) {
      const res = await c.post(`/trades/${id}/${action}`);
      expect([res.status, res.body.code]).toEqual([409, "TRADE_CLOSED"]);
    }
    expect((await box(a.don.client, a.id, "closed")).items.map((i) => i.status)).toEqual(["cancelled", "declined"]);
    expect((await b.don.client.get(`/families/${b.id}/activity`)).body.items[0]).toMatchObject({ type: "trade.cancelled", payload: { with: a.tag } });
    expect(await balance(b.don.client, b.id)).toBe(20_000);
  });

  it("an offer expires after its time: it can't be accepted, and the sweep closes it once", async () => {
    const a = await trader();
    const b = await trader();
    const t = (await offer(a, b, [{ cash: 10 }], [])).body;
    clock.advance(OFFER_TTL_MS);
    const res = await b.don.client.post(`/trades/${t.id}/accept`);
    expect([res.status, res.body.code]).toEqual([409, "TRADE_CLOSED"]);
    expect((await box(b.don.client, b.id, "incoming")).items).toEqual([]);
    expect(await sweep()).toBeGreaterThanOrEqual(1);
    expect(await sweep()).toBe(0);
    expect((await box(b.don.client, b.id, "closed")).items[0]).toMatchObject({ id: t.id, status: "expired" });
    expect((await a.don.client.get(`/families/${a.id}/activity`)).body.items[0]).toMatchObject({ type: "trade.expired", payload: { with: b.tag } });
  });

  it("closed trades page newest first", async () => {
    const a = await trader();
    const b = await trader();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t = (await offer(a, b, [{ cash: i + 1 }], [])).body;
      await b.don.client.post(`/trades/${t.id}/decline`);
      ids.unshift(t.id);
    }
    const first = await box(a.don.client, a.id, "closed", "&limit=3");
    expect(first.items.map((i) => i.id)).toEqual(ids.slice(0, 3));
    const second = await box(a.don.client, a.id, "closed", `&limit=3&before=${first.nextCursor}`);
    expect(second.items.map((i) => i.id)).toEqual(ids.slice(3));
    expect(second.nextCursor).toBeNull();
  });

  it("a family's trades and the expiry sweep can use their indexes", async () => {
    await api.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const plan = async (q: ReturnType<typeof sql>) => (await tx.execute(q)).rows.map((r) => Object.values(r)[0]).join("\n");
      expect(await plan(sql`explain select * from trades where to_family_id = '00000000-0000-7000-8000-000000000000' order by id desc limit 20`)).toMatch(/trades_to_idx/);
      expect(await plan(sql`explain select id from trades where status = 'open' and expires_at <= now() order by expires_at limit 500`)).toMatch(/trades_expiry_idx/);
    });
  });
});
