import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { PgBoss } from "pg-boss";
import { HenchmenService } from "../modules/henchmen/henchmen.service";
import { BOSS, QUEUES } from "./boss";

/** Pays henchmen's wages as they fall due. Same cadence and batching as the upkeep sweep. */
@Injectable()
export class WagesJob implements OnApplicationBootstrap {
  constructor(
    @Inject(BOSS) private readonly boss: PgBoss,
    private readonly henchmen: HenchmenService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.boss.work(QUEUES.wageSweep, async () => this.run());
    await this.boss.schedule(QUEUES.wageSweep, "*/5 * * * *");
  }

  async run(): Promise<void> {
    await this.henchmen.sweepWages();
  }
}
