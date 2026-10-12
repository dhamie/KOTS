import type { TerritoryKind } from "@kots/content";
import type { TerritoryState } from "@kots/shared";

/** Messages between React (panels, data) and Phaser (the map). Phaser never fetches; React never draws the map. */
export interface MapEvents {
  /** The player clicked a territory (or cleared the selection). Emitted by the map. */
  "territory:clicked": { slug: string } | null;
  /** Select (highlight) a territory, or clear. Emitted by React. */
  "territory:select": { slug: string } | null;
  /** Move the camera to a territory or district. */
  "map:focus": { kind: "territory" | "district"; slug: string };
  /** The districts on screen changed, or the zoom crossed the marker threshold. */
  "viewport:changed": { districts: string[]; mode: "districts" | "territories" };
  /** Latest runtime state for some territories. */
  "territories:state": ReadonlyMap<string, TerritoryState>;
  /** Kinds whose markers are shown. */
  "markers:filter": ReadonlySet<TerritoryKind>;
  "map:ready": undefined;
}

type Handler<T> = (payload: T) => void;

export class MapBus {
  private handlers = new Map<keyof MapEvents, Set<Handler<never>>>();

  on<K extends keyof MapEvents>(event: K, handler: Handler<MapEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  emit<K extends keyof MapEvents>(event: K, payload: MapEvents[K]): void {
    for (const h of this.handlers.get(event) ?? []) (h as Handler<MapEvents[K]>)(payload);
  }
}

/** One map per page, so one shared bus. */
export const mapBus = new MapBus();
