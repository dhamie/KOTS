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
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly realtime: RealtimeService,
  ) {}

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
    const [row] = await this.db
      .select({ userId: users.id, playerId: players.id, lastSeenAt: sessions.lastSeenAt })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(players, eq(players.userId, users.id))
      .where(and(eq(sessions.id, id), gt(sessions.expiresAt, sql`now()`), eq(users.status, "active")));
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
    return { userId: row.userId, playerId: row.playerId, sessionId: id, refreshed };
  }

  /** Also disconnects the session's live connections. */
  async delete(sessionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(sessions).where(eq(sessions.id, sessionId));
      await this.realtime.sessionEnded(tx, sessionId);
    });
  }
}
