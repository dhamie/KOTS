import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { PgBoss } from "pg-boss";
import { MarketService } from "../modules/market/market.service";
import { BOSS, QUEUES } from "./boss";

/** Moves market stock back toward normal, one drift step (30 min) at a time. */
@Injectable()
export class DriftJob implements OnApplicationBootstrap {
  constructor(
    @Inject(BOSS) private readonly boss: PgBoss,
    private readonly market: MarketService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.boss.work(QUEUES.marketDrift, async () => this.run());
    // A minute into each step, so the step has changed by the time the job runs.
    await this.boss.schedule(QUEUES.marketDrift, "1,31 * * * *");
  }

  async run(): Promise<void> {
    await this.market.sweepDrift();
  }
}
