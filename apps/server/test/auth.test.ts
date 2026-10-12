import { ApiErrorBody, MeResponse } from "@kots/shared";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, resetTestDatabase, startApi, type TestApi } from "./helpers";

let api: TestApi;

beforeAll(async () => {
  await resetTestDatabase();
  api = await startApi();
});

afterAll(async () => {
  await api?.close();
});

const PASSWORD = "correct horse battery";

describe("accounts", () => {
  it("register logs you in; /me shows the account with no family", async () => {
    const c = new Client(api.base);
    const reg = await c.post("/auth/register", { email: "Ada@Example.test", password: PASSWORD, handle: "Ada_1" });
    expect(reg.status).toBe(204);
    const cookie = reg.headers.get("set-cookie")!;
    expect(cookie).toMatch(/^ll_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);

    const me = await c.get("/me");
    expect(me.status).toBe(200);
    expect(MeResponse.parse(me.body)).toMatchObject({ email: "Ada@Example.test", player: { handle: "Ada_1" }, family: null });
  });

  it("stores an argon2id hash and only a hash of the session token", async () => {
    const [user] = (await api.db.execute(sql`select password_hash from users where email = 'ada@example.test'`)).rows as { password_hash: string }[];
    expect(user!.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    const sessions = (await api.db.execute(sql`select id from sessions`)).rows as { id: string }[];
    expect(sessions.every((s) => /^[0-9a-f]{64}$/.test(s.id))).toBe(true);
  });

  it("rejects duplicate email and handle regardless of case", async () => {
    const c = new Client(api.base);
    const email = await c.post("/auth/register", { email: "ADA@example.TEST", password: PASSWORD, handle: "someone_else" });
    expect(email.status).toBe(409);
    expect(email.body.code).toBe("EMAIL_TAKEN");
    const handle = await c.post("/auth/register", { email: "new@example.test", password: PASSWORD, handle: "ada_1" });
    expect(handle.status).toBe(409);
    expect(handle.body.code).toBe("HANDLE_TAKEN");
  });

  it("login works with the right password and gives the same error for a wrong password or unknown email", async () => {
    const c = new Client(api.base);
    expect((await c.post("/auth/login", { email: "ada@example.test", password: PASSWORD })).status).toBe(204);
    expect((await c.get("/me")).status).toBe(200);

    const wrong = await new Client(api.base).post("/auth/login", { email: "ada@example.test", password: "wrong password!" });
    const unknown = await new Client(api.base).post("/auth/login", { email: "nobody@example.test", password: "wrong password!" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.code).toBe("INVALID_CREDENTIALS");
    expect(unknown.body.message).toBe(wrong.body.message);
  });

  it("logout ends the session", async () => {
    const c = new Client(api.base);
    await c.post("/auth/login", { email: "ada@example.test", password: PASSWORD });
    const cookieBefore = (c as unknown as { cookie: string }).cookie;
    expect((await c.post("/auth/logout")).status).toBe(204);
    expect((await c.get("/me")).status).toBe(401);
    // Replaying the old cookie doesn't work either: the session row is gone.
    const replay = new Client(api.base, { cookie: cookieBefore });
    expect((await replay.get("/me")).status).toBe(401);
  });

  it("rejects requests with no session, an unknown token or an expired session", async () => {
    expect((await new Client(api.base).get("/me")).status).toBe(401);
    expect((await new Client(api.base, { cookie: "ll_session=forged" }).get("/me")).status).toBe(401);

    const c = new Client(api.base);
    await c.post("/auth/register", { email: "exp@example.test", password: PASSWORD, handle: "expiring" });
    await api.db.execute(sql`update sessions set expires_at = now() - interval '1 second' where user_id = (select id from users where email = 'exp@example.test')`);
    const res = await c.get("/me");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
  });

  it("a banned user is logged out everywhere and can't log back in", async () => {
    const c = new Client(api.base);
    await c.post("/auth/register", { email: "ban@example.test", password: PASSWORD, handle: "banned_one" });
    expect((await c.get("/me")).status).toBe(200);
    await api.db.execute(sql`update users set status = 'banned' where email = 'ban@example.test'`);
    expect((await c.get("/me")).status).toBe(401);
    const login = await new Client(api.base).post("/auth/login", { email: "ban@example.test", password: PASSWORD });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe("ACCOUNT_BANNED");
    // The wrong password still gets the generic answer, so a ban isn't revealed to strangers.
    const guess = await new Client(api.base).post("/auth/login", { email: "ban@example.test", password: "not the password" });
    expect(guess.body.code).toBe("INVALID_CREDENTIALS");
  });

  it("refreshes an old session's expiry and cookie when it's used", async () => {
    const c = new Client(api.base);
    await c.post("/auth/register", { email: "slide@example.test", password: PASSWORD, handle: "slider" });
    await api.db.execute(sql`update sessions set last_seen_at = now() - interval '2 hours', expires_at = now() + interval '1 day' where user_id = (select id from users where email = 'slide@example.test')`);
    const res = await c.get("/me");
    expect(res.headers.get("set-cookie")).toMatch(/^ll_session=/);
    const [row] = (await api.db.execute(sql`select expires_at > now() + interval '29 days' as extended from sessions where user_id = (select id from users where email = 'slide@example.test')`)).rows;
    expect(row).toEqual({ extended: true });
  });

  it("public profile by handle", async () => {
    const c = new Client(api.base);
    await c.post("/auth/login", { email: "ada@example.test", password: PASSWORD });
    const res = await c.get("/players/ADA_1");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ handle: "Ada_1", family: null });
    expect(res.body.email).toBeUndefined();
    expect((await c.get("/players/nobody_here")).status).toBe(404);
  });
});

describe("validation and errors", () => {
  it("bad input is a 400 in the standard shape, listing the problems", async () => {
    const res = await new Client(api.base).post("/auth/register", { email: "not-an-email", password: "short", handle: "x" });
    expect(res.status).toBe(400);
    const body = ApiErrorBody.parse(res.body);
    expect(body.code).toBe("VALIDATION_FAILED");
    expect((body.details as { path: string }[]).map((d) => d.path).sort()).toEqual(["email", "handle", "password"]);
    expect(body.correlationId).toBe(res.headers.get("x-request-id"));
  });

  it("unknown fields are rejected, so clients can't smuggle extra properties", async () => {
    const res = await new Client(api.base).post("/auth/register", { email: "x@example.test", password: PASSWORD, handle: "smuggler", status: "active" });
    expect(res.status).toBe(400);
  });

  it("malformed JSON and oversized bodies get the standard shape", async () => {
    const bad = await new Client(api.base).request("POST", "/auth/login", "{not json");
    expect(bad.status).toBe(400);
    expect(ApiErrorBody.parse(bad.body).code).toBe("VALIDATION_FAILED");

    const big = await new Client(api.base).post("/auth/login", { email: "a@example.test", password: "x".repeat(20_000) });
    expect(big.status).toBe(413);
    expect(ApiErrorBody.parse(big.body).code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("reuses a sane incoming request id and replaces a bad one", async () => {
    const good = await new Client(api.base, { "x-request-id": "lb-abc.123" }).get("/me");
    expect(good.body.correlationId).toBe("lb-abc.123");
    const bad = await new Client(api.base, { "x-request-id": "has spaces <script>" }).get("/me");
    expect(bad.body.correlationId).not.toBe("has spaces <script>");
    expect(bad.body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("unknown routes are a 404 in the standard shape", async () => {
    const res = await new Client(api.base).get("/nope");
    expect(res.status).toBe(404);
    expect(ApiErrorBody.parse(res.body).code).toBe("NOT_FOUND");
  });
});

describe("origin check", () => {
  it("refuses writes from a foreign origin, allows the app's origin and non-browser clients", async () => {
    const evil = await new Client(api.base, { origin: "https://evil.example" }).post("/auth/login", { email: "ada@example.test", password: PASSWORD });
    expect(evil.status).toBe(403);
    expect(evil.body.code).toBe("ORIGIN_REJECTED");

    const app = await new Client(api.base, { origin: "http://localhost:5180" }).post("/auth/login", { email: "ada@example.test", password: PASSWORD });
    expect(app.status).toBe(204);
    const cli = await new Client(api.base).post("/auth/login", { email: "ada@example.test", password: PASSWORD });
    expect(cli.status).toBe(204);
  });

  it("reads are not origin-checked", async () => {
    expect((await new Client(api.base, { origin: "https://evil.example" }).get("/health")).status).toBe(200);
  });
});
