import { CITY, GOODS, MARKETS, type GoodKey } from "@kots/content";
import { checkFamilyAction, goodDef, marketGood, quoteOrder, type OrderSide } from "@kots/rules";
import type { Inventory, Market, MeResponse } from "@kots/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/http";
import { useCityNews } from "../events/useCityNews";
import { naira } from "../format";
import { useAction } from "../useAction";

/** A fresh Idempotency-Key. getRandomValues works over plain http too (randomUUID needs a secure context). */
const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

const placeName = (slug: string) => CITY.territories.get(slug)?.name ?? slug;

/**
 * The NPC markets: prices, stock, and a buy/sell form. Quotes come from the shared rules at the stock last loaded;
 * the order carries that quote as its limit, so the server refuses it (PRICE_CHANGED) rather than charge more.
 */
export function MarketView(props: { me: MeResponse; slug: string; revision: number; onSelectMarket: (slug: string) => void; onChanged: () => void }) {
  const { me, slug, revision, onSelectMarket, onChanged } = props;
  const family = me.family;
  const [market, setMarket] = useState<Market | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [good, setGood] = useState<GoodKey>(GOODS[0]!.key);
  const [quantity, setQuantity] = useState(10);
  const [done, setDone] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const events = useCityNews().filter((e) => e.state === "active" && ((e.scope === "market" && e.scopeId === slug) || e.scope === "city"));

  const load = useCallback(
    () =>
      run(async () => {
        const [m, inv, t] = await Promise.all([
          api.market(slug),
          family ? api.inventory(family.id) : Promise.resolve(null),
          family ? api.treasury(family.id) : Promise.resolve(null),
        ]);
        setMarket(m);
        setInventory(inv);
        setBalance(t?.balance ?? null);
      }),
    [slug, family?.id],
  );

  // A different market: clear what belonged to the last one.
  useEffect(() => {
    setMarket(null);
    setDone(null);
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  const canTrade = !!family && checkFamilyAction(family.role, { kind: "trade_market" }).ok;
  const row = market?.goods.find((g) => g.good === good);
  const heldOf = (key: GoodKey) => inventory?.items.find((i) => i.good === key)?.quantity ?? 0;
  const quote = (side: OrderSide) => (row && quantity > 0 ? quoteOrder(side, goodDef(good), marketGood(slug, good)!, row.stock, quantity) : null);
  const buy = quote("buy");
  const sell = quote("sell");
  const space = inventory ? inventory.capacity - inventory.used : 0;

  const submit = async (side: OrderSide, total: number) => {
    setDone(null);
    const ok = await run(async () => {
      const o = await api.order(slug, { side, good, quantity, limitTotal: total }, newKey());
      setDone(`${side === "buy" ? "Bought" : "Sold"} ${o.quantity} ${goodDef(o.good).label.toLowerCase()} for ${naira(o.total)}.`);
    });
    if (ok) onChanged();
    // Reload either way: after a refusal the stock (and so the quote) has usually moved.
    void load();
  };

  const why = (side: OrderSide): string | null => {
    const q = side === "buy" ? buy : sell;
    if (!canTrade) return family ? "Your role can't trade at the market." : "Join or start a family to trade.";
    if (!q) return null;
    if (!q.ok) return q.reason === "insufficient_stock" ? "The market doesn't have that many." : "The market won't take that many.";
    if (side === "buy" && quantity > space) return `Only ${space} units of storage free.`;
    if (side === "buy" && balance !== null && q.total > balance) return "Not enough in the treasury.";
    if (side === "sell" && quantity > heldOf(good)) return `Your family holds ${heldOf(good)}.`;
    return null;
  };

  return (
    <div data-testid="market-panel">
      <div className="tabs" role="group" aria-label="Markets">
        {MARKETS.map((m) => (
          <button key={m.territory} type="button" className={m.territory === slug ? "active" : ""} aria-pressed={m.territory === slug} onClick={() => onSelectMarket(m.territory)}>
            {placeName(m.territory)}
          </button>
        ))}
      </div>
      {family && (
        <p className="muted small">
          Treasury {balance === null ? "…" : naira(balance)} · storage {inventory ? `${inventory.used}/${inventory.capacity}` : "…"}
        </p>
      )}

      {events.map((e) => (
        <p key={e.id} className="event small" data-testid="market-event">
          <strong>{e.headline}.</strong> {e.body}
        </p>
      ))}

      <table className="prices">
        <thead>
          <tr>
            <th>Good</th>
            <th>Stock</th>
            <th>Buy</th>
            <th>Sell</th>
            {family && <th>Held</th>}
          </tr>
        </thead>
        <tbody>
          {market?.goods.map((g) => (
            <tr key={g.good} className={g.good === good ? "selected" : ""} onClick={() => setGood(g.good)}>
              <td>{goodDef(g.good).label}</td>
              <td>{g.stock}</td>
              <td>{naira(g.buyPrice)}</td>
              <td>{naira(g.sellPrice)}</td>
              {family && <td>{heldOf(g.good)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">{goodDef(good).blurb}</p>

      <div className="order">
        <label>
          Good
          <select value={good} onChange={(e) => setGood(e.target.value as GoodKey)}>
            {GOODS.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Quantity
          <input type="number" min={1} max={500} step={1} inputMode="numeric" value={quantity} onChange={(e) => setQuantity(Math.max(0, Math.min(500, Math.floor(Number(e.target.value) || 0))))} />
        </label>
      </div>
      <div className="order-buttons">
        {(["buy", "sell"] as const).map((side) => {
          const q = side === "buy" ? buy : sell;
          const reason = why(side);
          return (
            <div key={side}>
              <button type="button" disabled={busy || !q?.ok || reason !== null} onClick={() => q?.ok && void submit(side, q.total)}>
                {side === "buy" ? "Buy" : "Sell"} {quantity} {q?.ok ? `for ${naira(q.total)}` : ""}
              </button>
              {reason && <p className="muted small">{reason}</p>}
            </div>
          );
        })}
      </div>
      <p className="muted small">Each unit bought raises the price of the next; each unit sold lowers it. Stock drifts back to normal over time.</p>
      {done && (
        <p className="small" data-testid="order-done">
          {done}
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
