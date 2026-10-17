import { CITY, TERRITORY_KINDS, type TerritoryKind } from "@kots/content";
import type { DistrictSummary } from "@kots/shared";
import { useEffect, useState } from "react";
import { api } from "../../api/http";
import { mapBus } from "../../map/bus";
import { KIND_STYLE } from "../../map/palette";
import { useCityNews } from "../events/useCityNews";
import { when } from "../format";
import { OfficialsList } from "./OfficialsList";

/** District list (jump to a district), the city news, the officials and marker filters. */
export function DistrictNav({ onNavigate }: { onNavigate: () => void }) {
  const [summaries, setSummaries] = useState<Map<string, DistrictSummary>>(new Map());
  const [kinds, setKinds] = useState<ReadonlySet<TerritoryKind>>(new Set(TERRITORY_KINDS));
  const news = useCityNews();

  useEffect(() => {
    api
      .districts()
      .then((list) => setSummaries(new Map(list.map((d) => [d.slug, d]))))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    mapBus.emit("markers:filter", kinds);
  }, [kinds]);

  const toggle = (k: TerritoryKind) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <section className="panel side" aria-label="Districts">
      <h2>Districts</h2>
      <ul className="list">
        {[...CITY.districts.values()].map((d) => {
          const s = summaries.get(d.slug);
          return (
            <li key={d.slug}>
              <button
                type="button"
                className="link"
                onClick={() => {
                  mapBus.emit("map:focus", { kind: "district", slug: d.slug });
                  onNavigate();
                }}
              >
                {d.name}
              </button>
              <span className="muted">{s ? `${s.ownedCount}/${s.territoryCount} held` : `${d.territories.length} territories`}</span>
            </li>
          );
        })}
      </ul>
      <h3>City news</h3>
      {news.length === 0 ? (
        <p className="muted small">All quiet.</p>
      ) : (
        <ul className="news" data-testid="news">
          {news.map((e) => (
            <li key={e.id} className={e.state}>
              <strong>{e.headline}</strong>
              <p className="small">{e.body}</p>
              <p className="muted small">{e.state === "active" ? `Now · until ${when(e.expiresAt)}` : `Ended ${when(e.expiresAt)}`}</p>
            </li>
          ))}
        </ul>
      )}
      <h3>Officials</h3>
      <OfficialsList />
      <h3>Show markers</h3>
      <div className="filters">
        {TERRITORY_KINDS.map((k) => (
          <label key={k} className="check">
            <input type="checkbox" checked={kinds.has(k)} onChange={() => toggle(k)} />
            <span className="glyph">{KIND_STYLE[k].glyph}</span> {KIND_STYLE[k].label}
          </label>
        ))}
      </div>
    </section>
  );
}
