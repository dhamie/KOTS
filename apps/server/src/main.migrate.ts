import { join } from "node:path";
import { loadConfig } from "./config";
import { createDb, createPool, runMigrations } from "./db/db";

/**
 * `node dist/migrate.cjs` (Phase 10c): applies pending migrations with drizzle-orm's own migrator, so a production
 * image doesn't need drizzle-kit. It reads apps/server/drizzle and records progress in the same table as
 * `npm run db:migrate`, so the two can be mixed. Run once per deploy, before the api and worker start.
 */
async function main(): Promise<void> {
  const pool = createPool(loadConfig().databaseUrl);
  try {
    await runMigrations(createDb(pool), join(__dirname, "..", "drizzle"));
    console.log("Migrations applied.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
