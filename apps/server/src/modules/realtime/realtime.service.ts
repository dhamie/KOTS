import { Injectable } from "@nestjs/common";
import type { ServerEvent } from "@kots/shared";
import { sql } from "drizzle-orm";
import type { DbOrTx } from "../../db/tx";

/** The Postgres NOTIFY channel every api process listens on (see RealtimeGateway). */
export const EVENTS_CHANNEL = "kots_events";

/** Socket.IO rooms. Every socket joins its player's room and `public`, plus its family's room while a member. */
export const rooms = {
  player: (id: string) => `player:${id}`,
  family: (id: string) => `family:${id}`,
  public: "public",
} as const;

/** What travels over NOTIFY: an event for some rooms, or an instruction for the gateway itself. */
export type Envelope =
  | { rooms: string[]; event: ServerEvent }
  /** The player's membership or role changed: move their sockets between family rooms and tell them to reload. */
  | { control: "player"; playerId: string }
  /** Logged out: disconnect that session's sockets. */
  | { control: "session-ended"; sessionId: string };

/**
 * Publishes live events from either process. Called with a transaction, the event is sent only if it commits
 * (Postgres delivers NOTIFY at commit), so a rolled-back action never reaches a browser.
 */
@Injectable()
export class RealtimeService {
  async publish(db: DbOrTx, to: string[], event: ServerEvent): Promise<void> {
    await this.send(db, { rooms: to, event });
  }

  async playerChanged(db: DbOrTx, playerId: string): Promise<void> {
    await this.send(db, { control: "player", playerId });
  }

  async sessionEnded(db: DbOrTx, sessionId: string): Promise<void> {
    await this.send(db, { control: "session-ended", sessionId });
  }

  private async send(db: DbOrTx, envelope: Envelope): Promise<void> {
    // NOTIFY payloads are limited to 8000 bytes; the largest event is a 500-character chat message.
    await db.execute(sql`select pg_notify(${EVENTS_CHANNEL}, ${JSON.stringify(envelope)})`);
  }
}
