import { CITY, EVENTS, MARKETS, type EventType } from "@kots/content";
import { DRIFT_STEP_MS, planEvent, rollEvent } from "@kots/rules";
import { ActivityPage, Henchman, NotificationPage, WorldEventList } from "@kots/shared";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "../src/common/uuid";
import { worldEvents } from "../src/db/schema";
import { seedMap, seedMarkets } from "../src/db/seed";
import { eventRow, EventsService } from "../src/modules/events/events.service";
import { MarketService } from "../src/modules/market/market.service";
import { economyHelpers } from "./economy-helpers";
import { newPlayer, resetTestDatabase, startApi, TestClock, type Client, type TestApi } from "./helpers";
import { connect } from "./socket-helpers";

let api: TestApi;
const clock = new TestClock();
const HOUR = 3600_000;

beforeAll(async () => {
  await resetTestDatabase();
  api = await startApi(undefined, clock);
  await seedMap(api.db);
  await seedMarkets(api.db);
});

// Every test starts from a neutral map, no guards and no events.
beforeEach(async () => {
  clock.set(Date.now());
  await api.db.execute(sql`delete from world_events`);
  await api.db.execute(sql`update henchmen set assigned_territory_id = null where assigned_territory_id is not null`);
  await api.db.execute(sql`update territories set owner_family_id = null, owned_since = null, upkeep_paid_until = null, state = 'stable', last_evaluated_at = null`);
});

afterEach(async () => {
  await expectLedgerConsistent();
});

afterAll(async () => {
  await api?.close();
});

const { rows, family, balance, expectLedgerConsistent } = economyHelpers(() => api, "Event");
type Fam = Awaited<ReturnType<typeof family>>;

const service = () => api.app.get(EventsService);
const now = () => clock.now();
/** Schedules an event to start now, as `npm run event:trigger` does. */
async function trigger(type: EventType, scopeId?: string, seed = 1): Promise<string> {
  const [row] = await api.db
    .insert(worldEvents)
    .values(eventRow(planEvent(type, seed, scopeId), seed, now(), `test:${uuidv7()}`))
    .returning({ id: worldEvents.id });
  return row!.id;
}
const claim = async (f: Fam, slug: string) => {
  const res = await f.don.client.post(`/territories/${slug}/claim`);
  expect([slug, res.status, res.body?.code]).toEqual([slug, 200, undefined]);
};
const activity = async (f: Fam, type: string) => ActivityPage.parse((await f.don.client.get(`/families/${f.id}/activity`)).body).items.filter((a) => a.type === type);
const notes = async (c: Client, type: string) =>
  NotificationPage.parse((await c.get("/notifications")).body)
    .items.filter((n) => n.type === type)
    .map((n) => n.body);
const news = async (c: Client) => WorldEventList.parse((await c.get("/events")).body);
const stock = async (market: string, good: string) =>
  (
    await rows<{ stock: number }>(
      sql`select s.stock from npc_market_state s join territories t on t.id = s.territory_id where t.slug = ${market} and s.good = ${good}`,
    )
  )[0]!.stock;
const district = (slug: string) => CITY.districts.get(slug)!;
const sameDistrictBorder = (slug: string) => CITY.territories.get(slug)!.borders.find((b) => CITY.territories.get(b)!.district === CITY.territories.get(slug)!.district)!;
const income = (slug: string) => CITY.territories.get(slug)!.baseIncome;

describe("a street festival", () => {
  it("pays each family holding territory in the district once, a day's income per territory, from the events account", async () => {
    const [a, b, c] = [await family(), await family(), await family()];
    const [a1, b1] = district("apapa").territories;
    const a2 = sameDistrictBorder(a1!);
    expect(a2).not.toBe(b1);
    await claim(a, a1!);
    await claim(a, a2);
    await claim(b, b1!);
    await claim(c, district("lagos-island").territories[0]!);
    const before = await Promise.all([a, b, c].map((f) => balance(f.don.client, f.id)));

    const id = await trigger("street_festival", "apapa");
    // Two overlapping sweeps: the event starts, and pays, once.
    const results = await Promise.all([service().sweep(now()), service().sweep(now())]);
    expect(results.reduce((s, r) => s + r.started, 0)).toBe(1);
    await service().sweep(now());

    const after = await Promise.all([a, b, c].map((f) => balance(f.don.client, f.id)));
    expect(after[0]! - before[0]!).toBe(income(a1!) + income(a2));
    expect(after[1]! - before[1]!).toBe(income(b1!));
    expect(after[2]).toBe(before[2]);

    expect((await activity(a, "event.festival")).map((e) => e.payload)).toEqual([{ district: "Apapa", amount: income(a1!) + income(a2), territories: 2 }]);
    expect(await activity(c, "event.festival")).toEqual([]);
    expect(await notes(b.don.client, "event.festival")).toEqual([`A street festival in Apapa paid your family ₦${income(b1!).toLocaleString("en-NG")}.`]);
    const posted = await rows<{ key: string }>(sql`select idempotency_key as key from ledger_transactions where ref_id = ${id}`);
    expect(posted.map((p) => p.key).sort()).toEqual([`event:${id}:${a.id}`, `event:${id}:${b.id}`].sort());

    const [story] = await news(c.don.client);
    expect(story).toMatchObject({ id, type: "street_festival", scope: "district", scopeId: "apapa", state: "active", headline: "Street festival in Apapa" });
    expect(story!.body).toMatch(/^Area Chairman Dele Martins declared a celebration\./);
  });

  it("pays no one when nobody holds territory there", async () => {
    const id = await trigger("street_festival", "lagos-island");
    expect(await service().sweep(now())).toEqual({ started: 1, ended: 0 });
    expect(await rows(sql`select 1 from ledger_transactions where ref_id = ${id}`)).toHaveLength(0);
  });
});

describe("a police sweep", () => {
  it("lowers the morale of guards in the district, once, and tells their families", async () => {
    const [a, b] = [await family(["associate"]), await family()];
    const [a1] = district("yaba-ebute-metta").territories;
    const b1 = district("lagos-island").territories[1]!;
    await claim(a, a1!);
    await claim(b, b1);
    const hire = async (f: Fam, slot: number) => Henchman.parse((await f.don.client.post(`/families/${f.id}/recruits`, { slot })).body);
    const [guard, idle, other] = [await hire(a, 0), await hire(a, 1), await hire(b, 0)];
    for (const [f, h, slug] of [[a, guard, a1!], [b, other, b1]] as const) expect((await f.don.client.patch(`/henchmen/${h.id}`, { territory: slug })).status).toBe(200);
    const morale = async () => new Map((await rows<{ id: string; morale: number }>(sql`select id, morale from henchmen`)).map((r) => [r.id, r.morale]));
    const before = await morale();

    await trigger("police_sweep", "yaba-ebute-metta", 5);
    const loss = planEvent("police_sweep", 5, "yaba-ebute-metta");
    await Promise.all([service().sweep(now()), service().sweep(now())]);
    await service().sweep(now());

    const after = await morale();
    expect(after.get(guard.id)).toBe(Math.max(0, before.get(guard.id)! - (loss.type === "police_sweep" ? loss.moraleLoss : 0)));
    expect(after.get(idle.id)).toBe(before.get(idle.id));
    expect(after.get(other.id)).toBe(before.get(other.id));
    expect((await activity(a, "event.police_sweep")).map((e) => e.payload)).toEqual([{ district: "Yaba & Ebute Metta", henchmen: 1, morale: (loss as { moraleLoss: number }).moraleLoss }]);
    expect(await activity(b, "event.police_sweep")).toEqual([]);
    // Everyone in the family hears about it, including the associate.
    expect(await notes(a.members[0]!.client, "event.police_sweep")).toHaveLength(1);
  });
});

describe("market events", () => {
  it("port congestion cuts one good's stock at one market, and drift brings it back", async () => {
    const plan = planEvent("port_congestion", 9, "balogun");
    if (plan.type !== "port_congestion") throw new Error("unexpected plan");
    const before = { here: await stock("balogun", plan.good), there: await stock("apapa-wharf", plan.good), fuel: await stock("balogun", "fuel") };
    await trigger("port_congestion", "balogun", 9);
    await service().sweep(now());
    const cut = await stock("balogun", plan.good);
    expect(cut).toBe(Math.floor((before.here * plan.stockLeftPct) / 100));
    expect(await stock("apapa-wharf", plan.good)).toBe(before.there);
    expect(await stock("balogun", "fuel")).toBe(before.fuel);

    await api.app.get(MarketService).sweepDrift(new Date(now().getTime() + 4 * DRIFT_STEP_MS));
    expect(await stock("balogun", plan.good)).toBeGreaterThan(cut);
  });

  it("fuel scarcity cuts fuel at every market", async () => {
    const plan = planEvent("fuel_scarcity", 3);
    if (plan.type !== "fuel_scarcity") throw new Error("unexpected plan");
    const before = await Promise.all(MARKETS.map((m) => stock(m.territory, "fuel")));
    await trigger("fuel_scarcity", undefined, 3);
    await service().sweep(now());
    expect(await Promise.all(MARKETS.map((m) => stock(m.territory, "fuel")))).toEqual(before.map((s) => Math.floor((s * plan.stockLeftPct) / 100)));
  });
});

describe("the event lifecycle", () => {
  it("an event isn't started before its time, ends when its time is up, and leaves the news after a day", async () => {
    const { client } = await newPlayer(api.base);
    const seed = 2;
    const [row] = await api.db
      .insert(worldEvents)
      .values(eventRow(planEvent("fuel_scarcity", seed), seed, new Date(now().getTime() + HOUR), `test:${uuidv7()}`))
      .returning();
    expect(await service().sweep(now())).toEqual({ started: 0, ended: 0 });
    expect(await news(client)).toEqual([]);

    clock.advance(HOUR);
    expect(await service().sweep(now())).toEqual({ started: 1, ended: 0 });
    expect((await news(client)).map((e) => e.state)).toEqual(["active"]);

    clock.set(row!.expiresAt);
    expect(await service().sweep(now())).toEqual({ started: 0, ended: 1 });
    expect(await service().sweep(now())).toEqual({ started: 0, ended: 0 });
    expect((await news(client)).map((e) => e.state)).toEqual(["expired"]);

    clock.advance(EVENTS.newsHours * HOUR);
    expect(await news(client)).toEqual([]);
  });

  it("tells every connected browser when an event starts and ends", async () => {
    const { client } = await newPlayer(api.base);
    const live = await connect(api.base, client);
    await trigger("street_festival", "apapa");
    await service().sweep(now());
    await live.next("events.changed");
    live.close();
  });

  it("the news needs a session", async () => {
    expect((await fetch(`${api.base}/api/events`)).status).toBe(401);
  });
});

describe("the hourly roll", () => {
  const rolling = (at: number, past: { type: EventType; startsAtMs: number }[] = [], active = 0, from = 1) => {
    for (let s = from; ; s++) if (rollEvent(s, at, past, active)) return s;
  };

  it("creates at most one event per hour, however often it runs", async () => {
    const at = now();
    const first = rolling(at.getTime());
    const id = await service().generate(at, first);
    expect(id).not.toBeNull();
    const [row] = await rows<{ type: EventType; starts_at: Date }>(sql`select type, starts_at from world_events where id = ${id}`);
    const second = rolling(at.getTime(), [{ type: row!.type, startsAtMs: at.getTime() }], 1, first + 1);
    expect(await service().generate(at, second)).toBeNull();
    expect(await rows(sql`select 1 from world_events`)).toHaveLength(1);
  });

  it("creates nothing while the most events are current", async () => {
    for (let i = 0; i < EVENTS.maxActive; i++) await trigger("fuel_scarcity", undefined, i);
    const at = new Date(now().getTime() + HOUR);
    expect(await service().generate(at, rolling(at.getTime()))).toBeNull();
  });

  it("respects each type's cooldown", async () => {
    await trigger("street_festival", "apapa");
    await service().sweep(now());
    // Hours well inside the festival's cooldown; seeds that start an event pick another type.
    for (let s = 1, hour = 1; hour <= 5; s++) {
      const at = now().getTime() + hour * HOUR;
      if (!rollEvent(s, at, [], 0)) continue;
      await api.db.execute(sql`delete from world_events where type <> 'street_festival'`);
      const id = await service().generate(new Date(at), s);
      const [row] = await rows<{ type: string }>(sql`select type from world_events where id = ${id}`);
      expect(row!.type).not.toBe("street_festival");
      hour++;
    }
  });
});
