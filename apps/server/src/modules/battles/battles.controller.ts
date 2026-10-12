import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { BattleOrderRequest, CommitRequest } from "@kots/shared";
import { UuidParam } from "../../common/uuid-param.pipe";
import { ZodPipe } from "../../common/zod.pipe";
import { Auth, AuthGuard } from "../auth/auth.guard";
import type { AuthContext } from "../auth/sessions.service";
import { BattlesService } from "./battles.service";

const BattleId = new UuidParam("Battle");

@Controller()
@UseGuards(AuthGuard)
export class BattlesController {
  constructor(private readonly battles: BattlesService) {}

  @Post("territories/:slug/battles")
  declare(@Auth() auth: AuthContext, @Param("slug") slug: string) {
    return this.battles.declare(auth.playerId, slug);
  }

  @Get("territories/:slug/attack")
  attackQuote(@Auth() auth: AuthContext, @Param("slug") slug: string) {
    return this.battles.attackQuote(auth.playerId, slug);
  }

  @Get("families/:familyId/battles")
  list(@Auth() auth: AuthContext, @Param("familyId", new UuidParam("Family")) familyId: string) {
    return this.battles.list(auth.playerId, familyId);
  }

  @Get("battles/:battleId")
  get(@Auth() auth: AuthContext, @Param("battleId", BattleId) id: string) {
    return this.battles.get(auth.playerId, id);
  }

  @Post("battles/:battleId/commit")
  @HttpCode(200)
  commit(@Auth() auth: AuthContext, @Param("battleId", BattleId) id: string, @Body(new ZodPipe(CommitRequest)) body: CommitRequest) {
    return this.battles.commit(auth.playerId, id, body.henchmen);
  }

  @Post("battles/:battleId/release")
  @HttpCode(200)
  release(@Auth() auth: AuthContext, @Param("battleId", BattleId) id: string, @Body(new ZodPipe(CommitRequest)) body: CommitRequest) {
    return this.battles.release(auth.playerId, id, body.henchmen);
  }

  @Post("battles/:battleId/orders")
  @HttpCode(200)
  order(@Auth() auth: AuthContext, @Param("battleId", BattleId) id: string, @Body(new ZodPipe(BattleOrderRequest)) body: BattleOrderRequest) {
    return this.battles.order(auth.playerId, id, body.round, body.tactic);
  }

  @Post("battles/:battleId/withdraw")
  @HttpCode(200)
  withdraw(@Auth() auth: AuthContext, @Param("battleId", BattleId) id: string) {
    return this.battles.withdraw(auth.playerId, id);
  }
}
