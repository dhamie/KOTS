import { FAMILY_ROLES, GOOD_KEYS, GOODS, MARKET, MARKETS, STORAGE } from "@kots/content";
import { describe, expect, it } from "vitest";
import { askPrice, bidPrice, checkFamilyAction, driftStep, driftStock, goodDef, marketGood, maxStock, midPrice, quoteOrder, storageCapacity } from "../src";

const fuel = goodDef("fuel");
const contraband = goodDef("contraband");
const wharfFuel = marketGood("apapa-wharf", "fuel")!;
const wharfContraband = marketGood("apapa-wharf", "contraband")!;

describe("content", () => {
  it("every market lists every good, and markets are distinct territories", () => {
    for (const m of MARKETS) expect(Object.keys(m.goods).sort()).toEqual([...GOOD_KEYS].sort());
    expect(new Set(MARKETS.map((m) => m.territory)).size).toBe(MARKETS.length);
    expect(GOODS.map((g) => g.key)).toEqual([...GOOD_KEYS]);
  });
});

describe("midPrice", () => {
  it("is base × factor at normal stock", () => {
    expect(midPrice(fuel, wharfFuel, wharfFuel.normalStock)).toBeCloseTo(120 * 0.9);
  });

  it("rises as stock falls and falls as it rises", () => {
    const at = (s: number) => midPrice(contraband, wharfContraband, s);
    expect(at(40)).toBeGreaterThan(at(80));
    expect(at(160)).toBeLessThan(at(80));
  });

  it("stays within 0.5× and 2× of base × factor, including at zero stock", () => {
    const anchor = contraband.basePrice * wharfContraband.factor;
    expect(midPrice(contraband, wharfContraband, 0)).toBe(anchor * MARKET.maxPriceFactor);
    expect(midPrice(contraband, wharfContraband, 1)).toBe(anchor * MARKET.maxPriceFactor);
    expect(midPrice(contraband, wharfContraband, 100_000)).toBe(anchor * MARKET.minPriceFactor);
  });
});

describe("quoteOrder", () => {
  it("prices a buy one unit at a time, each dearer than the last", () => {
    const q = quoteOrder("buy", contraband, wharfContraband, 80, 3);
    const units = [80, 79, 78].map((s) => askPrice(contraband, wharfContraband, s));
    expect(units[2]).toBeGreaterThan(units[0]!);
    expect(q).toEqual({ ok: true, total: units[0]! + units[1]! + units[2]!, stockAfter: 77 });
  });

  it("prices a sell one unit at a time, each cheaper than the last", () => {
    const q = quoteOrder("sell", contraband, wharfContraband, 80, 3);
    const units = [80, 81, 82].map((s) => bidPrice(contraband, wharfContraband, s));
    expect(units[2]).toBeLessThan(units[0]!);
    expect(q).toEqual({ ok: true, total: units[0]! + units[1]! + units[2]!, stockAfter: 83 });
  });

  it("buying and selling straight back always loses money", () => {
    for (const good of GOODS) {
      for (const m of MARKETS) {
        const mg = m.goods[good.key];
        for (const qty of [1, 10, 100]) {
          const buy = quoteOrder("buy", good, mg, mg.normalStock, qty);
          if (!buy.ok) continue;
          const sell = quoteOrder("sell", good, mg, buy.stockAfter, qty);
          expect(sell.ok && sell.total < buy.total).toBe(true);
        }
      }
    }
  });

  it("refuses to buy more than the market holds, or sell past its limit", () => {
    expect(quoteOrder("buy", fuel, wharfFuel, 5, 6)).toEqual({ ok: false, reason: "insufficient_stock" });
    expect(quoteOrder("buy", fuel, wharfFuel, 5, 5)).toMatchObject({ ok: true, stockAfter: 0 });
    const max = maxStock(wharfFuel);
    expect(quoteOrder("sell", fuel, wharfFuel, max - 2, 3)).toEqual({ ok: false, reason: "market_full" });
    expect(quoteOrder("sell", fuel, wharfFuel, max - 2, 2)).toMatchObject({ ok: true, stockAfter: max });
  });

  it("some good is cheaper to buy in one market than it sells for in another", () => {
    const gaps = GOODS.flatMap((g) =>
      MARKETS.flatMap((a) => MARKETS.map((b) => bidPrice(g, b.goods[g.key], b.goods[g.key].normalStock) - askPrice(g, a.goods[g.key], a.goods[g.key].normalStock))),
    );
    expect(Math.max(...gaps)).toBeGreaterThan(0);
  });
});

describe("storageCapacity", () => {
  it("is the base plus each held territory's kind", () => {
    expect(storageCapacity([])).toBe(STORAGE.base);
    expect(storageCapacity(["logistics", "residential", "commercial"])).toBe(STORAGE.base + 100 + 20 + 40);
  });
});

describe("driftStock", () => {
  it("is deterministic in market, good and step", () => {
    expect(driftStock("apapa-wharf", fuel, wharfFuel, 300, 42)).toBe(driftStock("apapa-wharf", fuel, wharfFuel, 300, 42));
    const steps = new Set(Array.from({ length: 20 }, (_, i) => driftStock("apapa-wharf", fuel, wharfFuel, 300, i)));
    expect(steps.size).toBeGreaterThan(1);
  });

  it("closes the gap to normal stock over time, from either side, and stays within limits", () => {
    for (const start of [0, maxStock(wharfContraband)]) {
      let s = start;
      for (let step = 0; step < 100; step++) {
        s = driftStock("apapa-wharf", contraband, wharfContraband, s, step);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(maxStock(wharfContraband));
      }
      // Within the wobble (6% of 80 ≈ 5) plus the slack left by rounding.
      expect(Math.abs(s - wharfContraband.normalStock)).toBeLessThanOrEqual(15);
    }
  });

  it("uses fixed-length steps", () => {
    expect(driftStep(0)).toBe(0);
    expect(driftStep(MARKET.driftMinutes * 60_000 - 1)).toBe(0);
    expect(driftStep(MARKET.driftMinutes * 60_000)).toBe(1);
  });
});

describe("market permission", () => {
  it("is for the don, underboss and quartermaster", () => {
    expect(FAMILY_ROLES.filter((r) => checkFamilyAction(r, { kind: "trade_market" }).ok)).toEqual(["don", "underboss", "quartermaster"]);
  });
});
