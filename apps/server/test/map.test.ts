import { DISTRICTS, TERRITORIES } from "@kots/content";
import { DistrictSummaryList, DistrictTerritories } from "@kots/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedMap } from "../src/db/seed";
import { Client, newPlayer, resetTestDatabase, startApi, type TestApi } from "./helpers";

let api: TestApi;
let client: Client;

beforeAll(async () => {
  await resetTestDatabase();
  api = await startApi();
  await seedMap(api.db);
  client = (await newPlayer(api.base)).client;
});

afterAll(async () => {
  await api?.close();
});

describe("map seed", () => {
  it("loads every district and territory from content", async () => {
    const [counts] = (await api.db.execute(sql`select (select count(*) from districts) as d, (select count(*) from territories) as t`)).rows;
    expect(counts).toEqual({ d: String(DISTRICTS.length), t: String(TERRITORIES.length) });
  });

  it("is idempotent and never touches ownership", async () => {
    const p = await newPlayer(api.base);
    const fam = await p.client.post("/families", { name: "Seed Keepers", tag: "SEED" });
    await api.db.execute(
      sql`update territories set owner_family_id = ${fam.body.id}, owned_since = now(), upkeep_paid_until = now() + interval '1 day' where slug = 'balogun'`,
    );
    await api.db.execute(sql`update territories set name = 'Old Name' where slug = 'idumota'`);

    const result = await seedMap(api.db);
    expect(result.stale).toEqual([]);
    const rows = (await api.db.execute(sql`select slug, name, owner_family_id from territories where slug in ('balogun', 'idumota') order by slug`)).rows;
    expect(rows).toEqual([
      { slug: "balogun", name: "Balogun Market", owner_family_id: fam.body.id },
      { slug: "idumota", name: "Idumota", owner_family_id: null },
    ]);
    const [row] = (await api.db.execute(sql`select count(*) as n from territories`)).rows as { n: string }[];
    expect(Number(row!.n)).toBe(TERRITORIES.length);
  });

  it("reports territories that left content instead of deleting them", async () => {
    const [d] = (await api.db.execute(sql`select id from districts limit 1`)).rows as { id: string }[];
    await api.db.execute(sql`insert into territories (id, slug, district_id, name, kind, base_income, base_upkeep) values (gen_random_uuid(), 'retired-spot', ${d!.id}, 'Retired', 'civic', 0, 0)`);
    expect((await seedMap(api.db)).stale).toEqual(["retired-spot"]);
    await api.db.execute(sql`delete from territories where slug = 'retired-spot'`);
  });
});

describe("GET /api/map", () => {
  it("districts: one summary per district with territory and ownership counts", async () => {
    const res = await client.get("/map/districts");
    expect(res.status).toBe(200);
    const list = DistrictSummaryList.parse(res.body);
    expect(list.map((d) => d.slug).sort()).toEqual(DISTRICTS.map((d) => d.slug).sort());
    const island = list.find((d) => d.slug === "lagos-island")!;
    expect(island.territoryCount).toBe(TERRITORIES.filter((t) => t.district === "lagos-island").length);
    expect(island.ownedCount).toBe(1); // balogun, from the seed test
  });

  it("territories: only the requested district, runtime state only", async () => {
    const res = await client.get("/map/territories?district=lagos-island");
    expect(res.status).toBe(200);
    const body = DistrictTerritories.parse(res.body);
    expect(body.territories.map((t) => t.slug).sort()).toEqual(TERRITORIES.filter((t) => t.district === "lagos-island").map((t) => t.slug).sort());
    expect(body.territories.find((t) => t.slug === "balogun")!.owner).toMatchObject({ name: "Seed Keepers", tag: "SEED" });
    expect(body.territories.find((t) => t.slug === "idumota")!.owner).toBeNull();
    expect(Object.keys(body.territories[0]!).sort()).toEqual(["battleId", "owner", "slug"]);
  });

  it("unknown district is a 404, malformed or missing query a 400", async () => {
    expect((await client.get("/map/territories?district=atlantis")).status).toBe(404);
    expect((await client.get("/map/territories?district=DROP%20TABLE")).status).toBe(400);
    expect((await client.get("/map/territories")).status).toBe(400);
  });

  it("requires login", async () => {
    expect((await new Client(api.base).get("/map/districts")).status).toBe(401);
    expect((await new Client(api.base).get("/map/territories?district=apapa")).status).toBe(401);
  });

  it("the territory lookups can use their indexes", async () => {
    // The tables are tiny, so the planner rightly prefers a scan; disabling scans proves usable indexes exist.
    await api.db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const plan = (await tx.execute(sql`explain select slug from territories where district_id = (select id from districts where slug = 'apapa')`)).rows
        .map((r) => Object.values(r)[0])
        .join("\n");
      expect(plan).toMatch(/territories_district_idx/);
      expect(plan).toMatch(/districts_slug_unique/);
    });
  });
});
