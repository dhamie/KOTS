import { GRACE_MS } from "@kots/rules";
import { NotificationPage, TerritoryDetail } from "@kots/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedMap } from "../src/db/seed";
import { FamiliesService } from "../src/modules/families/families.service";
import { TerritoriesService } from "../src/modules/territories/territories.service";
import { TradesService } from "../src/modules/trades/trades.service";
import { economyHelpers } from "./economy-helpers";
import { newPlayer, resetTestDatabase, startApi, TestClock, type Client, type TestApi } from "./helpers";

let api: TestApi;
const clock = new TestClock();
const DAY = 24 * 3600_000;

beforeAll(async () => {
  await resetTestDatabase();
  api = await startApi(undefined, clock);
  await seedMap(api.db);
});

afterAll(async () => {
  await api?.close();
});

const { family, setBalance, ageForTrading } = economyHelpers(() => api, "Note");

const inbox = async (c: Client, query = "") => {
  const res = await c.get(`/notifications${query}`);
  expect(res.status).toBe(200);
  return NotificationPage.parse(res.body);
};
/** Notification types, newest first, leaving out the invitations members received while the helpers set families up. */
const types = async (c: Client) => (await inbox(c)).items.map((n) => n.type).filter((t) => t !== "member.invited");

describe("who is notified", () => {
  it("an invitation notifies the invited player only", async () => {
    const f = await family(["underboss"]);
    const p = await newPlayer(api.base);
    expect((await f.don.client.post(`/families/${f.id}/invitations`, { handle: p.handle })).status).toBe(201);
    const page = await inbox(p.client);
    expect(page.unread).toBe(1);
    expect(page.items[0]).toMatchObject({ type: "member.invited", target: "invitation", read: false, body: expect.stringContaining(`[${f.tag}] invited you`) });
    expect(await types(f.don.client)).toEqual([]);
    expect(await types(f.members[0]!.client)).toEqual([]);
  });

  it("a trade offer notifies the receiving family's traders, not its other members or the offering family", async () => {
    const a = await family(["quartermaster"]);
    const b = await family(["quartermaster", "associate", "consigliere"]);
    await Promise.all([ageForTrading(a.id), ageForTrading(b.id)]);
    const offer = await a.don.client.post(`/families/${a.id}/trades`, { to: b.tag, gives: [{ cash: 100 }], wants: [] });
    expect(offer.status).toBe(201);

    const [bQuartermaster, bAssociate, bConsigliere] = b.members;
    for (const c of [b.don.client, bQuartermaster!.client]) expect(await types(c)).toEqual(["trade.received"]);
    for (const c of [bAssociate!.client, bConsigliere!.client, a.don.client, a.members[0]!.client]) expect(await types(c)).toEqual([]);
    expect((await inbox(b.don.client)).items[0]!.body).toBe(`[${a.tag}] sent your family a trade offer.`);

    // Accepting notifies the offering family's traders; the accepting family isn't told what it did itself.
    expect((await bQuartermaster!.client.post(`/trades/${offer.body.id}/accept`)).status).toBe(200);
    for (const c of [a.don.client, a.members[0]!.client]) expect(await types(c)).toEqual(["trade.executed"]);
    expect(await types(b.don.client)).toEqual(["trade.received"]);
  });

  it("a declined offer notifies the offering family; an expired one notifies both", async () => {
    const a = await family();
    const b = await family();
    await Promise.all([ageForTrading(a.id), ageForTrading(b.id)]);
    const declined = await a.don.client.post(`/families/${a.id}/trades`, { to: b.tag, gives: [{ cash: 100 }], wants: [] });
    expect((await b.don.client.post(`/trades/${declined.body.id}/decline`)).status).toBe(200);
    expect(await types(a.don.client)).toEqual(["trade.declined"]);

    await a.don.client.post(`/families/${a.id}/trades`, { to: b.tag, gives: [{ cash: 100 }], wants: [] });
    const sweeper = api.app.get(TradesService);
    const later = new Date(clock.now().getTime() + 2 * DAY);
    await Promise.all([sweeper.sweepExpired(later), sweeper.sweepExpired(later)]);
    await sweeper.sweepExpired(later);
    expect(await types(a.don.client)).toEqual(["trade.expired", "trade.declined"]);
    expect(await types(b.don.client)).toEqual(["trade.expired", "trade.received", "trade.received"]);
  });

  it("unpaid upkeep notifies treasury roles once when neglected and once when lost, however often the sweep runs", async () => {
    const f = await family(["consigliere", "associate"]);
    const [consigliere, associate] = f.members;
    expect((await f.don.client.post("/territories/otto/claim")).status).toBe(200);
    await api.db.execute(sql`update territories set base_income = 0 where slug = 'otto'`);
    await setBalance(f.id, 0);
    const paidUntil = new Date(TerritoryDetail.parse((await f.don.client.get("/territories/otto")).body).holding!.paidUntil);
    const sweep = (at: number) => api.app.get(TerritoriesService).sweepUpkeep(new Date(at));

    await Promise.all([sweep(paidUntil.getTime() + 60_000), sweep(paidUntil.getTime() + 60_000)]);
    await sweep(paidUntil.getTime() + 120_000);
    await Promise.all([sweep(paidUntil.getTime() + GRACE_MS), sweep(paidUntil.getTime() + GRACE_MS)]);
    await sweep(paidUntil.getTime() + GRACE_MS + 60_000);

    for (const c of [f.don.client, consigliere!.client]) expect(await types(c)).toEqual(["territory.lost", "territory.neglected"]);
    expect(await types(associate!.client)).toEqual([]);
    expect((await inbox(f.don.client)).items[0]!.body).toMatch(/was lost: its upkeep went unpaid/);
  });

  it("succession notifies every member", async () => {
    const f = await family(["underboss", "associate"]);
    const [underboss, associate] = f.members;
    const now = clock.now().getTime();
    await api.db.execute(sql`update players set last_active_at = ${new Date(now - 8 * DAY)} where id = ${f.don.id}`);
    await api.app.get(FamiliesService).succeedInactiveDons(clock.now());
    for (const c of [f.don.client, underboss!.client, associate!.client]) expect(await types(c)).toEqual(["leadership.succeeded"]);
    expect((await inbox(associate!.client)).items[0]!.body).toBe(`${underboss!.handle} is now Don: ${f.don.handle} was inactive.`);
  });
});

describe("reading", () => {
  it("pages newest first, marks one or all read, and keeps players out of each other's notifications", async () => {
    const f = await family();
    const p = await newPlayer(api.base);
    const other = await newPlayer(api.base);
    for (let i = 0; i < 3; i++) {
      const inv = await f.don.client.post(`/families/${f.id}/invitations`, { handle: p.handle });
      expect(inv.status).toBe(201);
      expect((await f.don.client.delete(`/families/${f.id}/invitations/${inv.body.id}`)).status).toBe(204);
    }
    const first = await inbox(p.client, "?limit=2");
    expect([first.items.length, first.unread, first.nextCursor]).toEqual([2, 3, first.items[1]!.id]);
    const rest = await inbox(p.client, `?limit=2&before=${first.nextCursor}`);
    expect([rest.items.length, rest.nextCursor]).toEqual([1, null]);

    const newest = first.items[0]!.id;
    expect((await other.client.post(`/notifications/${newest}/read`)).status).toBe(404);
    expect((await p.client.post(`/notifications/${newest}/read`)).status).toBe(204);
    const after = await inbox(p.client);
    expect([after.unread, after.items[0]!.read, after.items[1]!.read]).toEqual([2, true, false]);
    expect((await p.client.post("/notifications/read-all")).status).toBe(204);
    expect((await inbox(p.client)).unread).toBe(0);
    expect((await p.client.post("/notifications/abc/read")).status).toBe(404);
  });
});
