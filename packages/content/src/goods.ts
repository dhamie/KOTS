import type { TerritoryKind } from "./map/territories";

/**
 * Trade goods, the NPC markets and storage. Names are deliberately abstract (see docs/BRIEF.md).
 * Formulas that use these live in packages/rules/src/market.ts; see docs/ECONOMY.md.
 */
export const GOOD_KEYS = ["fuel", "textiles", "imported_goods", "electronics", "contraband"] as const;
export type GoodKey = (typeof GOOD_KEYS)[number];

export interface GoodDef {
  key: GoodKey;
  label: string;
  blurb: string;
  /** ₦ per unit at a market's normal stock, before the market's own factor. */
  basePrice: number;
  /** How hard the price reacts to stock: price ∝ (normal ÷ stock)^elasticity. */
  elasticity: number;
  /** Largest random stock change per drift step, as a fraction of normal stock. */
  volatility: number;
}

export const GOODS: readonly GoodDef[] = [
  { key: "fuel", label: "Fuel", blurb: "Jerrycans and tanker loads. Everyone needs it, nobody asks where it came from.", basePrice: 120, elasticity: 0.5, volatility: 0.01 },
  { key: "textiles", label: "Textiles", blurb: "Bolts of ankara and lace, by the bale.", basePrice: 200, elasticity: 0.6, volatility: 0.015 },
  { key: "imported_goods", label: "Imported goods", blurb: "Containers that cleared the port, one way or another.", basePrice: 350, elasticity: 0.8, volatility: 0.02 },
  { key: "electronics", label: "Electronics", blurb: "Phones, parts and boxes with the labels peeled off.", basePrice: 700, elasticity: 1, volatility: 0.04 },
  { key: "contraband", label: "Contraband", blurb: "Unmarked crates. Better not to look inside.", basePrice: 1200, elasticity: 1.2, volatility: 0.06 },
];

export interface MarketGoodDef {
  /** Stock the market drifts back to; the price is the good's base × factor at this stock. */
  normalStock: number;
  /** Below 1 the good is cheap here, above 1 it sells well here. */
  factor: number;
}

export interface MarketDef {
  /** The territory the market is in; a market is identified by this slug. */
  territory: string;
  goods: Record<GoodKey, MarketGoodDef>;
}

/** One market per district, with different prices so buying in one and selling in another can pay. */
export const MARKETS: readonly MarketDef[] = [
  {
    territory: "tejuosho",
    goods: {
      fuel: { normalStock: 600, factor: 1 },
      textiles: { normalStock: 500, factor: 0.85 },
      imported_goods: { normalStock: 250, factor: 1.05 },
      electronics: { normalStock: 150, factor: 1.1 },
      contraband: { normalStock: 60, factor: 1 },
    },
  },
  {
    territory: "balogun",
    goods: {
      fuel: { normalStock: 500, factor: 1.1 },
      textiles: { normalStock: 400, factor: 1.1 },
      imported_goods: { normalStock: 250, factor: 1.15 },
      electronics: { normalStock: 120, factor: 1.15 },
      contraband: { normalStock: 50, factor: 1.15 },
    },
  },
  {
    territory: "apapa-wharf",
    goods: {
      fuel: { normalStock: 800, factor: 0.9 },
      textiles: { normalStock: 300, factor: 1 },
      imported_goods: { normalStock: 400, factor: 0.85 },
      electronics: { normalStock: 180, factor: 0.9 },
      contraband: { normalStock: 80, factor: 0.85 },
    },
  },
];

export const MARKET = {
  /** Markets sell this much above and buy this much below the price, so buying and selling straight back loses. */
  spread: 0.05,
  /** The price stays within this range of base × factor however far the stock moves. */
  minPriceFactor: 0.5,
  maxPriceFactor: 2,
  /** A market stops buying a good once its stock reaches this multiple of normal. */
  maxStockFactor: 3,
  /** Fraction of the gap to normal stock closed per drift step. */
  driftRate: 0.1,
  /** Length of one drift step. */
  driftMinutes: 30,
  /** Most units in one order. */
  maxOrderQuantity: 500,
} as const;

/** Storage in units of goods (one unit of any good takes one unit of space). */
export const STORAGE = {
  base: 50,
  perTerritory: { logistics: 100, industrial: 60, commercial: 40, residential: 20, civic: 20, waterfront: 20 } satisfies Record<TerritoryKind, number>,
} as const;
