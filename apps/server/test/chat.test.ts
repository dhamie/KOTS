import { BlockList, ChatChannel, ChatChannelList, ChatMessage, ChatPage, MeResponse, ReportList } from "@kots/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { economyHelpers } from "./economy-helpers";
import { newPlayer, resetTestDatabase, startApi, testConfig, type Client, type TestApi } from "./helpers";

let api: TestApi;

beforeAll(async () => {
  await resetTestDatabase();
  api = await startApi();
});

afterAll(async () => {
  await api?.close();
});

const { rows, family } = economyHelpers(() => api, "Chat");
const player = () => newPlayer(api.base);

const channels = async (c: Client) => ChatChannelList.parse((await c.get("/chat/channels")).body);
const channelOf = async (c: Client, kind: ChatChannel["kind"]) => (await channels(c)).find((ch) => ch.kind === kind)!;
const send = (c: Client, channelId: string, body: string) => c.post(`/chat/channels/${channelId}/messages`, { body });
const page = async (c: Client, channelId: string, query = "") => {
  const res = await c.get(`/chat/channels/${channelId}/messages${query}`);
  expect(res.status).toBe(200);
  return ChatPage.parse(res.body);
};
const bodies = async (c: Client, channelId: string) => (await page(c, channelId)).items.map((m) => m.body);
const makeModerator = (playerId: string) => api.db.execute(sql`update players set is_moderator = true where id = ${playerId}`);

describe("channels", () => {
  it("a player outside a family sees the public channel; a member also sees their family's", async () => {
    const loner = await player();
    expect((await channels(loner.client)).map((c) => [c.kind, c.name])).toEqual([["public", "Lagos"]]);

    const f = await family();
    const list = await channels(f.don.client);
    expect(list.map((c) => c.kind)).toEqual(["family", "public"]);
    expect(list[0]!.name).toMatch(/^Chat /);
  });

  it("family chat is for current members only: an outsider and a kicked member get 404", async () => {
    const f = await family(["associate"]);
    const outsider = await player();
    const fam = await channelOf(f.don.client, "family");
    expect((await send(f.members[0]!.client, fam.id, "hello family")).status).toBe(201);
    expect((await outsider.client.get(`/chat/channels/${fam.id}/messages`)).status).toBe(404);
    expect((await send(outsider.client, fam.id, "let me in")).status).toBe(404);

    expect((await f.don.client.delete(`/families/${f.id}/members/${f.members[0]!.id}`)).status).toBe(200);
    expect((await f.members[0]!.client.get(`/chat/channels/${fam.id}/messages`)).status).toBe(404);
    expect((await send(f.members[0]!.client, fam.id, "still here?")).status).toBe(404);
    expect(await bodies(f.don.client, fam.id)).toEqual(["hello family"]);
  });

  it("direct channels: opened by handle, found again rather than duplicated, private to the two players", async () => {
    const [a, b, c] = await Promise.all([player(), player(), player()]);
    const opened = await a.client.post("/chat/direct", { handle: b.handle });
    expect(opened.status).toBe(200);
    const dm = ChatChannel.parse(opened.body);
    expect(dm).toMatchObject({ kind: "direct", name: b.handle, with: { id: b.id, handle: b.handle } });
    expect(ChatChannel.parse((await b.client.post("/chat/direct", { handle: a.handle })).body).id).toBe(dm.id);

    expect((await send(a.client, dm.id, "psst")).status).toBe(201);
    expect(await bodies(b.client, dm.id)).toEqual(["psst"]);
    expect((await c.client.get(`/chat/channels/${dm.id}/messages`)).status).toBe(404);
    expect((await channels(b.client)).find((ch) => ch.id === dm.id)).toMatchObject({ name: a.handle, unread: 1 });

    expect((await a.client.post("/chat/direct", { handle: a.handle })).status).toBe(400);
    expect((await a.client.post("/chat/direct", { handle: "nobody_here" })).status).toBe(404);
    expect((await a.client.get("/chat/channels/not-a-uuid/messages")).status).toBe(404);
  });
});

describe("messages", () => {
  it("are validated: trimmed, 1 to 500 characters, no NUL, no extra fields", async () => {
    const p = await player();
    const pub = await channelOf(p.client, "public");
    expect((await send(p.client, pub.id, "   ")).status).toBe(400);
    expect((await send(p.client, pub.id, "x".repeat(501))).status).toBe(400);
    expect((await send(p.client, pub.id, "bad\u0000byte")).status).toBe(400);
    expect((await p.client.post(`/chat/channels/${pub.id}/messages`, { body: "hi", channel: "x" })).status).toBe(400);
    const ok = await send(p.client, pub.id, `  ${"y".repeat(500)}  `);
    expect(ok.status).toBe(201);
    expect(ChatMessage.parse(ok.body)).toMatchObject({ body: "y".repeat(500), author: { id: p.id, handle: p.handle }, channelId: pub.id });
  });

  it("page newest first, with a cursor for older ones", async () => {
    const [a, b] = await Promise.all([player(), player()]);
    const dm = ChatChannel.parse((await a.client.post("/chat/direct", { handle: b.handle })).body);
    for (let i = 1; i <= 7; i++) expect((await send(i % 2 ? a.client : b.client, dm.id, `m${i}`)).status).toBe(201);
    const first = await page(a.client, dm.id, "?limit=3");
    expect(first.items.map((m) => m.body)).toEqual(["m7", "m6", "m5"]);
    const second = await page(a.client, dm.id, `?limit=3&before=${first.nextCursor}`);
    expect(second.items.map((m) => m.body)).toEqual(["m4", "m3", "m2"]);
    const last = await page(a.client, dm.id, `?limit=3&before=${second.nextCursor}`);
    expect([last.items.map((m) => m.body), last.nextCursor]).toEqual([["m1"], null]);
  });

  it("unread counts others' messages since the last read mark, and marking read clears them", async () => {
    const f = await family(["associate"]);
    const fam = await channelOf(f.don.client, "family");
    const sent = [];
    for (const body of ["one", "two", "three"]) sent.push(ChatMessage.parse((await send(f.don.client, fam.id, body)).body));
    expect((await channelOf(f.members[0]!.client, "family")).unread).toBe(3);
    expect((await channelOf(f.don.client, "family")).unread).toBe(0); // own messages don't count

    expect((await f.members[0]!.client.post(`/chat/channels/${fam.id}/read`, { upTo: sent[1]!.id })).status).toBe(204);
    expect((await channelOf(f.members[0]!.client, "family")).unread).toBe(1);
    // Marking an older message read never moves the mark back.
    await f.members[0]!.client.post(`/chat/channels/${fam.id}/read`, { upTo: sent[2]!.id });
    await f.members[0]!.client.post(`/chat/channels/${fam.id}/read`, { upTo: sent[0]!.id });
    expect((await channelOf(f.members[0]!.client, "family")).unread).toBe(0);
  });

  it("are limited per player: the sixth in ten seconds is refused, and other players are unaffected", async () => {
    const limited = await startApi(testConfig({ chatLimit: { limit: 5, ttlMs: 10_000 } }));
    try {
      const [p, q] = await Promise.all([newPlayer(limited.base), newPlayer(limited.base)]);
      const pub = (ChatChannelList.parse((await p.client.get("/chat/channels")).body))[0]!;
      for (let i = 0; i < 5; i++) expect((await p.client.post(`/chat/channels/${pub.id}/messages`, { body: `n${i}` })).status).toBe(201);
      const refused = await p.client.post(`/chat/channels/${pub.id}/messages`, { body: "one more" });
      expect([refused.status, refused.body.code]).toEqual([429, "RATE_LIMITED"]);
      expect((await q.client.post(`/chat/channels/${pub.id}/messages`, { body: "me too" })).status).toBe(201);
    } finally {
      await limited.close();
    }
  });
});

describe("deleting and reporting", () => {
  it("authors delete their own messages; other players can't", async () => {
    const [a, b] = await Promise.all([player(), player()]);
    const pub = await channelOf(a.client, "public");
    const m = ChatMessage.parse((await send(a.client, pub.id, `mine ${a.handle}`)).body);
    expect((await b.client.delete(`/chat/messages/${m.id}`)).status).toBe(403);
    expect((await a.client.delete(`/chat/messages/${m.id}`)).status).toBe(204);
    expect((await a.client.delete(`/chat/messages/${m.id}`)).status).toBe(404);
    expect(await bodies(b.client, pub.id)).not.toContain(`mine ${a.handle}`);
    expect(await rows(sql`select 1 from moderation_actions where target_id = ${m.id}`)).toEqual([]);
  });

  it("reports: once per player, not your own, only messages you can see", async () => {
    const f = await family(["associate"]);
    const outsider = await player();
    const fam = await channelOf(f.don.client, "family");
    const m = ChatMessage.parse((await send(f.don.client, fam.id, "family secret")).body);
    expect((await f.members[0]!.client.post(`/chat/messages/${m.id}/report`, { reason: "abuse", note: "rude" })).status).toBe(204);
    expect((await f.members[0]!.client.post(`/chat/messages/${m.id}/report`, { reason: "spam" })).status).toBe(204);
    expect(await rows(sql`select reason from message_reports where message_id = ${m.id}`)).toEqual([{ reason: "abuse" }]);
    expect((await f.don.client.post(`/chat/messages/${m.id}/report`, { reason: "spam" })).status).toBe(400);
    expect((await outsider.client.post(`/chat/messages/${m.id}/report`, { reason: "spam" })).status).toBe(404);
    expect((await f.members[0]!.client.post(`/chat/messages/${m.id}/report`, { reason: "nonsense" })).status).toBe(400);
  });

  it("moderators see open reports, delete any message (audited, closing its reports) and dismiss reports (audited)", async () => {
    const [author, reporter, mod, plain] = await Promise.all([player(), player(), player(), player()]);
    await makeModerator(mod.id);
    expect(MeResponse.parse((await mod.client.get("/me")).body).moderator).toBe(true);
    expect(MeResponse.parse((await plain.client.get("/me")).body).moderator).toBe(false);
    const pub = await channelOf(author.client, "public");
    const bad = ChatMessage.parse((await send(author.client, pub.id, "something nasty")).body);
    const fine = ChatMessage.parse((await send(author.client, pub.id, "something fine")).body);
    await reporter.client.post(`/chat/messages/${bad.id}/report`, { reason: "abuse" });
    await reporter.client.post(`/chat/messages/${fine.id}/report`, { reason: "spam" });

    expect((await plain.client.get("/moderation/reports")).status).toBe(403);
    const reports = ReportList.parse((await mod.client.get("/moderation/reports")).body);
    const forBad = reports.find((r) => r.message.id === bad.id)!;
    const forFine = reports.find((r) => r.message.id === fine.id)!;
    expect(forBad).toMatchObject({ reason: "abuse", reporter: { handle: reporter.handle }, message: { body: "something nasty", author: { handle: author.handle } }, channelKind: "public" });

    expect((await mod.client.delete(`/chat/messages/${bad.id}`)).status).toBe(204);
    expect((await plain.client.post(`/moderation/reports/${forFine.id}/dismiss`)).status).toBe(403);
    expect((await mod.client.post(`/moderation/reports/${forFine.id}/dismiss`)).status).toBe(204);
    expect((await mod.client.post(`/moderation/reports/${forFine.id}/dismiss`)).status).toBe(404);

    expect(await rows(sql`select status from message_reports where id in (${forBad.id}, ${forFine.id}) order by status`)).toEqual([
      { status: "actioned" },
      { status: "dismissed" },
    ]);
    expect(
      await rows(sql`select moderator_id, action, target_type, target_id, details->>'body' as body from moderation_actions where moderator_id = ${mod.id} order by id`),
    ).toEqual([
      { moderator_id: mod.id, action: "delete_message", target_type: "message", target_id: bad.id, body: "something nasty" },
      { moderator_id: mod.id, action: "dismiss_report", target_type: "report", target_id: forFine.id, body: null },
    ]);
    const open = ReportList.parse((await mod.client.get("/moderation/reports")).body);
    expect(open.map((r) => r.id)).not.toContain(forBad.id);
    expect(await bodies(plain.client, pub.id)).not.toContain("something nasty");
  });
});

describe("blocking", () => {
  it("hides the blocked player's messages from the blocker, in history and unread counts", async () => {
    const f = await family(["associate", "associate"]);
    const [blocker, pest] = f.members as [(typeof f.members)[0], (typeof f.members)[0]];
    const fam = await channelOf(f.don.client, "family");
    const blocked = await blocker.client.post("/blocks", { handle: pest.handle });
    expect(blocked.status).toBe(200);
    expect(BlockList.parse(blocked.body)).toEqual([{ id: pest.id, handle: pest.handle }]);
    await send(pest.client, fam.id, "annoying");
    await send(f.don.client, fam.id, "orders");
    expect(await bodies(blocker.client, fam.id)).toEqual(["orders"]);
    expect((await channelOf(blocker.client, "family")).unread).toBe(1);
    expect(await bodies(f.don.client, fam.id)).toEqual(["orders", "annoying"]);

    expect((await blocker.client.delete(`/blocks/${pest.id}`)).status).toBe(204);
    expect(await bodies(blocker.client, fam.id)).toEqual(["orders", "annoying"]);
    expect(BlockList.parse((await blocker.client.get("/blocks")).body)).toEqual([]);
  });

  it("stops direct messages both ways, including in a channel opened before the block", async () => {
    const [a, b] = await Promise.all([player(), player()]);
    const dm = ChatChannel.parse((await a.client.post("/chat/direct", { handle: b.handle })).body);
    await b.client.post("/blocks", { handle: a.handle });
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const res = await send(from.client, dm.id, "hello?");
      expect([res.status, res.body.code]).toEqual([403, "BLOCKED"]);
      expect((await from.client.post("/chat/direct", { handle: to.handle })).body.code).toBe("BLOCKED");
    }
    expect((await a.client.post("/blocks", { handle: a.handle })).status).toBe(400);
  });
});
