import { describe, expect, it } from "vitest";
import { HealthResponse } from "../src";

describe("HealthResponse", () => {
  it("accepts a valid response", () => {
    expect(HealthResponse.parse({ status: "ok", db: "ok" })).toEqual({ status: "ok", db: "ok" });
  });

  it("rejects unknown or missing values", () => {
    expect(HealthResponse.safeParse({ status: "fine", db: "ok" }).success).toBe(false);
    expect(HealthResponse.safeParse({ status: "ok" }).success).toBe(false);
  });
});
