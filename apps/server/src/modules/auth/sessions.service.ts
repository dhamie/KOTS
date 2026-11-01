import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, sql } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { DB, type Database } from "../../db/db";
import { players, sessions, users } from "../../db/schema";
import type { DbOrTx } from "../../db/tx";
import { RealtimeService } from "../realtime/realtime.service";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Sliding expiry is refreshed at most this often, so ordinary requests don't write to the database. */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;
/**
 * How long this process trusts a session it has just looked up without asking the database again (Phase 10b: the
 * lookup was a third of all queries). Logout and ban clear it at once, on every api process, through `session-ended`;
 * this is only the bound if that signal were missed.
 */
export const SESSION_CACHE_MS = 10_000;

export interface AuthContext {
  userId: string;
  playerId: string;
  sessionId: string;
  /** True when this request extended the session; the cookie's max-age should be refreshed too. */
  refreshed: boolean;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

@Injectable()
export class SessionsService {
  private readonly cache = new Map<string, { userId: string; playerId: string; lastSeenAt: Date; cachedAt: number }>();
  /** Prepared once (Phase 10b): building this query on every request was a large share of the api's CPU. */
  private readonly lookup;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly realtime: RealtimeService,
  ) {
    this.lookup = this.db
      .select({ userId: users.id, playerId: players.id, lastSeenAt: sessions.lastSeenAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(players, eq(players.userId, users.id))
      .where(and(eq(sessions.id, sql.placeholder("id")), gt(sessions.expiresAt, sql`now()`), eq(users.status, "active")))
      .prepare("session_lookup");
  }

  /** Creates a session and returns the raw token for the cookie (only its hash is stored). */
  async create(userId: string, db: DbOrTx = this.db): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await db.insert(sessions).values({ id: hashToken(token), userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS) });
    await db.update(players).set({ lastActiveAt: sql`now()` }).where(eq(players.userId, userId));
    return token;
  }

  /** Resolves a cookie token to an active (unexpired, unbanned) session. */
  async resolve(token: string): Promise<AuthContext | undefined> {
    const id = hashToken(token);
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.cachedAt < SESSION_CACHE_MS && Date.now() - hit.lastSeenAt.getTime() <= TOUCH_INTERVAL_MS) {
      return { userId: hit.userId, playerId: hit.playerId, sessionId: id, refreshed: false };
    }
    this.cache.delete(id);
    const [row] = await this.lookup.execute({ id });
    if (!row) return undefined;

    let refreshed = false;
    if (Date.now() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db
        .update(sessions)
        .set({ lastSeenAt: sql`now()`, expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
        .where(eq(sessions.id, id));
      await this.db.update(players).set({ lastActiveAt: sql`now()` }).where(eq(players.userId, row.userId));
      refreshed = true;
    }
    this.cache.set(id, { userId: row.userId, playerId: row.playerId, lastSeenAt: refreshed ? new Date() : row.lastSeenAt, cachedAt: Date.now() });
    // Bounded: entries older than the cache window are useless, so drop them when the map grows.
    if (this.cache.size > 50_000) for (const [k, v] of this.cache) if (Date.now() - v.cachedAt >= SESSION_CACHE_MS) this.cache.delete(k);
    return { userId: row.userId, playerId: row.playerId, sessionId: id, refreshed };
  }

  /** Ends every session of a user (a ban) and disconnects their live connections. Returns how many ended. */
  async deleteAllFor(db: DbOrTx, userId: string): Promise<number> {
    const ended = await db.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
    for (const s of ended) await this.realtime.sessionEnded(db, s.id);
    return ended.length;
  }

  /** Stops this process trusting a cached session. Called when a session ends here or (through the gateway) anywhere. */
  forget(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  /** Also disconnects the session's live connections. */
  async delete(sessionId: string): Promise<void> {
    this.forget(sessionId);
    await this.db.transaction(async (tx) => {
      await tx.delete(sessions).where(eq(sessions.id, sessionId));
      await this.realtime.sessionEnded(tx, sessionId);
    });
  }
}
