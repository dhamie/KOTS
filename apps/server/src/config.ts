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
}

const MINUTE = 60_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    databaseUrl: env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    apiPort: env.API_PORT ? Number(env.API_PORT) : DEFAULT_API_PORT,
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "http://localhost:5180").split(",").map((s) => s.trim()).filter(Boolean),
    secureCookies: env.NODE_ENV === "production",
    authIpLimit: { limit: 30, ttlMs: 15 * MINUTE },
    authAccountLimit: { limit: 10, ttlMs: 15 * MINUTE },
    generalLimit: { limit: 300, ttlMs: MINUTE },
    chatLimit: { limit: CHAT.rateLimit.messages, ttlMs: CHAT.rateLimit.seconds * 1000 },
    workerQueues: env.WORKER_QUEUES ? env.WORKER_QUEUES.split(",").map((s) => s.trim()).filter(Boolean) : null,
    logRequests: env.LOG_REQUESTS === "1",
  };
}
