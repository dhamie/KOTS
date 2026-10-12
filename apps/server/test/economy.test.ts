import { ECONOMY } from "@kots/content";
import { GRACE_MS, UPKEEP_PERIOD_MS } from "@kots/rules";
import { FamilyHoldings, LedgerPage, TerritoryDetail } from "@kots/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedMap } from "../src/db/seed";
import { FamiliesService } from "../src/modules/families/families.service";
import { TerritoriesService } from "../src/modules/territories/territories.service";
import { economyHelpers } from "./economy-helpers";
import { newPlayer, resetTestDatabase, startApi, TestClock, type TestApi } from "./helpers";

let api: TestApi;
const clock = new TestClock();
const HOUR = 3600_000;

beforeAll(async () => {
  await resetTestDatabase();
  api = await startApi(undefined, clock);
  await seedMap(api.db);
});

afterAll(async () => {
  await api?.close();
});

const { rows, family, balance, adjust, setBalance, expectLedgerConsistent } = economyHelpers(() => api, "Economy");
const sweep = (at: Date = clock.now()) => api.app.get(TerritoriesService).sweepUpkeep(at);

const territoryRow = async (slug: string) => {
  const [row] = await rows<{ owner_family_id: string | null; state: string; upkeep_paid_until: string | null }>(
    sql`select owner_family_id, state, upkeep_paid_until from territories where slug = ${slug}`,
  );
  return { ...row!, upkeep_paid_until: row!.upkeep_paid_until === null ? null : new Date(row!.upkeep_paid_until) };
};

describe("treasury", () => {
  it("a new family starts with the grant, recorded in the ledger", async () => {
    const f = await family();
    expect(await balance(f.don.client, f.id)).toBe(ECONOMY.startingGrant);
    const page = LedgerPage.parse((await f.don.client.get(`/families/${f.id}/treasury/entries`)).body);
    expect(page.items).toEqual([
      expect.objectContaining({ kind: "grant", reason: "starting_grant", amount: ECONOMY.startingGrant, balanceAfter: ECONOMY.startingGrant }),
    ]);
    await expectLedgerConsistent();
  });

  it("every member sees the balance; only treasury roles see the history; outsiders see neither", async () => {
    const f = await family(["associate", "quartermaster"]);
    const [associate, quartermaster] = f.members;
    expect(await balance(associate!.client, f.id)).toBe(ECONOMY.startingGrant);
    expect((await associate!.client.get(`/families/${f.id}/treasury/entries`)).status).toBe(403);
    expect((await quartermaster!.client.get(`/families/${f.id}/treasury/entries`)).status).toBe(200);
    const outsider = await newPlayer(api.base);
    expect((await outsider.client.get(`/families/${f.id}/treasury`)).status).toBe(403);
    expect((await outsider.client.get(`/families/${f.id}/territories`)).status).toBe(403);
  });
});

describe("claiming territory", () => {
  it("first claim is free of fees; later claims must border a holding (bridges count) and cost more", async () => {
    const f = await family();
    const c = f.don.client;

    const first = await c.post("/territories/tejuosho/claim");
    expect(first.status).toBe(200);
    expect(TerritoryDetail.parse(first.body)).toMatchObject({ owner: { id: f.id }, state: "stable", holding: { upkeep: 400, income: 900 }, claim: null });
    expect(await balance(c, f.id)).toBe(20_000 - 400);

    const far = await c.post("/territories/marina/claim");
    expect(far.status).toBe(409);
    expect(far.body.code).toBe("NOT_ADJACENT");
    expect(TerritoryDetail.parse((await c.get("/territories/marina")).body).claim!.refusal).toBe("not_adjacent");

    // Akoka borders Tejuosho: fee 5 × 200, first upkeep 200 × 1.1.
    expect(TerritoryDetail.parse((await c.get("/territories/akoka")).body).claim).toEqual({ fee: 1000, firstUpkeep: 220, total: 1220, refusal: null });
    expect((await c.post("/territories/akoka/claim")).status).toBe(200);
    // Obalende is across Third Mainland Bridge from Akoka: fee 5 × 360, first upkeep 360 × 1.2.
    expect((await c.post("/territories/obalende/claim")).status).toBe(200);
    expect(await balance(c, f.id)).toBe(20_000 - 400 - 1220 - 2232);

    const holdings = FamilyHoldings.parse((await c.get(`/families/${f.id}/territories`)).body);
    expect(holdings.territories.map((t) => [t.slug, t.upkeep])).toEqual([
      ["akoka", 240],
      ["obalende", 432],
      ["tejuosho", 480],
    ]);
    expect(holdings).toMatchObject({ income: 900 + 500 + 800, upkeep: 240 + 432 + 480 });

    const page = LedgerPage.parse((await c.get(`/families/${f.id}/treasury/entries?limit=1`)).body);
    expect(page.items[0]).toMatchObject({ kind: "territory_claim", amount: -2232, balanceAfter: 20_000 - 400 - 1220 - 2232, ref: { type: "territory", id: "obalende" } });
    expect(page.nextCursor).not.toBeNull();

    const history = await rows(sql`select cause from territory_ownership_history h join territories t on t.id = h.territory_id where t.slug = 'obalende'`);
    expect(history).toEqual([{ cause: "claim" }]);
    const map = (await c.get("/map/territories?district=lagos-island")).body;
    expect(map.territories.find((t: { slug: string }) => t.slug === "obalende").owner).toMatchObject({ id: f.id });
    await expectLedgerConsistent();
  });

  it("refuses territory another family holds, and the viewer sees why", async () => {
    const a = await family();
    const b = await family();
    expect((await a.don.client.post("/territories/kirikiri/claim")).status).toBe(200);
    const res = await b.don.client.post("/territories/kirikiri/claim");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("TERRITORY_OWNED");
    const seen = TerritoryDetail.parse((await b.don.client.get("/territories/kirikiri")).body);
    expect(seen).toMatchObject({ owner: { id: a.id }, holding: null, claim: { refusal: "owned" } });
    expect((await a.don.client.post("/territories/kirikiri/claim")).body.code).toBe("TERRITORY_OWNED");
  });

  it("checks roles: capo can claim but not abandon; associate can do neither; no family, no claim", async () => {
    const f = await family(["capo", "associate"]);
    const [capo, associate] = f.members;
    expect(TerritoryDetail.parse((await associate!.client.get("/territories/sabo")).body).claim!.refusal).toBe("missing_permission");
    expect((await associate!.client.post("/territories/sabo/claim")).status).toBe(403);
    expect((await capo!.client.post("/territories/sabo/claim")).status).toBe(200);
    expect((await capo!.client.post("/territories/sabo/abandon")).status).toBe(403);
    expect((await associate!.client.post("/territories/sabo/abandon")).status).toBe(403);

    const loner = await newPlayer(api.base);
    expect(TerritoryDetail.parse((await loner.client.get("/territories/otto")).body).claim!.refusal).toBe("not_in_family");
    expect((await loner.client.post("/territories/otto/claim")).status).toBe(403);
  });

  it("refuses a claim the treasury can't cover, and changes nothing", async () => {
    const f = await family();
    await setBalance(f.id, 100);
    expect(TerritoryDetail.parse((await f.don.client.get("/territories/oyingbo")).body).claim!.refusal).toBe("insufficient_funds");
    const res = await f.don.client.post("/territories/oyingbo/claim");
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INSUFFICIENT_FUNDS");
    expect(res.body.message).toMatch(/₦380/);
    expect(await balance(f.don.client, f.id)).toBe(100);
    expect((await territoryRow("oyingbo")).owner_family_id).toBeNull();
  });

  it("unknown or malformed territory is a 404", async () => {
    const f = await family();
    expect((await f.don.client.get("/territories/atlantis")).status).toBe(404);
    expect((await f.don.client.post("/territories/atlantis/claim")).status).toBe(404);
    expect((await f.don.client.get("/territories/DROP%20TABLE")).status).toBe(404);
  });

  it("two families claiming the same territory at once: exactly one wins, and only it pays", async () => {
    const a = await family();
    const b = await family();
    const results = await Promise.all([a.don.client.post("/territories/balogun/claim"), b.don.client.post("/territories/balogun/claim")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = results[0]!.status === 200 ? a : b;
    const loser = winner === a ? b : a;
    expect((await territoryRow("balogun")).owner_family_id).toBe(winner.id);
    expect(await balance(winner.don.client, winner.id)).toBe(20_000 - 500);
    expect(await balance(loser.don.client, loser.id)).toBe(20_000);
    await expectLedgerConsistent();
  });

  it("one family racing two claims it can only afford one of: one succeeds, the treasury never goes negative", async () => {
    const f = await family(["underboss"]);
    expect((await f.don.client.post("/territories/ajegunle/claim")).status).toBe(200);
    // Apapa GRA costs 2135 and Liverpool Road 1952 as a second holding; 2200 covers either, not both.
    await setBalance(f.id, 2200);
    const results = await Promise.all([f.don.client.post("/territories/apapa-gra/claim"), f.members[0]!.client.post("/territories/liverpool-road/claim")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe("INSUFFICIENT_FUNDS");
    expect(await balance(f.don.client, f.id)).toBeGreaterThanOrEqual(0);
    await expectLedgerConsistent();
  });
});

describe("abandoning and disbanding", () => {
  it("abandoning returns the territory to neutral without a refund", async () => {
    const f = await family();
    expect((await f.don.client.post("/territories/alagomeji/claim")).status).toBe(200);
    const before = await balance(f.don.client, f.id);
    expect((await f.don.client.post("/territories/alagomeji/abandon")).status).toBe(204);
    expect((await territoryRow("alagomeji")).owner_family_id).toBeNull();
    expect(await balance(f.don.client, f.id)).toBe(before);
    const other = await family();
    expect((await other.don.client.post("/territories/alagomeji/abandon")).status).toBe(403);
    const history = await rows(sql`select cause from territory_ownership_history h join territories t on t.id = h.territory_id where t.slug = 'alagomeji' order by h.created_at`);
    expect(history).toEqual([{ cause: "claim" }, { cause: "abandon" }]);
  });

  it("disbanding releases every territory and empties the treasury into the system", async () => {
    const f = await family();
    expect((await f.don.client.post("/territories/broad-street/claim")).status).toBe(200);
    expect((await f.don.client.delete(`/families/${f.id}`)).status).toBe(204);
    expect((await territoryRow("broad-street")).owner_family_id).toBeNull();
    const [acct] = await rows<{ balance: string }>(sql`select balance from currency_accounts where family_id = ${f.id}`);
    expect(Number(acct!.balance)).toBe(0);
    const [moved] = await rows<{ amount: string }>(
      sql`select e.amount from ledger_entries e join currency_accounts a on a.id = e.account_id where a.code = 'disbanded' order by e.id desc limit 1`,
    );
    expect(Number(moved!.amount)).toBe(20_000 - 550);
    await expectLedgerConsistent();
  });
});

describe("upkeep over time", () => {
  /** Puts a family on one territory that earns nothing, so upkeep can only come out of the treasury. */
  async function unprofitable(slug: string, treasury: number) {
    const f = await family();
    expect((await f.don.client.post(`/territories/${slug}/claim`)).status).toBe(200);
    await api.db.execute(sql`update territories set base_income = 0 where slug = ${slug}`);
    await setBalance(f.id, treasury);
    const paidUntil = new Date(TerritoryDetail.parse((await f.don.client.get(`/territories/${slug}`)).body).holding!.paidUntil);
    return { ...f, paidUntil };
  }
  const restoreIncome = (slug: string, income: number) => api.db.execute(sql`update territories set base_income = ${income} where slug = ${slug}`);

  it("each period credits income and charges upkeep once, however often the sweep runs", async () => {
    const f = await family();
    expect((await f.don.client.post("/territories/iddo/claim")).status).toBe(200);
    const start = await balance(f.don.client, f.id);
    const paidUntil = new Date(TerritoryDetail.parse((await f.don.client.get("/territories/iddo")).body).holding!.paidUntil);
    expect(paidUntil.getTime() - clock.now().getTime()).toBe(UPKEEP_PERIOD_MS);

    expect((await sweep(new Date(paidUntil.getTime() - 1))).paid).toBe(0);
    clock.set(paidUntil.getTime() + 60_000);
    await Promise.all([sweep(), sweep(), sweep()]);
    await sweep();
    expect(await balance(f.don.client, f.id)).toBe(start + 750 - 330);
    expect((await territoryRow("iddo")).upkeep_paid_until!.getTime()).toBe(paidUntil.getTime() + UPKEEP_PERIOD_MS);
    const [upkeeps] = await rows<{ n: string }>(sql`select count(*) as n from ledger_transactions where kind = 'upkeep' and ref_id = 'iddo'`);
    expect(Number(upkeeps!.n)).toBe(1);
    await expectLedgerConsistent();
  });

  it("an unpaid territory is neglected through the grace period, then returns to neutral", async () => {
    const g = await unprofitable("otto", 100);

    clock.set(g.paidUntil.getTime() + 60_000);
    expect((await sweep()).neglected).toBeGreaterThanOrEqual(1);
    expect(TerritoryDetail.parse((await g.don.client.get("/territories/otto")).body).state).toBe("neglected");
    expect(await balance(g.don.client, g.id)).toBe(100);

    clock.set(g.paidUntil.getTime() + GRACE_MS - 60_000);
    await sweep();
    expect((await territoryRow("otto")).owner_family_id).toBe(g.id);

    clock.set(g.paidUntil.getTime() + GRACE_MS);
    await sweep();
    expect((await territoryRow("otto")).owner_family_id).toBeNull();
    const activity = (await g.don.client.get(`/families/${g.id}/activity`)).body.items.map((a: { type: string }) => a.type);
    expect(activity.filter((t: string) => t === "territory.neglected")).toHaveLength(1);
    expect(activity).toContain("territory.lost");
    const history = await rows(sql`select cause from territory_ownership_history h join territories t on t.id = h.territory_id where t.slug = 'otto' order by h.created_at`);
    expect(history.at(-1)).toEqual({ cause: "lapsed" });
    await restoreIncome("otto", 700);
    await expectLedgerConsistent();
  });

  it("a neglected territory recovers when the treasury can pay again, keeping its schedule", async () => {
    const f = await unprofitable("isale-eko", 0);
    clock.set(f.paidUntil.getTime() + HOUR);
    await sweep();
    expect((await territoryRow("isale-eko")).state).toBe("neglected");

    await adjust(f.id, 1000);
    clock.advance(HOUR);
    await sweep();
    const row = await territoryRow("isale-eko");
    expect(row).toMatchObject({ owner_family_id: f.id, state: "stable" });
    expect(row.upkeep_paid_until!.getTime()).toBe(f.paidUntil.getTime() + UPKEEP_PERIOD_MS);
    expect(await balance(f.don.client, f.id)).toBe(1000 - 250);
    await restoreIncome("isale-eko", 600);
  });

  it("after a long worker outage, every missed period is settled in order and nothing is lost", async () => {
    const f = await family();
    expect((await f.don.client.post("/territories/marina/claim")).status).toBe(200);
    const start = await balance(f.don.client, f.id);
    const paidUntil = (await territoryRow("marina")).upkeep_paid_until!;
    clock.set(paidUntil.getTime() + 3 * UPKEEP_PERIOD_MS - 60_000);
    await sweep();
    expect(await balance(f.don.client, f.id)).toBe(start + 3 * (900 - 420));
    expect((await territoryRow("marina")).upkeep_paid_until!.getTime()).toBe(paidUntil.getTime() + 3 * UPKEEP_PERIOD_MS);
    await expectLedgerConsistent();
  });
});

describe("succession", () => {
  const DAY = 24 * HOUR;
  const setActive = (playerId: string, at: Date) => api.db.execute(sql`update players set last_active_at = ${at} where id = ${playerId}`);
  const roleOf = async (playerId: string) => (await rows<{ role: string }>(sql`select role from family_memberships where player_id = ${playerId}`))[0]?.role;
  const succeed = () => api.app.get(FamiliesService).succeedInactiveDons(clock.now());

  it("an inactive Don is replaced by the most senior active member, who becomes Don", async () => {
    const f = await family(["capo", "underboss"]);
    const [capo, underboss] = f.members;
    const now = clock.now().getTime();
    await setActive(f.don.id, new Date(now - 8 * DAY));
    await setActive(underboss!.id, new Date(now - DAY));
    await setActive(capo!.id, new Date(now - DAY));
    expect(await succeed()).toBeGreaterThanOrEqual(1);
    expect(await roleOf(underboss!.id)).toBe("don");
    expect(await roleOf(f.don.id)).toBe("underboss");
    const activity = (await underboss!.client.get(`/families/${f.id}/activity`)).body.items;
    expect(activity[0]).toMatchObject({ type: "leadership.succeeded", actor: null, payload: { handle: underboss!.handle, formerDon: f.don.handle } });
  });

  it("keeps a Don active within the window, and keeps an inactive one when nobody else is active", async () => {
    const active = await family(["underboss"]);
    const lonely = await family(["underboss"]);
    const now = clock.now().getTime();
    await setActive(active.don.id, new Date(now - 6 * DAY));
    await setActive(lonely.don.id, new Date(now - 30 * DAY));
    await setActive(lonely.members[0]!.id, new Date(now - 10 * DAY));
    await succeed();
    expect(await roleOf(active.don.id)).toBe("don");
    expect(await roleOf(lonely.don.id)).toBe("don");
  });

  it("logging in counts as activity", async () => {
    const p = await newPlayer(api.base);
    await setActive(p.id, new Date(Date.now() - 30 * DAY));
    await p.client.post("/auth/logout");
    await p.client.post("/auth/login", { email: `${p.handle}@example.test`, password: "correct horse battery" });
    const [row] = await rows<{ last_active_at: string }>(sql`select last_active_at from players where id = ${p.id}`);
    expect(Date.now() - new Date(row!.last_active_at).getTime()).toBeLessThan(60_000);
  });
});

describe("indexes", () => {
  it("the upkeep sweep and the treasury history can use their indexes", async () => {
    await api.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const plan = async (q: ReturnType<typeof sql>) => (await tx.execute(q)).rows.map((r) => Object.values(r)[0]).join("\n");
      expect(await plan(sql`explain select id from territories where owner_family_id is not null and upkeep_paid_until <= now() order by upkeep_paid_until limit 1`)).toMatch(
        /territories_upkeep_due_idx/,
      );
      expect(await plan(sql`explain select id from ledger_entries where account_id = gen_random_uuid() order by id desc limit 21`)).toMatch(/ledger_entries_account_idx/);
    });
  });
});
