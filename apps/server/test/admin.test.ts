import { NestFactory } from "@nestjs/core";
import type { INestApplicationContext } from "@nestjs/common";
import { ActivityPage, NotificationPage } from "@kots/shared";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdminModule } from "../src/modules/admin/admin.module";
import { AdminService } from "../src/modules/admin/admin.service";
import { economyHelpers } from "./economy-helpers";
import { Client, newPlayer, resetTestDatabase, startApi, TEST_DATABASE_URL, type TestApi } from "./helpers";
import { closeAllSockets, connect } from "./socket-helpers";

let api: TestApi;
let ctx: INestApplicationContext;

beforeAll(async () => {
  await resetTestDatabase();
  api = await startApi();
  // The admin command's own application context, as `npm run admin` builds it.
  ctx = await NestFactory.createApplicationContext(AdminModule.forDatabase(TEST_DATABASE_URL), { logger: false });
});

afterEach(async () => {
  closeAllSockets();
  await expectLedgerConsistent();
});

afterAll(async () => {
  await ctx?.close();
  await api?.close();
});

const { rows, family, balance, setBalance, expectLedgerConsistent } = economyHelpers(() => api, "Admin");
const admin = () => ctx.get(AdminService);
const audit = (targetId: string) => rows<{ action: string; moderator_id: string | null; details: Record<string, unknown> }>(sql`select action, moderator_id, details from moderation_actions where target_id = ${targetId} order by id`);
const login = (handle: string) => new Client(api.base).post("/auth/login", { email: `${handle}@example.test`, password: "correct horse battery" });

describe("adjusting a treasury", () => {
  it("credits and debits through the ledger, with history, a notification for the treasury viewers and an audit entry", async () => {
    const f = await family(["associate"]);
    await setBalance(f.id, 1_000);

    expect(await admin().adjustTreasury(f.tag, 5_000, "compensation for an outage")).toBe(6_000);
    expect(await admin().adjustTreasury(f.tag, -2_500, "duplicate payout")).toBe(3_500);
    expect(await balance(f.don.client, f.id)).toBe(3_500);

    const entries = await rows<{ kind: string; amount: number; code: string | null }>(sql`
      select t.kind, e.amount::int as amount, a.code from ledger_entries e
      join ledger_transactions t on t.id = e.transaction_id join currency_accounts a on a.id = e.account_id
      where t.kind = 'admin_adjust' and t.ref_id = ${f.id} order by e.id`);
    expect(entries).toEqual([
      { kind: "admin_adjust", amount: 5_000, code: null },
      { kind: "admin_adjust", amount: -5_000, code: "admin" },
      { kind: "admin_adjust", amount: -2_500, code: null },
      { kind: "admin_adjust", amount: 2_500, code: "admin" },
    ]);

    const history = ActivityPage.parse((await f.don.client.get(`/families/${f.id}/activity`)).body).items.filter((a) => a.type === "admin.adjusted");
    expect(history.map((a) => [a.actor, a.payload])).toEqual([
      [null, { amount: -2_500, reason: "duplicate payout" }],
      [null, { amount: 5_000, reason: "compensation for an outage" }],
    ]);
    const notes = async (c: Client) => NotificationPage.parse((await c.get("/notifications")).body).items.filter((n) => n.type === "admin.adjusted").map((n) => n.body);
    expect(await notes(f.don.client)).toEqual(["An administrator debited your treasury ₦2,500: duplicate payout", "An administrator credited your treasury ₦5,000: compensation for an outage"]);
    expect(await notes(f.members[0]!.client)).toEqual([]); // associates can't see the treasury

    expect(await audit(f.id)).toEqual([
      { action: "adjust_treasury", moderator_id: null, details: { amount: 5_000, reason: "compensation for an outage" } },
      { action: "adjust_treasury", moderator_id: null, details: { amount: -2_500, reason: "duplicate payout" } },
    ]);
  });

  it("refuses a debit larger than the balance, and bad input, writing nothing", async () => {
    const f = await family();
    await setBalance(f.id, 1_000);
    await expect(admin().adjustTreasury(f.tag, -1_001, "too much")).rejects.toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    await expect(admin().adjustTreasury(f.tag, 0, "nothing")).rejects.toThrow("non-zero whole number");
    await expect(admin().adjustTreasury(f.tag, 10, "  ")).rejects.toThrow("Give a reason");
    await expect(admin().adjustTreasury("NOPE9", 10, "no family")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await balance(f.don.client, f.id)).toBe(1_000);
    expect(await audit(f.id)).toEqual([]);
    expect(await rows(sql`select 1 from activity_log where family_id = ${f.id} and type = 'admin.adjusted'`)).toEqual([]);
  });
});

describe("banning", () => {
  it("ends every session at once, disconnects live connections, blocks login, and is audited; unbanning restores login", async () => {
    const p = await newPlayer(api.base);
    const second = new Client(api.base);
    expect((await second.post("/auth/login", { email: `${p.handle}@example.test`, password: "correct horse battery" })).status).toBe(204);
    const live = await connect(api.base, p.client);
    const closed = new Promise<string>((resolve) => live.socket.once("disconnect", resolve));

    expect(await admin().ban(p.handle, "cheating")).toBe(2);
    expect(await closed).toBe("io server disconnect");
    expect((await p.client.get("/me")).status).toBe(401);
    expect((await second.get("/me")).status).toBe(401);
    const refused = await login(p.handle);
    expect([refused.status, refused.body.code]).toEqual([403, "ACCOUNT_BANNED"]);
    await expect(admin().ban(p.handle, "again")).rejects.toThrow("already banned");

    await admin().unban(p.handle, "appeal upheld");
    expect((await login(p.handle)).status).toBe(204);
    await expect(admin().unban(p.handle, "")).rejects.toThrow("isn't banned");

    expect(await audit(p.id)).toEqual([
      { action: "ban_player", moderator_id: null, details: { reason: "cheating", sessionsEnded: 2 } },
      { action: "unban_player", moderator_id: null, details: { reason: "appeal upheld" } },
    ]);
  });

  it("leaves the family alone", async () => {
    const f = await family(["associate"]);
    await admin().ban(f.members[0]!.handle, "spam");
    const members = (await f.don.client.get(`/families/${f.id}`)).body.members.map((m: { handle: string }) => m.handle);
    expect(members).toContain(f.members[0]!.handle);
  });

  it("an unknown handle fails cleanly", async () => {
    await expect(admin().ban("nobody_here", "x")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("inspecting", () => {
  it("reports a player's account, family and admin history", async () => {
    const f = await family(["associate"]);
    const m = f.members[0]!;
    await admin().ban(m.handle, "spam");
    const r = await admin().inspectPlayer(m.handle);
    expect(r.account).toMatchObject({ playerId: m.id, handle: m.handle, email: `${m.handle}@example.test`, status: "banned", isModerator: false });
    expect(r.membership).toMatchObject({ family: { id: f.id, tag: f.tag }, role: "associate" });
    expect(r.audit.map((a) => a.action)).toEqual(["ban_player"]);
  });

  it("reports a family's members, treasury, holdings, henchmen, goods and ledger", async () => {
    const f = await family(["associate"]);
    await setBalance(f.id, 2_000);
    await admin().adjustTreasury(f.tag, 300, "bonus");
    const r = await admin().inspectFamily(f.tag);
    expect(r.family.members.map((m) => m.handle)).toEqual([f.don.handle, f.members[0]!.handle]);
    expect(r.balance).toBe(2_300);
    expect(r.holdings.territories).toEqual([]);
    expect(r.henchmen).toEqual([]);
    expect(r.inventory.items).toEqual([]);
    expect(r.ledger[0]).toMatchObject({ kind: "admin_adjust", amount: 300, balanceAfter: 2_300 });
    expect(r.audit.map((a) => a.action)).toEqual(["adjust_treasury"]);
  });
});
