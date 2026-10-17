import { ChatChannelList, type ChatChannel, type ServerEvent } from "@kots/shared";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool } from "../src/db/db";
import { RealtimeService, rooms } from "../src/modules/realtime/realtime.service";
import { TradesService } from "../src/modules/trades/trades.service";
import { economyHelpers } from "./economy-helpers";
import { newPlayer, resetTestDatabase, startApi, TEST_DATABASE_URL, TestClock, type Client, type TestApi, keyed } from "./helpers";
import { closeAllSockets, connect, settle } from "./socket-helpers";

let api: TestApi;
const clock = new TestClock();

beforeAll(async () => {
  await resetTestDatabase();
  api = await startApi(undefined, clock);
});

afterEach(() => closeAllSockets());

afterAll(async () => {
  await api?.close();
});

const { family, ageForTrading } = economyHelpers(() => api, "Live");
const channel = async (c: Client, kind: ChatChannel["kind"]) => ChatChannelList.parse((await c.get("/chat/channels")).body).find((ch) => ch.kind === kind)!;
const say = async (c: Client, channelId: string, body: string) => expect((await c.post(`/chat/channels/${channelId}/messages`, { body })).status).toBe(201);
const chatBodies = (events: ServerEvent[]) => events.flatMap((e) => (e.type === "chat.message" ? [e.message.body] : []));

describe("connecting", () => {
  it("needs a session cookie, and refuses a foreign Origin", async () => {
    await expect(connect(api.base)).rejects.toThrow("UNAUTHENTICATED");
    const p = await newPlayer(api.base);
    await expect(connect(api.base, p.client, { origin: "https://evil.example" })).rejects.toThrow("ORIGIN_REJECTED");
    const ok = await connect(api.base, p.client, { origin: "http://localhost:5180" });
    expect(ok.socket.connected).toBe(true);
  });

  it("logging out disconnects that session's sockets", async () => {
    const p = await newPlayer(api.base);
    const live = await connect(api.base, p.client);
    const closed = new Promise<string>((resolve) => live.socket.once("disconnect", resolve));
    expect((await p.client.post("/auth/logout")).status).toBe(204);
    expect(await closed).toBe("io server disconnect");
  });
});

describe("rooms", () => {
  it("family chat reaches the family's sockets only; public chat reaches everyone; direct chat only the two players", async () => {
    const a = await family(["associate"]);
    const b = await family();
    const loner = await newPlayer(api.base);
    const [aDon, aMember, bDon, lone] = await Promise.all([connect(api.base, a.don.client), connect(api.base, a.members[0]!.client), connect(api.base, b.don.client), connect(api.base, loner.client)]);

    await say(a.don.client, (await channel(a.don.client, "family")).id, "family only");
    expect((await aMember.next("chat.message")).message).toMatchObject({ body: "family only", author: { handle: a.don.handle } });
    await say(loner.client, (await channel(loner.client, "public")).id, "hello Lagos");
    const dm = (await a.don.client.post("/chat/direct", { handle: loner.handle })).body as ChatChannel;
    await say(a.don.client, dm.id, "just us");
    await Promise.all([bDon.next("chat.message", (e) => e.message.body === "hello Lagos"), lone.next("chat.message", (e) => e.message.body === "just us")]);
    await settle();

    expect(chatBodies(aDon.events)).toEqual(["family only", "hello Lagos", "just us"]);
    expect(chatBodies(aMember.events)).toEqual(["family only", "hello Lagos"]);
    expect(chatBodies(bDon.events)).toEqual(["hello Lagos"]);
    expect(chatBodies(lone.events)).toEqual(["hello Lagos", "just us"]);
  });

  it("a kicked member stops hearing the family at once; a new member starts, without reconnecting", async () => {
    const f = await family(["associate"]);
    const kicked = f.members[0]!;
    const joiner = await newPlayer(api.base);
    const [kickedLive, joinerLive] = await Promise.all([connect(api.base, kicked.client), connect(api.base, joiner.client)]);
    const fam = await channel(f.don.client, "family");

    expect((await f.don.client.delete(`/families/${f.id}/members/${kicked.id}`)).status).toBe(200);
    await kickedLive.next("me.changed");
    const inv = await f.don.client.post(`/families/${f.id}/invitations`, { handle: joiner.handle });
    await joinerLive.next("notification", (e) => e.notification.type === "member.invited");
    expect((await joiner.client.post(`/invitations/${inv.body.id}/accept`)).status).toBe(200);
    await joinerLive.next("me.changed");
    await settle();

    await say(f.don.client, fam.id, "after the changes");
    await joinerLive.next("chat.message", (e) => e.message.body === "after the changes");
    await settle();
    expect(chatBodies(kickedLive.events)).toEqual([]);
  });

  it("family activity tells the family's sockets to refresh", async () => {
    const f = await family(["associate"]);
    const live = await connect(api.base, f.members[0]!.client);
    const other = await connect(api.base, (await newPlayer(api.base)).client);
    expect((await f.don.client.post(`/families/${f.id}/invitations`, { handle: (await newPlayer(api.base)).handle })).status).toBe(201);
    await live.next("family.changed");
    await settle();
    expect(other.events.filter((e) => e.type === "family.changed")).toEqual([]);
  });
});

describe("delivery", () => {
  it("an event published in a rolled-back transaction is never delivered", async () => {
    const p = await newPlayer(api.base);
    const live = await connect(api.base, p.client);
    const realtime = api.app.get(RealtimeService);
    await api.db
      .transaction(async (tx) => {
        await realtime.publish(tx, [rooms.player(p.id)], { type: "resync" });
        throw new Error("roll back");
      })
      .catch(() => undefined);
    await api.db.transaction((tx) => realtime.publish(tx, [rooms.player(p.id)], { type: "me.changed" }));
    await live.next("me.changed");
    await settle();
    expect(live.events.map((e) => e.type)).toEqual(["me.changed"]);
  });

  it("if the listening connection drops, it reconnects and tells every socket to reload what it missed", async () => {
    const p = await newPlayer(api.base);
    const live = await connect(api.base, p.client);
    const killed = await api.db.execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where query = 'LISTEN kots_events' and datname = current_database()`);
    expect(killed.rows.length).toBeGreaterThanOrEqual(1);
    await live.next("resync", undefined, 10_000);
    await api.db.transaction((tx) => api.app.get(RealtimeService).publish(tx, [rooms.player(p.id)], { type: "me.changed" }));
    await live.next("me.changed");
  });

  it("events from another process's connection reach the sockets (as the worker's sweeps do)", async () => {
    const a = await family();
    const b = await family();
    await Promise.all([ageForTrading(a.id), ageForTrading(b.id)]);
    expect((await a.don.client.post(`/families/${a.id}/trades`, { to: b.tag, gives: [{ cash: 100 }], wants: [] }, keyed())).status).toBe(201);
    const live = await connect(api.base, a.don.client);

    // A publish from a separate connection pool, as the worker process makes.
    const pool = createPool(TEST_DATABASE_URL);
    try {
      const db = createDb(pool);
      await db.transaction((tx) => api.app.get(RealtimeService).publish(tx, [rooms.family(a.id)], { type: "family.changed" }));
    } finally {
      await pool.end();
    }
    await live.next("family.changed");

    // The trade-expiry sweep the worker runs: its notification arrives live, once.
    await api.app.get(TradesService).sweepExpired(new Date(clock.now().getTime() + 2 * 24 * 3600_000));
    const note = await live.next("notification", (e) => e.notification.type === "trade.expired");
    expect(note.notification.body).toBe(`An offer between your family and [${b.tag}] expired.`);
    const [row] = (await api.db.execute(sql`select count(*)::int as n from notifications where player_id = ${a.don.id} and type = 'trade.expired'`)).rows as { n: number }[];
    expect(row!.n).toBe(1);
  });
});
