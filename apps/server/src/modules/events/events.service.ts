import { Inject, Injectable, Logger } from "@nestjs/common";
import { CITY, EVENT_DEFS, EVENT_TYPES, EVENTS, MARKETS } from "@kots/content";
import { eventDurationMs, goodDef, rollEvent, type PlannedEvent } from "@kots/rules";
import type { WorldEvent } from "@kots/shared";
import { and, asc, count, desc, eq, gt, inArray, lte } from "drizzle-orm";
import { randomInt } from "node:crypto";
import { CLOCK, type Clock } from "../../common/clock";
import { DB, type Database } from "../../db/db";
import { worldEvents } from "../../db/schema";
import type { Tx } from "../../db/tx";
import { ActivityService } from "../activity/activity.service";
import { HenchmenService } from "../henchmen/henchmen.service";
import { LedgerService } from "../ledger/ledger.service";
import { MarketService } from "../market/market.service";
import { RealtimeService, rooms } from "../realtime/realtime.service";
import { HoldingsService } from "../territories/holdings.service";

type Row = typeof worldEvents.$inferSelect;

const HOUR_MS = 60 * 60 * 1000;
const placeName = (slug: string) => CITY.territories.get(slug)?.name ?? slug;
const districtName = (slug: string) => CITY.districts.get(slug)?.name ?? slug;
/** Cooldowns reach back at most this far, so the roll only needs events that started since. */
const LOOKBACK_MS = Math.max(...EVENT_TYPES.map((t) => EVENT_DEFS[t].cooldownHours)) * HOUR_MS;

/** The world_events row for a planned event. Used by the hourly roll and by `npm run event:trigger`. */
export function eventRow(plan: PlannedEvent, seed: number, startsAt: Date, dedupeKey: string): typeof worldEvents.$inferInsert {
  return {
    type: plan.type,
    scope: EVENT_DEFS[plan.type].scope,
    scopeId: plan.scopeId,
    seed,
    startsAt,
    expiresAt: new Date(startsAt.getTime() + eventDurationMs(plan.type)),
    payload: plan as unknown as Record<string, unknown>,
    dedupeKey,
  };
}

/** The news text for an event. */
function story(plan: PlannedEvent): { headline: string; body: string } {
  switch (plan.type) {
    case "port_congestion": {
      const good = goodDef(plan.good).label.toLowerCase();
      return {
        headline: `Port congestion hits ${placeName(plan.scopeId)}`,
        body: `Ships are stuck in the queue: the market's ${good} stock fell to ${plan.stockLeftPct}% and prices are up until supply recovers.`,
      };
    }
    case "fuel_scarcity":
      return { headline: "Fuel scarcity across the city", body: `Every market's fuel stock fell to ${plan.stockLeftPct}%. Prices are up until supply recovers.` };
    case "street_festival":
      return {
        headline: `Street festival in ${districtName(plan.scopeId)}`,
        body: `The district is celebrating. Every family holding territory there took ${plan.incomeDays === 1 ? "a day's" : `${plan.incomeDays} days'`} income per territory.`,
      };
    case "police_sweep":
      return {
        headline: `Police sweep in ${districtName(plan.scopeId)}`,
        body: `A sweep through the district rattled the families' guards there: each lost ${plan.moraleLoss} morale.`,
      };
  }
}

/**
 * City events (Phase 8). The worker rolls for a new one every hour and starts due ones every minute. Starting an
 * event is a conditional transition (scheduled → active) that applies its effect in the same transaction, through
 * the services that own the data, so a retried or overlapping sweep applies nothing twice.
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly ledger: LedgerService,
    private readonly holdings: HoldingsService,
    private readonly henchmen: HenchmenService,
    private readonly market: MarketService,
    private readonly activity: ActivityService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Current events, then those that ended within EVENTS.newsHours, newest first. */
  async news(now: Date = this.clock.now()): Promise<WorldEvent[]> {
    const rows = await this.db
      .select()
      .from(worldEvents)
      .where(and(inArray(worldEvents.state, ["active", "expired"]), gt(worldEvents.expiresAt, new Date(now.getTime() - EVENTS.newsHours * HOUR_MS))))
      .orderBy(desc(worldEvents.startsAt))
      .limit(20);
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      scope: r.scope,
      scopeId: r.scopeId,
      state: r.state === "active" ? "active" : "expired",
      ...story(r.payload as unknown as PlannedEvent),
      startsAt: r.startsAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
    }));
  }

  /**
   * The hourly roll (rules `rollEvent`). An event it creates starts now; the key `generate:{hour}` means a retried
   * run in the same hour can't add a second. Returns the new event's id, or null.
   */
  async generate(now: Date = this.clock.now(), seed: number = randomInt(2 ** 32)): Promise<string | null> {
    const past = await this.db
      .select({ type: worldEvents.type, startsAt: worldEvents.startsAt })
      .from(worldEvents)
      .where(gt(worldEvents.startsAt, new Date(now.getTime() - LOOKBACK_MS)));
    const [current] = await this.db
      .select({ n: count() })
      .from(worldEvents)
      .where(inArray(worldEvents.state, ["scheduled", "active"]));
    const plan = rollEvent(
      seed,
      now.getTime(),
      past.map((e) => ({ type: e.type, startsAtMs: e.startsAt.getTime() })),
      current!.n,
    );
    if (!plan) return null;
    const [row] = await this.db
      .insert(worldEvents)
      .values(eventRow(plan, seed, now, `generate:${Math.floor(now.getTime() / HOUR_MS)}`))
      .onConflictDoNothing({ target: worldEvents.dedupeKey })
      .returning({ id: worldEvents.id });
    if (row) this.logger.log(`event ${plan.type} ${plan.scopeId ?? "city"} scheduled`);
    return row?.id ?? null;
  }

  /** Starts events that are due (applying their effects) and ends those whose time is up. */
  async sweep(now: Date = this.clock.now(), limit = 20): Promise<{ started: number; ended: number }> {
    const due = await this.db
      .select({ id: worldEvents.id })
      .from(worldEvents)
      .where(and(eq(worldEvents.state, "scheduled"), lte(worldEvents.startsAt, now)))
      .orderBy(asc(worldEvents.startsAt))
      .limit(limit);
    let started = 0;
    for (const { id } of due) {
      try {
        if (await this.db.transaction((tx) => this.start(tx, id, now))) started++;
      } catch (err) {
        // One bad event must not stop the others; it is retried on the next sweep.
        this.logger.error(`event ${id}: ${(err as Error).message}`);
      }
    }
    const ended = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(worldEvents)
        .set({ state: "expired" })
        .where(and(eq(worldEvents.state, "active"), lte(worldEvents.expiresAt, now)))
        .returning({ id: worldEvents.id });
      if (rows.length > 0) await this.realtime.publish(tx, [rooms.public], { type: "events.changed" });
      return rows.length;
    });
    if (started + ended > 0) this.logger.log(`event sweep: ${started} started, ${ended} ended`);
    return { started, ended };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** scheduled → active, with its effect. Returns false if another sweep got there first. */
  private async start(tx: Tx, id: string, now: Date): Promise<boolean> {
    const [e] = await tx
      .update(worldEvents)
      .set({ state: "active" })
      .where(and(eq(worldEvents.id, id), eq(worldEvents.state, "scheduled")))
      .returning();
    if (!e) return false;
    await this.apply(tx, e, now);
    await this.realtime.publish(tx, [rooms.public], { type: "events.changed" });
    return true;
  }

  private async apply(tx: Tx, e: Row, now: Date): Promise<void> {
    const plan = e.payload as unknown as PlannedEvent;
    switch (plan.type) {
      case "port_congestion":
        return this.market.shock(tx, [plan.scopeId], plan.good, plan.stockLeftPct, now);
      case "fuel_scarcity":
        return this.market.shock(
          tx,
          MARKETS.map((m) => m.territory),
          "fuel",
          plan.stockLeftPct,
          now,
        );
      case "street_festival":
        return this.festival(tx, e.id, plan);
      case "police_sweep":
        return this.policeSweep(tx, plan);
    }
  }

  /** Pays each family holding territory in the district, from the `events` system account. */
  private async festival(tx: Tx, eventId: string, plan: Extract<PlannedEvent, { type: "street_festival" }>): Promise<void> {
    const held = await this.holdings.lockHeldAmong(tx, CITY.districts.get(plan.scopeId)?.territories ?? []);
    const owed = new Map<string, { amount: number; territories: number }>();
    for (const t of held) {
      const o = owed.get(t.owner) ?? { amount: 0, territories: 0 };
      owed.set(t.owner, { amount: o.amount + t.baseIncome * plan.incomeDays, territories: o.territories + 1 });
    }
    const source = await this.ledger.systemAccount("events", tx);
    const payees: { familyId: string; treasury: string }[] = [];
    for (const familyId of owed.keys()) payees.push({ familyId, treasury: await this.ledger.treasuryId(tx, familyId) });
    // Treasuries in id order: the ledger's lock order.
    for (const { familyId, treasury } of payees.sort((a, b) => (a.treasury < b.treasury ? -1 : 1))) {
      const { amount, territories } = owed.get(familyId)!;
      if (amount === 0) continue;
      const posted = await this.ledger.post(tx, {
        kind: "event",
        idempotencyKey: `event:${eventId}:${familyId}`,
        ref: { type: "world_event", id: eventId },
        lines: [
          { accountId: treasury, amount, reason: "event_windfall" },
          { accountId: source, amount: -amount, reason: "event_windfall" },
        ],
      });
      if (posted === "posted") {
        await this.activity.record(tx, {
          familyId,
          actorPlayerId: null,
          type: "event.festival",
          payload: { district: districtName(plan.scopeId), amount, territories },
        });
      }
    }
  }

  /** Henchmen guarding territory in the district lose morale. */
  private async policeSweep(tx: Tx, plan: Extract<PlannedEvent, { type: "police_sweep" }>): Promise<void> {
    const ids = await this.holdings.idsOf(CITY.districts.get(plan.scopeId)?.territories ?? [], tx);
    const guards = await this.henchmen.guardsOn(tx, [...ids.values()]);
    await this.henchmen.shiftMorale(
      tx,
      guards.map((g) => g.id),
      -plan.moraleLoss,
    );
    const byFamily = new Map<string, number>();
    for (const g of guards) byFamily.set(g.familyId, (byFamily.get(g.familyId) ?? 0) + 1);
    for (const [familyId, henchmen] of [...byFamily].sort(([a], [b]) => (a < b ? -1 : 1))) {
      await this.activity.record(tx, {
        familyId,
        actorPlayerId: null,
        type: "event.police_sweep",
        payload: { district: districtName(plan.scopeId), henchmen, morale: plan.moraleLoss },
      });
    }
  }
}
