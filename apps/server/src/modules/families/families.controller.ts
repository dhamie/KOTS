import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ActivityQuery, CreateFamilyRequest, InviteRequest, SetRoleRequest, TransferLeadershipRequest } from "@kots/shared";
import type { z } from "zod";
import { UuidParam } from "../../common/uuid-param.pipe";
import { ZodPipe } from "../../common/zod.pipe";
import { Auth, AuthGuard } from "../auth/auth.guard";
import type { AuthContext } from "../auth/sessions.service";
import { FamiliesService } from "./families.service";

const FamilyId = new UuidParam("Family");

@Controller("families")
@UseGuards(AuthGuard)
export class FamiliesController {
  constructor(private readonly families: FamiliesService) {}

  @Post()
  create(@Auth() auth: AuthContext, @Body(new ZodPipe(CreateFamilyRequest)) body: CreateFamilyRequest) {
    return this.families.create(auth.playerId, body.name, body.tag);
  }

  @Get(":familyId")
  get(@Param("familyId", FamilyId) familyId: string) {
    return this.families.getFamily(familyId);
  }

  @Delete(":familyId")
  @HttpCode(204)
  disband(@Auth() auth: AuthContext, @Param("familyId", FamilyId) familyId: string) {
    return this.families.disband(auth.playerId, familyId);
  }

  @Get(":familyId/activity")
  activity(
    @Auth() auth: AuthContext,
    @Param("familyId", FamilyId) familyId: string,
    @Query(new ZodPipe(ActivityQuery)) query: z.infer<typeof ActivityQuery>,
  ) {
    return this.families.activityPage(auth.playerId, familyId, query.before, query.limit);
  }

  @Get(":familyId/invitations")
  invitations(@Auth() auth: AuthContext, @Param("familyId", FamilyId) familyId: string) {
    return this.families.familyInvitations(auth.playerId, familyId);
  }

  @Post(":familyId/invitations")
  invite(@Auth() auth: AuthContext, @Param("familyId", FamilyId) familyId: string, @Body(new ZodPipe(InviteRequest)) body: z.infer<typeof InviteRequest>) {
    return this.families.invite(auth.playerId, familyId, body.handle);
  }

  @Delete(":familyId/invitations/:invitationId")
  @HttpCode(204)
  revoke(
    @Auth() auth: AuthContext,
    @Param("familyId", FamilyId) familyId: string,
    @Param("invitationId", new UuidParam("Invitation")) invitationId: string,
  ) {
    return this.families.revokeInvitation(auth.playerId, familyId, invitationId);
  }

  @Patch(":familyId/members/:playerId")
  setRole(
    @Auth() auth: AuthContext,
    @Param("familyId", FamilyId) familyId: string,
    @Param("playerId", new UuidParam("Member")) playerId: string,
    @Body(new ZodPipe(SetRoleRequest)) body: z.infer<typeof SetRoleRequest>,
  ) {
    return this.families.setRole(auth.playerId, familyId, playerId, body.role);
  }

  @Delete(":familyId/members/:playerId")
  kick(@Auth() auth: AuthContext, @Param("familyId", FamilyId) familyId: string, @Param("playerId", new UuidParam("Member")) playerId: string) {
    return this.families.kick(auth.playerId, familyId, playerId);
  }

  @Post(":familyId/leave")
  @HttpCode(204)
  leave(@Auth() auth: AuthContext, @Param("familyId", FamilyId) familyId: string) {
    return this.families.leave(auth.playerId, familyId);
  }

  @Post(":familyId/transfer-leadership")
  @HttpCode(200)
  transfer(
    @Auth() auth: AuthContext,
    @Param("familyId", FamilyId) familyId: string,
    @Body(new ZodPipe(TransferLeadershipRequest)) body: z.infer<typeof TransferLeadershipRequest>,
  ) {
    return this.families.transferLeadership(auth.playerId, familyId, body.playerId);
  }
}
