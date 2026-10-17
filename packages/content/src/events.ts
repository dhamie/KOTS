import type { GoodKey } from "./goods";
import type { Office, OfficialTrait } from "./officials";

/**
 * City events (Phase 8). Every event is fictional and abstract. Formulas that use these live in
 * packages/rules/src/events.ts; see docs/EVENTS.md.
 */
export const EVENT_TYPES = ["port_congestion", "fuel_scarcity", "street_festival", "police_sweep"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** What an event covers: one market, one district, or the whole city. */
export const EVENT_SCOPES = ["market", "district", "city"] as const;
export type EventScope = (typeof EVENT_SCOPES)[number];

interface EventBase {
  label: string;
  scope: EventScope;
  /** Relative chance of being picked when the city rolls an event. */
  weight: number;
  /** How long it is shown as current news. Its effect is applied once, when it starts. */
  durationHours: number;
  /** After one starts, no other event of the same type is rolled for this long. */
  cooldownHours: number;
}

/** Which official's traits make a district event more likely in their district. */
export interface Sway {
  office: Office;
  traits: readonly OfficialTrait[];
}

export const EVENT_DEFS = {
  /** One market's stock of one good drops to a fraction of what it was; market drift brings it back. */
  port_congestion: {
    label: "Port congestion",
    scope: "market",
    weight: 3,
    durationHours: 6,
    cooldownHours: 12,
    goods: ["imported_goods", "electronics", "textiles"] as readonly GoodKey[],
    /** Stock left, in percent, picked in this range. */
    stockLeftPct: [30, 50],
  },
  /** Every market's fuel stock drops to a fraction of what it was. */
  fuel_scarcity: { label: "Fuel scarcity", scope: "city", weight: 2, durationHours: 8, cooldownHours: 24, stockLeftPct: [40, 60] },
  /** Each family holding territory in the district is paid this many days of base income per territory there. */
  street_festival: {
    label: "Street festival",
    scope: "district",
    weight: 2,
    durationHours: 6,
    cooldownHours: 24,
    incomeDays: 1,
    /** A district's chance grows with its Area Chairman's ambition (see OFFICIALS_TUNING.baseSway). */
    swayedBy: { office: "area_chairman", traits: ["ambition"] } as Sway,
  },
  /** Henchmen guarding territories in the district lose this much morale, picked in this range. */
  police_sweep: {
    label: "Police sweep",
    scope: "district",
    weight: 2,
    durationHours: 6,
    cooldownHours: 18,
    moraleLoss: [5, 10],
    /** A district's chance grows with its Area Commander's ambition and integrity. */
    swayedBy: { office: "area_commander", traits: ["ambition", "integrity"] } as Sway,
  },
} as const satisfies Record<EventType, EventBase & Record<string, unknown>>;

export const EVENTS = {
  /** Chance, in percent, that the hourly roll starts an event. */
  chancePerHourPct: 25,
  /** No event is rolled while this many are current. */
  maxActive: 2,
  /** Ended events stay in the city news for this long. */
  newsHours: 24,
} as const;
