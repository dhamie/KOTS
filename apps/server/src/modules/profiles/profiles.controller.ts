import { Controller, Get, Param, UseGuards } from "@nestjs/common";
import { Handle, type MeResponse, type PlayerProfile } from "@kots/shared";
import { notFound } from "../../common/errors";
import { AccountsService } from "../auth/accounts.service";
import { Auth, AuthGuard } from "../auth/auth.guard";
import type { AuthContext } from "../auth/sessions.service";
import { FamiliesService } from "../families/families.service";

/** Read-only views that combine the account and family modules. */
@Controller()
@UseGuards(AuthGuard)
export class ProfilesController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly families: FamiliesService,
  ) {}

  @Get("me")
  async me(@Auth() auth: AuthContext): Promise<MeResponse> {
    const [email, player, membership, moderator] = await Promise.all([
      this.accounts.emailOf(auth.userId),
      this.accounts.findPlayerById(auth.playerId),
      this.families.membershipOf(auth.playerId),
      this.accounts.isModerator(auth.playerId),
    ]);
    return {
      email,
      player: { id: player!.id, handle: player!.handle },
      moderator,
      family: membership && { ...membership.family, role: membership.role, permissions: membership.permissions },
    };
  }

  @Get("players/:handle")
  async profile(@Param("handle") handle: string): Promise<PlayerProfile> {
    const parsed = Handle.safeParse(handle);
    const player = parsed.success ? await this.accounts.findPlayerByHandle(parsed.data) : undefined;
    if (!player) throw notFound("Player");
    const membership = await this.families.membershipOf(player.id);
    return {
      id: player.id,
      handle: player.handle,
      createdAt: player.createdAt.toISOString(),
      family: membership && { ...membership.family, role: membership.role },
    };
  }
}
