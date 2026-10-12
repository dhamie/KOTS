import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { TerritoriesQuery } from "@kots/shared";
import type { z } from "zod";
import { ZodPipe } from "../../common/zod.pipe";
import { AuthGuard } from "../auth/auth.guard";
import { MapService } from "./map.service";

@Controller("map")
@UseGuards(AuthGuard)
export class MapController {
  constructor(private readonly map: MapService) {}

  @Get("districts")
  districts() {
    return this.map.districtSummaries();
  }

  @Get("territories")
  territories(@Query(new ZodPipe(TerritoriesQuery)) query: z.infer<typeof TerritoriesQuery>) {
    return this.map.districtTerritories(query.district);
  }
}
