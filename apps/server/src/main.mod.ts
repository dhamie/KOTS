import { eq } from "drizzle-orm";
import { loadConfig } from "./config";
import { createDb, createPool } from "./db/db";
import { moderationActions, players } from "./db/schema";

/**
 * `npm run mod:grant <handle>` / `npm run mod:revoke <handle>`: makes a player a chat moderator, or not.
 * Until admin tools exist (Phase 11), this is how moderators are appointed. Each change is written to the audit log.
 */
async function main(): Promise<void> {
  const [command, handle] = process.argv.slice(2);
  if ((command !== "grant" && command !== "revoke") || !handle) throw new Error("Usage: mod.cjs grant|revoke <handle>");
  const pool = createPool(loadConfig().databaseUrl);
  try {
    const db = createDb(pool);
    await db.transaction(async (tx) => {
      const [player] = await tx
        .update(players)
        .set({ isModerator: command === "grant" })
        .where(eq(players.handle, handle))
        .returning({ id: players.id, handle: players.handle });
      if (!player) throw new Error(`No player with handle ${handle}.`);
      await tx.insert(moderationActions).values({ moderatorId: null, action: command === "grant" ? "grant_moderator" : "revoke_moderator", targetType: "player", targetId: player.id });
      console.log(`${player.handle} is ${command === "grant" ? "now" : "no longer"} a moderator.`);
    });
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
