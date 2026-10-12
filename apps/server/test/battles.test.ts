import { BATTLES, CITY } from "@kots/content";
import { declarationFee, INJURY_MS, PREPARATION_MS, replay, ROUND_MS, type BattleState, type RoundResult } from "@kots/rules";
import { AttackQuote, Battle, BattleList, DistrictTerritories, Henchman, NotificationPage, TerritoryDetail } from "@kots/shared";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedMap } from "../src/db/seed";
import { BattlesService } from "../src/modules/battles/battles.service";
import { TerritoriesService } from "../src/modules/territories/territories.service";
import { economyHelpers } from "./economy-helpers";
import { newPlayer, resetTestDatabase, startApi, TestClock, type Client, type TestApi } from "./helpers";

let api: TestApi;
const clock = new TestClock();
const HOUR = 3600_000;

beforeAll(async () => {
  await resetTestDatabase();
  api = await startApi(undefined, clock);
  await seedMap(api.db);
});

afterEach(async () => {
  clock.set(Date.now());
  await expectLedgerConsistent();
  // A henchman is never committed to a battle that is over, and no territory is contested by one.
  expect(await rows(sql`select h.id from henchmen h join battles b on b.id = h.battle_id where b.status not in ('preparing', 'active')`)).toEqual([]);
  expect(await rows(sql`select t.slug from territories t join battles b on b.id = t.contested_battle_id where b.status not in ('preparing', 'active')`)).toEqual([]);
});

// The map is small, so every test starts from a neutral map: no owners, guards, commitments or live battles.
// (No money moves here, so the ledger checks still hold.)
beforeEach(async () => {
  used.clear();
  await api.db.execute(sql`update henchmen set battle_id = null, assigned_territory_id = null where battle_id is not null or assigned_territory_id is not null`);
  await api.db.execute(sql`update battles set status = 'cancelled', end_reason = 'test_reset', ended_at = now(), next_round_at = null where status in ('preparing', 'active')`);
  await api.db.execute(
    sql`update territories set owner_family_id = null, owned_since = null, upkeep_paid_until = null, state = 'stable', last_evaluated_at = null, contested_battle_id = null`,
  );
  await seedMap(api.db);
});

afterAll(async () => {
  await api?.close();
});

const { rows, family, balance, setBalance, ageForTrading, expectLedgerConsistent } = economyHelpers(() => api, "War");
type Fam = Awaited<ReturnType<typeof family>>;
type Role = NonNullable<Parameters<typeof family>[0]>[number];

const service = () => api.app.get(BattlesService);
const sweepAt = (at: number) => service().sweep(new Date(at));
const borders = (slug: string) => CITY.territories.get(slug)!.borders;
const claim = async (f: Fam, slug: string) => {
  const res = await f.don.client.post(`/territories/${slug}/claim`);
  expect([slug, res.status, res.body?.code]).toEqual([slug, 200, undefined]);
};
const hire = async (f: Fam, n: number): Promise<Henchman[]> => {
  const out = [];
  for (let slot = 0; slot < n; slot++) {
    const res = await f.don.client.post(`/families/${f.id}/recruits`, { slot });
    expect(res.status).toBe(201);
    out.push(Henchman.parse(res.body));
  }
  return out;
};
const guard = async (f: Fam, h: Henchman, slug: string) => expect((await f.don.client.patch(`/henchmen/${h.id}`, { territory: slug })).status).toBe(200);
const view = async (c: Client, id: string) => {
  const res = await c.get(`/battles/${id}`);
  expect(res.status).toBe(200);
  return Battle.parse(res.body);
};
const ownerOf = async (slug: string) => (await rows<{ owner_family_id: string | null }>(sql`select owner_family_id from territories where slug = ${slug}`))[0]!.owner_family_id;
const notes = async (c: Client) =>
  NotificationPage.parse((await c.get("/notifications")).body)
    .items.map((n) => n.type)
    .filter((t) => t.startsWith("battle."));

/** A target with two free borders, so each scenario in a test gets its own corner of the map. */
const used = new Set<string>();
function pickFront(minFree = 2): { target: string; defenderSecond: string; attackerBase: string; spare: string | undefined } {
  for (const target of [...CITY.territories.keys()].sort()) {
    const free = borders(target).filter((b) => !used.has(b));
    if (used.has(target) || free.length < minFree) continue;
    const [defenderSecond, attackerBase] = free as [string, string];
    const spare = minFree > 2 ? free[2] : undefined;
    for (const s of [target, defenderSecond, attackerBase, ...(spare ? [spare] : []), ...borders(attackerBase), ...borders(defenderSecond)]) used.add(s);
    return { target, defenderSecond, attackerBase, spare };
  }
  throw new Error("map exhausted");
}

/**
 * Two established families: the defender holds `target` and a second territory; the attacker holds land bordering
 * `target`. Optionally hires henchmen; the defender's are posted to `target` as guards.
 */
async function front(opts: { attackers?: number; defenders?: number; attackerRoles?: Role[]; defenderRoles?: Role[]; minFree?: number } = {}) {
  const { target, defenderSecond, attackerBase, spare } = pickFront(opts.minFree);
  const attacker = await family(opts.attackerRoles ?? []);
  const defender = await family(opts.defenderRoles ?? []);
  await Promise.all([ageForTrading(attacker.id), ageForTrading(defender.id)]);
  await claim(defender, target);
  await claim(defender, defenderSecond);
  await claim(attacker, attackerBase);
  await Promise.all([setBalance(attacker.id, 50_000), setBalance(defender.id, 50_000)]);
  const aMen = await hire(attacker, opts.attackers ?? 0);
  const dMen = await hire(defender, opts.defenders ?? 0);
  for (const h of dMen) await guard(defender, h, target);
  return { attacker, defender, target, defenderSecond, attackerBase, spare, aMen, dMen };
}

const declare = async (f: Fam, slug: string, c: Client = f.don.client) => {
  const res = await c.post(`/territories/${slug}/battles`);
  expect([res.status, res.body?.code]).toEqual([201, undefined]);
  return Battle.parse(res.body);
};
const commit = (c: Client, battleId: string, ids: string[]) => c.post(`/battles/${battleId}/commit`, { henchmen: ids });
const declaredAt = (b: Battle) => new Date(b.declaredAt).getTime();

describe("declaring", () => {
  it("charges the fee, contests the territory, commits the defender's guards and warns the defending family", async () => {
    const f = await front({ attackers: 2, defenders: 2, defenderRoles: ["associate"] });
    const before = await balance(f.attacker.don.client, f.attacker.id);
    const b = await declare(f.attacker, f.target);
    const fee = declarationFee(CITY.territories.get(f.target)!.baseUpkeep);
    expect(b).toMatchObject({ status: "preparing", fee, mySide: "attacker", currentRound: 0, rounds: BATTLES.rounds, enemyCommitted: 2, committed: [] });
    expect(new Date(b.nextRoundAt!).getTime()).toBe(declaredAt(b) + PREPARATION_MS);
    expect(await balance(f.attacker.don.client, f.attacker.id)).toBe(before - fee);
    expect(TerritoryDetail.parse((await f.defender.don.client.get(`/territories/${f.target}`)).body).battleId).toBe(b.id);

    const theirs = await view(f.defender.don.client, b.id);
    expect(theirs).toMatchObject({ mySide: "defender", enemyCommitted: 0 });
    expect(theirs.committed.map((h) => h.id).sort()).toEqual(f.dMen.map((h) => h.id).sort());
    for (const c of [f.defender.don.client, f.defender.members[0]!.client]) expect(await notes(c)).toEqual(["battle.attacked"]);
    expect(await notes(f.attacker.don.client)).toEqual([]);
    expect(BattleList.parse((await f.defender.don.client.get(`/families/${f.defender.id}/battles`)).body).map((x) => x.id)).toEqual([b.id]);
    const outsider = await newPlayer(api.base);
    expect((await outsider.client.get(`/battles/${b.id}`)).status).toBe(404);
  });

  it("refuses: neutral, own, not bordering, last territory, too new, by a role that can't declare, or unaffordable", async () => {
    const f = await front({ attackerRoles: ["capo"] });
    const expectRefused = async (c: Client, slug: string, status: number, code?: string) => {
      const res = await c.post(`/territories/${slug}/battles`);
      expect([slug, res.status, res.body.code]).toEqual([slug, status, code ?? res.body.code]);
    };
    const neutral = [...CITY.territories.keys()].find((s) => !used.has(s))!;
    await expectRefused(f.attacker.don.client, neutral, 409, "TERRITORY_NOT_HELD");
    await expectRefused(f.attacker.don.client, f.attackerBase, 400);
    // Not bordering: the defender's second territory may or may not border the attacker's base.
    if (!borders(f.defenderSecond).includes(f.attackerBase)) await expectRefused(f.attacker.don.client, f.defenderSecond, 409, "NOT_ADJACENT");
    await expectRefused(f.attacker.members[0]!.client, f.target, 403, "FORBIDDEN");

    // The defender's last territory can't be attacked.
    const lonely = await front();
    expect((await lonely.defender.don.client.post(`/territories/${lonely.defenderSecond}/abandon`)).status).toBe(204);
    await expectRefused(lonely.attacker.don.client, lonely.target, 409, "LAST_TERRITORY");

    // New-family protection, both ways.
    const young = await front();
    await api.db.execute(sql`update families set founded_at = now() where id = ${young.defender.id}`);
    await expectRefused(young.attacker.don.client, young.target, 409, "PROTECTED");

    const poor = await front();
    await setBalance(poor.attacker.id, 0);
    await expectRefused(poor.attacker.don.client, poor.target, 409, "INSUFFICIENT_FUNDS");
    expect(await rows(sql`select 1 from battles where attacker_family_id = ${poor.attacker.id}`)).toEqual([]);
  });

  it("refuses during a ceasefire, during the cooldown after a battle, and while already attacking or already contested", async () => {
    const f = await front({ defenderRoles: [] });
    // A ceasefire signed through diplomacy.
    const room = (await f.attacker.don.client.post("/diplomacy/rooms", { tag: f.defender.tag })).body;
    const p = (await f.attacker.don.client.post(`/diplomacy/rooms/${room.id}/proposals`, { terms: { kind: "ceasefire", hours: 24 } })).body;
    expect((await f.defender.don.client.post(`/proposals/${p.id}/sign`)).body.status).toBe("executed");
    expect((await f.attacker.don.client.post(`/territories/${f.target}/battles`)).body.code).toBe("CEASEFIRE");

    // After a battle ends, the pair cools down.
    const g = await front({ attackers: 1 });
    const b = await declare(g.attacker, g.target);
    // One battle at a time per attacker (checked before anything about the new target).
    expect((await g.attacker.don.client.post(`/territories/${g.defenderSecond}/battles`)).body.code).toBe("ALREADY_FIGHTING");
    expect((await g.attacker.don.client.post(`/battles/${b.id}/withdraw`)).status).toBe(200);
    expect((await g.attacker.don.client.post(`/territories/${g.target}/battles`)).body.code).toBe("BATTLE_COOLDOWN");
    clock.advance(BATTLES.pairCooldownHours * HOUR + 1000);
    expect((await g.attacker.don.client.post(`/territories/${g.target}/battles`)).status).toBe(201);
  });

  it("two families declaring on the same territory at once: exactly one gets it", async () => {
    const f = await front({ minFree: 3 });
    const second = await family();
    await ageForTrading(second.id);
    await claim(second, f.spare!);
    const [x, y] = await Promise.all([f.attacker.don.client.post(`/territories/${f.target}/battles`), second.don.client.post(`/territories/${f.target}/battles`)]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    expect((x.status === 409 ? x : y).body.code).toBe("TERRITORY_CONTESTED");
    expect(await rows(sql`select 1 from battles where territory_id = (select id from territories where slug = ${f.target}) and status = 'preparing'`)).toHaveLength(1);
  });
});

describe("the attack quote", () => {
  const quote = async (c: Client, slug: string) => {
    const res = await c.get(`/territories/${slug}/attack`);
    expect(res.status).toBe(200);
    return AttackQuote.parse(res.body);
  };
  const onMap = async (c: Client, slug: string) => {
    const district = CITY.territories.get(slug)!.district;
    const res = await c.get(`/map/territories?district=${district}`);
    return DistrictTerritories.parse(res.body).territories.find((t) => t.slug === slug)!.battleId;
  };

  it("gives the fee and agrees with what declaring would do, for each reason", async () => {
    const f = await front({ attackerRoles: ["capo"], minFree: 3 });
    const fee = declarationFee(CITY.territories.get(f.target)!.baseUpkeep);
    expect(await quote(f.attacker.don.client, f.target)).toEqual({ fee, refusal: null });
    expect((await quote(f.attacker.members[0]!.client, f.target)).refusal).toBe("missing_permission");
    expect((await quote(f.attacker.don.client, f.attackerBase)).refusal).toBe("not_held");
    expect((await quote(f.attacker.don.client, f.spare!)).refusal).toBe("not_held");
    expect((await quote((await newPlayer(api.base)).client, f.target)).refusal).toBe("not_in_family");
    if (!borders(f.defenderSecond).includes(f.attackerBase)) expect((await quote(f.attacker.don.client, f.defenderSecond)).refusal).toBe("not_adjacent");
    await setBalance(f.attacker.id, fee - 1);
    expect((await quote(f.attacker.don.client, f.target)).refusal).toBe("insufficient_funds");
    await setBalance(f.attacker.id, 50_000);

    // Declaring contests it, on the map too; a third family sees it contested, and the attacker can't open a second front.
    expect(await onMap(f.attacker.don.client, f.target)).toBeNull();
    const b = await declare(f.attacker, f.target);
    expect(await onMap(f.defender.don.client, f.target)).toBe(b.id);
    const third = await family();
    await ageForTrading(third.id);
    await claim(third, f.spare!);
    expect((await quote(third.don.client, f.target)).refusal).toBe("contested");
    expect((await quote(f.attacker.don.client, f.defenderSecond)).refusal).toBe("already_fighting");

    // Over: no longer contested, and the pair cools down.
    expect((await f.attacker.don.client.post(`/battles/${b.id}/withdraw`)).status).toBe(200);
    expect(await onMap(f.attacker.don.client, f.target)).toBeNull();
    expect((await quote(f.attacker.don.client, f.target)).refusal).toBe("cooldown");
    expect((await f.attacker.don.client.post(`/territories/${f.target}/battles`)).body.code).toBe("BATTLE_COOLDOWN");

    // The defender's last territory, and new-family protection.
    const lonely = await front();
    expect((await lonely.defender.don.client.post(`/territories/${lonely.defenderSecond}/abandon`)).status).toBe(204);
    expect((await quote(lonely.attacker.don.client, lonely.target)).refusal).toBe("last_territory");
    const young = await front();
    await api.db.execute(sql`update families set founded_at = now() where id = ${young.defender.id}`);
    expect((await quote(young.attacker.don.client, young.target)).refusal).toBe("defender_protected");
    expect((await f.attacker.don.client.get("/territories/atlantis/attack")).status).toBe(404);
  });
});

describe("while contested", () => {
  it("the territory can't be abandoned or transferred, and committed henchmen can't be reassigned or dismissed", async () => {
    const f = await front({ attackers: 1, defenders: 1 });
    const b = await declare(f.attacker, f.target);
    expect((await f.defender.don.client.post(`/territories/${f.target}/abandon`)).body.code).toBe("TERRITORY_CONTESTED");
    const room = (await f.defender.don.client.post("/diplomacy/rooms", { tag: f.attacker.tag })).body;
    const p = await f.defender.don.client.post(`/diplomacy/rooms/${room.id}/proposals`, { terms: { kind: "territory_transfer", territory: f.target, giver: "proposer", price: 0 } });
    expect((await f.attacker.don.client.post(`/proposals/${p.body.id}/sign`)).body.code).toBe("TERRITORY_CONTESTED");

    expect((await commit(f.attacker.don.client, b.id, [f.aMen[0]!.id])).status).toBe(200);
    expect((await f.attacker.don.client.patch(`/henchmen/${f.aMen[0]!.id}`, { territory: null })).body.code).toBe("HENCHMAN_BUSY");
    expect((await f.attacker.don.client.post(`/henchmen/${f.aMen[0]!.id}/dismiss`)).body.code).toBe("HENCHMAN_BUSY");
    expect((await f.defender.don.client.post(`/henchmen/${f.dMen[0]!.id}/dismiss`)).body.code).toBe("HENCHMAN_BUSY");
  });
});

describe("committing", () => {
  it("commanders commit and release their own fit henchmen before round 1; others can't", async () => {
    const f = await front({ attackers: 3, defenders: 1, attackerRoles: ["enforcer", "associate"] });
    const b = await declare(f.attacker, f.target);
    const [enforcer, associate] = f.attacker.members;
    expect((await commit(associate!.client, b.id, [f.aMen[0]!.id])).status).toBe(403);
    expect((await commit(enforcer!.client, b.id, [f.aMen[0]!.id, f.aMen[1]!.id])).status).toBe(200);
    expect((await commit(f.attacker.don.client, b.id, [f.dMen[0]!.id])).status).toBe(404); // not theirs
    await api.db.execute(sql`update henchmen set injured_until = ${new Date(clock.now().getTime() + HOUR)} where id = ${f.aMen[2]!.id}`);
    expect((await commit(f.attacker.don.client, b.id, [f.aMen[2]!.id])).body.code).toBe("HENCHMAN_BUSY");
    expect((await f.attacker.don.client.post(`/battles/${b.id}/release`, { henchmen: [f.aMen[1]!.id] })).status).toBe(200);
    expect((await view(f.attacker.don.client, b.id)).committed.map((h) => h.id)).toEqual([f.aMen[0]!.id]);

    await sweepAt(declaredAt(b) + PREPARATION_MS);
    expect((await commit(f.attacker.don.client, b.id, [f.aMen[1]!.id])).body.code).toBe("BATTLE_CLOSED");
  });
});

describe("fighting", () => {
  it("rounds resolve on schedule with the sent orders (defaults otherwise), and the stored report replays exactly", async () => {
    const f = await front({ attackers: 3, defenders: 3 });
    const b = await declare(f.attacker, f.target);
    expect((await commit(f.attacker.don.client, b.id, f.aMen.map((h) => h.id))).status).toBe(200);
    const order = (c: Client, round: number, tactic: string) => c.post(`/battles/${b.id}/orders`, { round, tactic });
    expect((await order(f.attacker.don.client, 2, "flank")).body.code).toBe("BATTLE_CLOSED");
    expect((await order(f.attacker.don.client, 1, "hold")).status).toBe(200);
    expect((await order(f.attacker.don.client, 1, "flank")).status).toBe(200); // changed before the round
    expect((await view(f.attacker.don.client, b.id)).nextOrder).toBe("flank");

    // Not yet due: nothing happens.
    expect(await sweepAt(declaredAt(b) + PREPARATION_MS - 1000)).toBe(0);
    for (let r = 0; r < BATTLES.rounds; r++) await sweepAt(declaredAt(b) + PREPARATION_MS + r * ROUND_MS);

    const done = await view(f.attacker.don.client, b.id);
    expect(done.report[0]!.tactics).toEqual({ attacker: "flank", defender: "hold" });
    expect(done.report.length).toBeGreaterThanOrEqual(1);
    if (done.report.length > 1) expect(done.report[1]!.tactics).toEqual({ attacker: "press", defender: "hold" });
    expect(done.status).toBe("resolved");

    const [row] = await rows<{ initial_state: BattleState; seed: number }>(sql`select initial_state, seed from battles where id = ${b.id}`);
    const stored = (await rows<{ result: RoundResult }>(sql`select result from battle_rounds where battle_id = ${b.id} order by round_no`)).map((r) => r.result);
    expect(replay(row!.initial_state, row!.seed, stored.map((r) => ({ tactics: r.tactics, absent: r.absent })))).toEqual(stored);

    // Injured fighters are out for INJURY_MS from the round they were hurt in.
    const injured = await rows<{ id: string; injured_until: string }>(sql`select id, injured_until from henchmen where injured_until is not null and family_id in (${f.attacker.id}, ${f.defender.id})`);
    for (const h of injured) expect(new Date(h.injured_until).getTime() - INJURY_MS).toBeGreaterThanOrEqual(declaredAt(b) + PREPARATION_MS);
  });

  it("an attacker facing nobody wins: the territory changes hands, morale moves, everyone is released, both families are told", async () => {
    const f = await front({ attackers: 2, defenders: 0, defenderRoles: ["associate"] });
    const b = await declare(f.attacker, f.target);
    expect((await commit(f.attacker.don.client, b.id, f.aMen.map((h) => h.id))).status).toBe(200);
    const moraleBefore = f.aMen.map((h) => h.morale);
    await sweepAt(declaredAt(b) + PREPARATION_MS);

    const done = await view(f.attacker.don.client, b.id);
    expect(done).toMatchObject({ status: "resolved", winner: "attacker", currentRound: 1, points: { attacker: 1, defender: 0 } });
    expect(await ownerOf(f.target)).toBe(f.attacker.id);
    expect(
      await rows(sql`select h.cause from territory_ownership_history h join territories t on t.id = h.territory_id where t.slug = ${f.target} order by h.created_at desc limit 1`),
    ).toEqual([{ cause: "battle" }]);
    const after = await rows<{ id: string; morale: number; battle_id: string | null }>(sql`select id, morale, battle_id from henchmen where family_id = ${f.attacker.id} order by id`);
    for (const h of after) {
      const i = f.aMen.findIndex((x) => x.id === h.id);
      expect(h.battle_id).toBeNull();
      expect(h.morale).toBe(Math.min(100, moraleBefore[i]! + BATTLES.moraleWin));
    }
    expect(await notes(f.defender.members[0]!.client)).toEqual(["battle.lost", "battle.attacked"]);
    expect(await notes(f.attacker.don.client)).toEqual(["battle.won", "battle.round"]);
    expect(TerritoryDetail.parse((await f.attacker.don.client.get(`/territories/${f.target}`)).body).battleId).toBeNull();
  });

  it("a defender facing nobody keeps the territory, and the attacker's fee is not refunded", async () => {
    const f = await front({ defenders: 1 });
    const before = await balance(f.attacker.don.client, f.attacker.id);
    const b = await declare(f.attacker, f.target);
    await sweepAt(declaredAt(b) + PREPARATION_MS);
    expect(await view(f.defender.don.client, b.id)).toMatchObject({ status: "resolved", winner: "defender" });
    expect(await ownerOf(f.target)).toBe(f.defender.id);
    expect(await balance(f.attacker.don.client, f.attacker.id)).toBe(before - b.fee);
  });
});

describe("ending early", () => {
  it("withdrawing hands the win to the other side: an attacker keeps nothing, a defender gives up the territory", async () => {
    const f = await front({ attackers: 1, defenders: 1 });
    const b = await declare(f.attacker, f.target);
    const out = await f.attacker.don.client.post(`/battles/${b.id}/withdraw`);
    expect(Battle.parse(out.body)).toMatchObject({ status: "resolved", winner: "defender", endReason: "withdrawn" });
    expect(await ownerOf(f.target)).toBe(f.defender.id);
    expect((await f.attacker.don.client.post(`/battles/${b.id}/withdraw`)).body.code).toBe("BATTLE_CLOSED");

    const g = await front({ attackers: 1 });
    const c = await declare(g.attacker, g.target);
    expect(Battle.parse((await g.defender.don.client.post(`/battles/${c.id}/withdraw`)).body)).toMatchObject({ winner: "attacker" });
    expect(await ownerOf(g.target)).toBe(g.attacker.id);
  });

  it("a defender who loses the territory to unpaid upkeep: the battle is called off and the fee refunded", async () => {
    const f = await front({ attackers: 1 });
    const b = await declare(f.attacker, f.target);
    const afterFee = await balance(f.attacker.don.client, f.attacker.id);
    await setBalance(f.defender.id, 0);
    await api.db.execute(sql`update territories set base_income = 0, upkeep_paid_until = ${new Date(clock.now().getTime() - 49 * HOUR)} where slug = ${f.target}`);
    await api.app.get(TerritoriesService).sweepUpkeep(clock.now());
    expect(await ownerOf(f.target)).toBeNull();
    await sweepAt(declaredAt(b) + PREPARATION_MS);
    expect(await view(f.attacker.don.client, b.id)).toMatchObject({ status: "cancelled", endReason: "territory_lost", winner: null });
    expect(await balance(f.attacker.don.client, f.attacker.id)).toBe(afterFee + b.fee);
    expect(await notes(f.attacker.don.client)).toEqual(["battle.cancelled"]);
  });
});

describe("races", () => {
  it("concurrent sweeps resolve each round exactly once", async () => {
    const f = await front({ attackers: 4, defenders: 4 });
    const b = await declare(f.attacker, f.target);
    await commit(f.attacker.don.client, b.id, f.aMen.map((h) => h.id));
    for (let r = 0; r < BATTLES.rounds; r++) {
      const at = declaredAt(b) + PREPARATION_MS + r * ROUND_MS;
      await Promise.all([sweepAt(at), sweepAt(at), sweepAt(at)]);
    }
    const rounds = await rows<{ round_no: number }>(sql`select round_no from battle_rounds where battle_id = ${b.id} order by round_no`);
    const done = await view(f.attacker.don.client, b.id);
    expect(rounds.map((r) => r.round_no)).toEqual(Array.from({ length: done.currentRound }, (_, i) => i + 1));
    expect(done.status).toBe("resolved");
  });

  it("a round resolving while a side withdraws: one outcome, applied once", async () => {
    for (let i = 0; i < 3; i++) {
      const f = await front({ attackers: 2, defenders: 2 });
      const b = await declare(f.attacker, f.target);
      await commit(f.attacker.don.client, b.id, f.aMen.map((h) => h.id));
      const at = declaredAt(b) + PREPARATION_MS;
      await Promise.all([sweepAt(at), f.attacker.don.client.post(`/battles/${b.id}/withdraw`)]);
      const done = await view(f.defender.don.client, b.id);
      // Either the withdrawal came first (resolved, no rounds) or round 1 did and the withdrawal then ended it.
      expect(done.status).toBe("resolved");
      expect(await rows(sql`select 1 from battles where id = ${b.id} and ended_at is not null`)).toHaveLength(1);
      const won = await rows(sql`select 1 from activity_log where type = 'battle.won' and (payload->>'battle') = ${b.id}`);
      expect(won).toHaveLength(1);
    }
  });
});

describe("races with the upkeep sweep", () => {
  it("a round resolving while the defender's territory lapses: cancelled with a refund, or fought and then lost; never both", async () => {
    // The upkeep sweep starts a little later each time, so both orders occur (checked by hand: cancelled and resolved both seen).
    for (let i = 0; i < 4; i++) {
      const f = await front({ attackers: 1, defenders: 1 });
      const b = await declare(f.attacker, f.target);
      await commit(f.attacker.don.client, b.id, [f.aMen[0]!.id]);
      await setBalance(f.defender.id, 0);
      const at = declaredAt(b) + PREPARATION_MS;
      await api.db.execute(sql`update territories set base_income = 0, upkeep_paid_until = ${new Date(at - 49 * HOUR)} where slug = ${f.target}`);
      const upkeep = new Promise((r) => setTimeout(r, i * 10)).then(() => api.app.get(TerritoriesService).sweepUpkeep(new Date(at)));
      await Promise.all([sweepAt(at), upkeep]);
      await sweepAt(at + ROUND_MS * BATTLES.rounds); // whatever is left
      const done = await view(f.attacker.don.client, b.id);
      const refunds = await rows(sql`select 1 from ledger_transactions where idempotency_key = ${`battle:${b.id}:refund`}`);
      expect(refunds).toHaveLength(done.status === "cancelled" ? 1 : 0);
      if (done.status === "resolved" && done.winner === "attacker") expect(await ownerOf(f.target)).toBe(f.attacker.id);
    }
  });
});

describe("endpoints", () => {
  it("validates bodies and ids", async () => {
    const f = await front({ attackers: 1 });
    const b = await declare(f.attacker, f.target);
    expect((await f.attacker.don.client.post(`/battles/${b.id}/orders`, { round: 1, tactic: "retreat" })).status).toBe(400);
    expect((await f.attacker.don.client.post(`/battles/${b.id}/commit`, { henchmen: [] })).status).toBe(400);
    expect((await f.attacker.don.client.get("/battles/nope")).status).toBe(404);
    expect((await f.attacker.don.client.post("/territories/atlantis/battles")).status).toBe(404);
  });
});
