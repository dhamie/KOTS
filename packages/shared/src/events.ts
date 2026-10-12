import { EVENT_SCOPES, EVENT_TYPES } from "@kots/content";
import { z } from "zod";

const Timestamp = z.iso.datetime({ offset: true });

/** A city event in the news (`GET /api/events`): current ones, then those that ended recently. */
export const WorldEvent = z.object({
  id: z.uuid(),
  type: z.enum(EVENT_TYPES),
  scope: z.enum(EVENT_SCOPES),
  /** The market or district slug; null for the whole city. */
  scopeId: z.string().nullable(),
  state: z.enum(["active", "expired"]),
  headline: z.string(),
  body: z.string(),
  startsAt: Timestamp,
  expiresAt: Timestamp,
});
export type WorldEvent = z.infer<typeof WorldEvent>;
export const WorldEventList = z.array(WorldEvent);
