import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { Client, resetTestDatabase, startApi, testConfig, type TestApi } from "./helpers";

/** Phase 10c: what production refuses to start with, and reading the client's IP behind Caddy. */
describe("production config", () => {
  const prod = { NODE_ENV: "production", DATABASE_URL: "postgres://kots:x@db:5432/kots", ALLOWED_ORIGINS: "https://kots.example" };

  it("starts with a database URL and https origins, with Secure cookies", () => {
    const config = loadConfig(prod);
    expect(config.allowedOrigins).toEqual(["https://kots.example"]);
    expect(config.secureCookies).toBe(true);
  });

  it("refuses the development defaults", () => {
    expect(() => loadConfig({ ...prod, DATABASE_URL: undefined })).toThrow("DATABASE_URL must be set");
    expect(() => loadConfig({ ...prod, ALLOWED_ORIGINS: undefined })).toThrow("must all be https"); // the localhost default
    expect(() => loadConfig({ ...prod, ALLOWED_ORIGINS: " , " })).toThrow("ALLOWED_ORIGINS must be set");
    expect(() => loadConfig({ ...prod, ALLOWED_ORIGINS: "https://kots.example,http://kots.example" })).toThrow("http://kots.example");
  });

  it("reads TRUST_PROXY as a number of proxies, off by default", () => {
    expect(loadConfig({}).trustProxy).toBe(0);
    expect(loadConfig({ TRUST_PROXY: "1" }).trustProxy).toBe(1);
    for (const bad of ["-1", "1.5", "yes", "true"]) expect(() => loadConfig({ TRUST_PROXY: bad })).toThrow("TRUST_PROXY");
  });
});

describe("per-IP limits behind a proxy", () => {
  let api: TestApi | undefined;
  afterEach(async () => {
    await api?.close();
    api = undefined;
  });

  const start = async (trustProxy: number) => {
    await resetTestDatabase();
    api = await startApi(testConfig({ trustProxy, authIpLimit: { limit: 2, ttlMs: 60_000 } }));
    return api;
  };
  let n = 0;
  /** A failed login, as if forwarded by Caddy for the player at `ip`. */
  const loginFrom = (a: TestApi, ip: string) =>
    new Client(a.base, { "x-forwarded-for": ip }).post("/auth/login", { email: `guess${++n}@example.test`, password: "guessing-123" }).then((r) => r.status);

  it("with TRUST_PROXY=1, counts each player's address separately", async () => {
    const a = await start(1);
    expect([await loginFrom(a, "203.0.113.1"), await loginFrom(a, "203.0.113.1"), await loginFrom(a, "203.0.113.1")]).toEqual([401, 401, 429]);
    expect(await loginFrom(a, "203.0.113.2")).toBe(401);
    // Only the last hop is trusted: an address a client prepends itself is ignored, so it can't dodge its limit.
    expect(await loginFrom(a, "198.51.100.9, 203.0.113.1")).toBe(429);
  });

  it("without it, ignores X-Forwarded-For, so a client can't choose its own address", async () => {
    const a = await start(0);
    expect([await loginFrom(a, "203.0.113.1"), await loginFrom(a, "203.0.113.2"), await loginFrom(a, "203.0.113.3")]).toEqual([401, 401, 429]);
  });
});
