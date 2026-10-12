import { DIPLOMACY } from "@kots/content";
import { PROPOSAL_TTL_MS } from "@kots/rules";
import { ChatChannel, ChatChannelList, NotificationPage, Proposal, RoomState, TerritoryDetail } from "@kots/shared";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { seedMap } from "../src/db/seed";
import { DiplomacyService } from "../src/modules/diplomacy/diplomacy.service";
import { TerritoriesService } from "../src/modules/territories/territories.service";
import { economyHelpers } from "./economy-helpers";
import { newPlayer, resetTestDatabase, startApi, TestClock, type Client, type TestApi } from "./helpers";
import { closeAllSockets, connect, settle } from "./socket-helpers";

let api: TestApi;
const clock = new TestClock();
const HOUR = 3600_000;

beforeAll(async () => {
  await resetTestDatabase();
  api = await startApi(undefined, clock);
  await seedMap(api.db);
});

afterEach(async () => {
  closeAllSockets();
  await expectLedgerConsistent();
});

afterAll(async () => {
  await api?.close();
});

const { rows, family, balance, setBalance, ageForTrading, expectLedgerConsistent } = economyHelpers(() => api, "Dip");

type Fam = Awaited<ReturnType<typeof family>>;
type Role = Parameters<typeof family>[0];

async function diplomats(roles: Role = []): Promise<Fam> {
  const f = await family(roles);
  await ageForTrading(f.id);
  return f;
}
const openRoom = async (from: Fam, to: Fam) => {
  const res = await from.don.client.post("/diplomacy/rooms", { tag: to.tag });
  expect(res.status).toBe(200);
  return ChatChannel.parse(res.body);
};
const propose = (c: Client, roomId: string, terms: unknown) => c.post(`/diplomacy/rooms/${roomId}/proposals`, { terms });
const proposeOk = async (c: Client, roomId: string, terms: unknown) => {
  const res = await propose(c, roomId, terms);
  expect([res.status, res.body.code]).toEqual([201, undefined]);
  return Proposal.parse(res.body);
};
const roomState = async (c: Client, roomId: string) => RoomState.parse((await c.get(`/diplomacy/rooms/${roomId}`)).body);
const statusOf = async (id: string) => (await rows<{ status: string }>(sql`select status from proposals where id = ${id}`))[0]!.status;
const ownerOf = async (slug: string) => (await rows<{ owner_family_id: string | null }>(sql`select owner_family_id from territories where slug = ${slug}`))[0]!.owner_family_id;
const claim = async (f: Fam, slug: string) => expect((await f.don.client.post(`/territories/${slug}/claim`)).status).toBe(200);
const notes = async (c: Client) =>
  NotificationPage.parse((await c.get("/notifications")).body)
    .items.map((n) => n.type)
    .filter((t) => t.startsWith("proposal."));
const transfer = (territory: string, giver: "proposer" | "recipient", price: number) => ({ kind: "territory_transfer", territory, giver, price });

describe("rooms", () => {
  it("open by tag; Don, Underboss and Consigliere of both families use it; other roles and outsiders can't", async () => {
    const a = await diplomats(["consigliere", "capo"]);
    const b = await diplomats(["underboss", "associate"]);
    const outsider = await diplomats();
    const room = await openRoom(a, b);
    expect(room).toMatchObject({ kind: "diplomacy", family: { id: b.id, tag: b.tag } });
    expect(room.name).toBe(`${room.family!.name} [${b.tag}]`);
    // Opening again, from either side, finds the same room.
    expect(ChatChannel.parse((await b.don.client.post("/diplomacy/rooms", { tag: a.tag })).body).id).toBe(room.id);

    const [consigliere, capo] = a.members;
    const [underboss, associate] = b.members;
    const listed = async (c: Client) => ChatChannelList.parse((await c.get("/chat/channels")).body).some((ch) => ch.id === room.id);
    for (const c of [a.don.client, consigliere!.client, b.don.client, underboss!.client]) expect(await listed(c)).toBe(true);
    for (const c of [capo!.client, associate!.client, outsider.don.client]) {
      expect(await listed(c)).toBe(false);
      expect((await c.get(`/chat/channels/${room.id}/messages`)).status).toBe(404);
      expect((await c.get(`/diplomacy/rooms/${room.id}`)).status).toBe(404);
    }
    expect((await consigliere!.client.post(`/chat/channels/${room.id}/messages`, { body: "Shall we talk?" })).status).toBe(201);
    expect((await underboss!.client.get(`/chat/channels/${room.id}/messages`)).body.items[0].body).toBe("Shall we talk?");

    // Losing the role loses the room at once.
    expect((await a.don.client.patch(`/families/${a.id}/members/${consigliere!.id}`, { role: "associate" })).status).toBe(200);
    expect((await consigliere!.client.get(`/chat/channels/${room.id}/messages`)).status).toBe(404);

    expect((await a.don.client.post("/diplomacy/rooms", { tag: a.tag })).status).toBe(400);
    expect((await a.don.client.post("/diplomacy/rooms", { tag: "ZZZZ" })).status).toBe(404);
    expect((await capo!.client.post("/diplomacy/rooms", { tag: b.tag })).status).toBe(403);
  });

  it("live room messages reach only the members who may talk", async () => {
    const a = await diplomats(["associate"]);
    const b = await diplomats(["consigliere"]);
    const room = await openRoom(a, b);
    const [bConsigliere, aAssociate] = await Promise.all([connect(api.base, b.members[0]!.client), connect(api.base, a.members[0]!.client)]);
    expect((await a.don.client.post(`/chat/channels/${room.id}/messages`, { body: "Terms?" })).status).toBe(201);
    expect((await bConsigliere.next("chat.message")).message.body).toBe("Terms?");
    await settle();
    expect(aAssociate.events.filter((e) => e.type === "chat.message")).toEqual([]);
  });
});

describe("ceasefire", () => {
  it("a Don's proposal counts as their signature; the other Don's signature runs it", async () => {
    const a = await diplomats(["associate"]);
    const b = await diplomats(["underboss", "consigliere", "associate"]);
    const room = await openRoom(a, b);
    const p = await proposeOk(a.don.client, room.id, { kind: "ceasefire", hours: 72 });
    expect(p).toMatchObject({ status: "open", from: { id: a.id }, to: { id: b.id }, createdBy: a.don.handle, signatures: [{ familyId: a.id, by: a.don.handle }] });

    // Diplomacy roles of the receiving family are told; others aren't.
    const [bUnderboss, bConsigliere, bAssociate] = b.members;
    for (const c of [b.don.client, bUnderboss!.client, bConsigliere!.client]) expect(await notes(c)).toEqual(["proposal.received"]);
    expect(await notes(bAssociate!.client)).toEqual([]);

    const signed = await bUnderboss!.client.post(`/proposals/${p.id}/sign`);
    expect(signed.status).toBe(200);
    expect(Proposal.parse(signed.body)).toMatchObject({ status: "executed", signatures: [{ familyId: a.id }, { familyId: b.id, by: bUnderboss!.handle }] });
    const state = await roomState(a.don.client, room.id);
    expect(new Date(state.ceasefireUntil!).getTime()).toBe(clock.now().getTime() + 72 * HOUR);
    expect(await notes(a.don.client)).toEqual(["proposal.executed"]);
    expect(await notes(a.members[0]!.client)).toEqual([]);
    const types = (await a.don.client.get(`/families/${a.id}/activity`)).body.items.map((i: { type: string }) => i.type);
    expect(types).toEqual(expect.arrayContaining(["proposal.made", "ceasefire.agreed", "proposal.executed"]));
    // Signing again changes nothing.
    expect(Proposal.parse((await b.don.client.post(`/proposals/${p.id}/sign`)).body).status).toBe("executed");
    expect(await rows(sql`select 1 from ceasefires where proposal_id = ${p.id}`)).toHaveLength(1);
  });

  it("a Consigliere proposes but can't sign: it needs a signature from each family", async () => {
    const a = await diplomats(["consigliere"]);
    const b = await diplomats();
    const room = await openRoom(a, b);
    const p = await proposeOk(a.members[0]!.client, room.id, { kind: "ceasefire", hours: 24 });
    expect(p.signatures).toEqual([]);
    expect((await a.members[0]!.client.post(`/proposals/${p.id}/sign`)).status).toBe(403);

    expect(Proposal.parse((await b.don.client.post(`/proposals/${p.id}/sign`)).body).status).toBe("open");
    expect(await notes(a.don.client)).toEqual(["proposal.signed"]);
    expect(Proposal.parse((await a.don.client.post(`/proposals/${p.id}/sign`)).body).status).toBe("executed");
  });
});

describe("territory transfer", () => {
  it("hands the territory over for the price, moves the money through the ledger, and stands guards down", async () => {
    const a = await diplomats();
    const b = await diplomats();
    await claim(a, "tejuosho");
    const hired = await a.don.client.post(`/families/${a.id}/recruits`, { slot: 0 });
    expect(hired.status).toBe(201);
    expect((await a.don.client.patch(`/henchmen/${hired.body.id}`, { territory: "tejuosho" })).status).toBe(200);
    const paidUntil = TerritoryDetail.parse((await a.don.client.get("/territories/tejuosho")).body).holding!.paidUntil;
    const [aBefore, bBefore] = [await balance(a.don.client, a.id), await balance(b.don.client, b.id)];

    const room = await openRoom(a, b);
    const p = await proposeOk(a.don.client, room.id, transfer("tejuosho", "proposer", 5_000));
    expect(await ownerOf("tejuosho")).toBe(a.id);
    expect(Proposal.parse((await b.don.client.post(`/proposals/${p.id}/sign`)).body).status).toBe("executed");

    expect(await ownerOf("tejuosho")).toBe(b.id);
    expect(TerritoryDetail.parse((await b.don.client.get("/territories/tejuosho")).body).holding!.paidUntil).toBe(paidUntil);
    expect(await balance(a.don.client, a.id)).toBe(aBefore + 5_000);
    expect(await balance(b.don.client, b.id)).toBe(bBefore - 5_000);
    expect(await rows(sql`select kind from ledger_transactions where idempotency_key = ${`proposal:${p.id}`}`)).toEqual([{ kind: "transfer" }]);
    expect(await rows(sql`select assigned_territory_id from henchmen where id = ${hired.body.id}`)).toEqual([{ assigned_territory_id: null }]);
    expect(
      await rows(sql`select h.cause, h.from_family_id, h.to_family_id from territory_ownership_history h join territories t on t.id = h.territory_id where t.slug = 'tejuosho' order by h.created_at desc limit 1`),
    ).toEqual([{ cause: "transfer", from_family_id: a.id, to_family_id: b.id }]);
    const bActivity = (await b.don.client.get(`/families/${b.id}/activity`)).body.items;
    expect(bActivity.find((i: { type: string }) => i.type === "territory.transferred").payload).toMatchObject({ slug: "tejuosho", direction: "in", with: a.tag, price: 5_000 });
  });

  it("can ask the other family for one of theirs; the proposer then pays", async () => {
    const a = await diplomats();
    const b = await diplomats();
    await claim(b, "akoka");
    const room = await openRoom(a, b);
    const p = await proposeOk(a.don.client, room.id, transfer("akoka", "recipient", 2_000));
    expect(Proposal.parse((await b.don.client.post(`/proposals/${p.id}/sign`)).body).status).toBe("executed");
    expect(await ownerOf("akoka")).toBe(a.id);
    expect(await balance(a.don.client, a.id)).toBe(20_000 - 2_000);
  });

  it("re-checks at signing: a territory no longer held, a receiver who can't pay or doesn't border it, an expired proposal", async () => {
    const a = await diplomats();
    const b = await diplomats();
    await claim(a, "sabo");
    await claim(b, "marina"); // far from Sabo
    const room = await openRoom(a, b);

    const notAdjacent = await proposeOk(a.don.client, room.id, transfer("sabo", "proposer", 0));
    const refused = await b.don.client.post(`/proposals/${notAdjacent.id}/sign`);
    expect([refused.status, refused.body.code]).toEqual([409, "NOT_ADJACENT"]);
    // Refused signatures leave nothing behind.
    expect(Proposal.parse((await a.don.client.post(`/proposals/${notAdjacent.id}/withdraw`)).body)).toMatchObject({ status: "withdrawn", signatures: [{ familyId: a.id }] });

    const c = await diplomats();
    const room2 = await openRoom(a, c);
    const tooDear = await proposeOk(a.don.client, room2.id, transfer("sabo", "proposer", 50_000));
    const poor = await c.don.client.post(`/proposals/${tooDear.id}/sign`);
    expect([poor.status, poor.body.code]).toEqual([409, "INSUFFICIENT_FUNDS"]);
    expect(await statusOf(tooDear.id)).toBe("open");
    expect(await rows(sql`select 1 from proposal_signatures where proposal_id = ${tooDear.id} and family_id = ${c.id}`)).toEqual([]);

    const gone = await proposeOk(a.don.client, room2.id, transfer("sabo", "proposer", 100));
    expect((await a.don.client.post("/territories/sabo/abandon")).status).toBe(204);
    const lost = await c.don.client.post(`/proposals/${gone.id}/sign`);
    expect([lost.status, lost.body.code]).toEqual([409, "TERRITORY_NOT_HELD"]);

    const late = await proposeOk(a.don.client, room2.id, { kind: "ceasefire", hours: 24 });
    clock.advance(PROPOSAL_TTL_MS + 1000);
    const expired = await c.don.client.post(`/proposals/${late.id}/sign`);
    expect([expired.status, expired.body.code]).toEqual([409, "PROPOSAL_CLOSED"]);
    clock.set(Date.now());
  });
});

describe("making and closing proposals", () => {
  it("checks terms, roles, holdings, family age and the open-proposal limit", async () => {
    const a = await diplomats(["associate"]);
    const b = await diplomats();
    const room = await openRoom(a, b);
    for (const terms of [{ kind: "ceasefire", hours: 5 }, transfer("atlantis", "proposer", 0), transfer("otto", "proposer", -1), { kind: "war" }]) {
      expect((await propose(a.don.client, room.id, terms)).status).toBe(400);
    }
    expect((await propose(a.members[0]!.client, room.id, { kind: "ceasefire", hours: 24 })).status).toBe(403);
    const notHeld = await propose(a.don.client, room.id, transfer("otto", "proposer", 0));
    expect([notHeld.status, notHeld.body.code]).toEqual([409, "TERRITORY_NOT_HELD"]);

    for (let i = 0; i < DIPLOMACY.maxOpenPerPair; i++) await proposeOk(i % 2 ? b.don.client : a.don.client, room.id, { kind: "ceasefire", hours: 24 });
    const tooMany = await propose(a.don.client, room.id, { kind: "ceasefire", hours: 24 });
    expect([tooMany.status, tooMany.body.code]).toEqual([409, "TOO_MANY_PROPOSALS"]);

    const young = await family();
    const room2 = await openRoom(a, young);
    const tooNew = await propose(a.don.client, room2.id, { kind: "ceasefire", hours: 24 });
    expect([tooNew.status, tooNew.body.code]).toEqual([409, "TOO_NEW"]);
  });

  it("only the receiving family's signers decline; only the proposing family withdraws; a closed proposal stays closed", async () => {
    const a = await diplomats(["consigliere"]);
    const b = await diplomats(["consigliere"]);
    const outsider = await diplomats();
    const room = await openRoom(a, b);
    const p = await proposeOk(a.don.client, room.id, { kind: "ceasefire", hours: 24 });
    expect((await a.don.client.post(`/proposals/${p.id}/decline`)).status).toBe(403);
    expect((await b.members[0]!.client.post(`/proposals/${p.id}/decline`)).status).toBe(403); // a Consigliere can't decline
    expect((await b.don.client.post(`/proposals/${p.id}/withdraw`)).status).toBe(403);
    expect((await outsider.don.client.post(`/proposals/${p.id}/withdraw`)).status).toBe(404);
    expect(Proposal.parse((await b.don.client.post(`/proposals/${p.id}/decline`)).body).status).toBe("declined");
    expect(await notes(a.don.client)).toEqual(["proposal.declined"]);
    for (const action of ["sign", "decline"]) expect((await b.don.client.post(`/proposals/${p.id}/${action}`)).body.code).toBe("PROPOSAL_CLOSED");
    expect((await a.members[0]!.client.post(`/proposals/${p.id}/withdraw`)).body.code).toBe("PROPOSAL_CLOSED");

    const q = await proposeOk(a.members[0]!.client, room.id, { kind: "ceasefire", hours: 24 });
    expect(Proposal.parse((await a.members[0]!.client.post(`/proposals/${q.id}/withdraw`)).body).status).toBe("withdrawn");
  });

  it("the expiry sweep closes a proposal once and tells both families once", async () => {
    const a = await diplomats();
    const b = await diplomats();
    const room = await openRoom(a, b);
    const p = await proposeOk(a.don.client, room.id, { kind: "ceasefire", hours: 168 });
    const later = new Date(clock.now().getTime() + PROPOSAL_TTL_MS + 1000);
    const service = api.app.get(DiplomacyService);
    await Promise.all([service.sweepExpired(later), service.sweepExpired(later)]);
    await service.sweepExpired(later);
    expect(await statusOf(p.id)).toBe("expired");
    expect(await notes(a.don.client)).toEqual(["proposal.expired"]);
    expect(await notes(b.don.client)).toEqual(["proposal.expired", "proposal.received"]);
    expect((await roomState(a.don.client, room.id)).proposals[0]).toMatchObject({ id: p.id, status: "expired" });
  });
});

describe("races", () => {
  it("ten signatures at once, from two signers: the transfer runs exactly once", async () => {
    const a = await diplomats();
    const b = await diplomats(["underboss"]);
    await claim(a, "ebute-metta");
    const room = await openRoom(a, b);
    const p = await proposeOk(a.don.client, room.id, transfer("ebute-metta", "proposer", 1_000));
    const signers = [b.don.client, b.members[0]!.client];
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => signers[i % 2]!.post(`/proposals/${p.id}/sign`)));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(results.every((r) => r.body.status === "executed")).toBe(true);
    expect(await balance(b.don.client, b.id)).toBe(20_000 - 1_000);
    expect(await rows(sql`select 1 from ledger_transactions where idempotency_key = ${`proposal:${p.id}`}`)).toHaveLength(1);
    expect(await rows(sql`select 1 from territory_ownership_history h join territories t on t.id = h.territory_id where t.slug = 'ebute-metta' and h.cause = 'transfer'`)).toHaveLength(1);
  });

  it("sign, decline and withdraw at once: exactly one wins", async () => {
    const a = await diplomats();
    const b = await diplomats();
    const room = await openRoom(a, b);
    for (let i = 0; i < 4; i++) {
      const p = await proposeOk(a.don.client, room.id, { kind: "ceasefire", hours: 24 });
      const [sign, decline, withdraw] = await Promise.all([
        b.don.client.post(`/proposals/${p.id}/sign`),
        b.don.client.post(`/proposals/${p.id}/decline`),
        a.don.client.post(`/proposals/${p.id}/withdraw`),
      ]);
      expect([sign, decline, withdraw].filter((r) => r.status === 200)).toHaveLength(1);
      expect([sign, decline, withdraw].filter((r) => r.status !== 200).every((r) => r.body.code === "PROPOSAL_CLOSED")).toBe(true);
      const status = await statusOf(p.id);
      expect(status).toBe(sign.status === 200 ? "executed" : decline.status === 200 ? "declined" : "withdrawn");
      expect(await rows(sql`select 1 from ceasefires where proposal_id = ${p.id}`)).toHaveLength(status === "executed" ? 1 : 0);
    }
  });

  it("a signature racing the upkeep sweep that loses the territory: the transfer runs or the land goes neutral, never both", async () => {
    const territoriesService = api.app.get(TerritoriesService);
    // The sweep starts after a growing delay, so the rounds cover it winning, the signature winning, and real overlap.
    for (const [round, slug] of ["alagomeji", "oyingbo", "iddo", "otto", "ijora", "idumota"].entries()) {
      const a = await diplomats();
      const b = await diplomats();
      await claim(a, slug);
      await setBalance(a.id, 0);
      await api.db.execute(sql`update territories set base_income = 0, upkeep_paid_until = ${new Date(clock.now().getTime() - 49 * HOUR)} where slug = ${slug}`);
      const room = await openRoom(a, b);
      const p = await proposeOk(a.don.client, room.id, transfer(slug, "proposer", 0));
      const sweep = new Promise((r) => setTimeout(r, round * 15)).then(() => territoriesService.sweepUpkeep(clock.now()));
      const [signed] = await Promise.all([b.don.client.post(`/proposals/${p.id}/sign`), sweep]);
      const owner = await ownerOf(slug);
      if (signed.status === 200) {
        expect([signed.body.status, owner === b.id || owner === null]).toEqual(["executed", true]);
        // If the transfer won, the sweep may still have charged the new owner later; either way only one history change came from the transfer.
        expect(await rows(sql`select 1 from territory_ownership_history h join territories t on t.id = h.territory_id where t.slug = ${slug} and h.cause = 'transfer'`)).toHaveLength(1);
      } else {
        expect([signed.body.code, owner]).toEqual(["TERRITORY_NOT_HELD", null]);
        expect(await statusOf(p.id)).toBe("open");
      }
    }
  });
});

describe("endpoints", () => {
  it("malformed ids are 404, unknown ids are 404, unauthenticated calls are 401", async () => {
    const a = await diplomats();
    expect((await a.don.client.get("/diplomacy/rooms/nope")).status).toBe(404);
    expect((await a.don.client.post("/proposals/nope/sign")).status).toBe(404);
    expect((await a.don.client.post("/proposals/01a00000-0000-7000-8000-000000000000/sign")).status).toBe(404);
    const anon = (await newPlayer(api.base)).client;
    await anon.post("/auth/logout");
    expect((await anon.get("/diplomacy/rooms/01a00000-0000-7000-8000-000000000000")).status).toBe(401);
  });
});
