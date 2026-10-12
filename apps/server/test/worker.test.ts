import "reflect-metadata";
import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BOSS, QUEUES } from "../src/worker/boss";
import { DriftJob } from "../src/worker/drift.job";
import { BattleSweepJob } from "../src/worker/battle-sweep.job";
import { EventGenerateJob } from "../src/worker/event-generate.job";
import { EventSweepJob } from "../src/worker/event-sweep.job";
import { ProposalExpiryJob } from "../src/worker/proposal-expiry.job";
import { TradeExpiryJob } from "../src/worker/trade-expiry.job";
import { HeartbeatJob } from "../src/worker/heartbeat.job";
import { SuccessionJob } from "../src/worker/succession.job";
import { UpkeepJob } from "../src/worker/upkeep.job";
import { WagesJob } from "../src/worker/wages.job";
import { WorkerModule } from "../src/worker.module";
import { resetTestDatabase, TEST_DATABASE_URL } from "./helpers";

/** Polls until `check` passes or the timeout expires. */
async function eventually(check: () => void | Promise<void>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await check();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

describe("worker process", () => {
  let ctx: INestApplicationContext;
  let boss: PgBoss;

  beforeAll(async () => {
    await resetTestDatabase();
    ctx = await NestFactory.createApplicationContext(WorkerModule.forDatabase(TEST_DATABASE_URL), { logger: false });
    await ctx.init();
    boss = ctx.get<PgBoss>(BOSS);
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it("picks up a heartbeat job and runs it", async () => {
    const run = vi.spyOn(ctx.get(HeartbeatJob), "run");
    const id = await boss.send(QUEUES.heartbeat);
    expect(id).not.toBeNull();
    await eventually(() => expect(run).toHaveBeenCalledTimes(1));
    await eventually(async () => {
      const [job] = await boss.findJobs(QUEUES.heartbeat, { id: id! });
      expect(job?.state).toBe("completed");
    });
  });

  it("schedules the upkeep and wage sweeps, the succession check, market drift, trade and proposal expiry, the battle sweep, the event roll and sweep, and runs them when a job arrives", async () => {
    const schedules = (await boss.getSchedules()).map((s) => [s.name, s.cron]);
    expect(schedules).toEqual(
      expect.arrayContaining([
        [QUEUES.upkeepSweep, "*/5 * * * *"],
        [QUEUES.succession, "17 * * * *"],
        [QUEUES.wageSweep, "*/5 * * * *"],
        [QUEUES.marketDrift, "1,31 * * * *"],
        [QUEUES.tradeExpiry, "*/5 * * * *"],
        [QUEUES.proposalExpiry, "*/5 * * * *"],
        [QUEUES.battleSweep, "* * * * *"],
        [QUEUES.eventGenerate, "7 * * * *"],
        [QUEUES.eventSweep, "* * * * *"],
      ]),
    );
    const upkeep = vi.spyOn(ctx.get(UpkeepJob), "run");
    const succession = vi.spyOn(ctx.get(SuccessionJob), "run");
    const wages = vi.spyOn(ctx.get(WagesJob), "run");
    const drift = vi.spyOn(ctx.get(DriftJob), "run");
    const expiry = vi.spyOn(ctx.get(TradeExpiryJob), "run");
    const proposalExpiry = vi.spyOn(ctx.get(ProposalExpiryJob), "run");
    const battleSweep = vi.spyOn(ctx.get(BattleSweepJob), "run");
    const eventGenerate = vi.spyOn(ctx.get(EventGenerateJob), "run");
    const eventSweep = vi.spyOn(ctx.get(EventSweepJob), "run");
    await boss.send(QUEUES.upkeepSweep);
    await boss.send(QUEUES.succession);
    await boss.send(QUEUES.wageSweep);
    await boss.send(QUEUES.marketDrift);
    await boss.send(QUEUES.tradeExpiry);
    await boss.send(QUEUES.proposalExpiry);
    await boss.send(QUEUES.battleSweep);
    await boss.send(QUEUES.eventGenerate);
    await boss.send(QUEUES.eventSweep);
    await eventually(() => {
      expect(upkeep).toHaveBeenCalledTimes(1);
      expect(succession).toHaveBeenCalledTimes(1);
      expect(wages).toHaveBeenCalledTimes(1);
      expect(drift).toHaveBeenCalledTimes(1);
      expect(expiry).toHaveBeenCalledTimes(1);
      expect(proposalExpiry).toHaveBeenCalledTimes(1);
      expect(battleSweep).toHaveBeenCalledTimes(1);
      expect(eventGenerate).toHaveBeenCalledTimes(1);
      expect(eventSweep).toHaveBeenCalledTimes(1);
    });
    // Both ran against the real (empty) tables without failing.
    await eventually(async () => {
      const jobs = await Promise.all([QUEUES.upkeepSweep, QUEUES.succession, QUEUES.wageSweep, QUEUES.marketDrift, QUEUES.tradeExpiry, QUEUES.proposalExpiry, QUEUES.battleSweep, QUEUES.eventGenerate, QUEUES.eventSweep].map((q) => boss.findJobs(q)));
      const states = jobs.flat().map((j) => j.state);
      expect(states.length).toBeGreaterThan(0);
      expect(states.every((s) => s === "completed")).toBe(true);
    });
  });

  it("refuses a duplicate job with the same singleton key, so it runs once", async () => {
    const queue = "test.dedupe";
    await boss.createQueue(queue, { policy: "short" });
    const first = await boss.send(queue, { n: 1 }, { singletonKey: "territory-7:2026-10-09" });
    const second = await boss.send(queue, { n: 2 }, { singletonKey: "territory-7:2026-10-09" });
    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const seen: unknown[] = [];
    await boss.work(queue, async (jobs) => {
      for (const job of jobs) seen.push(job.data);
    });
    await eventually(() => expect(seen).toEqual([{ n: 1 }]));
    // Give a would-be second run time to happen, then check it didn't.
    await new Promise((r) => setTimeout(r, 1500));
    expect(seen).toEqual([{ n: 1 }]);
  });

  it("a worker limited to some queues runs only those jobs", async () => {
    const limited = await NestFactory.createApplicationContext(WorkerModule.forDatabase(TEST_DATABASE_URL, undefined, [QUEUES.battleSweep]), { logger: false });
    await limited.init();
    expect(limited.get(BattleSweepJob)).toBeInstanceOf(BattleSweepJob);
    expect(() => limited.get(HeartbeatJob)).toThrow();
    expect(() => limited.get(DriftJob)).toThrow();
    await limited.close();
  });

  it("re-running queue setup on an existing database is harmless (a second worker can start)", async () => {
    const second = await NestFactory.createApplicationContext(WorkerModule.forDatabase(TEST_DATABASE_URL), { logger: false });
    await second.init();
    await second.close();
  });
});
