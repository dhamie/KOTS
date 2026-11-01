import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, NoAnswerError } from "../src/api/http";
import { keyedSender } from "../src/ui/useRequestKey";

afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("a request with no answer (Phase 9c)", () => {
  it("is given up on after the timeout, with a message the player can act on", async () => {
    const fetch = vi.fn((_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal); // every request carries the timeout
      return Promise.reject(new DOMException("signal timed out", "TimeoutError"));
    });
    vi.stubGlobal("fetch", fetch);
    await expect(api.me()).rejects.toEqual(new NoAnswerError("The server didn't answer. Try again."));
  });

  it("can't reach the server: says so", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(api.me()).rejects.toBeInstanceOf(NoAnswerError);
  });

  it("an answered refusal is still an ApiError with the server's message", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(json(409, { code: "TERRITORY_OWNED", message: "Someone holds it.", correlationId: "00000000-0000-4000-8000-000000000000" })));
    await expect(api.claim("isale-eko")).rejects.toEqual(new ApiError(409, "TERRITORY_OWNED", "Someone holds it."));
  });
});

describe("a form's Idempotency-Key", () => {
  const keys = () => {
    let n = 0;
    return () => `key-${++n}`;
  };

  it("is kept when there was no answer or a 5xx, so the retry is recognised; renewed after any definite answer", async () => {
    const send = keyedSender(keys());
    const used: string[] = [];
    const attempt = (outcome: () => Promise<string>) => send(async (key) => (used.push(key), outcome()));

    await expect(attempt(() => Promise.reject(new NoAnswerError("no answer")))).rejects.toBeInstanceOf(NoAnswerError);
    await expect(attempt(() => Promise.reject(new ApiError(502, "INTERNAL", "HTTP 502")))).rejects.toBeInstanceOf(ApiError);
    await attempt(() => Promise.resolve("ok")); // the retry that finally gets through
    await expect(attempt(() => Promise.reject(new ApiError(409, "TOO_MANY_OFFERS", "full")))).rejects.toBeInstanceOf(ApiError);
    await attempt(() => Promise.resolve("ok"));

    expect(used).toEqual(["key-1", "key-1", "key-1", "key-2", "key-3"]);
  });
});
