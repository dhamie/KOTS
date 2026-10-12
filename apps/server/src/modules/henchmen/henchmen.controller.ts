import { Body, Controller, Get, HttpCode, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { AssignRequest, HireRequest } from "@kots/shared";
import type { z } from "zod";
import { UuidParam } from "../../common/uuid-param.pipe";
import { ZodPipe } from "../../common/zod.pipe";
import { Auth, AuthGuard } from "../auth/auth.guard";
import type { AuthContext } from "../auth/sessions.service";
import { HenchmenService } from "./henchmen.service";

const FamilyId = new UuidParam("Family");
const HenchmanId = new UuidParam("Henchman");

@Controller()
@UseGuards(AuthGuard)
export class HenchmenController {
  constructor(private readonly henchmen: HenchmenService) {}

  @Get("families/:familyId/recruits")
  board(@Auth() auth: AuthContext, @Param("familyId", FamilyId) familyId: string) {
    return this.henchmen.board(auth.playerId, familyId);
  }

  @Post("families/:familyId/recruits")
  hire(@Auth() auth: AuthContext, @Param("familyId", FamilyId) familyId: string, @Body(new ZodPipe(HireRequest)) body: z.infer<typeof HireRequest>) {
    return this.henchmen.hire(auth.playerId, familyId, body.slot);
  }

  @Get("families/:familyId/henchmen")
  list(@Auth() auth: AuthContext, @Param("familyId", FamilyId) familyId: string) {
    return this.henchmen.list(auth.playerId, familyId);
  }

  @Patch("henchmen/:henchmanId")
  assign(@Auth() auth: AuthContext, @Param("henchmanId", HenchmanId) henchmanId: string, @Body(new ZodPipe(AssignRequest)) body: z.infer<typeof AssignRequest>) {
    return this.henchmen.assign(auth.playerId, henchmanId, body.territory);
  }

  @Post("henchmen/:henchmanId/dismiss")
  @HttpCode(204)
  dismiss(@Auth() auth: AuthContext, @Param("henchmanId", HenchmanId) henchmanId: string) {
    return this.henchmen.dismiss(auth.playerId, henchmanId);
  }
}
