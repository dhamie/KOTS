import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { OfferRequest, TradeQuery } from "@kots/shared";
import type { z } from "zod";
import { idempotencyKey } from "../../common/idempotency-key";
import { UuidParam } from "../../common/uuid-param.pipe";
import { ZodPipe } from "../../common/zod.pipe";
import { Auth, AuthGuard } from "../auth/auth.guard";
import type { AuthContext } from "../auth/sessions.service";
import { TradesService } from "./trades.service";

const FamilyId = new UuidParam("Family");
const TradeId = new UuidParam("Trade");

@Controller()
@UseGuards(AuthGuard)
export class TradesController {
  constructor(private readonly trades: TradesService) {}

  @Get("families/:familyId/trades")
  list(@Auth() auth: AuthContext, @Param("familyId", FamilyId) familyId: string, @Query(new ZodPipe(TradeQuery)) query: z.infer<typeof TradeQuery>) {
    return this.trades.list(auth.playerId, familyId, query.box, query.before, query.limit);
  }

  @Post("families/:familyId/trades")
  propose(
    @Auth() auth: AuthContext,
    @Param("familyId", FamilyId) familyId: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body(new ZodPipe(OfferRequest)) body: OfferRequest,
  ) {
    return this.trades.propose(auth.playerId, familyId, idempotencyKey(key, "offer"), body);
  }

  @Post("trades/:tradeId/accept")
  @HttpCode(200)
  accept(@Auth() auth: AuthContext, @Param("tradeId", TradeId) tradeId: string) {
    return this.trades.accept(auth.playerId, tradeId);
  }

  @Post("trades/:tradeId/decline")
  @HttpCode(200)
  decline(@Auth() auth: AuthContext, @Param("tradeId", TradeId) tradeId: string) {
    return this.trades.decline(auth.playerId, tradeId);
  }

  @Post("trades/:tradeId/cancel")
  @HttpCode(200)
  cancel(@Auth() auth: AuthContext, @Param("tradeId", TradeId) tradeId: string) {
    return this.trades.cancel(auth.playerId, tradeId);
  }
}
