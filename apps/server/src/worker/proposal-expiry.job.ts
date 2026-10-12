import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";
import type { PgBoss } from "pg-boss";
import { DiplomacyService } from "../modules/diplomacy/diplomacy.service";
import { BOSS, QUEUES } from "./boss";

/** Closes diplomacy proposals past their expiry. Signing also checks the time, so this only tidies up. */
@Injectable()
export class ProposalExpiryJob implements OnApplicationBootstrap {
  constructor(
    @Inject(BOSS) private readonly boss: PgBoss,
    private readonly diplomacy: DiplomacyService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.boss.work(QUEUES.proposalExpiry, async () => this.run());
    await this.boss.schedule(QUEUES.proposalExpiry, "*/5 * * * *");
  }

  async run(): Promise<void> {
    await this.diplomacy.sweepExpired();
  }
}
