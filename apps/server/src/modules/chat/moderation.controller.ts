import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { BlockRequest } from "@kots/shared";
import { UuidParam } from "../../common/uuid-param.pipe";
import { ZodPipe } from "../../common/zod.pipe";
import { Auth, AuthGuard } from "../auth/auth.guard";
import type { AuthContext } from "../auth/sessions.service";
import { ModerationService } from "./moderation.service";

/** Blocks (every player) and the report queue (moderators). Moderators delete messages through DELETE /chat/messages/:id. */
@Controller()
@UseGuards(AuthGuard)
export class ModerationController {
  constructor(private readonly moderation: ModerationService) {}

  @Get("blocks")
  blocks(@Auth() auth: AuthContext) {
    return this.moderation.blocks(auth.playerId);
  }

  @Post("blocks")
  @HttpCode(200)
  block(@Auth() auth: AuthContext, @Body(new ZodPipe(BlockRequest)) body: BlockRequest) {
    return this.moderation.block(auth.playerId, body.handle);
  }

  @Delete("blocks/:playerId")
  @HttpCode(204)
  unblock(@Auth() auth: AuthContext, @Param("playerId", new UuidParam("Player")) playerId: string) {
    return this.moderation.unblock(auth.playerId, playerId);
  }

  @Get("moderation/reports")
  reports(@Auth() auth: AuthContext) {
    return this.moderation.openReports(auth.playerId);
  }

  @Post("moderation/reports/:reportId/dismiss")
  @HttpCode(204)
  dismiss(@Auth() auth: AuthContext, @Param("reportId", new UuidParam("Report")) reportId: string) {
    return this.moderation.dismissReport(auth.playerId, reportId);
  }
}
