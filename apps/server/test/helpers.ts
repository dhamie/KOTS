import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { sql } from "drizzle-orm";
import { join } from "node:path";
import { ApiModule } from "../src/api.module";
import type { Clock } from "../src/common/clock";
import { loadConfig, type ServerConfig } from "../src/config";
import { configureApp } from "../src/configure";
import { createDb, createPool, runMigrations, type Database } from "../src/db/db";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://kots:kots@localhost:5434/kots_test";

/** Drops everything in the test database and re-applies all migrations from empty. */
export async function resetTestDatabase(): Promise<void> {
  const pool = createPool(TEST_DATABASE_URL);
  const db = createDb(pool);
  try {
    await db.execute(sql`DROP SCHEMA IF EXISTS public, drizzle, pgboss CASCADE`);
    await db.execute(sql`CREATE SCHEMA public`);
    await runMigrations(db, join(__dirname, "..", "drizzle"));
  } finally {
    await pool.end();
  }
}

/** Real config against the test database, with rate limits high enough not to interfere unless a test lowers them. */
export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const base = loadConfig({ DATABASE_URL: TEST_DATABASE_URL });
  const roomy = { limit: 10_000, ttlMs: 60_000 };
  return { ...base, authIpLimit: roomy, authAccountLimit: roomy, generalLimit: roomy, ...overrides };
}

export interface TestApi {
  app: INestApplication;
  base: string;
  db: Database;
  close(): Promise<void>;
}

/** A clock tests move by hand. Starts at the real time so database defaults (`now()`) stay close to it. */
export class TestClock implements Clock {
  private t = Date.now();
  now = () => new Date(this.t);
  set(at: Date | number): void {
    this.t = typeof at === "number" ? at : at.getTime();
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export async function startApi(config: ServerConfig = testConfig(), clock?: Clock): Promise<TestApi> {
  const app = await NestFactory.create(ApiModule.forConfig(config, clock), { logger: false });
  configureApp(app, config);
  await app.listen(0);
  const base = (await app.getUrl()).replace("[::1]", "localhost");
  const pool = createPool(config.databaseUrl);
  return {
    app,
    base,
    db: createDb(pool),
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

/** A tiny HTTP client that keeps its session cookie, like a browser tab. */
export class Client {
  private cookie: string | undefined;

  constructor(
    private readonly base: string,
    private readonly headers: Record<string, string> = {},
  ) {}

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any; headers: Headers }> {
    const res = await fetch(`${this.base}/api${path}`, {
      method,
      headers: {
        ...this.headers,
        ...headers,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) {
      const pair = setCookie.split(";")[0]!;
      this.cookie = pair.endsWith("=") ? undefined : pair;
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  }

  /** The session cookie, for opening a socket as this client. */
  get sessionCookie(): string | undefined {
    return this.cookie;
  }

  get = (path: string) => this.request("GET", path);
  post = (path: string, body?: unknown, headers?: Record<string, string>) => this.request("POST", path, body ?? {}, headers);
  patch = (path: string, body: unknown) => this.request("PATCH", path, body);
  delete = (path: string) => this.request("DELETE", path);
}

let counter = 0;

/** Registers a fresh player and returns a logged-in client plus the player's id. */
export async function newPlayer(base: string, handle = `p${Date.now() % 1e6}_${++counter}`): Promise<{ client: Client; id: string; handle: string }> {
  const client = new Client(base);
  const reg = await client.post("/auth/register", { email: `${handle}@example.test`, password: "correct horse battery", handle });
  if (reg.status !== 204) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  const me = await client.get("/me");
  return { client, id: me.body.player.id, handle };
}
