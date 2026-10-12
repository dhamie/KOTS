import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { AppError, conflict, uniqueViolation } from "../../common/errors";
import { DB, type Database } from "../../db/db";
import { players, users } from "../../db/schema";
import type { DbOrTx } from "../../db/tx";
import { dummyPasswordHash, hashPassword, verifyPassword } from "./password";
import { SessionsService } from "./sessions.service";

export interface PlayerSummary {
  id: string;
  handle: string;
  createdAt: Date;
}

/** Owns users, players and their credentials. Other modules look players up through here. */
@Injectable()
export class AccountsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly sessions: SessionsService,
  ) {}

  /** Creates the user, its player and a session in one transaction. Returns the session token. */
  async register(email: string, password: string, handle: string): Promise<string> {
    const passwordHash = await hashPassword(password);
    try {
      return await this.db.transaction(async (tx) => {
        const [user] = await tx.insert(users).values({ email, passwordHash }).returning({ id: users.id });
        await tx.insert(players).values({ userId: user!.id, handle });
        return this.sessions.create(user!.id, tx);
      });
    } catch (err) {
      const constraint = uniqueViolation(err);
      if (constraint === "users_email_unique") throw conflict("EMAIL_TAKEN", "That email is already registered.");
      if (constraint === "players_handle_unique") throw conflict("HANDLE_TAKEN", "That handle is taken.");
      throw err;
    }
  }

  /** Returns a new session token. Unknown email and wrong password are indistinguishable, including in timing. */
  async login(email: string, password: string): Promise<string> {
    const [user] = await this.db.select().from(users).where(eq(users.email, email));
    const ok = await verifyPassword(user?.passwordHash ?? (await dummyPasswordHash()), password);
    if (!user || !ok) throw new AppError(401, "INVALID_CREDENTIALS", "Wrong email or password.");
    // Only someone who knows the password learns the account is banned.
    if (user.status !== "active") throw new AppError(403, "ACCOUNT_BANNED", "This account is banned.");
    return this.sessions.create(user.id);
  }

  async emailOf(userId: string): Promise<string> {
    const [row] = await this.db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    return row!.email;
  }

  async findPlayerByHandle(handle: string): Promise<PlayerSummary | undefined> {
    const [row] = await this.db
      .select({ id: players.id, handle: players.handle, createdAt: players.createdAt })
      .from(players)
      .where(eq(players.handle, handle));
    return row;
  }

  async isModerator(playerId: string, db: DbOrTx = this.db): Promise<boolean> {
    const [row] = await db.select({ isModerator: players.isModerator }).from(players).where(eq(players.id, playerId));
    return row?.isModerator ?? false;
  }

  async findPlayerById(id: string, db: DbOrTx = this.db): Promise<PlayerSummary | undefined> {
    const [row] = await db
      .select({ id: players.id, handle: players.handle, createdAt: players.createdAt })
      .from(players)
      .where(eq(players.id, id));
    return row;
  }
}
