import { MARKETS } from "@kots/content";
import type { WorldEvent } from "@kots/shared";
import { useEffect, useState } from "react";
import { api } from "../../api/http";
import { onLive } from "../../api/live";

/** The city news (current events, then recent ones), reloaded whenever the server says an event started or ended. */
export function useCityNews(): WorldEvent[] {
  const [news, setNews] = useState<WorldEvent[]>([]);
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .events()
        .then((list) => live && setNews(list))
        .catch(() => undefined);
    void load();
    const off = onLive((e) => {
      if (e.type === "events.changed" || e.type === "resync") void load();
    });
    return () => {
      live = false;
      off();
    };
  }, []);
  return news;
}

/** Current events that bear on a territory: its district's, its market's, and city-wide ones if it has a market. */
export function eventsAt(news: readonly WorldEvent[], slug: string, district: string): WorldEvent[] {
  const market = MARKETS.some((m) => m.territory === slug);
  return news.filter(
    (e) =>
      e.state === "active" && ((e.scope === "district" && e.scopeId === district) || (e.scope === "market" && e.scopeId === slug) || (e.scope === "city" && market)),
  );
}
