import { CITY } from "@kots/content";
import { planEvent } from "@kots/rules";
import { Henchman, Trade } from "@kots/shared";
import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../src/common/uuid";
import { worldEvents } from "../src/db/schema";
import { seedMap } from "../src/db/seed";
import { AdminModule } from "../src/modules/admin/admin.module";
import { AdminService } from "../src/modules/admin/admin.service";
import { eventRow, EventsService } from "../src/modules/events/events.service";
import { FamiliesService } from "../src/modules/families/families.service";
import { TerritoriesService } from "../src/modules/territories/territories.service";
import { economyHelpers } from "./economy-helpers";
import { keyed, resetTestDatabase, startApi, TEST_DATABASE_URL, type TestApi } from "./helpers";

/**
 * Phase 9b: races not covered by the earlier suites. Each fires the competing actions at the same moment, a few
 * times over, and checks the final state is one of the allowed outcomes, with the ledger still consistent.
 */
let api: TestApi;
let admin: INestApplicationContext;
beforeAll(async () => {
  await resetTestDatabase();
  api = await startApi();
  await seedMap(api.db);
  admin = await NestFactory.createApplicationContext(AdminModule.forDatabase(TEST_DATABASE_URL), { logger: false });
});
afterEach(async () => {
  await expectLedgerConsistent();
});
afterAll(async () => {
  await admin?.close();
  await api?.close();
});

const { rows, family, setBalance, ageForTrading, expectLedgerConsistent } = economyHelpers(() => api, "Race");
const ROUNDS = 3;
const ok = (status: number) => status >= 200 && status < 300;
const one = async <T>(q: ReturnType<typeof sql>) => (await rows<T>(q))[0]!;

/** A territory and two of its borders not used since the last map reset. */
const used = new Set<string>();
function front(): { target: string; second: string; base: string } {
  const borders = (s: string) => CITY.territories.get(s)!.borders;
  const free = (s: string) => !used.has(s);
  for (const target of [...CITY.territories.keys()].sort()) {
    const near = borders(target).filter(free);
    if (!free(target) || near.length < 2) continue;
    const [second, base] = near as [string, string];
    for (const s of [target, second, base, ...borders(target), ...borders(second), ...borders(base)]) used.add(s);
    return { target, second, base };
  }
  throw new Error("map exhausted");
}
/** A neutral map with no live battles, as battles.test.ts resets it. (No money moves, so the ledger checks hold.) */
async function resetMap(): Promise<void> {
  used.clear();
  await api.db.execute(sql`update henchmen set battle_id = null, assigned_territory_id = null where battle_id is not null or assigned_territory_id is not null`);
  await api.db.execute(sql`update battles set status = 'cancelled', end_reason = 'test_reset', ended_at = now(), next_round_at = null where status in ('preparing', 'active')`);
  await api.db.execute(
    sql`update territories set owner_family_id = null, owned_since = null, upkeep_paid_until = null, state = 'stable', last_evaluated_at = null, contested_battle_id = null`,
  );
}

/** An established attacker holding `base`, and a defender holding `target` and `second`. */
async function sides(attackerRoles: Parameters<typeof family>[0] = [], defenderRoles: Parameters<typeof family>[0] = []) {
  await resetMap();
  const f = front();
  const attacker = await family(attackerRoles);
  const defender = await family(defenderRoles);
  for (const x of [attacker, defender]) {
    await ageForTrading(x.id);
    await setBalance(x.id, 100_000);
  }
  for (const [x, s] of [[defender, f.target], [defender, f.second], [attacker, f.base]] as const) expect((await x.don.client.post(`/territories/${s}/claim`)).status).toBe(200);
  return { ...f, attacker, defender };
}

describe("henchmen", () => {
  it("committing, dismissing and reposting one henchman at once: the answers match its final state", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const s = await sides();
      const h = Henchman.parse((await s.attacker.don.client.post(`/families/${s.attacker.id}/recruits`, { slot: 0 })).body);
      const battle = (await s.attacker.don.client.post(`/territories/${s.target}/battles`)).body;
      const c = s.attacker.don.client;
      const [commit, dismiss, assign] = await Promise.all([
        c.post(`/battles/${battle.id}/commit`, { henchmen: [h.id] }),
        c.post(`/henchmen/${h.id}/dismiss`),
        c.patch(`/henchmen/${h.id}`, { territory: s.base }),
      ]);
      const row = await one<{ status: string; battle_id: string | null; assigned_territory_id: string | null }>(
        sql`select status, battle_id, assigned_territory_id from henchmen where id = ${h.id}`,
      );
      expect(ok(dismiss.status)).toBe(row.status !== "active");
      if (row.status !== "active") expect([row.battle_id, row.assigned_territory_id]).toEqual([null, null]);
      else {
        expect(row.battle_id === battle.id).toBe(ok(commit.status));
        expect(row.assigned_territory_id !== null).toBe(ok(assign.status));
      }
    }
  });
});

describe("membership", () => {
  it("a kick and the member leaving at once: exactly one succeeds, and the member is out once", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const f = await family(["associate"]);
      const m = f.members[0]!;
      const [kick, leave] = await Promise.all([f.don.client.delete(`/families/${f.id}/members/${m.id}`), m.client.post(`/families/${f.id}/leave`)]);
      expect([kick, leave].filter((r) => ok(r.status))).toHaveLength(1);
      expect((await one<{ n: string }>(sql`select count(*) as n from family_memberships where player_id = ${m.id}`)).n).toBe("0");
      const left = await rows(sql`select 1 from activity_log where family_id = ${f.id} and type in ('member.kicked', 'member.left')`);
      expect(left).toHaveLength(1);
    }
  });

  it("a leadership transfer racing the succession sweep leaves exactly one Don", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const f = await family(["underboss", "associate"]);
      // The Don looks long inactive to the sweep, but still holds a session and transfers at the same moment.
      await api.db.execute(sql`update players set last_active_at = now() - interval '30 days' where id = ${f.don.id}`);
      const [transfer] = await Promise.all([
        f.don.client.post(`/families/${f.id}/transfer-leadership`, { playerId: f.members[1]!.id }),
        api.app.get(FamiliesService).succeedInactiveDons(),
      ]);
      const dons = await rows<{ player_id: string }>(sql`select player_id from family_memberships where family_id = ${f.id} and role = 'don'`);
      expect(dons).toHaveLength(1);
      if (ok(transfer.status)) expect(dons[0]!.player_id).toBe(f.members[1]!.id);
      else expect(dons[0]!.player_id).toBe(f.members[0]!.id); // the sweep's pick: the underboss
    }
  });
});

describe("disbanding", () => {
  it("racing a trade accept, a festival payout and an admin credit: no money is left in the closed treasury", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const s = await sides();
      // The disbanding family holds land (for the festival) and is offered cash it accepts as it disbands.
      const lone = s.attacker;
      const offer = Trade.parse((await s.defender.don.client.post(`/families/${s.defender.id}/trades`, { to: lone.tag, gives: [{ cash: 1_000 }], wants: [] }, keyed())).body);
      const district = CITY.territories.get(s.base)!.district;
      await api.db.insert(worldEvents).values(eventRow(planEvent("street_festival", 1, district), 1, new Date(), `race:${uuidv7()}`));

      const [disband, accept, , credit] = await Promise.allSettled([
        lone.don.client.delete(`/families/${lone.id}`),
        lone.don.client.post(`/trades/${offer.id}/accept`),
        api.app.get(EventsService).sweep(new Date()),
        admin.get(AdminService).adjustTreasury(lone.tag, 500, "race test"),
      ]);
      expect(disband.status === "fulfilled" && disband.value.status).toBe(204);
      const treasury = await one<{ balance: number }>(sql`select balance from currency_accounts where family_id = ${lone.id}`);
      expect(Number(treasury.balance)).toBe(0);
      // The trade either ran before the disband or was refused after it; never half-done.
      const trade = await one<{ status: string }>(sql`select status from trades where id = ${offer.id}`);
      const accepted = accept.status === "fulfilled" && ok(accept.value.status);
      expect(trade.status === "executed").toBe(accepted);
      // The credit either landed before the disband (and was swept to `disbanded`) or found no family.
      if (credit.status === "rejected") expect(credit.reason).toMatchObject({ code: "NOT_FOUND" });
      await api.db.execute(sql`update world_events set state = 'expired' where state <> 'expired'`);
    }
  });
});

describe("abandoning", () => {
  it("racing a battle declaration on the same territory: either the battle starts on held land, or the land is left and no battle starts", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const s = await sides();
      const [abandon, declare] = await Promise.all([
        s.defender.don.client.post(`/territories/${s.target}/abandon`),
        s.attacker.don.client.post(`/territories/${s.target}/battles`),
      ]);
      expect([abandon, declare].filter((r) => ok(r.status))).toHaveLength(1);
      const t = await one<{ owner_family_id: string | null; contested_battle_id: string | null }>(
        sql`select owner_family_id, contested_battle_id from territories where slug = ${s.target}`,
      );
      if (ok(declare.status)) expect([t.owner_family_id, t.contested_battle_id]).toEqual([s.defender.id, declare.body.id]);
      else expect([t.owner_family_id, t.contested_battle_id]).toEqual([null, null]);
      const fees = await rows(sql`select 1 from ledger_transactions where kind = 'battle' and ref_type = 'territory' and ref_id = ${s.target} and actor_player_id = ${s.attacker.don.id}`);
      expect(fees).toHaveLength(ok(declare.status) ? 1 : 0);
    }
  });

  it("racing the upkeep sweep that would lose it: the territory is released once", async () => {
    for (let i = 0; i < ROUNDS; i++) {
      const s = await sides();
      // Long unpaid and broke: the sweep would take it back at the same moment the family lets it go.
      await setBalance(s.defender.id, 0);
      await api.db.execute(sql`update territories set upkeep_paid_until = now() - interval '10 days', state = 'neglected' where slug = ${s.target}`);
      const [abandon] = await Promise.all([s.defender.don.client.post(`/territories/${s.target}/abandon`), api.app.get(TerritoriesService).sweepUpkeep(new Date())]);
      expect([204, 403]).toContain(abandon.status); // 403 when the sweep took it first: the family no longer holds it
      const t = await one<{ owner_family_id: string | null }>(sql`select owner_family_id from territories where slug = ${s.target}`);
      expect(t.owner_family_id).toBeNull();
      const releases = await rows(sql`
        select h.cause from territory_ownership_history h join territories t on t.id = h.territory_id
        where t.slug = ${s.target} and h.from_family_id = ${s.defender.id}`);
      expect(releases).toHaveLength(1);
    }
  });
});
