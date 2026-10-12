import { HealthResponse } from "@kots/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetTestDatabase, startApi, testConfig, type TestApi } from "./helpers";

describe("GET /api/health", () => {
  let api: TestApi;

  beforeAll(async () => {
    await resetTestDatabase();
    api = await startApi();
  });

  afterAll(async () => {
    await api?.close();
  });

  it("returns 200 and db ok when the database is reachable", async () => {
    const res = await fetch(`${api.base}/api/health`);
    expect(res.status).toBe(200);
    expect(HealthResponse.parse(await res.json())).toEqual({ status: "ok", db: "ok" });
  });

  it("is only served under the /api prefix", async () => {
    expect((await fetch(`${api.base}/health`)).status).toBe(404);
  });
});

describe("GET /api/health without a database", () => {
  it("returns 503 and db down", async () => {
    // Nothing listens on port 1, so every query fails.
    const api = await startApi(testConfig({ databaseUrl: "postgres://nobody:nothing@127.0.0.1:1/none" }));
    try {
      const res = await fetch(`${api.base}/api/health`);
      expect(res.status).toBe(503);
      expect(HealthResponse.parse(await res.json())).toEqual({ status: "degraded", db: "down" });
    } finally {
      await api.close();
    }
  });
});
