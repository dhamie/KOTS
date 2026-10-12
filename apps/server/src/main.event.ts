import { EVENT_TYPES, type EventType } from "@kots/content";
import { eventScopeIds, planEvent } from "@kots/rules";
import { randomInt, randomUUID } from "node:crypto";
import { loadConfig } from "./config";
import { createDb, createPool } from "./db/db";
import { moderationActions, worldEvents } from "./db/schema";
import { eventRow } from "./modules/events/events.service";

/**
 * `npm run event:trigger <type> [market or district]`: schedules a city event to start now; the worker's event
 * sweep applies it within a minute. For operators and the browser tests. Each use is written to the audit log.
 */
async function main(): Promise<void> {
  const [type, scopeId] = process.argv.slice(2);
  if (!EVENT_TYPES.includes(type as EventType)) throw new Error(`Usage: event.cjs <${EVENT_TYPES.join("|")}> [market or district]`);
  const ids = eventScopeIds(type as EventType);
  if (scopeId !== undefined && !ids.includes(scopeId)) {
    throw new Error(ids.length ? `${type} covers one of: ${ids.join(", ")}.` : `${type} covers the whole city; give no place.`);
  }
  const seed = randomInt(2 ** 32);
  const plan = planEvent(type as EventType, seed, scopeId);
  const pool = createPool(loadConfig().databaseUrl);
  try {
    const db = createDb(pool);
    await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(worldEvents)
        .values(eventRow(plan, seed, new Date(), `trigger:${randomUUID()}`))
        .returning({ id: worldEvents.id });
      await tx.insert(moderationActions).values({ moderatorId: null, action: "trigger_event", targetType: "world_event", targetId: row!.id, details: { ...plan } });
      console.log(`Scheduled ${type}${plan.scopeId ? ` in ${plan.scopeId}` : ""} (${row!.id}); the worker starts it within a minute.`);
    });
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
