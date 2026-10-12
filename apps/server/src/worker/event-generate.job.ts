import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { PgBoss } from "pg-boss";
import { EventsService } from "../modules/events/events.service";
import { BOSS, QUEUES } from "./boss";

/** Every hour: rolls for a new city event. */
@Injectable()
export class EventGenerateJob implements OnApplicationBootstrap {
  constructor(
    @Inject(BOSS) private readonly boss: PgBoss,
    private readonly events: EventsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.boss.work(QUEUES.eventGenerate, async () => this.run());
    await this.boss.schedule(QUEUES.eventGenerate, "7 * * * *");
  }

  async run(): Promise<void> {
    await this.events.generate();
  }
}
