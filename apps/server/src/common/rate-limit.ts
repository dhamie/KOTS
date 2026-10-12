import { type ExecutionContext, SetMetadata } from "@nestjs/common";
import type { ThrottlerModuleOptions } from "@nestjs/throttler";
import type { RateLimit, ServerConfig } from "../config";

const AUTH_RATE_LIMITED = "authRateLimited";

/** Marks login/register handlers for the stricter per-IP and per-account limits. */
export const AuthRateLimited = () => SetMetadata(AUTH_RATE_LIMITED, true);

const isAuthRoute = (ctx: ExecutionContext) => Reflect.getMetadata(AUTH_RATE_LIMITED, ctx.getHandler()) === true;

/** In-memory counters for now; switch `storage` to Redis when there is more than one API instance. */
export function throttlerOptions(config: ServerConfig): ThrottlerModuleOptions {
  return {
    throttlers: [
      { name: "general", limit: config.generalLimit.limit, ttl: config.generalLimit.ttlMs },
      { name: "auth_ip", limit: config.authIpLimit.limit, ttl: config.authIpLimit.ttlMs, skipIf: (ctx) => !isAuthRoute(ctx) },
      {
        name: "auth_account",
        limit: config.authAccountLimit.limit,
        ttl: config.authAccountLimit.ttlMs,
        skipIf: (ctx) => !isAuthRoute(ctx),
        getTracker: (req) => `email:${String(req.body?.email ?? "").trim().toLowerCase()}`,
      },
    ],
  };
}

/** Allows `limit` hits per key in any `ttlMs` window. In memory, like the throttler above. */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly config: RateLimit) {}

  /** Records a hit and returns true, or returns false if the key is over its limit. */
  take(key: string, now = Date.now()): boolean {
    const since = now - this.config.ttlMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (recent.length >= this.config.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    // Keep the map from growing without bound: drop keys with nothing recent.
    if (this.hits.size > 10_000) for (const [k, ts] of this.hits) if (ts[ts.length - 1]! <= since) this.hits.delete(k);
    return true;
  }
}
