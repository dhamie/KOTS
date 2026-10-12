import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { PgBoss } from "pg-boss";
import { BattlesService } from "../modules/battles/battles.service";
import { BOSS, QUEUES } from "./boss";

/** Every minute: starts battles whose preparation is over and resolves rounds that are due. */
@Injectable()
export class BattleSweepJob implements OnApplicationBootstrap {
  constructor(
    @Inject(BOSS) private readonly boss: PgBoss,
    private readonly battles: BattlesService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.boss.work(QUEUES.battleSweep, async () => this.run());
    await this.boss.schedule(QUEUES.battleSweep, "* * * * *");
  }

  async run(): Promise<void> {
    await this.battles.sweep();
  }
}
