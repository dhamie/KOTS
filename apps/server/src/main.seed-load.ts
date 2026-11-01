import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config";
import { LoadSeedModule, seedLoad } from "./db/seed-load";

/**
 * `npm run seed:load` (Phase 10): fills a *test* database with LOAD_PLAYERS players (default 500) for the load tests
 * and writes a session cookie for each to LOAD_SESSIONS. Refuses any database whose name doesn't end in _test.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const dbName = new URL(config.databaseUrl).pathname.slice(1);
  if (!dbName.endsWith("_test")) throw new Error(`Refusing to load-seed ${dbName}: point DATABASE_URL at a *_test database.`);
  const count = Number(process.env.LOAD_PLAYERS ?? 500);
  const out = process.env.LOAD_SESSIONS ?? "load/results/sessions.json";
  const app = await NestFactory.createApplicationContext(LoadSeedModule.forDatabase(config.databaseUrl), { logger: ["error", "warn"] });
  try {
    const started = Date.now();
    const r = await seedLoad(app, count);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(r.players));
    console.log(
      `Load-seeded ${r.players.length} players in ${r.families} families (${r.claimed} territories, ${r.offers} open offers) in ${((Date.now() - started) / 1000).toFixed(1)} s; sessions in ${out}.`,
    );
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
