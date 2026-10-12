import { ECONOMY, RECRUITMENT } from "@kots/content";
import { boardDay, generateBoard, GRACE_MS, UPKEEP_PERIOD_MS } from "@kots/rules";
import { Henchman, HenchmanList, RecruitBoard } from "@kots/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedMap } from "../src/db/seed";
import { HenchmenService } from "../src/modules/henchmen/henchmen.service";
import { economyHelpers } from "./economy-helpers";
import { newPlayer, resetTestDatabase, startApi, TestClock, type TestApi } from "./helpers";

let api: TestApi;
const clock = new TestClock();

beforeAll(async () => {
  await resetTestDatabase();
  api = await startApi(undefined, clock);
  await seedMap(api.db);
});

afterAll(async () => {
  await api?.close();
});

const { rows, family, balance, adjust, setBalance, expectLedgerConsistent } = economyHelpers(() => api, "Henchmen");
const sweep = (at: Date = clock.now()) => api.app.get(HenchmenService).sweepWages(at);

type Client = Awaited<ReturnType<typeof family>>["don"]["client"];
const board = async (c: Client, familyId: string) => RecruitBoard.parse((await c.get(`/families/${familyId}/recruits`)).body);
const roster = async (c: Client, familyId: string) => HenchmanList.parse((await c.get(`/families/${familyId}/henchmen`)).body);
const hire = (c: Client, familyId: string, slot: number) => c.post(`/families/${familyId}/recruits`, { slot });
const status = async (id: string) => (await rows<{ status: string }>(sql`select status from henchmen where id = ${id}`))[0]!.status;

describe("recruitment board", () => {
  it("shows today's candidates, the same on every load, matching the shared rules", async () => {
    const f = await family();
    const b = await board(f.don.client, f.id);
    expect(b.candidates).toHaveLength(RECRUITMENT.boardSize);
    expect(await board(f.don.client, f.id)).toEqual(b);
    const day = boardDay(clock.now().getTime());
    expect(b.day).toBe(day);
    expect(b.candidates.map(({ hired: _, ...c }) => c)).toEqual(generateBoard(f.id, day));
    expect(b.candidates.every((c) => !c.hired)).toBe(true);
    expect(new Date(b.resetsAt).getTime()).toBeGreaterThan(clock.now().getTime());
  });

  it("is only visible to the family's members", async () => {
    const f = await family();
    const outsider = await newPlayer(api.base);
    expect((await outsider.client.get(`/families/${f.id}/recruits`)).status).toBe(403);
    expect((await outsider.client.get(`/families/${f.id}/henchmen`)).status).toBe(403);
  });

  it("is replaced at midnight Lagos time", async () => {
    const f = await family();
    const today = await board(f.don.client, f.id);
    clock.set(new Date(today.resetsAt));
    const tomorrow = await board(f.don.client, f.id);
    expect(tomorrow.day).toBe(today.day + 1);
    expect(tomorrow.candidates).not.toEqual(today.candidates);
  });
});

describe("hiring", () => {
  it("costs the hire price plus the first day's wage, and each candidate can be hired once", async () => {
    const f = await family();
    const c = (await board(f.don.client, f.id)).candidates[1]!;
    const res = await hire(f.don.client, f.id, 1);
    expect(res.status).toBe(201);
    const h = Henchman.parse(res.body);
    expect(h).toMatchObject({ name: c.name, archetype: c.archetype, attributes: c.attributes, traits: c.traits, wage: c.wage, morale: RECRUITMENT.startingMorale, assignedTo: null });
    expect(new Date(h.wagePaidUntil).getTime() - clock.now().getTime()).toBe(UPKEEP_PERIOD_MS);
    expect(await balance(f.don.client, f.id)).toBe(ECONOMY.startingGrant - c.hireCost - c.wage);

    const again = await hire(f.don.client, f.id, 1);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("ALREADY_HIRED");
    expect((await board(f.don.client, f.id)).candidates.map((x) => x.hired)).toEqual([false, true, false, false]);
    expect((await roster(f.don.client, f.id)).map((x) => x.id)).toEqual([h.id]);
    expect((await f.don.client.get(`/families/${f.id}/activity`)).body.items[0]).toMatchObject({ type: "henchman.hired", payload: { name: c.name } });
    await expectLedgerConsistent();
  });

  it("two members hiring the same candidate at once: exactly one gets them, and the family pays once", async () => {
    const f = await family(["underboss"]);
    const c = (await board(f.don.client, f.id)).candidates[0]!;
    const results = await Promise.all([hire(f.don.client, f.id, 0), hire(f.members[0]!.client, f.id, 0)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await balance(f.don.client, f.id)).toBe(ECONOMY.startingGrant - c.hireCost - c.wage);
    await expectLedgerConsistent();
  });

  it("refuses when the treasury can't cover it, and hires nobody", async () => {
    const f = await family();
    await setBalance(f.id, 50);
    const res = await hire(f.don.client, f.id, 2);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("INSUFFICIENT_FUNDS");
    expect(await roster(f.don.client, f.id)).toEqual([]);
    expect(await balance(f.don.client, f.id)).toBe(50);
    // The candidate is still available once there's money.
    await adjust(f.id, 10_000);
    expect((await hire(f.don.client, f.id, 2)).status).toBe(201);
  });

  it("many families hiring at once all finish: no transaction waits on a second pool connection", { timeout: 60_000 }, async () => {
    // More concurrent transactions than the API's pool has connections (10). If a transaction ran a query on
    // the pool instead of on itself, every connection would end up waiting for another and this would hang.
    const families = await Promise.all(Array.from({ length: 16 }, () => family()));
    const results = await Promise.race([
      Promise.all(families.map((f) => hire(f.don.client, f.id, 0))),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("hires did not finish: pool deadlock?")), 20_000)),
    ]);
    expect(results.map((r) => [r.status, r.body?.code])).toEqual(families.map(() => [201, undefined]));
  });

  it("checks roles and family: an associate can't hire, nobody hires into another family, unknown slots are 404", async () => {
    const f = await family(["associate", "quartermaster"]);
    const [associate, quartermaster] = f.members;
    expect((await hire(associate!.client, f.id, 0)).status).toBe(403);
    expect((await hire(quartermaster!.client, f.id, 0)).status).toBe(201);
    const other = await family();
    expect((await hire(other.don.client, f.id, 1)).status).toBe(403);
    expect((await hire(f.don.client, f.id, RECRUITMENT.boardSize)).status).toBe(404);
    expect((await f.don.client.post(`/families/${f.id}/recruits`, { slot: "x" })).status).toBe(400);
  });
});

describe("assigning and dismissing", () => {
  it("assigns a henchman to a held territory, makes them idle, and refuses territory the family doesn't hold", async () => {
    const f = await family(["capo"]);
    const capo = f.members[0]!.client;
    expect((await f.don.client.post("/territories/sabo/claim")).status).toBe(200);
    const h = Henchman.parse((await hire(f.don.client, f.id, 0)).body);

    const assigned = await capo.patch(`/henchmen/${h.id}`, { territory: "sabo" });
    expect(assigned.status).toBe(200);
    expect(Henchman.parse(assigned.body).assignedTo).toBe("sabo");
    expect((await roster(capo, f.id))[0]!.assignedTo).toBe("sabo");

    expect((await capo.patch(`/henchmen/${h.id}`, { territory: "marina" })).status).toBe(403);
    expect((await capo.patch(`/henchmen/${h.id}`, { territory: "atlantis" })).status).toBe(404);
    expect(Henchman.parse((await capo.patch(`/henchmen/${h.id}`, { territory: null })).body).assignedTo).toBeNull();

    const other = await family();
    expect((await other.don.client.patch(`/henchmen/${h.id}`, { territory: null })).status).toBe(404);
  });

  it("losing the territory sends its guards back to idle", async () => {
    const f = await family();
    expect((await f.don.client.post("/territories/oyingbo/claim")).status).toBe(200);
    const h = Henchman.parse((await hire(f.don.client, f.id, 0)).body);
    expect((await f.don.client.patch(`/henchmen/${h.id}`, { territory: "oyingbo" })).status).toBe(200);
    expect((await f.don.client.post("/territories/oyingbo/abandon")).status).toBe(204);
    expect((await roster(f.don.client, f.id))[0]!.assignedTo).toBeNull();
  });

  it("dismissing: capo can't, underboss can; the henchman leaves the roster with no refund", async () => {
    const f = await family(["capo", "underboss"]);
    const [capo, underboss] = f.members;
    const h = Henchman.parse((await hire(f.don.client, f.id, 3)).body);
    const before = await balance(f.don.client, f.id);
    expect((await capo!.client.post(`/henchmen/${h.id}/dismiss`)).status).toBe(403);
    expect((await underboss!.client.post(`/henchmen/${h.id}/dismiss`)).status).toBe(204);
    expect(await roster(f.don.client, f.id)).toEqual([]);
    expect(await status(h.id)).toBe("dismissed");
    expect(await balance(f.don.client, f.id)).toBe(before);
    expect((await underboss!.client.post(`/henchmen/${h.id}/dismiss`)).status).toBe(404);
  });

  it("disbanding the family dismisses everyone", async () => {
    const f = await family();
    const h = Henchman.parse((await hire(f.don.client, f.id, 0)).body);
    expect((await f.don.client.delete(`/families/${f.id}`)).status).toBe(204);
    expect(await status(h.id)).toBe("dismissed");
    await expectLedgerConsistent();
  });
});

describe("wages over time", () => {
  it("each day's wage is paid once however often the sweep runs, and paid henchmen gain a little morale", async () => {
    const f = await family();
    const h = Henchman.parse((await hire(f.don.client, f.id, 0)).body);
    const start = await balance(f.don.client, f.id);
    const due = new Date(h.wagePaidUntil).getTime();

    expect((await sweep(new Date(due - 1))).paid).toBe(0);
    clock.set(due + 60_000);
    await Promise.all([sweep(), sweep(), sweep()]);
    await sweep();
    expect(await balance(f.don.client, f.id)).toBe(start - h.wage);
    const after = (await roster(f.don.client, f.id))[0]!;
    expect(new Date(after.wagePaidUntil).getTime()).toBe(due + UPKEEP_PERIOD_MS);
    expect(after.morale).toBe(RECRUITMENT.startingMorale + RECRUITMENT.paidMoraleGain);
    await expectLedgerConsistent();
  });

  it("an unpaid henchman loses morale once, then deserts when the grace period ends", async () => {
    const f = await family();
    const h = Henchman.parse((await hire(f.don.client, f.id, 0)).body);
    await setBalance(f.id, 0);
    const due = new Date(h.wagePaidUntil).getTime();

    clock.set(due + 60_000);
    await sweep();
    let now = (await roster(f.don.client, f.id))[0]!;
    expect(now).toMatchObject({ wageOverdue: true, morale: RECRUITMENT.startingMorale - RECRUITMENT.unpaidMoralePenalty });

    clock.set(due + GRACE_MS - 60_000);
    await sweep();
    now = (await roster(f.don.client, f.id))[0]!;
    expect(now.morale).toBe(RECRUITMENT.startingMorale - RECRUITMENT.unpaidMoralePenalty);

    clock.set(due + GRACE_MS);
    await sweep();
    expect(await roster(f.don.client, f.id)).toEqual([]);
    expect(await status(h.id)).toBe("deserted");
    const types = (await f.don.client.get(`/families/${f.id}/activity`)).body.items.map((a: { type: string }) => a.type);
    expect(types.filter((t: string) => t === "henchman.unpaid")).toHaveLength(1);
    expect(types).toContain("henchman.deserted");
    await expectLedgerConsistent();
  });

  it("paying up in time clears the overdue flag and keeps the schedule", async () => {
    const f = await family();
    const h = Henchman.parse((await hire(f.don.client, f.id, 0)).body);
    await setBalance(f.id, 0);
    const due = new Date(h.wagePaidUntil).getTime();
    clock.set(due + 60_000);
    await sweep();
    await adjust(f.id, 5000);
    clock.advance(60_000);
    await sweep();
    const now = (await roster(f.don.client, f.id))[0]!;
    expect(now.wageOverdue).toBe(false);
    expect(new Date(now.wagePaidUntil).getTime()).toBe(due + UPKEEP_PERIOD_MS);
    expect(await balance(f.don.client, f.id)).toBe(5000 - h.wage);
  });
});

describe("indexes", () => {
  it("the wage sweep and the family roster can use their indexes", async () => {
    await api.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const plan = async (q: ReturnType<typeof sql>) => (await tx.execute(q)).rows.map((r) => Object.values(r)[0]).join("\n");
      expect(await plan(sql`explain select id from henchmen where status = 'active' and wage_paid_until <= now() order by wage_paid_until limit 1`)).toMatch(/henchmen_wage_due_idx/);
      expect(await plan(sql`explain select id from henchmen where family_id = '00000000-0000-7000-8000-000000000000'`)).toMatch(/henchmen_family_idx/);
    });
  });
});
