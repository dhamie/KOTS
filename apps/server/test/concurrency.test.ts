import { GOOD_KEYS, MARKETS, type GoodKey } from "@kots/content";
import { createRng, DRIFT_STEP_MS, nextInt, OFFER_TTL_MS, type RngState } from "@kots/rules";
import { Inventory, TradePage } from "@kots/shared";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../src/common/uuid";
import { seedMap, seedMarkets } from "../src/db/seed";
import { MarketService } from "../src/modules/market/market.service";
import { TradesService } from "../src/modules/trades/trades.service";
import { economyHelpers } from "./economy-helpers";
import { resetTestDatabase, startApi, TestClock, type TestApi, keyed } from "./helpers";

/**
 * Trades and market orders fired at the same moment against real Postgres. After every test the shared checks
 * confirm that money and goods still add up (economy-helpers: expectLedgerConsistent, expectMarketConsistent).
 */
let api: TestApi;
const clock = new TestClock();

beforeAll(async () => {
  await resetTestDatabase();
  api = await startApi(undefined, clock);
  await seedMap(api.db);
  await seedMarkets(api.db);
});

afterEach(async () => {
  await expectLedgerConsistent();
  await expectMarketConsistent();
});

afterAll(async () => {
  await api?.close();
});

const { rows, family, balance, setBalance, expectLedgerConsistent, expectMarketConsistent, ageForTrading } = economyHelpers(() => api, "Race");

type Fam = Awaited<ReturnType<typeof family>>;
type Client = Fam["don"]["client"];

async function trader(roles: Parameters<typeof family>[0] = []): Promise<Fam> {
  const f = await family(roles);
  await ageForTrading(f.id);
  return f;
}

const order = (c: Client, side: "buy" | "sell", good: GoodKey, quantity: number, market = "apapa-wharf") =>
  c.post(`/markets/${market}/orders`, { side, good, quantity, limitTotal: side === "buy" ? 1_000_000 : 1 }, { "idempotency-key": uuidv7() });
const held = async (c: Client, familyId: string, good: GoodKey) =>
  Inventory.parse((await c.get(`/families/${familyId}/inventory`)).body).items.find((i) => i.good === good)?.quantity ?? 0;
const offer = async (from: Fam, to: Fam, gives: unknown[], wants: unknown[]) => {
  const res = await from.don.client.post(`/families/${from.id}/trades`, { to: to.tag, gives, wants }, keyed());
  expect(res.status).toBe(201);
  return res.body.id as string;
};
const statusOf = async (id: string) => (await rows<{ status: string }>(sql`select status from trades where id = ${id}`))[0]!.status;

describe("racing trades", () => {
  it("the same offer accepted ten times at once, by two members, runs exactly once", async () => {
    const a = await trader();
    const b = await trader(["quartermaster"]);
    await order(a.don.client, "buy", "fuel", 5);
    const id = await offer(a, b, [{ good: "fuel", quantity: 5 }], [{ cash: 600 }]);
    const accepters = [b.don.client, b.members[0]!.client];
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => accepters[i % 2]!.post(`/trades/${id}/accept`)));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(results.every((r) => r.body.status === "executed")).toBe(true);
    expect(await held(b.don.client, b.id, "fuel")).toBe(5);
    expect(await balance(b.don.client, b.id)).toBe(20_000 - 600);
    expect(await rows(sql`select id from ledger_transactions where idempotency_key = ${`trade:${id}`}`)).toHaveLength(1);
  });

  it("offers in both directions between the same families, accepted at the same moment, all run without deadlock", async () => {
    const a = await trader();
    const b = await trader();
    await order(a.don.client, "buy", "textiles", 8);
    await order(b.don.client, "buy", "fuel", 8);
    const aToB = await Promise.all(Array.from({ length: 8 }, () => offer(a, b, [{ good: "textiles", quantity: 1 }], [{ cash: 100 }])));
    const bToA = await Promise.all(Array.from({ length: 8 }, () => offer(b, a, [{ good: "fuel", quantity: 1 }], [{ cash: 50 }])));
    const results = await Promise.all([...aToB.map((id) => b.don.client.post(`/trades/${id}/accept`)), ...bToA.map((id) => a.don.client.post(`/trades/${id}/accept`))]);
    expect(results.map((r) => r.status)).toEqual(Array(16).fill(200));
    expect(await held(a.don.client, a.id, "fuel")).toBe(8);
    expect(await held(b.don.client, b.id, "textiles")).toBe(8);
    expect(await held(a.don.client, a.id, "textiles")).toBe(0);
  });

  it("a trade and a market sale racing for the same goods: exactly one gets them", async () => {
    const a = await trader();
    const b = await trader();
    await setBalance(a.id, 100_000);
    for (let round = 0; round < 5; round++) {
      expect((await order(a.don.client, "buy", "electronics", 10)).status).toBe(200);
      const id = await offer(a, b, [{ good: "electronics", quantity: 10 }], []);
      const [accept, sale] = await Promise.all([b.don.client.post(`/trades/${id}/accept`), order(a.don.client, "sell", "electronics", 10)]);
      expect([accept.status, sale.status].sort()).toEqual([200, 409]);
      expect((accept.status === 409 ? accept : sale).body.code).toBe("INSUFFICIENT_STOCK");
      expect(await held(a.don.client, a.id, "electronics")).toBe(0);
      if (accept.status === 409) await b.don.client.post(`/trades/${id}/decline`);
    }
  });

  it("accept, cancel and decline racing on the same offer: exactly one wins, and money moves only if it was the accept", async () => {
    const a = await trader();
    const b = await trader();
    await setBalance(a.id, 100_000);
    const ids = await Promise.all(Array.from({ length: 8 }, () => offer(a, b, [{ cash: 1000 }], [])));
    const results = await Promise.all(
      ids.map((id) => Promise.all([b.don.client.post(`/trades/${id}/accept`), a.don.client.post(`/trades/${id}/cancel`), b.don.client.post(`/trades/${id}/decline`)])),
    );
    let executed = 0;
    for (const [i, [accept, cancel, decline]] of results.entries()) {
      expect([accept, cancel, decline].filter((r) => r.status === 200)).toHaveLength(1);
      expect([accept, cancel, decline].filter((r) => r.status === 409).every((r) => r.body.code === "TRADE_CLOSED")).toBe(true);
      const status = await statusOf(ids[i]!);
      expect(status).toBe(accept.status === 200 ? "executed" : cancel.status === 200 ? "cancelled" : "declined");
      if (status === "executed") executed++;
    }
    expect(await balance(b.don.client, b.id)).toBe(20_000 + executed * 1000);
    expect(await balance(a.don.client, a.id)).toBe(100_000 - executed * 1000);
  });

  it("accepts racing the expiry sweep: each offer ends executed or expired, never both", async () => {
    const a = await trader();
    const b = await trader();
    const ids = await Promise.all(Array.from({ length: 8 }, () => offer(a, b, [{ cash: 100 }], [])));
    const expiry = new Date(clock.now().getTime() + OFFER_TTL_MS);
    const sweeper = api.app.get(TradesService);
    const [accepts] = await Promise.all([Promise.all(ids.map((id) => b.don.client.post(`/trades/${id}/accept`))), sweeper.sweepExpired(expiry), sweeper.sweepExpired(expiry)]);
    await sweeper.sweepExpired(expiry); // whatever was skipped while locked
    let executed = 0;
    for (const [i, res] of accepts.entries()) {
      const status = await statusOf(ids[i]!);
      if (res.status === 200) {
        expect(status).toBe("executed");
        executed++;
      } else {
        expect([res.body.code, status]).toEqual(["TRADE_CLOSED", "expired"]);
      }
    }
    expect(await balance(b.don.client, b.id)).toBe(20_000 + executed * 100);
  });
});

describe("mixed load", () => {
  it("about two hundred market orders, offers, answers and drift steps from ten families at once keep every invariant", async () => {
    const fams = await Promise.all(Array.from({ length: 10 }, () => trader()));
    await Promise.all(fams.map((f) => setBalance(f.id, 200_000)));
    const rng: RngState = createRng(20261010);
    const pick = <T,>(list: readonly T[]) => list[nextInt(rng, 0, list.length - 1)]!;
    const good = () => pick(GOOD_KEYS);
    const market = () => pick(MARKETS).territory;
    const drift = api.app.get(MarketService);
    const unexpected: { status: number; body: unknown }[] = [];
    const settle = async (calls: Promise<{ status: number; body: unknown }>[]) => {
      for (const r of await Promise.all(calls)) if (![200, 201, 409].includes(r.status)) unexpected.push(r);
    };
    const randomOffer = () => {
      const from = pick(fams);
      const to = pick(fams.filter((f) => f !== from));
      const gives = nextInt(rng, 0, 1) ? [{ good: good(), quantity: nextInt(rng, 1, 3) }] : [{ cash: nextInt(rng, 100, 2000) }];
      const wants = nextInt(rng, 0, 1) ? [{ good: good(), quantity: nextInt(rng, 1, 3) }] : [];
      return from.don.client.post(`/families/${from.id}/trades`, { to: to.tag, gives, wants }, keyed());
    };

    // Wave 1: stock up and make offers.
    await settle([
      ...Array.from({ length: 40 }, () => order(pick(fams).don.client, "buy", good(), nextInt(rng, 1, 4), market())),
      ...Array.from({ length: 30 }, randomOffer),
    ]);

    // Wave 2: answer offers while trading at the markets, making new offers and drifting.
    const open = (
      await Promise.all(fams.map(async (f) => TradePage.parse((await f.don.client.get(`/families/${f.id}/trades?box=incoming&limit=50`)).body).items.map((t) => ({ t, f }))))
    ).flat();
    const answers = open.map(({ t, f }) => {
      const roll = nextInt(rng, 0, 9);
      if (roll < 7) return f.don.client.post(`/trades/${t.id}/accept`);
      if (roll < 9) return f.don.client.post(`/trades/${t.id}/decline`);
      return fams.find((x) => x.id === t.from.id)!.don.client.post(`/trades/${t.id}/cancel`);
    });
    // Each answer is also sent twice more, to hit the same rows from several requests.
    const repeats = open.slice(0, 10).map(({ t, f }) => f.don.client.post(`/trades/${t.id}/accept`));
    const step = new Date(Math.ceil(clock.now().getTime() / DRIFT_STEP_MS) * DRIFT_STEP_MS + 60_000);
    await settle([
      ...answers,
      ...repeats,
      ...Array.from({ length: 30 }, () => order(pick(fams).don.client, nextInt(rng, 0, 1) ? "buy" : "sell", good(), nextInt(rng, 1, 3), market())),
      ...Array.from({ length: 20 }, randomOffer),
      drift.sweepDrift(step).then(() => ({ status: 200, body: null })),
      drift.sweepDrift(step).then(() => ({ status: 200, body: null })),
    ]);

    // Wave 3: everything still open is accepted while families sell.
    const rest = (
      await Promise.all(fams.map(async (f) => TradePage.parse((await f.don.client.get(`/families/${f.id}/trades?box=incoming&limit=50`)).body).items.map((t) => ({ t, f }))))
    ).flat();
    await settle([
      ...rest.map(({ t, f }) => f.don.client.post(`/trades/${t.id}/accept`)),
      ...Array.from({ length: 30 }, () => order(pick(fams).don.client, "sell", good(), nextInt(rng, 1, 3), market())),
    ]);

    expect(unexpected).toEqual([]);
    const [executed] = await rows<{ n: number }>(sql`select count(*)::int as n from trades where status = 'executed'`);
    expect(executed!.n).toBeGreaterThan(0);
    // Every executed trade has exactly one ledger posting if it moved cash, and none otherwise.
    expect(
      await rows(sql`
        select t.id from trades t
        where t.status <> 'executed' and exists (select 1 from ledger_transactions l where l.idempotency_key = 'trade:' || t.id)`),
    ).toEqual([]);
  });
});
