import { Controller, Get, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard";
import { EventsService } from "./events.service";

@Controller("events")
@UseGuards(AuthGuard)
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /** The city news: current events, then recent ones. */
  @Get()
  news() {
    return this.events.news();
  }
}
