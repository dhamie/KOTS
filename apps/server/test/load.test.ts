import { NestFactory } from "@nestjs/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { LoadSeedModule, seedLoad } from "../src/db/seed-load";
import { seedMap, seedMarkets } from "../src/db/seed";
import { economyHelpers } from "./economy-helpers";
import { Client, resetTestDatabase, startApi, TEST_DATABASE_URL, type TestApi } from "./helpers";

/** Phase 10a: the load-test switch, and the data the load seed builds. */
describe("LOAD_TEST", () => {
  it("lifts only the per-IP limits, and can't be used in production", () => {
    const normal = loadConfig({});
    const load = loadConfig({ LOAD_TEST: "1" });
    expect(normal.loadTest).toBe(false);
    expect(normal.generalLimit.limit).toBe(300);
    expect(load.generalLimit.limit).toBeGreaterThan(100_000);
    expect(load.authIpLimit.limit).toBeGreaterThan(100_000);
    expect([load.authAccountLimit, load.chatLimit]).toEqual([normal.authAccountLimit, normal.chatLimit]);
    expect(() => loadConfig({ LOAD_TEST: "1", NODE_ENV: "production" })).toThrow("can't be used in production");
    expect(loadConfig({ LOAD_TEST: "yes" }).loadTest).toBe(false);
  });
});

describe("the load seed", () => {
  let api: TestApi;
  beforeAll(async () => {
    await resetTestDatabase();
    api = await startApi();
    await seedMap(api.db);
    await seedMarkets(api.db);
  });
  afterAll(async () => {
    await api?.close();
  });
  const { rows, expectLedgerConsistent } = economyHelpers(() => api, "Load");

  it("builds families of four with working sessions, land, henchmen and offers, through the services", async () => {
    const ctx = await NestFactory.createApplicationContext(LoadSeedModule.forDatabase(TEST_DATABASE_URL), { logger: false });
    let seeded: Awaited<ReturnType<typeof seedLoad>>;
    try {
      seeded = await seedLoad(ctx, 20);
    } finally {
      await ctx.close();
    }
    expect([seeded.players.length, seeded.families]).toEqual([20, 5]);
    expect(seeded.players.filter((p) => p.role === "don")).toHaveLength(5);
    expect(seeded.claimed).toBeGreaterThan(0);
    expect(seeded.offers).toBeGreaterThan(0);
    await expectLedgerConsistent();
    expect(await rows(sql`select family_id from family_memberships group by family_id having count(*) <> 4`)).toEqual([]);
    expect(Number((await rows<{ n: string }>(sql`select count(*) as n from henchmen where status = 'active'`))[0]!.n)).toBe(10);

    // Each cookie is a live session for its player.
    for (const p of seeded.players.slice(0, 4)) {
      const c = new Client(api.base, { cookie: p.cookie });
      const me = await c.get("/me");
      expect([me.status, me.body.player.handle, me.body.family.id]).toEqual([200, p.handle, p.familyId]);
    }
  });
});
