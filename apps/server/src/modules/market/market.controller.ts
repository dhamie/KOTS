import { Body, Controller, Get, Headers, HttpCode, Param, Post, UseGuards, type PipeTransform } from "@nestjs/common";
import { IdempotencyKey, OrderRequest, TerritorySlug } from "@kots/shared";
import { badRequest, notFound } from "../../common/errors";
import { ZodPipe } from "../../common/zod.pipe";
import { Auth, AuthGuard } from "../auth/auth.guard";
import type { AuthContext } from "../auth/sessions.service";
import { MarketService } from "./market.service";

class MarketSlug implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!TerritorySlug.safeParse(value).success) throw notFound("Market");
    return value;
  }
}

function idempotencyKey(value: string | undefined): string {
  const parsed = IdempotencyKey.safeParse(value);
  if (!parsed.success) throw badRequest("Send a unique Idempotency-Key header (8–100 letters, digits, '_', ':' or '-') with each order.");
  return parsed.data;
}

@Controller()
@UseGuards(AuthGuard)
export class MarketController {
  constructor(private readonly market: MarketService) {}

  @Get("markets/:slug")
  view(@Param("slug", MarketSlug) slug: string) {
    return this.market.market(slug);
  }

  @Post("markets/:slug/orders")
  @HttpCode(200)
  order(
    @Auth() auth: AuthContext,
    @Param("slug", MarketSlug) slug: string,
    @Headers("idempotency-key") key: string | undefined,
    @Body(new ZodPipe(OrderRequest)) body: OrderRequest,
  ) {
    return this.market.order(auth.playerId, slug, idempotencyKey(key), body);
  }
}
