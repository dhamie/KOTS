import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ChatQuery, MarkReadRequest, OpenDirectRequest, ReportRequest, SendMessageRequest } from "@kots/shared";
import { SerialParam, UuidParam } from "../../common/uuid-param.pipe";
import { ZodPipe } from "../../common/zod.pipe";
import { Auth, AuthGuard } from "../auth/auth.guard";
import type { AuthContext } from "../auth/sessions.service";
import { ChatService } from "./chat.service";

const ChannelId = new UuidParam("Channel");
const MessageId = new SerialParam("Message");

@Controller("chat")
@UseGuards(AuthGuard)
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get("channels")
  channels(@Auth() auth: AuthContext) {
    return this.chat.channels(auth.playerId);
  }

  @Post("direct")
  @HttpCode(200)
  openDirect(@Auth() auth: AuthContext, @Body(new ZodPipe(OpenDirectRequest)) body: OpenDirectRequest) {
    return this.chat.openDirect(auth.playerId, body.handle);
  }

  @Get("channels/:channelId/messages")
  messages(@Auth() auth: AuthContext, @Param("channelId", ChannelId) channelId: string, @Query(new ZodPipe(ChatQuery)) query: ChatQuery) {
    return this.chat.messages(auth.playerId, channelId, query.before, query.limit);
  }

  @Post("channels/:channelId/messages")
  send(@Auth() auth: AuthContext, @Param("channelId", ChannelId) channelId: string, @Body(new ZodPipe(SendMessageRequest)) body: SendMessageRequest) {
    return this.chat.send(auth.playerId, channelId, body.body);
  }

  @Post("channels/:channelId/read")
  @HttpCode(204)
  read(@Auth() auth: AuthContext, @Param("channelId", ChannelId) channelId: string, @Body(new ZodPipe(MarkReadRequest)) body: MarkReadRequest) {
    return this.chat.markRead(auth.playerId, channelId, body.upTo);
  }

  @Delete("messages/:messageId")
  @HttpCode(204)
  delete(@Auth() auth: AuthContext, @Param("messageId", MessageId) messageId: string) {
    return this.chat.delete(auth.playerId, messageId);
  }

  @Post("messages/:messageId/report")
  @HttpCode(204)
  report(@Auth() auth: AuthContext, @Param("messageId", MessageId) messageId: string, @Body(new ZodPipe(ReportRequest)) body: ReportRequest) {
    return this.chat.report(auth.playerId, messageId, body);
  }
}
