import { CITY } from "@kots/content";
import { ChatChannel, ChatChannelList, Henchman, NotificationPage, Proposal } from "@kots/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedMap, seedMarkets } from "../src/db/seed";
import { economyHelpers } from "./economy-helpers";
import { Client, newPlayer, resetTestDatabase, startApi, type TestApi, keyed } from "./helpers";
import { closeAllSockets, connect } from "./socket-helpers";

/**
 * Who may call what (Phase 9a). Every route the api serves must have a row here, so a new route can't ship
 * without a decision about its access.
 * - `public`: no session needed.
 * - `self`: needs a session and acts only for the caller (their profile, their own family, their notifications).
 * - `family`: acts on family A's data; the expected status for an outsider (another family's Don) and for an
 *   associate of A (a member with only `activity.view`). Outsiders get 404 where the resource is private to the
 *   families involved (a battle, a room, a channel), and 403 where the family is named in the path.
 */
type Access = "public" | "self" | { outsider: number; associate: number };
const fam = (outsider: number, associate: number) => ({ outsider, associate });

const ACCESS: Record<string, Access> = {
  "GET /api/health": "public",
  "POST /api/auth/register": "public",
  "POST /api/auth/login": "public",
  "POST /api/auth/logout": "self",
  "GET /api/me": "self",
  "GET /api/players/:handle": "self",
  "GET /api/me/invitations": "self",
  "POST /api/invitations/:invitationId/accept": fam(404, 404),
  "POST /api/invitations/:invitationId/decline": fam(404, 404),
  "POST /api/families": "self",
  // Any player may look at a family's public page; every member sees its balance (the history needs treasury.view).
  "GET /api/families/:familyId": "self",
  "DELETE /api/families/:familyId": fam(403, 403),
  "GET /api/families/:familyId/activity": fam(403, 200),
  "GET /api/families/:familyId/invitations": fam(403, 403),
  "POST /api/families/:familyId/invitations": fam(403, 403),
  "DELETE /api/families/:familyId/invitations/:invitationId": fam(403, 403),
  "PATCH /api/families/:familyId/members/:playerId": fam(403, 403),
  "DELETE /api/families/:familyId/members/:playerId": fam(403, 403),
  "POST /api/families/:familyId/transfer-leadership": fam(403, 403),
  "GET /api/map/districts": "self",
  "GET /api/map/territories": "self",
  "GET /api/territories/:slug": "self",
  "GET /api/territories/:slug/attack": "self",
  "POST /api/territories/:slug/claim": fam(409, 403),
  "POST /api/territories/:slug/abandon": fam(403, 403),
  "GET /api/families/:familyId/territories": fam(403, 200),
  "GET /api/families/:familyId/treasury": fam(403, 200),
  "GET /api/families/:familyId/treasury/entries": fam(403, 403),
  "GET /api/families/:familyId/recruits": fam(403, 200),
  "POST /api/families/:familyId/recruits": fam(403, 403),
  "GET /api/families/:familyId/henchmen": fam(403, 200),
  "PATCH /api/henchmen/:henchmanId": fam(403, 403),
  "POST /api/henchmen/:henchmanId/dismiss": fam(404, 403),
  "GET /api/families/:familyId/inventory": fam(403, 200),
  "GET /api/markets/:slug": "self",
  "POST /api/markets/:slug/orders": fam(200, 403), // the outsider buys for their own family
  "GET /api/families/:familyId/trades": fam(403, 200),
  "POST /api/families/:familyId/trades": fam(403, 403),
  "POST /api/trades/:tradeId/accept": fam(403, 403),
  "POST /api/trades/:tradeId/decline": fam(403, 403),
  "POST /api/trades/:tradeId/cancel": fam(403, 403),
  "GET /api/chat/channels": "self",
  "POST /api/chat/direct": "self",
  "GET /api/chat/channels/:channelId/messages": fam(404, 200),
  "POST /api/chat/channels/:channelId/messages": fam(404, 201),
  "POST /api/chat/channels/:channelId/read": fam(404, 204),
  "DELETE /api/chat/messages/:messageId": fam(403, 403),
  "POST /api/chat/messages/:messageId/report": fam(404, 204),
  "GET /api/blocks": "self",
  "POST /api/blocks": "self",
  "DELETE /api/blocks/:playerId": "self",
  "GET /api/moderation/reports": fam(403, 403), // moderators only
  "POST /api/moderation/reports/:reportId/dismiss": fam(403, 403),
  "GET /api/notifications": "self",
  "POST /api/notifications/read-all": "self",
  "POST /api/notifications/:id/read": fam(404, 404), // someone else's notification
  "POST /api/diplomacy/rooms": fam(200, 403), // the outsider opens a room for their own family
  "GET /api/diplomacy/rooms/:roomId": fam(404, 404),
  "POST /api/diplomacy/rooms/:roomId/proposals": fam(404, 403),
  "POST /api/proposals/:proposalId/sign": fam(403, 403),
  "POST /api/proposals/:proposalId/decline": fam(404, 403),
  "POST /api/proposals/:proposalId/withdraw": fam(404, 403),
  "POST /api/territories/:slug/battles": fam(409, 403),
  "GET /api/families/:familyId/battles": fam(403, 200),
  "GET /api/battles/:battleId": fam(404, 200),
  "POST /api/battles/:battleId/commit": fam(404, 403),
  "POST /api/battles/:battleId/release": fam(404, 403),
  "POST /api/battles/:battleId/orders": fam(404, 403),
  "POST /api/battles/:battleId/withdraw": fam(403, 403),
  "GET /api/events": "self",
  // Last: it takes the associate out of the family.
  "POST /api/families/:familyId/leave": fam(403, 204),
};

let api: TestApi;
let w: Awaited<ReturnType<typeof world>>;
beforeAll(async () => {
  await resetTestDatabase();
  api = await startApi();
  await seedMap(api.db);
  await seedMarkets(api.db);
  w = await world();
});
afterAll(async () => {
  closeAllSockets();
  await api?.close();
});

const { family, setBalance, ageForTrading } = economyHelpers(() => api, "Acc");
const served = (): string[] =>
  (api.app.getHttpAdapter().getInstance() as { router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } }).router.stack
    .flatMap((l) => (l.route ? Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route!.path}`) : []));

/** Family A (Don and an associate) attacking family B, with one of everything a route can point at. */
async function world() {
  const [a, b, outsider] = [await family(["associate"]), await family(), await family()];
  const loner = await newPlayer(api.base);
  for (const f of [a, b, outsider]) {
    await ageForTrading(f.id);
    await setBalance(f.id, 50_000);
  }
  const borders = (s: string) => CITY.territories.get(s)!.borders;
  const target = [...CITY.territories.keys()].sort().find((t) => borders(t).length >= 2)!;
  const [second, base] = borders(target) as [string, string];
  for (const [f, s] of [[b, target], [b, second], [a, base]] as const) expect((await f.don.client.post(`/territories/${s}/claim`)).status).toBe(200);
  const ok = async (res: Promise<{ status: number; body: any }>) => {
    const r = await res;
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    return r.body;
  };
  const henchman = Henchman.parse(await ok(a.don.client.post(`/families/${a.id}/recruits`, { slot: 0 })));
  const invitation = await ok(a.don.client.post(`/families/${a.id}/invitations`, { handle: loner.handle }));
  const trade = await ok(a.don.client.post(`/families/${a.id}/trades`, { to: b.tag, gives: [{ cash: 1 }], wants: [] }, keyed()));
  const room = ChatChannel.parse(await ok(a.don.client.post("/diplomacy/rooms", { tag: b.tag })));
  const proposal = Proposal.parse(await ok(a.don.client.post(`/diplomacy/rooms/${room.id}/proposals`, { terms: { kind: "ceasefire", hours: 24 } }, keyed())));
  const battle = await ok(a.don.client.post(`/territories/${target}/battles`));
  const channel = ChatChannelList.parse((await a.don.client.get("/chat/channels")).body).find((ch) => ch.kind === "family")!;
  const message = await ok(a.don.client.post(`/chat/channels/${channel.id}/messages`, { body: "hello" }));
  await ok(a.members[0]!.client.post(`/chat/messages/${message.id}/report`, { reason: "spam" }));
  const [report] = (await api.db.execute(sql`select id from message_reports`)).rows as { id: string }[];
  const notification = NotificationPage.parse((await loner.client.get("/notifications")).body).items[0]!;

  const params: Record<string, string> = {
    familyId: a.id,
    playerId: a.members[0]!.id,
    invitationId: invitation.id,
    slug: target,
    henchmanId: henchman.id,
    tradeId: trade.id,
    channelId: channel.id,
    messageId: String(message.id),
    reportId: String(report!.id),
    id: notification.id,
    roomId: room.id,
    proposalId: proposal.id,
    battleId: battle.id,
    handle: a.don.handle,
  };
  /** A valid request for each route, so a refusal can't be a validation error in disguise. */
  const request = (route: string): { path: string; body?: unknown; headers?: Record<string, string> } => {
    const [method, pattern] = route.split(" ") as [string, string];
    let path = pattern.replace(/^\/api/, "").replace(/:(\w+)/g, (_, k: string) => params[k]!);
    if (path.startsWith("/markets/")) path = `/markets/balogun${path.endsWith("/orders") ? "/orders" : ""}`;
    const query: Record<string, string> = { "GET /api/families/:familyId/trades": "?box=outgoing", "GET /api/map/territories": "?district=apapa" };
    const bodies: Record<string, unknown> = {
      "POST /api/auth/register": { email: "probe@example.test", password: "correct horse battery", handle: "probe_reg" },
      "POST /api/auth/login": { email: "probe@example.test", password: "correct horse battery" },
      "POST /api/families": { name: "Probe Family", tag: "PRB" },
      "POST /api/families/:familyId/invitations": { handle: loner.handle },
      "PATCH /api/families/:familyId/members/:playerId": { role: "capo" },
      "POST /api/families/:familyId/transfer-leadership": { playerId: a.don.id },
      "POST /api/families/:familyId/recruits": { slot: 1 },
      "PATCH /api/henchmen/:henchmanId": { territory: base },
      "POST /api/markets/:slug/orders": { side: "buy", good: "fuel", quantity: 1, limitTotal: 100_000 },
      "POST /api/families/:familyId/trades": { to: b.tag, gives: [{ cash: 1 }], wants: [] },
      "POST /api/chat/direct": { handle: a.don.handle },
      "POST /api/chat/channels/:channelId/messages": { body: "hi" },
      "POST /api/chat/channels/:channelId/read": { upTo: String(message.id) },
      "POST /api/chat/messages/:messageId/report": { reason: "spam" },
      "POST /api/blocks": { handle: a.don.handle },
      "POST /api/diplomacy/rooms": { tag: a.tag },
      "POST /api/diplomacy/rooms/:roomId/proposals": { terms: { kind: "ceasefire", hours: 24 } },
      "POST /api/battles/:battleId/commit": { henchmen: [henchman.id] },
      "POST /api/battles/:battleId/release": { henchmen: [henchman.id] },
      "POST /api/battles/:battleId/orders": { round: 1, tactic: "press" },
    };
    return {
      path: path + (query[route] ?? ""),
      body: method === "GET" || method === "DELETE" ? undefined : (bodies[route] ?? {}),
      headers: ["POST /api/markets/:slug/orders", "POST /api/families/:familyId/trades", "POST /api/diplomacy/rooms/:roomId/proposals"].includes(route) ? keyed() : {},
    };
  };
  return { a, outsider, request };
}

const call = (c: Client, route: string, req: { path: string; body?: unknown; headers?: Record<string, string> }) => c.request(route.split(" ")[0]!, req.path, req.body, req.headers);

describe("access control", () => {
  it("every route the api serves has an access rule, and every rule a route", () => {
    expect(served().sort()).toEqual(Object.keys(ACCESS).sort());
  });

  it("every route except the public ones refuses a caller with no session, and a banned player whose session survived", async () => {
    const { request } = w;
    const banned = await newPlayer(api.base);
    // Only the account is marked: its session row stays, so this checks the status test in session lookup itself.
    await api.db.execute(sql`update users set status = 'banned' where id = (select user_id from players where id = ${banned.id})`);
    const anon = new Client(api.base);
    const refused: string[] = [];
    for (const route of Object.keys(ACCESS).filter((r) => ACCESS[r] !== "public")) {
      for (const [who, c] of [["anon", anon], ["banned", banned.client]] as const) {
        const res = await call(c, route, request(route));
        if (res.status !== 401 || res.body?.code !== "UNAUTHENTICATED") refused.push(`${who} ${route} → ${res.status}`);
      }
    }
    expect(refused).toEqual([]);
    await expect(connect(api.base, banned.client)).rejects.toThrow("UNAUTHENTICATED");
  });

  it("family routes refuse outsiders and members whose role lacks the permission, as the table says", async () => {
    const { a, outsider, request } = w;
    const got: string[] = [];
    const want: string[] = [];
    for (const [route, access] of Object.entries(ACCESS)) {
      if (typeof access === "string") continue;
      for (const [who, c] of [["outsider", outsider.don.client], ["associate", a.members[0]!.client]] as const) {
        const res = await call(c, route, request(route));
        got.push(`${who} ${route} → ${res.status}`);
        want.push(`${who} ${route} → ${access[who]}`);
      }
    }
    expect(got).toEqual(want);
  });
});
