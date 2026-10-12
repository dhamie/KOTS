import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { join } from "node:path";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema>;

/** Injection tokens. */
export const DB = Symbol("DB");
export const PG_POOL = Symbol("PG_POOL");

export function createPool(url: string): Pool {
  return new Pool({ connectionString: url });
}

export function createDb(pool: Pool): Database {
  return drizzle(pool, { schema });
}

/** Applies pending SQL migrations from apps/server/drizzle. Used by tests; elsewhere run `npm run db:migrate`. */
export async function runMigrations(db: Database, migrationsFolder = join(__dirname, "..", "..", "drizzle")): Promise<void> {
  await migrate(db, { migrationsFolder });
}
