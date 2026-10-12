import { FAMILY_PERMISSIONS, FAMILY_ROLES } from "@kots/content";
import { z } from "zod";

export const Email = z.string().trim().max(254).pipe(z.email());
export const Password = z.string().min(10, "at least 10 characters").max(128);
export const Handle = z
  .string()
  .trim()
  .min(3)
  .max(20)
  .regex(/^[A-Za-z0-9_]+$/, "letters, digits and _ only");

export const RegisterRequest = z.strictObject({ email: Email, password: Password, handle: Handle });
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.strictObject({ email: Email, password: z.string().min(1).max(128) });
export type LoginRequest = z.infer<typeof LoginRequest>;

export const FamilyRoleSchema = z.enum(FAMILY_ROLES);

/** `GET /api/me`, also returned by register and login. */
export const MeResponse = z.object({
  email: z.string(),
  player: z.object({ id: z.uuid(), handle: z.string() }),
  /** Can delete any chat message and review reports. */
  moderator: z.boolean(),
  family: z
    .object({
      id: z.uuid(),
      name: z.string(),
      tag: z.string(),
      role: FamilyRoleSchema,
      permissions: z.array(z.enum(FAMILY_PERMISSIONS)),
    })
    .nullable(),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const PlayerProfile = z.object({
  id: z.uuid(),
  handle: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  family: z.object({ id: z.uuid(), name: z.string(), tag: z.string(), role: FamilyRoleSchema }).nullable(),
});
export type PlayerProfile = z.infer<typeof PlayerProfile>;
