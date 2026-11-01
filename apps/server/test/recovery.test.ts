import { NestFactory } from "@nestjs/core";
import { ChatChannelList } from "@kots/shared";
import { sql } from "drizzle-orm";
import net from "node:net";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, createPool } from "../src/db/db";
import { BOSS, QUEUES, startBoss } from "../src/worker/boss";
import { WorkerModule } from "../src/worker.module";
import { newPlayer, resetTestDatabase, startApi, TEST_DATABASE_URL, type TestApi } from "./helpers";
import { closeAllSockets, connect } from "./socket-helpers";

/**
 * Phase 9c: the processes survive the database dropping their connections, jobs abandoned by a crashed worker are
 * freed within minutes, and an api shutdown lets browsers reconnect. (These run in this process: a crash here would
 * fail the whole run.)
 */
let api: TestApi;
beforeAll(async () => {
  await resetTestDatabase();
  api = await startApi();
});
afterAll(async () => {
  closeAllSockets();
  await api?.close();
});

/** What a database restart or failover does to clients: every other connection to the database is ended. */
async function endAllConnections(): Promise<void> {
  const pool = createPool(TEST_DATABASE_URL);
  try {
    await createDb(pool).execute(sql`select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`);
  } finally {
    await pool.end();
  }
  await new Promise((r) => setTimeout(r, 300));
}
async function eventually<T>(fn: () => Promise<T>, ms = 10_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (Date.now() > until) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

describe("the database dropping every connection", () => {
  it("doesn't stop the api: the next requests work, and live updates resume once the listener reconnects", async () => {
    const p = await newPlayer(api.base);
    expect((await p.client.get("/me")).status).toBe(200);
    const live = await connect(api.base, p.client);

    await endAllConnections();

    // The pool dropped its dead connections instead of crashing the process; new ones serve the next requests.
    expect((await p.client.get("/me")).status).toBe(200);
    expect((await p.client.get("/health")).status).toBe(200);
    // The socket itself stayed up (it isn't a database connection); the event listener reconnects within seconds.
    const channel = ChatChannelList.parse((await p.client.get("/chat/channels")).body).find((c) => c.kind === "public")!;
    await eventually(async () => {
      const body = `after the outage ${Date.now()}`;
      expect((await p.client.post(`/chat/channels/${channel.id}/messages`, { body })).status).toBe(201);
      await live.next("chat.message", (e) => e.message.body === body, 1_000);
    });
  });

  it("doesn't stop the worker: it still picks up and finishes jobs", async () => {
    const ctx = await NestFactory.createApplicationContext(WorkerModule.forDatabase(TEST_DATABASE_URL, undefined, [QUEUES.heartbeat]), { logger: false });
    try {
      await ctx.init();
      const boss = ctx.get<PgBoss>(BOSS);
      await endAllConnections();
      const id = await eventually(async () => (await boss.send(QUEUES.heartbeat))!);
      await eventually(async () => {
        const [job] = await boss.findJobs(QUEUES.heartbeat, { id });
        expect(job?.state).toBe("completed");
      }, 20_000);
    } finally {
      await ctx.close();
    }
  });
});

describe("jobs a crashed worker abandons", () => {
  it("expire within minutes, not pg-boss's default 15, so the sweep after them runs; queues made before 9c are updated", async () => {
    const boss = await startBoss(TEST_DATABASE_URL);
    try {
      expect((await boss.getQueue(QUEUES.battleSweep))?.expireInSeconds).toBe(120);
      expect((await boss.getQueue(QUEUES.upkeepSweep))?.expireInSeconds).toBe(300);
      expect((await boss.getQueue(QUEUES.succession))?.expireInSeconds).toBe(600);
      // A queue as an earlier release left it: the next start brings it in line.
      await boss.updateQueue(QUEUES.eventSweep, { expireInSeconds: 900 });
    } finally {
      await boss.stop({ graceful: false });
    }
    const again = await startBoss(TEST_DATABASE_URL);
    try {
      expect((await again.getQueue(QUEUES.eventSweep))?.expireInSeconds).toBe(120);
    } finally {
      await again.stop({ graceful: false });
    }
  });
});

describe("an api shutting down", () => {
  it("doesn't wait for ever on a connection a client left open mid-request", async () => {
    const other = await startApi();
    const url = new URL(other.base);
    // Half a request and then silence, as a dead client or a proxy can leave it: the server sees an active connection.
    const stuck = net.connect(Number(url.port), url.hostname);
    await new Promise<void>((resolve) => stuck.once("connect", () => resolve()));
    stuck.write("GET /api/health HTTP/1.1\r\nHost: localhost\r\n");
    await new Promise((r) => setTimeout(r, 200));
    const closedBy = Date.now();
    await other.close();
    expect(Date.now() - closedBy).toBeLessThan(5_000);
    stuck.destroy();
  });

  it("closes live connections so browsers reconnect, rather than telling them their session ended", async () => {
    const other = await startApi();
    const p = await newPlayer(other.base);
    const live = await connect(other.base, p.client);
    const closed = new Promise<string>((resolve) => live.socket.once("disconnect", resolve));
    await other.close();
    expect(await closed).toBe("transport close");
  });
});
