import { loadConfig } from "./config";
import { createDb, createPool } from "./db/db";
import { seedMap, seedMarkets } from "./db/seed";

/** `npm run db:seed`: loads static game content (the map, goods and markets) into the database. Safe to run repeatedly. */
async function main(): Promise<void> {
  const pool = createPool(loadConfig().databaseUrl);
  try {
    const db = createDb(pool);
    const result = await seedMap(db);
    console.log(`Seeded ${result.districts} districts and ${result.territories} territories.`);
    const market = await seedMarkets(db);
    console.log(`Seeded ${market.goods} goods and ${market.markets} markets.`);
    if (result.stale.length) console.warn(`Territories in the database but not in content (left untouched): ${result.stale.join(", ")}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
