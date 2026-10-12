import { ActivityPage, FamilyDetail, Invitation, MeResponse } from "@kots/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newPlayer, resetTestDatabase, startApi, type TestApi } from "./helpers";

let api: TestApi;
let n = 0;

beforeAll(async () => {
  await resetTestDatabase();
  api = await startApi();
});

afterAll(async () => {
  await api?.close();
});

const player = () => newPlayer(api.base);
const uniqueName = () => {
  n++;
  return { name: `Family ${n} ${Date.now() % 1e5}`, tag: `F${n}`.slice(0, 5) };
};

/** A Don with a family and `extra` members who have accepted invitations (all associates). */
async function familyWith(extra: number) {
  const don = await player();
  const created = await don.client.post("/families", uniqueName());
  expect(created.status).toBe(201);
  const family = FamilyDetail.parse(created.body);
  const members = [];
  for (let i = 0; i < extra; i++) {
    const m = await player();
    const inv = await don.client.post(`/families/${family.id}/invitations`, { handle: m.handle });
    expect(inv.status).toBe(201);
    expect((await m.client.post(`/invitations/${inv.body.id}/accept`)).status).toBe(200);
    members.push(m);
  }
  return { don, family, members };
}

const roleOf = async (familyId: string, playerId: string) =>
  ((await api.db.execute(sql`select role from family_memberships where family_id = ${familyId} and player_id = ${playerId}`)).rows[0] as
    | { role: string }
    | undefined)?.role;

const donCount = async (familyId: string) =>
  Number(((await api.db.execute(sql`select count(*) as n from family_memberships where family_id = ${familyId} and role = 'don'`)).rows[0] as { n: string }).n);

describe("creating a family", () => {
  it("makes the creator Don, visible in /me with permissions", async () => {
    const p = await player();
    const res = await p.client.post("/families", { name: "  Eko   Boys ", tag: "eko" });
    expect(res.status).toBe(201);
    const family = FamilyDetail.parse(res.body);
    expect(family).toMatchObject({ name: "Eko Boys", tag: "EKO", stage: "street_crew" });
    expect(family.members).toEqual([expect.objectContaining({ playerId: p.id, role: "don" })]);

    const me = MeResponse.parse((await p.client.get("/me")).body);
    expect(me.family).toMatchObject({ id: family.id, role: "don" });
    expect(me.family!.permissions).toContain("family.disband");
  });

  it("rejects a second family for the same player, and taken names or tags regardless of case", async () => {
    const p = await player();
    await p.client.post("/families", { name: "Third Mainland", tag: "TML" });
    expect((await p.client.post("/families", uniqueName())).body.code).toBe("ALREADY_IN_FAMILY");

    const q = await player();
    expect((await q.client.post("/families", { name: "third mainland", tag: "ZZZ" })).body.code).toBe("FAMILY_NAME_TAKEN");
    expect((await q.client.post("/families", { name: "Other Name", tag: "tml" })).body.code).toBe("FAMILY_TAG_TAKEN");
  });

  it("validates name and tag", async () => {
    const p = await player();
    expect((await p.client.post("/families", { name: "x", tag: "TOOLONG" })).status).toBe(400);
    expect((await p.client.post("/families", { name: "<script>", tag: "AB" })).status).toBe(400);
  });

  it("needs a session", async () => {
    const res = await fetch(`${api.base}/api/families`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(uniqueName()) });
    expect(res.status).toBe(401);
  });
});

describe("invitations", () => {
  it("invite → the player sees it → accept → joins as associate, logged in activity", async () => {
    const { don, family } = await familyWith(0);
    const p = await player();
    const inv = await don.client.post(`/families/${family.id}/invitations`, { handle: p.handle.toUpperCase() });
    expect(inv.status).toBe(201);
    expect(Invitation.parse(inv.body)).toMatchObject({ family: { id: family.id }, player: { id: p.id }, invitedBy: { id: don.id } });

    const mine = await p.client.get("/me/invitations");
    expect(mine.body.map((i: Invitation) => i.id)).toEqual([inv.body.id]);
    const sent = await don.client.get(`/families/${family.id}/invitations`);
    expect(sent.body.map((i: Invitation) => i.id)).toEqual([inv.body.id]);

    const accepted = await p.client.post(`/invitations/${inv.body.id}/accept`);
    expect(accepted.status).toBe(200);
    expect(FamilyDetail.parse(accepted.body).members.map((m) => [m.playerId, m.role])).toEqual([
      [don.id, "don"],
      [p.id, "associate"],
    ]);
    expect((await p.client.get("/me/invitations")).body).toEqual([]);

    const activity = ActivityPage.parse((await p.client.get(`/families/${family.id}/activity`)).body);
    expect(activity.items.map((a) => a.type)).toEqual(["member.joined", "member.invited", "family.created"]);
    expect(activity.items[1]!.actor).toEqual({ id: don.id, handle: don.handle });
  });

  it("refuses duplicate invitations, inviting members and unknown players", async () => {
    const { don, family, members } = await familyWith(1);
    const p = await player();
    expect((await don.client.post(`/families/${family.id}/invitations`, { handle: p.handle })).status).toBe(201);
    expect((await don.client.post(`/families/${family.id}/invitations`, { handle: p.handle })).body.code).toBe("ALREADY_INVITED");
    expect((await don.client.post(`/families/${family.id}/invitations`, { handle: members[0]!.handle })).body.code).toBe("ALREADY_MEMBER");
    expect((await don.client.post(`/families/${family.id}/invitations`, { handle: "ghost_player" })).status).toBe(404);
  });

  it("an expired invitation can't be accepted, and doesn't block a new one", async () => {
    const { don, family } = await familyWith(0);
    const p = await player();
    const inv = await don.client.post(`/families/${family.id}/invitations`, { handle: p.handle });
    await api.db.execute(sql`update family_invitations set expires_at = now() - interval '1 minute' where id = ${inv.body.id}`);
    expect((await p.client.get("/me/invitations")).body).toEqual([]);
    const accept = await p.client.post(`/invitations/${inv.body.id}/accept`);
    expect(accept.status).toBe(410);
    expect(accept.body.code).toBe("INVITATION_EXPIRED");
    expect((await don.client.post(`/families/${family.id}/invitations`, { handle: p.handle })).status).toBe(201);
  });

  it("decline and revoke close the invitation", async () => {
    const { don, family } = await familyWith(0);
    const a = await player();
    const b = await player();
    const invA = await don.client.post(`/families/${family.id}/invitations`, { handle: a.handle });
    const invB = await don.client.post(`/families/${family.id}/invitations`, { handle: b.handle });

    expect((await a.client.post(`/invitations/${invA.body.id}/decline`)).status).toBe(204);
    expect((await a.client.post(`/invitations/${invA.body.id}/accept`)).status).toBe(404);

    expect((await don.client.delete(`/families/${family.id}/invitations/${invB.body.id}`)).status).toBe(204);
    expect((await b.client.post(`/invitations/${invB.body.id}/accept`)).status).toBe(404);
  });

  it("only the invited player can accept or decline", async () => {
    const { don, family } = await familyWith(0);
    const invited = await player();
    const intruder = await player();
    const inv = await don.client.post(`/families/${family.id}/invitations`, { handle: invited.handle });
    expect((await intruder.client.post(`/invitations/${inv.body.id}/accept`)).status).toBe(404);
    expect((await intruder.client.post(`/invitations/${inv.body.id}/decline`)).status).toBe(404);
  });

  it("can't accept while already in a family", async () => {
    const other = await familyWith(1);
    const { don, family } = await familyWith(0);
    const inv = await don.client.post(`/families/${family.id}/invitations`, { handle: other.members[0]!.handle });
    expect((await other.members[0]!.client.post(`/invitations/${inv.body.id}/accept`)).body.code).toBe("ALREADY_IN_FAMILY");
  });
});

describe("permissions", () => {
  it("an associate can't invite, kick or change roles", async () => {
    const { don, family, members } = await familyWith(2);
    const [a, b] = members;
    const outsider = await player();
    expect((await a!.client.post(`/families/${family.id}/invitations`, { handle: outsider.handle })).status).toBe(403);
    expect((await a!.client.delete(`/families/${family.id}/members/${b!.id}`)).status).toBe(403);
    expect((await a!.client.patch(`/families/${family.id}/members/${b!.id}`, { role: "capo" })).status).toBe(403);
    expect((await a!.client.patch(`/families/${family.id}/members/${don.id}`, { role: "associate" })).status).toBe(403);
    expect((await a!.client.get(`/families/${family.id}/invitations`)).status).toBe(403);
  });

  it("outsiders can see the public family page but not its activity or invitations", async () => {
    const { family } = await familyWith(0);
    const outsider = await player();
    expect((await outsider.client.get(`/families/${family.id}`)).status).toBe(200);
    expect((await outsider.client.get(`/families/${family.id}/activity`)).status).toBe(403);
    expect((await outsider.client.get(`/families/${family.id}/invitations`)).status).toBe(403);
  });

  it("a Don can't act on another family's members, whichever family id is in the path", async () => {
    const a = await familyWith(0);
    const b = await familyWith(1);
    const victim = b.members[0]!;
    // Own family id + other family's member: not a member here.
    expect((await a.don.client.delete(`/families/${a.family.id}/members/${victim.id}`)).status).toBe(404);
    // Other family's id: not a member of that family.
    expect((await a.don.client.delete(`/families/${b.family.id}/members/${victim.id}`)).status).toBe(403);
    expect((await a.don.client.patch(`/families/${b.family.id}/members/${victim.id}`, { role: "capo" })).status).toBe(403);
    expect(await roleOf(b.family.id, victim.id)).toBe("associate");
  });

  it("malformed ids are a 404, not a server error", async () => {
    const p = await player();
    expect((await p.client.get("/families/not-a-uuid")).status).toBe(404);
    expect((await p.client.post("/invitations/123/accept")).status).toBe(404);
  });
});

describe("roles and membership", () => {
  it("rank rules: the Don promotes a capo; the capo can kick associates but can't promote", async () => {
    const { don, family, members } = await familyWith(2);
    const [capo, assoc] = members;
    const promoted = await don.client.patch(`/families/${family.id}/members/${capo!.id}`, { role: "capo" });
    expect(promoted.status).toBe(200);
    expect(await roleOf(family.id, capo!.id)).toBe("capo");

    expect((await capo!.client.patch(`/families/${family.id}/members/${assoc!.id}`, { role: "enforcer" })).status).toBe(403);
    expect((await don.client.patch(`/families/${family.id}/members/${assoc!.id}`, { role: "don" })).status).toBe(403);
    expect((await don.client.patch(`/families/${family.id}/members/${assoc!.id}`, { role: "warlord" })).status).toBe(400);

    expect((await capo!.client.delete(`/families/${family.id}/members/${assoc!.id}`)).status).toBe(200);
    expect(await roleOf(family.id, assoc!.id)).toBeUndefined();

    const types = ActivityPage.parse((await don.client.get(`/families/${family.id}/activity`)).body).items.map((i) => i.type);
    expect(types.slice(0, 2)).toEqual(["member.kicked", "member.role_changed"]);
  });

  it("members can leave; the Don must transfer first", async () => {
    const { don, family, members } = await familyWith(1);
    expect((await don.client.post(`/families/${family.id}/leave`)).body.code).toBe("DON_MUST_TRANSFER");
    expect((await members[0]!.client.post(`/families/${family.id}/leave`)).status).toBe(204);
    expect(MeResponse.parse((await members[0]!.client.get("/me")).body).family).toBeNull();
  });

  it("leadership transfer swaps the Don and the old Don becomes underboss", async () => {
    const { don, family, members } = await familyWith(1);
    const heir = members[0]!;
    expect((await heir.client.post(`/families/${family.id}/transfer-leadership`, { playerId: don.id })).status).toBe(403);
    const res = await don.client.post(`/families/${family.id}/transfer-leadership`, { playerId: heir.id });
    expect(res.status).toBe(200);
    expect(await roleOf(family.id, heir.id)).toBe("don");
    expect(await roleOf(family.id, don.id)).toBe("underboss");
    expect(await donCount(family.id)).toBe(1);
  });

  it("disband: refused with other members, allowed for a lone Don; the name is free again", async () => {
    const { don, family, members } = await familyWith(1);
    expect((await don.client.delete(`/families/${family.id}`)).body.code).toBe("FAMILY_NOT_EMPTY");
    await don.client.delete(`/families/${family.id}/members/${members[0]!.id}`);
    expect((await don.client.delete(`/families/${family.id}`)).status).toBe(204);
    expect((await don.client.get(`/families/${family.id}`)).status).toBe(404);
    expect(MeResponse.parse((await don.client.get("/me")).body).family).toBeNull();
    expect((await don.client.post("/families", { name: family.name, tag: family.tag })).status).toBe(201);
  });
});

describe("activity paging", () => {
  it("pages newest first with a cursor and bounded limit", async () => {
    const { don, family } = await familyWith(3); // created + 3×(invited, joined) = 7 entries
    const first = ActivityPage.parse((await don.client.get(`/families/${family.id}/activity?limit=4`)).body);
    expect(first.items).toHaveLength(4);
    const second = ActivityPage.parse((await don.client.get(`/families/${family.id}/activity?limit=4&before=${first.nextCursor}`)).body);
    expect(second.items).toHaveLength(3);
    expect(second.nextCursor).toBeNull();
    expect(second.items.at(-1)!.type).toBe("family.created");
    expect((await don.client.get(`/families/${family.id}/activity?limit=500`)).status).toBe(400);
  });
});

describe("concurrency", () => {
  it("accepting two invitations at the same moment yields exactly one membership", async () => {
    const a = await familyWith(0);
    const b = await familyWith(0);
    const p = await player();
    const invA = await a.don.client.post(`/families/${a.family.id}/invitations`, { handle: p.handle });
    const invB = await b.don.client.post(`/families/${b.family.id}/invitations`, { handle: p.handle });
    const results = await Promise.all([p.client.post(`/invitations/${invA.body.id}/accept`), p.client.post(`/invitations/${invB.body.id}/accept`)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const rows = (await api.db.execute(sql`select family_id from family_memberships where player_id = ${p.id}`)).rows;
    expect(rows).toHaveLength(1);
  });

  it("two simultaneous leadership transfers leave exactly one Don", async () => {
    const { don, family, members } = await familyWith(2);
    const results = await Promise.all(
      members.map((m) => don.client.post(`/families/${family.id}/transfer-leadership`, { playerId: m.id })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
    expect(await donCount(family.id)).toBe(1);
  });

  it("demoting a capo while they kick someone has a consistent outcome", async () => {
    for (let round = 0; round < 3; round++) {
      const { don, family, members } = await familyWith(2);
      const [capo, assoc] = members;
      await don.client.patch(`/families/${family.id}/members/${capo!.id}`, { role: "capo" });
      const [demote, kick] = await Promise.all([
        don.client.patch(`/families/${family.id}/members/${capo!.id}`, { role: "associate" }),
        capo!.client.delete(`/families/${family.id}/members/${assoc!.id}`),
      ]);
      expect(demote.status).toBe(200);
      const assocRole = await roleOf(family.id, assoc!.id);
      // Either the kick ran first (while still capo) or it was refused after the demotion.
      if (kick.status === 200) expect(assocRole).toBeUndefined();
      else {
        expect(kick.status).toBe(403);
        expect(assocRole).toBe("associate");
      }
      expect(await roleOf(family.id, capo!.id)).toBe("associate");
    }
  });

  it("creating two families with the same name at once: one wins", async () => {
    const [p, q] = await Promise.all([player(), player()]);
    const results = await Promise.all([p.client.post("/families", { name: "Race Condition", tag: "RACE" }), q.client.post("/families", { name: "Race Condition", tag: "RAC2" })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });
});
