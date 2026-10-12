import { Logger } from "@nestjs/common";
import { PgBoss } from "pg-boss";

/** Queue names. Each queue's policy is set once, in QUEUE_POLICIES, so senders can't disagree about it. */
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

const QUEUE_POLICIES: Record<string, "standard" | "short" | "singleton" | "stately"> = {
  // At most one queued and one active, so a slow or restarted worker never piles runs up.
  [QUEUES.heartbeat]: "stately",
  [QUEUES.upkeepSweep]: "stately",
  [QUEUES.succession]: "stately",
  [QUEUES.wageSweep]: "stately",
  [QUEUES.marketDrift]: "stately",
  [QUEUES.tradeExpiry]: "stately",
  [QUEUES.proposalExpiry]: "stately",
  [QUEUES.battleSweep]: "stately",
  [QUEUES.eventGenerate]: "stately",
  [QUEUES.eventSweep]: "stately",
};

/** Injection token for the started PgBoss instance. */
export const BOSS = Symbol("BOSS");

/** Starts pg-boss (it creates/migrates its own `pgboss` schema) and makes sure every queue exists. */
export async function startBoss(databaseUrl: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
  boss.on("error", (err) => Logger.error(err, "pg-boss"));
  await boss.start();
  for (const [name, policy] of Object.entries(QUEUE_POLICIES)) {
    if (!(await boss.getQueue(name))) await boss.createQueue(name, { policy });
  }
  return boss;
}
