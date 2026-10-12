import { HENCHMAN_ATTRIBUTES } from "@kots/content";
import { z } from "zod";

const Timestamp = z.iso.datetime({ offset: true });
const Naira = z.number().int();
const Attributes = z.record(z.enum(HENCHMAN_ATTRIBUTES), z.number().int());

export const RecruitCandidate = z.object({
  slot: z.number().int(),
  archetype: z.string(),
  name: z.string(),
  attributes: Attributes,
  traits: z.array(z.string()),
  hireCost: Naira,
  wage: Naira,
  /** Already hired from today's board. */
  hired: z.boolean(),
});
export type RecruitCandidate = z.infer<typeof RecruitCandidate>;

/** `GET /api/families/:id/recruits`: today's board (Lagos time). Hiring costs `hireCost + wage` (the first day's wage). */
export const RecruitBoard = z.object({ day: z.number().int(), resetsAt: Timestamp, candidates: z.array(RecruitCandidate) });
export type RecruitBoard = z.infer<typeof RecruitBoard>;

export const Henchman = z.object({
  id: z.uuid(),
  archetype: z.string(),
  name: z.string(),
  attributes: Attributes,
  traits: z.array(z.string()),
  morale: z.number().int(),
  wage: Naira,
  wagePaidUntil: Timestamp,
  wageOverdue: z.boolean(),
  /** Slug of the territory they guard, or null if idle. */
  assignedTo: z.string().nullable(),
  hiredAt: Timestamp,
  /** Can't fight until then. */
  injuredUntil: Timestamp.nullable(),
  /** The battle they're committed to. */
  battleId: z.uuid().nullable(),
});
export type Henchman = z.infer<typeof Henchman>;
export const HenchmanList = z.array(Henchman);

export const HireRequest = z.strictObject({ slot: z.number().int().min(0).max(31) });
export const AssignRequest = z.strictObject({ territory: z.string().regex(/^[a-z0-9-]{1,40}$/).nullable() });
