import { ChatChannelList } from "@kots/shared";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DB, type Database } from "../src/db/db";
import { SESSION_CACHE_MS, SessionsService } from "../src/modules/auth/sessions.service";
import { economyHelpers } from "./economy-helpers";
import { newPlayer, resetTestDatabase, startApi, type TestApi } from "./helpers";

/** Phase 10b: the per-process session cache and the read-only channel listing. */
let api: TestApi;
beforeAll(async () => {
  await resetTestDatabase();
  api = await startApi();
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await api?.close();
});
const { family } = economyHelpers(() => api, "Perf");
const tokenOf = (cookie: string) => cookie.split("=")[1]!;

describe("the session cache", () => {
  it("trusts a session it just looked up without asking the database, until the cache window ends", async () => {
    const p = await newPlayer(api.base); // its /me puts the session in the cache
    const sessions = api.app.get(SessionsService);
    const token = tokenOf(p.client.sessionCookie!);
    // Removed behind the service's back (no logout, no signal): only the cache still knows it.
    await api.db.execute(sql`delete from sessions where user_id = (select user_id from players where id = ${p.id})`);
    expect((await sessions.resolve(token))?.playerId).toBe(p.id);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + SESSION_CACHE_MS + 1);
    expect(await sessions.resolve(token)).toBeUndefined();
  });

  it("logout ends the session at once, cache or not", async () => {
    const p = await newPlayer(api.base);
    expect((await p.client.get("/me")).status).toBe(200);
    const cookie = p.client.sessionCookie!;
    expect((await p.client.post("/auth/logout")).status).toBe(204);
    expect(await api.app.get(SessionsService).resolve(tokenOf(cookie))).toBeUndefined();
  });
});

describe("listing chat channels", () => {
  it("only reads once the family channel exists", async () => {
    const f = await family();
    const first = ChatChannelList.parse((await f.don.client.get("/chat/channels")).body);
    expect(first.some((c) => c.kind === "family")).toBe(true);
    const insert = vi.spyOn(api.app.get<Database>(DB), "insert");
    const again = ChatChannelList.parse((await f.don.client.get("/chat/channels")).body);
    expect(again.map((c) => c.id)).toEqual(first.map((c) => c.id));
    expect(insert).not.toHaveBeenCalled();
  });
});
