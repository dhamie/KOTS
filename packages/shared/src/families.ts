import { z } from "zod";
import { FamilyRoleSchema, Handle } from "./auth";

const Timestamp = z.iso.datetime({ offset: true });

export const FamilyName = z
  .string()
  .trim()
  .transform((s) => s.replace(/\s+/g, " "))
  .pipe(
    z
      .string()
      .min(3)
      .max(32)
      .regex(/^[\p{L}\p{N}][\p{L}\p{N} '-]*$/u, "letters, digits, spaces, ' and - only"),
  );
export const FamilyTag = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,5}$/, "2–5 letters or digits");

export const CreateFamilyRequest = z.strictObject({ name: FamilyName, tag: FamilyTag });
export type CreateFamilyRequest = z.infer<typeof CreateFamilyRequest>;

export const InviteRequest = z.strictObject({ handle: Handle });
export const SetRoleRequest = z.strictObject({ role: FamilyRoleSchema });
export const TransferLeadershipRequest = z.strictObject({ playerId: z.uuid() });

export const FamilyMember = z.object({ playerId: z.uuid(), handle: z.string(), role: FamilyRoleSchema, joinedAt: Timestamp });
export type FamilyMember = z.infer<typeof FamilyMember>;

export const FamilyDetail = z.object({
  id: z.uuid(),
  name: z.string(),
  tag: z.string(),
  stage: z.string(),
  foundedAt: Timestamp,
  members: z.array(FamilyMember),
});
export type FamilyDetail = z.infer<typeof FamilyDetail>;

export const Invitation = z.object({
  id: z.uuid(),
  family: z.object({ id: z.uuid(), name: z.string(), tag: z.string() }),
  player: z.object({ id: z.uuid(), handle: z.string() }),
  invitedBy: z.object({ id: z.uuid(), handle: z.string() }),
  createdAt: Timestamp,
  expiresAt: Timestamp,
});
export type Invitation = z.infer<typeof Invitation>;
export const InvitationList = z.array(Invitation);

export const ActivityEntry = z.object({
  id: z.string(),
  type: z.string(),
  actor: z.object({ id: z.uuid(), handle: z.string() }).nullable(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: Timestamp,
});
export type ActivityEntry = z.infer<typeof ActivityEntry>;

/** Keyset page: pass `nextCursor` as `before` to get older entries. */
export const ActivityPage = z.object({ items: z.array(ActivityEntry), nextCursor: z.string().nullable() });
export type ActivityPage = z.infer<typeof ActivityPage>;

export const ActivityQuery = z.strictObject({
  before: z.string().regex(/^\d{1,19}$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
