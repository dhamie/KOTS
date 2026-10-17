import { CITY } from "@kots/content";
import { ChatChannel, ChatChannelList, Henchman, NotificationPage, Proposal } from "@kots/shared";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { seedMap, seedMarkets } from "../src/db/seed";
import { economyHelpers } from "./economy-helpers";
import { keyed, newPlayer, resetTestDatabase, startApi, type TestApi } from "./helpers";

let api: TestApi;
beforeAll(async () => {
  await resetTestDatabase();
  api = await startApi();
  await seedMap(api.db);
  await seedMarkets(api.db);
});
afterEach(async () => {
  await expectLedgerConsistent();
});
afterAll(async () => {
  await api?.close();
});

const { rows, family, setBalance, ageForTrading, expectLedgerConsistent } = economyHelpers(() => api, "Rty");
type Res = { status: number; body: any };
const log: string[] = [];
/** Sends the same request twice in a row, as a player would after a lost response, and records both statuses. */
async function twice(label: string, send: () => Promise<Res>): Promise<[Res, Res]> {
  const first = await send();
  const second = await send();
  log.push(`${label}: ${first.status} then ${second.status}${second.body?.code ? ` ${second.body.code}` : ""}`);
  return [first, second];
}
const count = async (q: ReturnType<typeof sql>) => Number((await rows<{ n: string }>(q))[0]!.n);

/**
 * Phase 9b: what each write does when a player sends it again because the first response was lost. None may act
 * twice: keyed requests (market orders, trade offers, proposals) return the first result; the rest either end in the
 * same state or are refused because the first already happened. The one exception is a chat message, which is
 * posted again (harmless, and visible to the player).
 */
const EXPECTED = [
  "claim: 200 then 409 TERRITORY_OWNED",
  "abandon: 204 then 403 FORBIDDEN",
  "hire: 201 then 409 ALREADY_HIRED",
  "assign: 200 then 200",
  "dismiss: 204 then 404 NOT_FOUND",
  "market order, same key: 200 then 200",
  "market order, same key, other order: 400",
  "trade offer, same key: 201 then 201",
  "trade offer ids equal: true",
  "trade offer, same key, other offer: 400",
  "trade accept: 200 then 200",
  "trade decline: 200 then 409 TRADE_CLOSED",
  "trade cancel: 200 then 409 TRADE_CLOSED",
  "declare battle: 201 then 409 TERRITORY_CONTESTED",
  "commit: 200 then 200",
  "release: 200 then 200",
  "order: 200 then 200",
  "withdraw: 200 then 409 BATTLE_CLOSED",
  "open room: 200 then 200",
  "room ids equal: true",
  "proposal, same key: 201 then 201",
  "proposal ids equal: true",
  "proposal, same key, other terms: 400",
  "proposal decline: 200 then 409 PROPOSAL_CLOSED",
  "proposal withdraw: 200 then 409 PROPOSAL_CLOSED",
  "proposal sign: 200 then 200",
  "invite: 201 then 409 ALREADY_INVITED",
  "accept invitation: 200 then 404 NOT_FOUND",
  "decline invitation: 204 then 404 NOT_FOUND",
  "revoke invitation: 204 then 404 NOT_FOUND",
  "set role: 200 then 403 FORBIDDEN",
  "kick: 200 then 404 NOT_FOUND",
  "leave: 204 then 403 FORBIDDEN",
  "transfer leadership: 200 then 403 FORBIDDEN",
  "create family: 201 then 409 ALREADY_IN_FAMILY",
  "disband: 204 then 404 NOT_FOUND",
  "chat send: 201 then 201",
  "chat read: 204 then 204",
  "open direct: 200 then 200",
  "block: 200 then 200",
  "unblock: 204 then 204",
  "notification read: 204 then 204",
  "read all: 204 then 204",
];

it("every write sent twice acts once (except a chat message), with the answers in EXPECTED", { timeout: 120_000 }, async () => {
  const [f1, f2, f3] = [await family(["associate"]), await family(), await family()];
  for (const f of [f1, f2, f3]) {
    await ageForTrading(f.id);
    await setBalance(f.id, 100_000);
  }
  const borders = (s: string) => CITY.territories.get(s)!.borders;
  const target = [...CITY.territories.keys()].sort().find((t) => borders(t).length >= 2)!;
  const [second, base] = borders(target) as [string, string];
  for (const [f, s] of [[f2, target], [f2, second], [f1, base]] as const) expect((await f.don.client.post(`/territories/${s}/claim`)).status).toBe(200);
  const far = [...CITY.territories.keys()].find((t) => ![target, second, base, ...borders(target), ...borders(second), ...borders(base)].includes(t))!;

  await twice("claim", () => f3.don.client.post(`/territories/${far}/claim`));
  await twice("abandon", () => f3.don.client.post(`/territories/${far}/abandon`));
  const [h] = await twice("hire", () => f1.don.client.post(`/families/${f1.id}/recruits`, { slot: 0 }));
  const guard = Henchman.parse(h.body);
  await twice("assign", () => f1.don.client.patch(`/henchmen/${guard.id}`, { territory: base }));
  const spare = Henchman.parse((await f1.don.client.post(`/families/${f1.id}/recruits`, { slot: 1 })).body);
  await twice("dismiss", () => f1.don.client.post(`/henchmen/${spare.id}/dismiss`));
  const fighter = Henchman.parse((await f1.don.client.post(`/families/${f1.id}/recruits`, { slot: 2 })).body);

  const order = keyed();
  await twice("market order, same key", () => f1.don.client.post("/markets/balogun/orders", { side: "buy", good: "fuel", quantity: 1, limitTotal: 100_000 }, order));
  log.push(`market order, same key, other order: ${(await f1.don.client.post("/markets/balogun/orders", { side: "buy", good: "fuel", quantity: 2, limitTotal: 100_000 }, order)).status}`);

  const offerKey = keyed();
  const [o1, o2] = await twice("trade offer, same key", () => f1.don.client.post(`/families/${f1.id}/trades`, { to: f2.tag, gives: [{ cash: 10 }], wants: [] }, offerKey));
  log.push(`trade offer ids equal: ${o1.body.id === o2.body.id}`);
  log.push(`trade offer, same key, other offer: ${(await f1.don.client.post(`/families/${f1.id}/trades`, { to: f2.tag, gives: [{ cash: 11 }], wants: [] }, offerKey)).status}`);
  await twice("trade accept", () => f2.don.client.post(`/trades/${o1.body.id}/accept`));
  const toDecline = (await f1.don.client.post(`/families/${f1.id}/trades`, { to: f2.tag, gives: [{ cash: 10 }], wants: [] }, keyed())).body;
  await twice("trade decline", () => f2.don.client.post(`/trades/${toDecline.id}/decline`));
  const toCancel = (await f1.don.client.post(`/families/${f1.id}/trades`, { to: f2.tag, gives: [{ cash: 10 }], wants: [] }, keyed())).body;
  await twice("trade cancel", () => f1.don.client.post(`/trades/${toCancel.id}/cancel`));

  const [b] = await twice("declare battle", () => f1.don.client.post(`/territories/${target}/battles`));
  await twice("commit", () => f1.don.client.post(`/battles/${b.body.id}/commit`, { henchmen: [fighter.id] }));
  await twice("release", () => f1.don.client.post(`/battles/${b.body.id}/release`, { henchmen: [fighter.id] }));
  await twice("order", () => f1.don.client.post(`/battles/${b.body.id}/orders`, { round: 1, tactic: "press" }));
  await twice("withdraw", () => f1.don.client.post(`/battles/${b.body.id}/withdraw`));

  const [r1, r2] = await twice("open room", () => f1.don.client.post("/diplomacy/rooms", { tag: f2.tag }));
  log.push(`room ids equal: ${r1.body.id === r2.body.id}`);
  const room = ChatChannel.parse(r1.body);
  const propKey = keyed();
  const [p1, p2] = await twice("proposal, same key", () => f1.don.client.post(`/diplomacy/rooms/${room.id}/proposals`, { terms: { kind: "ceasefire", hours: 24 } }, propKey));
  log.push(`proposal ids equal: ${p1.body.id === p2.body.id}`);
  log.push(`proposal, same key, other terms: ${(await f1.don.client.post(`/diplomacy/rooms/${room.id}/proposals`, { terms: { kind: "ceasefire", hours: 72 } }, propKey)).status}`);
  const pdRes = await f1.don.client.post(`/diplomacy/rooms/${room.id}/proposals`, { terms: { kind: "ceasefire", hours: 72 } }, keyed());
  const pd = Proposal.parse(pdRes.body);
  await twice("proposal decline", () => f2.don.client.post(`/proposals/${pd.id}/decline`));
  const pwRes = await f1.don.client.post(`/diplomacy/rooms/${room.id}/proposals`, { terms: { kind: "ceasefire", hours: 168 } }, keyed());
  const pw = Proposal.parse(pwRes.body);
  await twice("proposal withdraw", () => f1.don.client.post(`/proposals/${pw.id}/withdraw`));
  await twice("proposal sign", () => f2.don.client.post(`/proposals/${p1.body.id}/sign`));

  const [x, y, z] = [await newPlayer(api.base), await newPlayer(api.base), await newPlayer(api.base)];
  const [inv] = await twice("invite", () => f1.don.client.post(`/families/${f1.id}/invitations`, { handle: x.handle }));
  await twice("accept invitation", () => x.client.post(`/invitations/${inv.body.id}/accept`));
  const invY = (await f1.don.client.post(`/families/${f1.id}/invitations`, { handle: y.handle })).body;
  await twice("decline invitation", () => y.client.post(`/invitations/${invY.id}/decline`));
  const invZ = (await f1.don.client.post(`/families/${f1.id}/invitations`, { handle: z.handle })).body;
  await twice("revoke invitation", () => f1.don.client.delete(`/families/${f1.id}/invitations/${invZ.id}`));
  await twice("set role", () => f1.don.client.patch(`/families/${f1.id}/members/${x.id}`, { role: "capo" }));
  await twice("kick", () => f1.don.client.delete(`/families/${f1.id}/members/${x.id}`));
  await twice("leave", () => f1.members[0]!.client.post(`/families/${f1.id}/leave`));
  const f4 = await family(["associate"]);
  await twice("transfer leadership", () => f4.don.client.post(`/families/${f4.id}/transfer-leadership`, { playerId: f4.members[0]!.id }));
  const [created] = await twice("create family", () => y.client.post("/families", { name: `Retry ${Date.now() % 1e5}`, tag: "RTY9" }));
  await twice("disband", () => y.client.delete(`/families/${created.body.id}`));

  const ch = ChatChannelList.parse((await f2.don.client.get("/chat/channels")).body).find((c) => c.kind === "family")!;
  const [m] = await twice("chat send", () => f2.don.client.post(`/chat/channels/${ch.id}/messages`, { body: "same words" }));
  await twice("chat read", () => f2.don.client.post(`/chat/channels/${ch.id}/read`, { upTo: String(m.body.id) }));
  await twice("open direct", () => f2.don.client.post("/chat/direct", { handle: z.handle }));
  await twice("block", () => z.client.post("/blocks", { handle: f2.don.handle }));
  await twice("unblock", () => z.client.delete(`/blocks/${f2.don.id}`));
  const note = NotificationPage.parse((await f2.don.client.get("/notifications")).body).items[0]!;
  await twice("notification read", () => f2.don.client.post(`/notifications/${note.id}/read`));
  await twice("read all", () => f2.don.client.post("/notifications/read-all"));
  expect(log).toEqual(EXPECTED);

  // And the effects happened once.
  const n = (q: ReturnType<typeof sql>) => count(q);
  expect(await n(sql`select count(*) as n from chat_messages where body = 'same words'`)).toBe(2);
  expect(await n(sql`select count(*) as n from ledger_transactions where kind = 'territory_claim' and ref_type = 'territory' and ref_id = ${far}`)).toBe(1);
  expect(await n(sql`select count(*) as n from henchmen where family_id = ${f1.id} and recruit_key like ${`%:0`}`)).toBe(1);
  expect(await n(sql`select count(*) as n from market_orders where request_key = ${order["idempotency-key"]}`)).toBe(1);
  expect(await n(sql`select count(*) as n from trades where request_key = ${offerKey["idempotency-key"]}`)).toBe(1);
  expect(await n(sql`select count(*) as n from ledger_transactions where kind = 'trade' and ref_id::text = ${o1.body.id}`)).toBe(1);
  expect(await n(sql`select count(*) as n from proposals where request_key = ${propKey["idempotency-key"]}`)).toBe(1);
  expect(await n(sql`select count(*) as n from ceasefires where proposal_id = ${p1.body.id}`)).toBe(1);
  expect(await n(sql`select count(*) as n from battles where territory_id = (select id from territories where slug = ${target})`)).toBe(1);
  expect(await n(sql`select count(*) as n from family_memberships where player_id = ${x.id}`)).toBe(0); // joined once, then kicked
});

describe("keyed requests sent at the same moment", () => {
  it("five copies of one trade offer, or one proposal, make one", async () => {
    const [a, b] = [await family(), await family()];
    for (const f of [a, b]) await ageForTrading(f.id);
    const offer = keyed();
    const offers = await Promise.all(Array.from({ length: 5 }, () => a.don.client.post(`/families/${a.id}/trades`, { to: b.tag, gives: [{ cash: 5 }], wants: [] }, offer)));
    expect(offers.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(offers.map((r) => r.body.id)).size).toBe(1);
    expect(await count(sql`select count(*) as n from trades where from_family_id = ${a.id}`)).toBe(1);

    const room = ChatChannel.parse((await a.don.client.post("/diplomacy/rooms", { tag: b.tag })).body);
    const proposal = keyed();
    const made = await Promise.all(Array.from({ length: 5 }, () => a.don.client.post(`/diplomacy/rooms/${room.id}/proposals`, { terms: { kind: "ceasefire", hours: 24 } }, proposal)));
    expect(made.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(new Set(made.map((r) => r.body.id)).size).toBe(1);
    expect(await count(sql`select count(*) as n from proposals where from_family_id = ${a.id}`)).toBe(1);
  });

  it("an offer or proposal without a key is refused", async () => {
    const [a, b] = [await family(), await family()];
    for (const f of [a, b]) await ageForTrading(f.id);
    const offer = await a.don.client.post(`/families/${a.id}/trades`, { to: b.tag, gives: [{ cash: 5 }], wants: [] });
    expect([offer.status, offer.body.message]).toEqual([400, expect.stringContaining("Idempotency-Key")]);
    const room = ChatChannel.parse((await a.don.client.post("/diplomacy/rooms", { tag: b.tag })).body);
    expect((await a.don.client.post(`/diplomacy/rooms/${room.id}/proposals`, { terms: { kind: "ceasefire", hours: 24 } })).status).toBe(400);
  });
});
