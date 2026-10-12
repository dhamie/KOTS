import { CITY } from "@kots/content";
import type { TerritoryState } from "@kots/shared";
import { useEffect, useRef, useState } from "react";
import { mapBus } from "../../map/bus";
import { mapData } from "../../map/mapData";

const slugFromHash = (): string | null => {
  const m = /^#t=([a-z0-9-]+)$/.exec(window.location.hash);
  return m && CITY.territories.has(m[1]!) ? m[1]! : null;
};

/**
 * Connects React state to the map: loads territory state for the districts on screen (when signed in),
 * tracks the selected territory, and keeps it in the URL as #t=<slug> so links can open the map on a place.
 */
export function useMapSync(signedIn: boolean) {
  const [selected, setSelected] = useState<string | null>(slugFromHash);
  const [states, setStates] = useState<ReadonlyMap<string, TerritoryState>>(new Map());
  const visible = useRef<string[]>([]);
  const signedInRef = useRef(signedIn);
  signedInRef.current = signedIn;

  // Selection → map highlight and URL.
  useEffect(() => {
    mapBus.emit("territory:select", selected ? { slug: selected } : null);
    const hash = selected ? `#t=${selected}` : "";
    if (window.location.hash !== hash) history.replaceState(null, "", hash || window.location.pathname + window.location.search);
  }, [selected]);

  useEffect(() => {
    const offs = [
      mapBus.on("territory:clicked", (c) => setSelected(c?.slug ?? null)),
      mapBus.on("territories:state", (s) => setStates(new Map(s))),
      mapBus.on("viewport:changed", (v) => {
        visible.current = v.districts;
        if (signedInRef.current) void mapData.ensure(v.districts).catch(() => undefined);
      }),
      // The map loads lazily: when it's ready, replay the selection (and focus a deep-linked territory).
      mapBus.on("map:ready", () => {
        const slug = slugFromHash();
        if (slug) {
          setSelected(slug);
          mapBus.emit("territory:select", { slug });
          mapBus.emit("map:focus", { kind: "territory", slug });
        }
      }),
    ];
    const onHash = () => {
      const slug = slugFromHash();
      if (!slug) return;
      setSelected(slug);
      mapBus.emit("map:focus", { kind: "territory", slug });
    };
    window.addEventListener("hashchange", onHash);
    return () => {
      offs.forEach((off) => off());
      window.removeEventListener("hashchange", onHash);
    };
  }, []);

  // Signing in loads whatever is already on screen; signing out forgets it.
  useEffect(() => {
    if (signedIn) void mapData.ensure(visible.current).catch(() => undefined);
    else {
      mapData.clear();
      setStates(new Map());
    }
  }, [signedIn]);

  return { selected, setSelected, states };
}
