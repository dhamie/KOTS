import { GOODS, MARKET, MARKETS, STORAGE, type GoodDef, type GoodKey, type MarketGoodDef, type TerritoryKind } from "@kots/content";
import { hashSeed } from "./henchmen";
import { createRng, nextInt } from "./rng";

export const DRIFT_STEP_MS = MARKET.driftMinutes * 60 * 1000;

export function goodDef(key: GoodKey): GoodDef {
  return GOODS.find((g) => g.key === key)!;
}

/** A market's settings for one good, or undefined if `market` isn't a market territory. */
export function marketGood(market: string, good: GoodKey): MarketGoodDef | undefined {
  return MARKETS.find((m) => m.territory === market)?.goods[good];
}

export const maxStock = (mg: MarketGoodDef) => mg.normalStock * MARKET.maxStockFactor;

/** The price at `stock`, before the spread: base × factor × (normal ÷ stock)^elasticity, kept within the clamp. */
export function midPrice(good: GoodDef, mg: MarketGoodDef, stock: number): number {
  const anchor = good.basePrice * mg.factor;
  const raw = stock <= 0 ? Infinity : anchor * Math.pow(mg.normalStock / stock, good.elasticity);
  return Math.min(anchor * MARKET.maxPriceFactor, Math.max(anchor * MARKET.minPriceFactor, raw));
}

/** What the market charges for one unit when it holds `stock` (the unit takes stock to stock − 1). */
export const askPrice = (good: GoodDef, mg: MarketGoodDef, stock: number) => Math.ceil(midPrice(good, mg, stock) * (1 + MARKET.spread));

/** What the market pays for one unit when it holds `stock` (the unit takes stock to stock + 1). */
export const bidPrice = (good: GoodDef, mg: MarketGoodDef, stock: number) => Math.floor(midPrice(good, mg, stock + 1) * (1 - MARKET.spread));

export type OrderSide = "buy" | "sell";
export type MarketQuote = { ok: true; total: number; stockAfter: number } | { ok: false; reason: "insufficient_stock" | "market_full" };

/**
 * The total for `quantity` units, priced one unit at a time, so each unit bought raises the next unit's price and
 * each unit sold lowers it. A large order can't be filled at the first unit's price.
 */
export function quoteOrder(side: OrderSide, good: GoodDef, mg: MarketGoodDef, stock: number, quantity: number): MarketQuote {
  if (side === "buy") {
    if (quantity > stock) return { ok: false, reason: "insufficient_stock" };
    let total = 0;
    for (let i = 0; i < quantity; i++) total += askPrice(good, mg, stock - i);
    return { ok: true, total, stockAfter: stock - quantity };
  }
  if (stock + quantity > maxStock(mg)) return { ok: false, reason: "market_full" };
  let total = 0;
  for (let i = 0; i < quantity; i++) total += bidPrice(good, mg, stock + i);
  return { ok: true, total, stockAfter: stock + quantity };
}

/** Units of goods a family can store, from the kinds of the territories it holds. */
export function storageCapacity(heldKinds: readonly TerritoryKind[]): number {
  return heldKinds.reduce<number>((sum, kind) => sum + STORAGE.perTerritory[kind], STORAGE.base);
}

/** The drift step `nowMs` falls in. Each step is applied at most once per market and good. */
export const driftStep = (nowMs: number) => Math.floor(nowMs / DRIFT_STEP_MS);

/**
 * Stock after one drift step: part of the way back to normal, plus a seeded wobble of up to the good's volatility.
 * Deterministic in (market, good, step), so a retried job computes the same result.
 */
export function driftStock(market: string, good: GoodDef, mg: MarketGoodDef, stock: number, step: number): number {
  const wobbleMax = Math.round(mg.normalStock * good.volatility);
  const wobble = wobbleMax > 0 ? nextInt(createRng(hashSeed(`${market}:${good.key}:${step}`)), -wobbleMax, wobbleMax) : 0;
  const next = stock + Math.round((mg.normalStock - stock) * MARKET.driftRate) + wobble;
  return Math.min(maxStock(mg), Math.max(0, next));
}
