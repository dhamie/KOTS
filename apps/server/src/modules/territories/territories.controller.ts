import { Controller, Get, HttpCode, Param, Post, UseGuards, type PipeTransform } from "@nestjs/common";
import { TerritorySlug } from "@kots/shared";
import { notFound } from "../../common/errors";
import { UuidParam } from "../../common/uuid-param.pipe";
import { Auth, AuthGuard } from "../auth/auth.guard";
import type { AuthContext } from "../auth/sessions.service";
import { TerritoriesService } from "./territories.service";

/** A malformed slug can't match a territory, so it's a 404. */
class SlugParam implements PipeTransform<string, string> {
  transform(value: string): string {
    if (!TerritorySlug.safeParse(value).success) throw notFound("Territory");
    return value;
  }
}

@Controller()
@UseGuards(AuthGuard)
export class TerritoriesController {
  constructor(private readonly territories: TerritoriesService) {}

  @Get("territories/:slug")
  detail(@Auth() auth: AuthContext, @Param("slug", SlugParam) slug: string) {
    return this.territories.detail(auth.playerId, slug);
  }

  @Post("territories/:slug/claim")
  @HttpCode(200)
  claim(@Auth() auth: AuthContext, @Param("slug", SlugParam) slug: string) {
    return this.territories.claim(auth.playerId, slug);
  }

  @Post("territories/:slug/abandon")
  @HttpCode(204)
  abandon(@Auth() auth: AuthContext, @Param("slug", SlugParam) slug: string) {
    return this.territories.abandon(auth.playerId, slug);
  }

  @Get("families/:familyId/territories")
  holdings(@Auth() auth: AuthContext, @Param("familyId", new UuidParam("Family")) familyId: string) {
    return this.territories.holdings(auth.playerId, familyId);
  }
}
