import { GOODS, TRADES, type GoodKey } from "@kots/content";
import { checkFamilyAction, checkTerms, goodDef } from "@kots/rules";
import type { MeResponse, Trade, TradeItem } from "@kots/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../../api/http";
import { naira, when } from "../format";
import { useAction } from "../useAction";

const describe = (items: TradeItem[]) =>
  items.length === 0 ? "nothing" : items.map((i) => ("cash" in i ? naira(i.cash) : `${i.quantity} ${goodDef(i.good).label.toLowerCase()}`)).join(", ");

const STATUS_LABEL: Record<Trade["status"], string> = { open: "open", executed: "done", declined: "declined", cancelled: "cancelled", expired: "expired" };

/** One editable item of a new offer: cash, or a good. Amount is kept as typed text until the offer is sent. */
type Row = { what: "cash" | GoodKey; amount: string };

const toItem = (r: Row): TradeItem | null => {
  const n = Math.floor(Number(r.amount));
  if (!Number.isFinite(n) || n < 1) return null;
  return r.what === "cash" ? { cash: n } : { good: r.what, quantity: n };
};

/**
 * Offers to and from other families. Accepting runs the trade on the server, which re-checks goods, cash, storage
 * and both families' age; the controls here only follow the shared rules.
 */
export function TradesView(props: { me: MeResponse; revision: number; onChanged: () => void }) {
  const { me, revision, onChanged } = props;
  const family = me.family;
  const [incoming, setIncoming] = useState<Trade[]>([]);
  const [outgoing, setOutgoing] = useState<Trade[]>([]);
  const [closed, setClosed] = useState<Trade[]>([]);
  const { busy, error, run } = useAction();

  const load = useCallback(
    () =>
      run(async () => {
        if (!family) return;
        const [i, o, c] = await Promise.all([api.trades(family.id, "incoming"), api.trades(family.id, "outgoing"), api.trades(family.id, "closed")]);
        setIncoming(i.items);
        setOutgoing(o.items);
        setClosed(c.items);
      }),
    [family?.id],
  );

  useEffect(() => {
    void load();
  }, [load, revision]);

  if (!family) return <p className="muted">Join or start a family to trade with other families.</p>;

  const canPropose = checkFamilyAction(family.role, { kind: "propose_trade" }).ok;
  const canAccept = checkFamilyAction(family.role, { kind: "accept_trade" }).ok;
  const act = async (action: () => Promise<unknown>) => {
    if (await run(action)) onChanged();
    void load();
  };

  return (
    <div className="trades" data-testid="trades">
      <p className="muted small">
        Accepting runs a trade at once: goods and cash move together or not at all. Offers expire after {TRADES.offerTtlHours} hours. Families can trade once they're{" "}
        {TRADES.minFamilyAgeDays} days old.
      </p>
      {error && <p className="error">{error}</p>}

      <h3>Offers to you</h3>
      {incoming.length === 0 && <p className="muted small">None.</p>}
      <ul className="list offers" data-testid="incoming">
        {incoming.map((t) => (
          <li key={t.id}>
            <div>
              <strong>
                {t.from.name} [{t.from.tag}]
              </strong>
              <div className="small">You get {describe(t.gives)}</div>
              <div className="small">You give {describe(t.wants)}</div>
              <div className="muted small">Expires {when(t.expiresAt)}</div>
            </div>
            {canAccept && (
              <div className="controls">
                <button type="button" disabled={busy} onClick={() => void act(() => api.acceptTrade(t.id))}>
                  Accept
                </button>
                <button type="button" disabled={busy} onClick={() => void act(() => api.declineTrade(t.id))}>
                  Decline
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      <h3>Your offers</h3>
      {outgoing.length === 0 && <p className="muted small">None.</p>}
      <ul className="list offers" data-testid="outgoing">
        {outgoing.map((t) => (
          <li key={t.id}>
            <div>
              <strong>
                To {t.to.name} [{t.to.tag}]
              </strong>
              <div className="small">You give {describe(t.gives)}</div>
              <div className="small">You get {describe(t.wants)}</div>
              <div className="muted small">Expires {when(t.expiresAt)}</div>
            </div>
            {canPropose && (
              <div className="controls">
                <button type="button" disabled={busy} onClick={() => void act(() => api.cancelTrade(t.id))}>
                  Cancel
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {canPropose && <NewOffer familyId={family.id} busy={busy} onSubmit={(offer) => act(() => api.proposeTrade(family.id, offer))} />}

      {closed.length > 0 && (
        <details>
          <summary className="small">Recent trades</summary>
          <ul className="list activity" data-testid="closed">
            {closed.map((t) => {
              const mine = t.from.id === family.id;
              const other = mine ? t.to : t.from;
              return (
                <li key={t.id}>
                  <span>
                    [{other.tag}] you gave {describe(mine ? t.gives : t.wants)} for {describe(mine ? t.wants : t.gives)}
                  </span>
                  <span className="muted">{STATUS_LABEL[t.status]}</span>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}

function NewOffer(props: { familyId: string; busy: boolean; onSubmit: (offer: { to: string; gives: TradeItem[]; wants: TradeItem[] }) => Promise<void> }) {
  const { busy, onSubmit } = props;
  const [to, setTo] = useState("");
  const [gives, setGives] = useState<Row[]>([{ what: "cash", amount: "" }]);
  const [wants, setWants] = useState<Row[]>([]);

  const items = (rows: Row[]) => rows.map(toItem);
  const complete = [...items(gives), ...items(wants)].every((i) => i !== null);
  const terms = complete ? checkTerms({ gives: items(gives) as TradeItem[], wants: items(wants) as TradeItem[] }) : null;
  const ready = to.trim().length >= 2 && terms?.ok === true;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    await onSubmit({ to: to.trim().toUpperCase(), gives: items(gives) as TradeItem[], wants: items(wants) as TradeItem[] });
    setGives([{ what: "cash", amount: "" }]);
    setWants([]);
  };

  return (
    <form className="new-offer" onSubmit={(e) => void submit(e)}>
      <h3>New offer</h3>
      <label>
        Family tag
        <input value={to} maxLength={5} onChange={(e) => setTo(e.target.value)} placeholder="e.g. APA" />
      </label>
      <Items title="You give" rows={gives} setRows={setGives} />
      <Items title="You want" rows={wants} setRows={setWants} />
      {terms && !terms.ok && <p className="muted small">{terms.reason === "repeated_item" ? "List each good, and cash, once per side." : terms.reason === "empty" ? "Add at least one item." : "Too much on one side."}</p>}
      <button type="submit" disabled={busy || !ready}>
        Send offer
      </button>
    </form>
  );
}

function Items(props: { title: string; rows: Row[]; setRows: (rows: Row[]) => void }) {
  const { title, rows, setRows } = props;
  const set = (i: number, row: Row) => setRows(rows.map((r, j) => (j === i ? row : r)));
  return (
    <fieldset className="items">
      <legend className="small">{title}</legend>
      {rows.map((r, i) => (
        <div key={i} className="item">
          <select aria-label={`${title} item ${i + 1}`} value={r.what} onChange={(e) => set(i, { ...r, what: e.target.value as Row["what"] })}>
            <option value="cash">Cash (₦)</option>
            {GOODS.map((g) => (
              <option key={g.key} value={g.key}>
                {g.label}
              </option>
            ))}
          </select>
          <input
            aria-label={`${title} amount ${i + 1}`}
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={r.amount}
            onChange={(e) => set(i, { ...r, amount: e.target.value.replace(/[^\d]/g, "") })}
          />
          <button type="button" className="link" aria-label={`Remove ${title.toLowerCase()} item ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      {rows.length < TRADES.maxLinesPerSide && (
        <button type="button" className="link small" onClick={() => setRows([...rows, { what: "cash", amount: "" }])}>
          + Add item
        </button>
      )}
    </fieldset>
  );
}
