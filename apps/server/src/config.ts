import { CHAT } from "@kots/content";

export const DEFAULT_DATABASE_URL = "postgres://kots:kots@localhost:5434/kots";
export const DEFAULT_API_PORT = 4100;

export interface RateLimit {
  limit: number;
  ttlMs: number;
}

export interface ServerConfig {
  databaseUrl: string;
  apiPort: number;
  /** Origins allowed to make state-changing requests (CSRF defence). */
  allowedOrigins: string[];
  /** Send the session cookie with `Secure` (on in production, where the site is HTTPS). */
  secureCookies: boolean;
  /** Per-IP limit on login/register. */
  authIpLimit: RateLimit;
  /** Per-account (email) limit on login/register, so one account can't be guessed from many IPs. */
  authAccountLimit: RateLimit;
  /** Per-IP limit on everything else. */
  generalLimit: RateLimit;
  /** Per-player limit on sending chat messages. */
  chatLimit: RateLimit;
  /** Queues the worker serves (WORKER_QUEUES, comma-separated); null for all. */
  workerQueues: string[] | null;
  /** Log every HTTP request on arrival and on finish (LOG_REQUESTS=1); used to diagnose browser-test stalls. */
  logRequests: boolean;
  /** LOAD_TEST=1 (Phase 10 load tests, never production): per-IP limits raised, since every virtual player shares one IP. */
  loadTest: boolean;
  /**
   * TRUST_PROXY: how many proxies sit in front of the api (1 behind Caddy). The client's IP, used by the per-IP rate
   * limits, is then read from X-Forwarded-For that many hops back. 0 (the default) ignores the header, so a client
   * can't set its own IP; behind a proxy, though, every player would then share the proxy's IP and its limits.
   */
  trustProxy: number;
}

const MINUTE = 60_000;

/** Per-IP limits during a load test: high enough never to trigger. Per-player and per-account limits stay as they are. */
const LOAD_TEST_IP_LIMIT: RateLimit = { limit: 1_000_000, ttlMs: MINUTE };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const production = env.NODE_ENV === "production";
  const loadTest = env.LOAD_TEST === "1";
  if (loadTest && production) throw new Error("LOAD_TEST=1 lifts the per-IP rate limits and can't be used in production.");
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "http://localhost:5180").split(",").map((s) => s.trim()).filter(Boolean);
  if (production) checkProduction(env, allowedOrigins);
  const trustProxy = Number(env.TRUST_PROXY ?? 0);
  if (!Number.isInteger(trustProxy) || trustProxy < 0) throw new Error(`TRUST_PROXY must be a whole number of proxies (0, 1, …), not "${env.TRUST_PROXY}".`);
  return {
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    apiPort: env.API_PORT ? Number(env.API_PORT) : DEFAULT_API_PORT,
    allowedOrigins,
    secureCookies: production,
    authIpLimit: loadTest ? LOAD_TEST_IP_LIMIT : { limit: 30, ttlMs: 15 * MINUTE },
    authAccountLimit: { limit: 10, ttlMs: 15 * MINUTE },
    generalLimit: loadTest ? LOAD_TEST_IP_LIMIT : { limit: 300, ttlMs: MINUTE },
    chatLimit: { limit: CHAT.rateLimit.messages, ttlMs: CHAT.rateLimit.seconds * 1000 },
    workerQueues: env.WORKER_QUEUES ? env.WORKER_QUEUES.split(",").map((s) => s.trim()).filter(Boolean) : null,
    logRequests: env.LOG_REQUESTS === "1",
    loadTest,
    trustProxy,
  };
}

/**
 * In production the development defaults would be wrong rather than merely unhelpful (the local database, a
 * localhost origin), so they must be set. Origins must be https: the session cookie is Secure there, so a browser
 * on an http origin could never sign in.
 */
function checkProduction(env: NodeJS.ProcessEnv, allowedOrigins: string[]): void {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL must be set in production.");
  if (allowedOrigins.length === 0) throw new Error("ALLOWED_ORIGINS must be set in production (e.g. https://kots.example).");
  const insecure = allowedOrigins.filter((o) => !o.startsWith("https://"));
  if (insecure.length > 0) throw new Error(`ALLOWED_ORIGINS must all be https in production: ${insecure.join(", ")}.`);
}
