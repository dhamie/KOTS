import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { UuidParam } from "../../common/uuid-param.pipe";
import { Auth, AuthGuard } from "../auth/auth.guard";
import type { AuthContext } from "../auth/sessions.service";
import { InventoryService } from "./inventory.service";

@Controller()
@UseGuards(AuthGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get("families/:familyId/inventory")
  view(@Auth() auth: AuthContext, @Param("familyId", new UuidParam("Family")) familyId: string) {
    return this.inventory.view(auth.playerId, familyId);
  }
}
