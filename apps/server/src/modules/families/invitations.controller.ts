import { Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { UuidParam } from "../../common/uuid-param.pipe";
import { Auth, AuthGuard } from "../auth/auth.guard";
import type { AuthContext } from "../auth/sessions.service";
import { FamiliesService } from "./families.service";

const InvitationId = new UuidParam("Invitation");

/** The invited player's side of invitations. */
@Controller()
@UseGuards(AuthGuard)
export class InvitationsController {
  constructor(private readonly families: FamiliesService) {}

  @Get("me/invitations")
  mine(@Auth() auth: AuthContext) {
    return this.families.invitationsFor(auth.playerId);
  }

  @Post("invitations/:invitationId/accept")
  @HttpCode(200)
  accept(@Auth() auth: AuthContext, @Param("invitationId", InvitationId) invitationId: string) {
    return this.families.acceptInvitation(auth.playerId, invitationId);
  }

  @Post("invitations/:invitationId/decline")
  @HttpCode(204)
  decline(@Auth() auth: AuthContext, @Param("invitationId", InvitationId) invitationId: string) {
    return this.families.declineInvitation(auth.playerId, invitationId);
  }
}
