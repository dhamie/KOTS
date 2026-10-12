import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from "@nestjs/common";
import { OpenRoomRequest, ProposeRequest } from "@kots/shared";
import { UuidParam } from "../../common/uuid-param.pipe";
import { ZodPipe } from "../../common/zod.pipe";
import { Auth, AuthGuard } from "../auth/auth.guard";
import type { AuthContext } from "../auth/sessions.service";
import { DiplomacyService } from "./diplomacy.service";

const RoomId = new UuidParam("Room");
const ProposalId = new UuidParam("Proposal");

/** Diplomacy rooms are chat channels: their messages use the /chat endpoints. These cover opening them and proposals. */
@Controller()
@UseGuards(AuthGuard)
export class DiplomacyController {
  constructor(private readonly diplomacy: DiplomacyService) {}

  @Post("diplomacy/rooms")
  @HttpCode(200)
  open(@Auth() auth: AuthContext, @Body(new ZodPipe(OpenRoomRequest)) body: OpenRoomRequest) {
    return this.diplomacy.openRoom(auth.playerId, body.tag);
  }

  @Get("diplomacy/rooms/:roomId")
  room(@Auth() auth: AuthContext, @Param("roomId", RoomId) roomId: string) {
    return this.diplomacy.room(auth.playerId, roomId);
  }

  @Post("diplomacy/rooms/:roomId/proposals")
  propose(@Auth() auth: AuthContext, @Param("roomId", RoomId) roomId: string, @Body(new ZodPipe(ProposeRequest)) body: ProposeRequest) {
    return this.diplomacy.propose(auth.playerId, roomId, body.terms);
  }

  @Post("proposals/:proposalId/sign")
  @HttpCode(200)
  sign(@Auth() auth: AuthContext, @Param("proposalId", ProposalId) id: string) {
    return this.diplomacy.sign(auth.playerId, id);
  }

  @Post("proposals/:proposalId/decline")
  @HttpCode(200)
  decline(@Auth() auth: AuthContext, @Param("proposalId", ProposalId) id: string) {
    return this.diplomacy.decline(auth.playerId, id);
  }

  @Post("proposals/:proposalId/withdraw")
  @HttpCode(200)
  withdraw(@Auth() auth: AuthContext, @Param("proposalId", ProposalId) id: string) {
    return this.diplomacy.withdraw(auth.playerId, id);
  }
}
