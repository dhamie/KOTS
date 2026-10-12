import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import type { PgBoss } from "pg-boss";
import { FamiliesService } from "../modules/families/families.service";
import { BOSS, QUEUES } from "./boss";

/** Hands leadership of a family on when its Don has been inactive too long. Hourly; the threshold is days. */
@Injectable()
export class SuccessionJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(SuccessionJob.name);

  constructor(
    @Inject(BOSS) private readonly boss: PgBoss,
    private readonly families: FamiliesService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.boss.work(QUEUES.succession, async () => this.run());
    await this.boss.schedule(QUEUES.succession, "17 * * * *");
  }

  async run(): Promise<void> {
    const changed = await this.families.succeedInactiveDons();
    if (changed > 0) this.logger.log(`succession: ${changed} families have a new Don`);
  }
}
