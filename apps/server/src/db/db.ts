import { Logger } from "@nestjs/common";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { join } from "node:path";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

/** Injection tokens. */
export const DB = Symbol("DB");
export const PG_POOL = Symbol("PG_POOL");

/**
 * When the database drops an idle connection (a restart, a failover, an admin ending it) the pool emits `error`.
 * Unhandled, that would crash the process (Phase 9c); logged, the pool discards the connection and opens a new
 * one for the next query. A query running at that moment still fails, and its caller answers 5xx.
 */
export function createPool(url: string): Pool {
  const pool = new Pool({ connectionString: url });
  pool.on("error", (err) => Logger.warn(`Dropped an idle database connection: ${err.message}`, "Database"));
  return pool;
}

export function createDb(pool: Pool): Database {
  return drizzle(pool, { schema });
}

/** Applies pending SQL migrations from apps/server/drizzle. Used by tests; elsewhere run `npm run db:migrate`. */
export async function runMigrations(db: Database, migrationsFolder = join(__dirname, "..", "..", "drizzle")): Promise<void> {
  await migrate(db, { migrationsFolder });
}
