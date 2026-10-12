import type { MeResponse } from "@kots/shared";
import { MarketView } from "./MarketView";
import { TradesView } from "./TradesView";

export type MarketTab = "markets" | "trades";

/** The market drawer: NPC markets in one tab, trades with other families in the other (one drawer keeps the phone toolbar short). */
export function MarketPanel(props: {
  me: MeResponse;
  slug: string;
  revision: number;
  tab: MarketTab;
  onTab: (tab: MarketTab) => void;
  onSelectMarket: (slug: string) => void;
  onChanged: () => void;
}) {
  const { tab, onTab: setTab } = props;
  return (
    <section className="panel side market" aria-label="Market">
      <h2>Market</h2>
      <div className="tabs primary" role="group" aria-label="Market sections">
        {(["markets", "trades"] as const).map((t) => (
          <button key={t} type="button" className={tab === t ? "active" : ""} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t === "markets" ? "Markets" : "Trades"}
          </button>
        ))}
      </div>
      {tab === "markets" ? <MarketView {...props} /> : <TradesView me={props.me} revision={props.revision} onChanged={props.onChanged} />}
    </section>
  );
}
