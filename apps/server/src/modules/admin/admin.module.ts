import { Inject, Module, type DynamicModule, type OnApplicationShutdown } from "@nestjs/common";
import type { Pool } from "pg";
import { CLOCK, systemClock } from "../../common/clock";
import { createDb, createPool, DB, PG_POOL } from "../../db/db";
import { ActivityService } from "../activity/activity.service";
import { AccountsService } from "../auth/accounts.service";
import { SessionsService } from "../auth/sessions.service";
import { ModerationService } from "../chat/moderation.service";
import { FamiliesService } from "../families/families.service";
import { MembershipsService } from "../families/memberships.service";
import { HenchmenService } from "../henchmen/henchmen.service";
import { InventoryService } from "../inventory/inventory.service";
import { LedgerService } from "../ledger/ledger.service";
import { NotificationsService } from "../notifications/notifications.service";
import { RealtimeService } from "../realtime/realtime.service";
import { HoldingsService } from "../territories/holdings.service";
import { TerritoriesService } from "../territories/territories.service";
import { AdminService } from "./admin.service";

/** Root module of the admin command (main.admin.ts): AdminService and the services it works through. No HTTP. */
@Module({})
export class AdminModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  static forDatabase(databaseUrl: string): DynamicModule {
    const pool = createPool(databaseUrl);
    return {
      module: AdminModule,
      providers: [
        { provide: PG_POOL, useValue: pool },
        { provide: DB, useValue: createDb(pool) },
        { provide: CLOCK, useValue: systemClock },
        AdminService,
        AccountsService,
        SessionsService,
        ModerationService,
        FamiliesService,
        MembershipsService,
        LedgerService,
        ActivityService,
        NotificationsService,
        // Live events (a ban's disconnect, a family refresh) go through Postgres; the api process delivers them.
        RealtimeService,
        TerritoriesService,
        HoldingsService,
        HenchmenService,
        InventoryService,
      ],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
