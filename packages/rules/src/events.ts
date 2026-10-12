import { DISTRICTS, EVENT_DEFS, EVENT_TYPES, EVENTS, MARKETS, type EventType, type GoodKey } from "@kots/content";
import { createRng, nextInt, nextUint32, type RngState } from "./rng";

const HOUR_MS = 60 * 60 * 1000;

/** An event's effect, decided when it is created. `scopeId` is a market or district slug (null for the whole city). */
export type PlannedEvent =
  | { type: "port_congestion"; scopeId: string; good: GoodKey; stockLeftPct: number }
  | { type: "fuel_scarcity"; scopeId: null; stockLeftPct: number }
  | { type: "street_festival"; scopeId: string; incomeDays: number }
  | { type: "police_sweep"; scopeId: string; moraleLoss: number };

/** An event that already started, for cooldowns. */
export interface PastEvent {
  type: EventType;
  startsAtMs: number;
}

export const eventDurationMs = (type: EventType) => EVENT_DEFS[type].durationHours * HOUR_MS;

/** The slugs an event of this type can cover: markets, districts, or none (the whole city). */
export function eventScopeIds(type: EventType): string[] {
  const scope = EVENT_DEFS[type].scope;
  if (scope === "market") return MARKETS.map((m) => m.territory);
  if (scope === "district") return DISTRICTS.map((d) => d.slug);
  return [];
}

const pick = <T>(rng: RngState, list: readonly T[]): T => list[nextInt(rng, 0, list.length - 1)]!;
const inRange = (rng: RngState, [min, max]: readonly [number, number]) => nextInt(rng, min, max);

/**
 * Decides where an event lands and how strong it is. `scopeId` fixes the place (it must be one of
 * eventScopeIds(type)); otherwise one is picked. Same type, seed and scope, same event.
 */
export function planEvent(type: EventType, seed: number, scopeId?: string): PlannedEvent {
  const rng = createRng(seed);
  const ids = eventScopeIds(type);
  if (scopeId !== undefined && !ids.includes(scopeId)) throw new RangeError(`${type} can't cover ${scopeId}`);
  const place = scopeId ?? (ids.length > 0 ? pick(rng, ids) : null);
  switch (type) {
    case "port_congestion": {
      const def = EVENT_DEFS.port_congestion;
      return { type, scopeId: place!, good: pick(rng, def.goods), stockLeftPct: inRange(rng, def.stockLeftPct) };
    }
    case "fuel_scarcity":
      return { type, scopeId: null, stockLeftPct: inRange(rng, EVENT_DEFS.fuel_scarcity.stockLeftPct) };
    case "street_festival":
      return { type, scopeId: place!, incomeDays: EVENT_DEFS.street_festival.incomeDays };
    case "police_sweep":
      return { type, scopeId: place!, moraleLoss: inRange(rng, EVENT_DEFS.police_sweep.moraleLoss) };
  }
}

/** Types whose cooldown has passed at `nowMs`. */
export function eligibleTypes(nowMs: number, past: readonly PastEvent[]): EventType[] {
  return EVENT_TYPES.filter((type) => !past.some((e) => e.type === type && nowMs - e.startsAtMs < EVENT_DEFS[type].cooldownHours * HOUR_MS));
}

/**
 * The hourly roll: with EVENTS.chancePerHourPct, and while fewer than EVENTS.maxActive events are current, picks
 * one type whose cooldown has passed (by weight) and plans it. Same inputs, same result.
 */
export function rollEvent(seed: number, nowMs: number, past: readonly PastEvent[], activeCount: number): PlannedEvent | null {
  const rng = createRng(seed);
  if (nextInt(rng, 0, 99) >= EVENTS.chancePerHourPct || activeCount >= EVENTS.maxActive) return null;
  const types = eligibleTypes(nowMs, past);
  const total = types.reduce((s, t) => s + EVENT_DEFS[t].weight, 0);
  if (total === 0) return null;
  let roll = nextInt(rng, 0, total - 1);
  const type = types.find((t) => (roll -= EVENT_DEFS[t].weight) < 0)!;
  return planEvent(type, nextUint32(rng));
}
