import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { PgBoss } from "pg-boss";
import { TerritoriesService } from "../modules/territories/territories.service";
import { BOSS, QUEUES } from "./boss";

/** Settles territory upkeep as it falls due. Each run handles a bounded batch; the next run picks up any rest. */
@Injectable()
export class UpkeepJob implements OnApplicationBootstrap {
  constructor(
    @Inject(BOSS) private readonly boss: PgBoss,
    private readonly territories: TerritoriesService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.boss.work(QUEUES.upkeepSweep, async () => this.run());
    await this.boss.schedule(QUEUES.upkeepSweep, "*/5 * * * *");
  }

  async run(): Promise<void> {
    await this.territories.sweepUpkeep();
  }
}
