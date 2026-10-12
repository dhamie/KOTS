import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { PgBoss } from "pg-boss";
import { EventsService } from "../modules/events/events.service";
import { BOSS, QUEUES } from "./boss";

/** Every minute: starts city events that are due (applying their effects) and ends those that are over. */
@Injectable()
export class EventSweepJob implements OnApplicationBootstrap {
  constructor(
    @Inject(BOSS) private readonly boss: PgBoss,
    private readonly events: EventsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.boss.work(QUEUES.eventSweep, async () => this.run());
    await this.boss.schedule(QUEUES.eventSweep, "* * * * *");
  }

  async run(): Promise<void> {
    await this.events.sweep();
  }
}
