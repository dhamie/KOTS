import { z } from "zod";

const Timestamp = z.iso.datetime({ offset: true });
const Naira = z.number().int();
const FamilyRef = z.object({ id: z.uuid(), name: z.string(), tag: z.string() });

export const TerritorySlug = z.string().regex(/^[a-z0-9-]{1,40}$/);

/** Why the viewer's family can't claim a territory right now. */
export const ClaimRefusal = z.enum(["not_in_family", "missing_permission", "owned", "not_adjacent", "insufficient_funds"]);
export type ClaimRefusal = z.infer<typeof ClaimRefusal>;

/** `GET /api/territories/:slug`, also returned by a claim. Static facts (name, kind, base values) come from content. */
export const TerritoryDetail = z.object({
  slug: z.string(),
  owner: FamilyRef.nullable(),
  /** `neglected` means the upkeep is overdue; the territory is lost when the grace period ends. */
  state: z.enum(["stable", "neglected"]),
  ownedSince: Timestamp.nullable(),
  /** Only for members of the owning family. */
  holding: z.object({ paidUntil: Timestamp, upkeep: Naira, income: Naira }).nullable(),
  /** What claiming would cost the viewer's family, for a territory it doesn't hold. Null if it holds it. */
  claim: z.object({ fee: Naira, firstUpkeep: Naira, total: Naira, refusal: ClaimRefusal.nullable() }).nullable(),
  /** The battle being fought over it, if any. */
  battleId: z.uuid().nullable(),
});
export type TerritoryDetail = z.infer<typeof TerritoryDetail>;

export const FamilyHolding = z.object({
  slug: z.string(),
  state: z.enum(["stable", "neglected"]),
  paidUntil: Timestamp,
  upkeep: Naira,
  income: Naira,
});
export type FamilyHolding = z.infer<typeof FamilyHolding>;

/** `GET /api/families/:id/territories`: the family's holdings, for members. */
export const FamilyHoldings = z.object({ territories: z.array(FamilyHolding), income: Naira, upkeep: Naira });
export type FamilyHoldings = z.infer<typeof FamilyHoldings>;

/** `GET /api/families/:id/treasury`: visible to every member. */
export const Treasury = z.object({ balance: Naira });
export type Treasury = z.infer<typeof Treasury>;

export const LedgerEntry = z.object({
  id: z.string(),
  kind: z.string(),
  /** What this line is for, e.g. `territory_income`, `claim_fee`. */
  reason: z.string(),
  /** Signed: positive is money in. */
  amount: Naira,
  balanceAfter: Naira,
  ref: z.object({ type: z.string(), id: z.string() }).nullable(),
  createdAt: Timestamp,
});
export type LedgerEntry = z.infer<typeof LedgerEntry>;

/** Keyset page, newest first: pass `nextCursor` as `before` for older entries. */
export const LedgerPage = z.object({ items: z.array(LedgerEntry), nextCursor: z.string().nullable() });
export type LedgerPage = z.infer<typeof LedgerPage>;

export const LedgerQuery = z.strictObject({
  before: z.string().regex(/^\d{1,19}$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
