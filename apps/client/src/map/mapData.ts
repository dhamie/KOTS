import type { TerritoryState } from "@kots/shared";
import { api } from "../api/http";
import { mapBus } from "./bus";

/** A district's state is refetched when it comes back into view after this long. */
const STALE_MS = 60_000;

/**
 * Runtime territory state, loaded one district at a time as districts come into view.
 * Owns no rendering: it publishes merged state on the bus for both the map and the panels.
 */
export class MapDataCache {
  private fetchedAt = new Map<string, number>();
  private inFlight = new Set<string>();
  private states = new Map<string, TerritoryState>();

  constructor(private readonly load = api.districtTerritories) {}

  get(slug: string): TerritoryState | undefined {
    return this.states.get(slug);
  }

  /** Loads any of these districts that are missing or stale. */
  async ensure(districts: readonly string[], now = Date.now()): Promise<void> {
    const due = districts.filter((d) => !this.inFlight.has(d) && now - (this.fetchedAt.get(d) ?? -Infinity) > STALE_MS);
    await Promise.all(
      due.map(async (d) => {
        this.inFlight.add(d);
        try {
          const res = await this.load(d);
          for (const t of res.territories) this.states.set(t.slug, t);
          this.fetchedAt.set(d, now);
          mapBus.emit("territories:state", this.states);
        } finally {
          this.inFlight.delete(d);
        }
      }),
    );
  }

  /** Reloads one district now, e.g. after a claim changed who holds a territory in it. */
  async refresh(district: string): Promise<void> {
    this.fetchedAt.delete(district);
    await this.ensure([district]);
  }

  /** Forget everything (e.g. after logout or a change that affects ownership). */
  clear(): void {
    this.fetchedAt.clear();
    this.states.clear();
  }
}

export const mapData = new MapDataCache();
