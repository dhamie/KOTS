import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from "@nestjs/common";
import type { Pool } from "pg";
import type { PgBoss } from "pg-boss";
import { CLOCK, systemClock, type Clock } from "./common/clock";
import { CONFIG } from "./common/tokens";
import { loadConfig } from "./config";
import { createDb, createPool, DB, PG_POOL } from "./db/db";
import { ActivityService } from "./modules/activity/activity.service";
import { AccountsService } from "./modules/auth/accounts.service";
import { SessionsService } from "./modules/auth/sessions.service";
import { FamiliesService } from "./modules/families/families.service";
import { HenchmenService } from "./modules/henchmen/henchmen.service";
import { InventoryService } from "./modules/inventory/inventory.service";
import { MarketService } from "./modules/market/market.service";
import { BattlesService } from "./modules/battles/battles.service";
import { EventsService } from "./modules/events/events.service";
import { ChatService } from "./modules/chat/chat.service";
import { ModerationService } from "./modules/chat/moderation.service";
import { DiplomacyService } from "./modules/diplomacy/diplomacy.service";
import { NotificationsService } from "./modules/notifications/notifications.service";
import { RealtimeService } from "./modules/realtime/realtime.service";
import { TradesService } from "./modules/trades/trades.service";
import { MembershipsService } from "./modules/families/memberships.service";
import { LedgerService } from "./modules/ledger/ledger.service";
import { HoldingsService } from "./modules/territories/holdings.service";
import { TerritoriesService } from "./modules/territories/territories.service";
import { BOSS, QUEUES, startBoss } from "./worker/boss";
import { DriftJob } from "./worker/drift.job";
import { HeartbeatJob } from "./worker/heartbeat.job";
import { SuccessionJob } from "./worker/succession.job";
import { BattleSweepJob } from "./worker/battle-sweep.job";
import { EventGenerateJob } from "./worker/event-generate.job";
import { EventSweepJob } from "./worker/event-sweep.job";
import { ProposalExpiryJob } from "./worker/proposal-expiry.job";
import { TradeExpiryJob } from "./worker/trade-expiry.job";
import { UpkeepJob } from "./worker/upkeep.job";
import { WagesJob } from "./worker/wages.job";

const JOBS = [
  [QUEUES.heartbeat, HeartbeatJob],
  [QUEUES.upkeepSweep, UpkeepJob],
  [QUEUES.succession, SuccessionJob],
  [QUEUES.wageSweep, WagesJob],
  [QUEUES.marketDrift, DriftJob],
  [QUEUES.tradeExpiry, TradeExpiryJob],
  [QUEUES.proposalExpiry, ProposalExpiryJob],
  [QUEUES.battleSweep, BattleSweepJob],
  [QUEUES.eventGenerate, EventGenerateJob],
  [QUEUES.eventSweep, EventSweepJob],
] as const;

/** Root module of the worker process: no HTTP, only pg-boss job handlers. */
@Module({})
export class WorkerModule implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(BOSS) private readonly boss: PgBoss,
  ) {}

  /** `queues` limits which jobs run (all when null); the browser tests run only the battle and event sweeps. */
  static forDatabase(databaseUrl: string, clock: Clock = systemClock, queues: readonly string[] | null = null): DynamicModule {
    const pool = createPool(databaseUrl);
    return {
      module: WorkerModule,
      providers: [
        { provide: PG_POOL, useValue: pool },
        { provide: DB, useValue: createDb(pool) },
        { provide: CLOCK, useValue: clock },
        // ChatService (through DiplomacyService) reads it; the worker serves no HTTP, so only the database URL matters.
        { provide: CONFIG, useValue: { ...loadConfig(), databaseUrl } },
        { provide: BOSS, useFactory: () => startBoss(databaseUrl) },
        // The services the jobs call, the same classes the api uses.
        SessionsService,
        AccountsService,
        ActivityService,
        MembershipsService,
        LedgerService,
        TerritoriesService,
        HoldingsService,
        HenchmenService,
        FamiliesService,
        InventoryService,
        MarketService,
        TradesService,
        // Jobs publish live events through Postgres; the api process delivers them.
        RealtimeService,
        NotificationsService,
        ModerationService,
        ChatService,
        DiplomacyService,
        BattlesService,
        EventsService,
        ...JOBS.filter(([queue]) => !queues || queues.includes(queue)).map(([, job]) => job),
      ],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    // Let active jobs finish before closing connections.
    await this.boss.stop({ graceful: true, timeout: 30_000 });
    await this.pool.end();
  }
}
