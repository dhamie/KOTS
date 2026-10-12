import { Controller, Get, HttpStatus, Inject, Res } from "@nestjs/common";
import type { HealthResponse } from "@kots/shared";
import { sql } from "drizzle-orm";
import type { Response } from "express";
import { DB, type Database } from "../../db/db";

@Controller("health")
export class HealthController {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** 200 when the database answers, 503 otherwise. Used by load balancers and the client's status panel. */
  @Get()
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthResponse> {
    try {
      await this.db.execute(sql`select 1`);
      return { status: "ok", db: "ok" };
    } catch {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
      return { status: "degraded", db: "down" };
    }
  }
}
