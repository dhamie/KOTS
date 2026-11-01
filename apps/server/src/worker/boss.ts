import { Logger } from "@nestjs/common";
import { PgBoss } from "pg-boss";

/** Queue names. Each queue's policy and expiry are set once, in QUEUE_OPTIONS. */
export const QUEUES = {
  heartbeat: "system.heartbeat",
  upkeepSweep: "territory.upkeep-sweep",
  succession: "family.succession",
  wageSweep: "henchmen.wage-sweep",
  marketDrift: "market.drift",
  tradeExpiry: "trades.expiry",
  proposalExpiry: "diplomacy.proposal-expiry",
  battleSweep: "battles.sweep",
  eventGenerate: "events.generate",
  eventSweep: "events.sweep",
} as const;

/**
 * Each queue's policy and expiry, set once here so senders can't disagree. "stately" keeps at most one queued and one
 * active, so a slow or restarted worker never piles runs up. The expiry is how long a job may stay active before
 * pg-boss gives up on it and retries it (default 15 minutes): it frees a job whose worker was killed mid-run, so a
 * crash delays a sweep by minutes, not a quarter of an hour. Every sweep is retry-safe, so a retry after an expiry
 * (even one overlapping a slow run) changes nothing twice. Each is several times the sweep's period or longest run.
 */
const MINUTE = 60;
const QUEUE_OPTIONS: Record<string, { policy: "standard" | "short" | "singleton" | "stately"; expireInSeconds: number }> = {
  [QUEUES.heartbeat]: { policy: "stately", expireInSeconds: 2 * MINUTE },
  [QUEUES.battleSweep]: { policy: "stately", expireInSeconds: 2 * MINUTE },
  [QUEUES.eventSweep]: { policy: "stately", expireInSeconds: 2 * MINUTE },
  [QUEUES.upkeepSweep]: { policy: "stately", expireInSeconds: 5 * MINUTE },
  [QUEUES.wageSweep]: { policy: "stately", expireInSeconds: 5 * MINUTE },
  [QUEUES.tradeExpiry]: { policy: "stately", expireInSeconds: 5 * MINUTE },
  [QUEUES.proposalExpiry]: { policy: "stately", expireInSeconds: 5 * MINUTE },
  [QUEUES.marketDrift]: { policy: "stately", expireInSeconds: 5 * MINUTE },
  [QUEUES.succession]: { policy: "stately", expireInSeconds: 10 * MINUTE },
  [QUEUES.eventGenerate]: { policy: "stately", expireInSeconds: 10 * MINUTE },
};

/** Injection token for the started PgBoss instance. */
export const BOSS = Symbol("BOSS");

/** Starts pg-boss (it creates/migrates its own `pgboss` schema) and makes sure every queue exists. */
export async function startBoss(databaseUrl: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
  boss.on("error", (err) => Logger.error(err, "pg-boss"));
  await boss.start();
  for (const [name, { policy, expireInSeconds }] of Object.entries(QUEUE_OPTIONS)) {
    const queue = await boss.getQueue(name);
    if (!queue) await boss.createQueue(name, { policy, expireInSeconds });
    // Queues created before Phase 9c have the default expiry.
    else if (queue.expireInSeconds !== expireInSeconds) await boss.updateQueue(name, { expireInSeconds });
  }
  return boss;
}
