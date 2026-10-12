import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { PgBoss } from "pg-boss";
import { TradesService } from "../modules/trades/trades.service";
import { BOSS, QUEUES } from "./boss";

/** Closes trade offers past their expiry. Accepting also checks the time, so this only tidies up. */
@Injectable()
export class TradeExpiryJob implements OnApplicationBootstrap {
  constructor(
    @Inject(BOSS) private readonly boss: PgBoss,
    private readonly trades: TradesService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.boss.work(QUEUES.tradeExpiry, async () => this.run());
    await this.boss.schedule(QUEUES.tradeExpiry, "*/5 * * * *");
  }

  async run(): Promise<void> {
    await this.trades.sweepExpired();
  }
}
