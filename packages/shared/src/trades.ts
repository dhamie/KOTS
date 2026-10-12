import { TRADES } from "@kots/content";
import { z } from "zod";
import { FamilyTag } from "./families";
import { GoodKey } from "./market";

const Timestamp = z.iso.datetime({ offset: true });
const FamilyRef = z.object({ id: z.uuid(), name: z.string(), tag: z.string() });

/** A quantity of a good, or cash. */
export const TradeItem = z.union([
  z.strictObject({ good: GoodKey, quantity: z.number().int().min(1).max(1_000_000) }),
  z.strictObject({ cash: z.number().int().min(1).max(TRADES.maxCash) }),
]);
export type TradeItem = z.infer<typeof TradeItem>;

/** `POST /api/families/:id/trades`: an offer to the family with tag `to`. Terms are checked by rules `checkTerms`. */
export const OfferRequest = z.strictObject({
  to: FamilyTag,
  gives: z.array(TradeItem).max(TRADES.maxLinesPerSide),
  wants: z.array(TradeItem).max(TRADES.maxLinesPerSide),
});
export type OfferRequest = z.infer<typeof OfferRequest>;

export const TRADE_STATUSES = ["open", "executed", "declined", "cancelled", "expired"] as const;

export const Trade = z.object({
  id: z.uuid(),
  /** The offering family; `gives` is what it hands over, `wants` what it asks for. */
  from: FamilyRef,
  to: FamilyRef,
  gives: z.array(TradeItem),
  wants: z.array(TradeItem),
  status: z.enum(TRADE_STATUSES),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  closedAt: Timestamp.nullable(),
});
export type Trade = z.infer<typeof Trade>;

export const TradeBox = z.enum(["incoming", "outgoing", "closed"]);
export type TradeBox = z.infer<typeof TradeBox>;

/** `GET /api/families/:id/trades?box=`: open offers to or from the family, or closed trades newest first (keyset). */
export const TradeQuery = z.strictObject({
  box: TradeBox,
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const TradePage = z.object({ items: z.array(Trade), nextCursor: z.string().nullable() });
export type TradePage = z.infer<typeof TradePage>;
