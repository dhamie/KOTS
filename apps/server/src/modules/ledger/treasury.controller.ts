import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { checkFamilyAction } from "@kots/rules";
import { LedgerQuery, type Treasury } from "@kots/shared";
import type { z } from "zod";
import { forbidden } from "../../common/errors";
import { UuidParam } from "../../common/uuid-param.pipe";
import { ZodPipe } from "../../common/zod.pipe";
import { Auth, AuthGuard } from "../auth/auth.guard";
import type { AuthContext } from "../auth/sessions.service";
import { MembershipsService } from "../families/memberships.service";
import { LedgerService } from "./ledger.service";

const FamilyId = new UuidParam("Family");

/** Read-only treasury views. Every member sees the balance; the history needs `treasury.view`. */
@Controller("families/:familyId/treasury")
@UseGuards(AuthGuard)
export class TreasuryController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly memberships: MembershipsService,
  ) {}

  @Get()
  async balance(@Auth() auth: AuthContext, @Param("familyId", FamilyId) familyId: string): Promise<Treasury> {
    await this.memberships.requireMemberOf(auth.playerId, familyId);
    return { balance: await this.ledger.balance(familyId) };
  }

  @Get("entries")
  async entries(@Auth() auth: AuthContext, @Param("familyId", FamilyId) familyId: string, @Query(new ZodPipe(LedgerQuery)) query: z.infer<typeof LedgerQuery>) {
    const member = await this.memberships.requireMemberOf(auth.playerId, familyId);
    if (!checkFamilyAction(member.role, { kind: "view_treasury" }).ok) throw forbidden("Your role doesn't allow that.");
    return this.ledger.treasuryPage(familyId, query.before, query.limit);
  }
}
