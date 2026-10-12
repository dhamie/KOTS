import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, resetTestDatabase, startApi, testConfig, type TestApi } from "./helpers";

describe("rate limits", () => {
  let api: TestApi;

  beforeAll(async () => {
    await resetTestDatabase();
    api = await startApi(
      testConfig({ authIpLimit: { limit: 6, ttlMs: 60_000 }, authAccountLimit: { limit: 3, ttlMs: 60_000 } }),
    );
  });

  afterAll(async () => {
    await api?.close();
  });

  const attempt = (email: string) => new Client(api.base).post("/auth/login", { email, password: "guessing-123" });

  it("limits login attempts per account, then per IP, with a standard 429", async () => {
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await attempt("victim@example.test")).status);
    expect(statuses).toEqual([401, 401, 401, 429]);
    const limited = await attempt("VICTIM@example.test");
    expect(limited.status).toBe(429); // same account, different case
    expect(limited.body.code).toBe("RATE_LIMITED");

    // Other accounts from the same IP continue until the per-IP limit (6) is used up.
    expect((await attempt("other1@example.test")).status).toBe(401);
    expect((await attempt("other2@example.test")).status).toBe(429);
  });

  it("doesn't count ordinary requests against the auth limits", async () => {
    for (let i = 0; i < 10; i++) expect((await new Client(api.base).get("/health")).status).toBe(200);
  });
});
