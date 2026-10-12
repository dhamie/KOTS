import { GOOD_KEYS, MARKET } from "@kots/content";
import { z } from "zod";

const Timestamp = z.iso.datetime({ offset: true });
const Naira = z.number().int();

export const GoodKey = z.enum(GOOD_KEYS);

export const MarketGood = z.object({
  good: GoodKey,
  stock: z.number().int(),
  /** The market stops buying at this stock. */
  maxStock: z.number().int(),
  /** Price of the next unit bought, and paid for the next unit sold. Quotes for larger orders use rules `quoteOrder`. */
  buyPrice: Naira,
  sellPrice: Naira,
});
export type MarketGood = z.infer<typeof MarketGood>;

/** `GET /api/markets/:slug`: open to every player. */
export const Market = z.object({ market: z.string(), goods: z.array(MarketGood) });
export type Market = z.infer<typeof Market>;

/**
 * `POST /api/markets/:slug/orders` with an `Idempotency-Key` header. `limitTotal` is the most the family will pay
 * (buy) or the least it will accept (sell); if the price has moved past it, the order is refused with PRICE_CHANGED.
 */
export const OrderRequest = z.strictObject({
  side: z.enum(["buy", "sell"]),
  good: GoodKey,
  quantity: z.number().int().min(1).max(MARKET.maxOrderQuantity),
  limitTotal: Naira.min(1),
});
export type OrderRequest = z.infer<typeof OrderRequest>;

/** A client-chosen key, unique per order attempt; a retry with the same key fills the order at most once. */
export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_:-]{8,100}$/);

export const MarketOrder = z.object({
  id: z.uuid(),
  market: z.string(),
  good: GoodKey,
  side: z.enum(["buy", "sell"]),
  quantity: z.number().int(),
  total: Naira,
  createdAt: Timestamp,
});
export type MarketOrder = z.infer<typeof MarketOrder>;

/** `GET /api/families/:id/inventory`: for members. Space is in units; one unit of any good takes one. */
export const Inventory = z.object({
  capacity: z.number().int(),
  used: z.number().int(),
  items: z.array(z.object({ good: GoodKey, quantity: z.number().int() })),
});
export type Inventory = z.infer<typeof Inventory>;
