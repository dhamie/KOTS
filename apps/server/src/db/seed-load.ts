import { Module, type DynamicModule, type INestApplicationContext } from "@nestjs/common";
import { CITY } from "@kots/content";
import { inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { CLOCK, systemClock } from "../common/clock";
import { CONFIG } from "../common/tokens";
import { loadConfig } from "../config";
import { createDb, createPool, DB, type Database } from "./db";
import { families as familiesTable, players, users } from "./schema";
import { ActivityService } from "../modules/activity/activity.service";
import { AccountsService } from "../modules/auth/accounts.service";
import { SESSION_COOKIE } from "../modules/auth/cookies";
import { hashPassword } from "../modules/auth/password";
import { SessionsService } from "../modules/auth/sessions.service";
import { FamiliesService } from "../modules/families/families.service";
import { MembershipsService } from "../modules/families/memberships.service";
import { HenchmenService } from "../modules/henchmen/henchmen.service";
import { InventoryService } from "../modules/inventory/inventory.service";
import { LedgerService } from "../modules/ledger/ledger.service";
import { NotificationsService } from "../modules/notifications/notifications.service";
import { RealtimeService } from "../modules/realtime/realtime.service";
import { HoldingsService } from "../modules/territories/holdings.service";
import { TerritoriesService } from "../modules/territories/territories.service";
import { TradesService } from "../modules/trades/trades.service";

/** One seeded player, as the load scripts use them. */
export interface LoadPlayer {
  handle: string;
  playerId: string;
  familyId: string;
  tag: string;
  role: "don" | "associate";
  /** `name=value` for the Cookie header. */
  cookie: string;
}

const FAMILY_SIZE = 4;
const PASSWORD = "correct horse battery";

@Module({})
export class LoadSeedModule {
  static forDatabase(databaseUrl: string): DynamicModule {
    const pool = createPool(databaseUrl);
    return {
      module: LoadSeedModule,
      providers: [
        { provide: DB, useValue: createDb(pool) },
        { provide: CLOCK, useValue: systemClock },
        { provide: CONFIG, useValue: { ...loadConfig(), databaseUrl } },
        AccountsService,
        SessionsService,
        FamiliesService,
        MembershipsService,
        LedgerService,
        ActivityService,
        NotificationsService,
        RealtimeService,
        TerritoriesService,
        HoldingsService,
        HenchmenService,
        InventoryService,
        TradesService,
      ],
    };
  }
}

/**
 * Fills a test database with `count` players in families of four, through the game's own services (Phase 10).
 * Families are aged past the new-family protection so they can trade; the first claims spread over the map; each
 * family hires two henchmen; a quarter of the families have an open offer to the next one.
 */
export async function seedLoad(app: INestApplicationContext, count: number): Promise<{ players: LoadPlayer[]; families: number; claimed: number; offers: number }> {
  const db = app.get<Database>(DB);
  const sessions = app.get(SessionsService);
  const families = app.get(FamiliesService);
  const territories = app.get(TerritoriesService);
  const henchmen = app.get(HenchmenService);
  const trades = app.get(TradesService);

  // Accounts directly, with one shared password hash: hashing 500 passwords would only measure argon2.
  const passwordHash = await hashPassword(PASSWORD);
  const run = Date.now().toString(36).slice(-4);
  const made: { id: string; userId: string; handle: string }[] = [];
  for (let i = 0; i < count; i++) {
    const handle = `load_${run}_${i}`;
    const [user] = await db.insert(users).values({ email: `${handle}@example.test`, passwordHash }).returning({ id: users.id });
    const [player] = await db.insert(players).values({ userId: user!.id, handle }).returning({ id: players.id });
    made.push({ id: player!.id, userId: user!.id, handle });
  }

  const seeded: LoadPlayer[] = [];
  const familyIds: { id: string; tag: string; don: string }[] = [];
  for (let f = 0; f * FAMILY_SIZE < made.length; f++) {
    const group = made.slice(f * FAMILY_SIZE, (f + 1) * FAMILY_SIZE);
    const don = group[0]!;
    const tag = `L${f.toString(36).toUpperCase()}`.slice(0, 5);
    const family = await families.create(don.id, `Load Family ${run} ${f}`, tag);
    familyIds.push({ id: family.id, tag, don: don.id });
    for (const m of group.slice(1)) {
      const inv = await families.invite(don.id, family.id, m.handle);
      await families.acceptInvitation(m.id, inv.id);
    }
    for (const [i, p] of group.entries()) {
      const token = await sessions.create(p.userId);
      seeded.push({ handle: p.handle, playerId: p.id, familyId: family.id, tag, role: i === 0 ? "don" : "associate", cookie: `${SESSION_COOKIE}=${token}` });
    }
  }
  // Past the new-family protection, so they can trade and fight.
  await db
    .update(familiesTable)
    .set({ foundedAt: sql`${familiesTable.foundedAt} - interval '4 days'` })
    .where(inArray(familiesTable.id, familyIds.map((f) => f.id)));

  // One claim each for the first families, wherever the rules allow (the map has only a few dozen territories).
  let claimed = 0;
  const free = [...CITY.territories.keys()];
  for (const fam of familyIds) {
    const slug = free.shift();
    if (!slug) break;
    try {
      await territories.claim(fam.don, slug);
      claimed++;
    } catch {
      // Not claimable for this family (a market, or the rules); leave it.
    }
  }
  for (const fam of familyIds) for (const slot of [0, 1]) await henchmen.hire(fam.don, fam.id, slot).catch(() => undefined);
  let offers = 0;
  for (let i = 0; i + 1 < familyIds.length && i < familyIds.length / 4; i++) {
    await trades.propose(familyIds[i]!.don, familyIds[i]!.id, `load:${randomUUID()}`, { to: familyIds[i + 1]!.tag, gives: [{ cash: 100 }], wants: [] });
    offers++;
  }

  return { players: seeded, families: familyIds.length, claimed, offers };
}
