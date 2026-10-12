import { Controller, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { NotificationQuery } from "@kots/shared";
import { SerialParam } from "../../common/uuid-param.pipe";
import { ZodPipe } from "../../common/zod.pipe";
import { Auth, AuthGuard } from "../auth/auth.guard";
import type { AuthContext } from "../auth/sessions.service";
import { NotificationsService } from "./notifications.service";

@Controller("notifications")
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  page(@Auth() auth: AuthContext, @Query(new ZodPipe(NotificationQuery)) query: NotificationQuery) {
    return this.notifications.page(auth.playerId, query.before, query.limit);
  }

  @Post("read-all")
  @HttpCode(204)
  readAll(@Auth() auth: AuthContext) {
    return this.notifications.markAllRead(auth.playerId);
  }

  @Post(":id/read")
  @HttpCode(204)
  read(@Auth() auth: AuthContext, @Param("id", new SerialParam("Notification")) id: string) {
    return this.notifications.markRead(auth.playerId, id);
  }
}
