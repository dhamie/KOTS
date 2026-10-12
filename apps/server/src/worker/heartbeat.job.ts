import { Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { DB, type Database } from "../db/db";
import { BOSS, QUEUES } from "./boss";

/** Harmless scheduled job proving the worker, the queue and the database work together. */
@Injectable()
export class HeartbeatJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(HeartbeatJob.name);

  constructor(
    @Inject(BOSS) private readonly boss: PgBoss,
    @Inject(DB) private readonly db: Database,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.boss.work(QUEUES.heartbeat, async () => this.run());
    await this.boss.schedule(QUEUES.heartbeat, "*/5 * * * *");
  }

  async run(): Promise<void> {
    await this.db.execute(sql`select 1`);
    this.logger.log("heartbeat ok");
  }
}
