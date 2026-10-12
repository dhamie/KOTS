import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import type { Pool } from "pg";
import { CLOCK, systemClock, type Clock } from "./common/clock";
import { AllExceptionsFilter } from "./common/http-exception.filter";
import { throttlerOptions } from "./common/rate-limit";
import { CONFIG } from "./common/tokens";
import type { ServerConfig } from "./config";
import { createDb, createPool, DB, PG_POOL } from "./db/db";
import { ActivityService } from "./modules/activity/activity.service";
import { AccountsService } from "./modules/auth/accounts.service";
import { AuthController } from "./modules/auth/auth.controller";
import { AuthGuard } from "./modules/auth/auth.guard";
import { BattlesController } from "./modules/battles/battles.controller";
import { EventsController } from "./modules/events/events.controller";
import { EventsService } from "./modules/events/events.service";
import { BattlesService } from "./modules/battles/battles.service";
import { ChatController } from "./modules/chat/chat.controller";
import { ChatService } from "./modules/chat/chat.service";
import { ModerationController } from "./modules/chat/moderation.controller";
import { ModerationService } from "./modules/chat/moderation.service";
import { DiplomacyController } from "./modules/diplomacy/diplomacy.controller";
import { DiplomacyService } from "./modules/diplomacy/diplomacy.service";
import { SessionsService } from "./modules/auth/sessions.service";
import { FamiliesController } from "./modules/families/families.controller";
import { FamiliesService } from "./modules/families/families.service";
import { InvitationsController } from "./modules/families/invitations.controller";
import { MembershipsService } from "./modules/families/memberships.service";
import { HealthController } from "./modules/health/health.controller";
import { HenchmenController } from "./modules/henchmen/henchmen.controller";
import { HenchmenService } from "./modules/henchmen/henchmen.service";
import { InventoryController } from "./modules/inventory/inventory.controller";
import { InventoryService } from "./modules/inventory/inventory.service";
import { LedgerService } from "./modules/ledger/ledger.service";
import { TreasuryController } from "./modules/ledger/treasury.controller";
import { MapController } from "./modules/map/map.controller";
import { MapService } from "./modules/map/map.service";
import { MarketController } from "./modules/market/market.controller";
import { MarketService } from "./modules/market/market.service";
import { NotificationsController } from "./modules/notifications/notifications.controller";
import { NotificationsService } from "./modules/notifications/notifications.service";
import { ProfilesController } from "./modules/profiles/profiles.controller";
import { RealtimeGateway } from "./modules/realtime/realtime.gateway";
import { RealtimeService } from "./modules/realtime/realtime.service";
import { HoldingsService } from "./modules/territories/holdings.service";
import { TerritoriesController } from "./modules/territories/territories.controller";
import { TerritoriesService } from "./modules/territories/territories.service";
import { TradesController } from "./modules/trades/trades.controller";
import { TradesService } from "./modules/trades/trades.service";

/** Root module of the api process: HTTP, and Socket.IO for live updates (RealtimeGateway). */
@Module({})
export class ApiModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** `clock` is replaceable so tests can move game time. */
  static forConfig(config: ServerConfig, clock: Clock = systemClock): DynamicModule {
    const pool = createPool(config.databaseUrl);
    return {
      module: ApiModule,
      imports: [ThrottlerModule.forRoot(throttlerOptions(config))],
      controllers: [
        HealthController,
        AuthController,
        ProfilesController,
        FamiliesController,
        InvitationsController,
        MapController,
        TerritoriesController,
        TreasuryController,
        HenchmenController,
        InventoryController,
        MarketController,
        TradesController,
        ChatController,
        ModerationController,
        NotificationsController,
        DiplomacyController,
        BattlesController,
        EventsController,
      ],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: CLOCK, useValue: clock },
        { provide: PG_POOL, useValue: pool },
        { provide: DB, useValue: createDb(pool) },
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
        SessionsService,
        AccountsService,
        AuthGuard,
        ActivityService,
        FamiliesService,
        MembershipsService,
        LedgerService,
        TerritoriesService,
        HoldingsService,
        HenchmenService,
        InventoryService,
        MarketService,
        TradesService,
        MapService,
        RealtimeService,
        RealtimeGateway,
        NotificationsService,
        ChatService,
        ModerationService,
        DiplomacyService,
        BattlesService,
        EventsService,
      ],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
