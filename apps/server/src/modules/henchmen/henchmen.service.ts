import { Inject, Injectable, Logger } from "@nestjs/common";
import { RECRUITMENT } from "@kots/content";
import { boardDay, boardResetsAt, generateBoard, moraleAfter, UPKEEP_PERIOD_MS, upkeepStatus, type Candidate } from "@kots/rules";
import type { Henchman, RecruitBoard } from "@kots/shared";
import { and, asc, count, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { CLOCK, type Clock } from "../../common/clock";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import { DB, type Database } from "../../db/db";
import { henchmen } from "../../db/schema";
import type { Tx } from "../../db/tx";
import { ActivityService } from "../activity/activity.service";
import { MembershipsService } from "../families/memberships.service";
import { InsufficientFunds, LedgerService, type PostingLine } from "../ledger/ledger.service";
import { HoldingsService } from "../territories/holdings.service";

type Row = typeof henchmen.$inferSelect;
type ActiveRow = Row & { wagePaidUntil: Date };

export interface WageSweepResult {
  paid: number;
  unpaid: number;
  deserted: number;
}

const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;
const recruitKey = (familyId: string, day: number, slot: number) => `${familyId}:${day}:${slot}`;

/**
 * NPC henchmen: the daily recruitment board, hiring, assignment, dismissal and wages.
 * Wages work like territory upkeep: paid a day at a time from the hire, settled by the worker's sweep; a henchman
 * unpaid for the grace period (48 h) deserts. Lock order: families → memberships → territories → henchmen → accounts.
 */
@Injectable()
export class HenchmenService {
  private readonly logger = new Logger(HenchmenService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly memberships: MembershipsService,
    private readonly holdings: HoldingsService,
    private readonly ledger: LedgerService,
    private readonly activity: ActivityService,
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────────

  async board(viewerId: string, familyId: string): Promise<RecruitBoard> {
    await this.memberships.requireMemberOf(viewerId, familyId);
    const day = boardDay(this.clock.now().getTime());
    const candidates = generateBoard(familyId, day);
    const keys = candidates.map((c) => recruitKey(familyId, day, c.slot));
    const hired = new Set((await this.db.select({ key: henchmen.recruitKey }).from(henchmen).where(inArray(henchmen.recruitKey, keys))).map((r) => r.key));
    return {
      day,
      resetsAt: new Date(boardResetsAt(day)).toISOString(),
      candidates: candidates.map((c) => ({ ...c, hired: hired.has(recruitKey(familyId, day, c.slot)) })),
    };
  }

  async list(viewerId: string, familyId: string): Promise<Henchman[]> {
    await this.memberships.requireMemberOf(viewerId, familyId);
    return this.activeOf(familyId);
  }

  /** A family's active henchmen. Authorisation is the caller's job. */
  async activeOf(familyId: string): Promise<Henchman[]> {
    const rows = (await this.db
      .select()
      .from(henchmen)
      .where(and(eq(henchmen.familyId, familyId), eq(henchmen.status, "active")))
      .orderBy(asc(henchmen.hiredAt))) as ActiveRow[];
    const slugs = await this.holdings.slugsOf(rows.flatMap((r) => (r.assignedTerritoryId ? [r.assignedTerritoryId] : [])));
    return rows.map((r) => this.toDto(r, r.assignedTerritoryId ? (slugs.get(r.assignedTerritoryId) ?? null) : null));
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  async hire(actorId: string, familyId: string, slot: number): Promise<Henchman> {
    const now = this.clock.now();
    const id = await this.db.transaction(async (tx) => {
      const actor = await this.memberships.lockActing(tx, actorId, { kind: "recruit_henchman" });
      if (actor.familyId !== familyId) throw forbidden("You are not a member of this family.");
      const day = boardDay(now.getTime());
      const c: Candidate | undefined = generateBoard(familyId, day)[slot];
      if (!c) throw notFound("Candidate");
      const key = recruitKey(familyId, day, slot);

      const [row] = await tx
        .insert(henchmen)
        .values({
          familyId,
          recruitKey: key,
          archetype: c.archetype,
          name: c.name,
          ...c.attributes,
          morale: RECRUITMENT.startingMorale,
          traits: c.traits,
          hireCost: c.hireCost,
          wage: c.wage,
          wagePaidUntil: new Date(now.getTime() + UPKEEP_PERIOD_MS),
          hiredAt: now,
        })
        .onConflictDoNothing({ target: henchmen.recruitKey })
        .returning({ id: henchmen.id });
      if (!row) throw conflict("ALREADY_HIRED", `${c.name} has already been hired.`);

      const lines: PostingLine[] = [{ accountId: await this.ledger.treasuryId(tx, familyId), amount: -(c.hireCost + c.wage), reason: "recruitment" }];
      if (c.hireCost > 0) lines.push({ accountId: await this.ledger.systemAccount("recruitment", tx), amount: c.hireCost, reason: "recruitment" });
      if (c.wage > 0) lines.push({ accountId: await this.ledger.systemAccount("wages", tx), amount: c.wage, reason: "wage" });
      try {
        await this.ledger.post(tx, { kind: "recruitment", idempotencyKey: `hire:${key}`, actorPlayerId: actorId, ref: { type: "henchman", id: row.id }, lines });
      } catch (err) {
        if (err instanceof InsufficientFunds) {
          throw new AppError(409, "INSUFFICIENT_FUNDS", `Hiring ${c.name} costs ${naira(c.hireCost + c.wage)}, more than the treasury holds.`);
        }
        throw err;
      }
      await this.activity.record(tx, { familyId, actorPlayerId: actorId, type: "henchman.hired", payload: { name: c.name, archetype: c.archetype, cost: c.hireCost + c.wage } });
      return row.id;
    });
    return this.one(id);
  }

  /** Assigns a henchman to guard one of the family's territories, or (territory null) makes them idle. */
  async assign(actorId: string, henchmanId: string, slug: string | null): Promise<Henchman> {
    await this.db.transaction(async (tx) => {
      const actor = await this.memberships.lockActing(tx, actorId, { kind: "assign_henchman" });
      const territoryId = slug ? await this.holdings.lockHeld(tx, slug, actor.familyId) : null;
      const h = await this.lockActive(tx, henchmanId, actor.familyId);
      this.requireNotFighting(h);
      await tx.update(henchmen).set({ assignedTerritoryId: territoryId }).where(eq(henchmen.id, h.id));
      await this.activity.record(tx, {
        familyId: actor.familyId,
        actorPlayerId: actorId,
        type: slug ? "henchman.assigned" : "henchman.unassigned",
        payload: { name: h.name, slug },
      });
    });
    return this.one(henchmanId);
  }

  async dismiss(actorId: string, henchmanId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const actor = await this.memberships.lockActing(tx, actorId, { kind: "dismiss_henchman" });
      const h = await this.lockActive(tx, henchmanId, actor.familyId);
      this.requireNotFighting(h);
      await this.leave(tx, h, "dismissed");
      await this.activity.record(tx, { familyId: actor.familyId, actorPlayerId: actorId, type: "henchman.dismissed", payload: { name: h.name } });
    });
  }

  /** Clears assignments to a territory that is changing hands. Called by TerritoriesService inside its transaction. */
  async unassignFrom(tx: Tx, territoryId: string): Promise<void> {
    await tx.update(henchmen).set({ assignedTerritoryId: null }).where(eq(henchmen.assignedTerritoryId, territoryId));
  }

  // ── Battles (called by BattlesService inside its transaction) ────────────

  /**
   * Commits the family's henchmen to a battle. Each must be active, theirs, uninjured and not in another battle.
   * Returns the side's committed count afterwards.
   */
  async commit(tx: Tx, familyId: string, ids: readonly string[], battleId: string, now: Date, max: number): Promise<number> {
    const rows = await tx
      .select()
      .from(henchmen)
      .where(and(inArray(henchmen.id, [...ids]), eq(henchmen.familyId, familyId), eq(henchmen.status, "active")))
      .orderBy(asc(henchmen.id))
      .for("update");
    if (rows.length !== new Set(ids).size) throw notFound("Henchman");
    for (const h of rows) {
      if (h.battleId && h.battleId !== battleId) throw conflict("HENCHMAN_BUSY", `${h.name} is already committed to another battle.`);
      if (h.injuredUntil && h.injuredUntil.getTime() > now.getTime()) throw conflict("HENCHMAN_BUSY", `${h.name} is injured and can't fight yet.`);
    }
    await tx.update(henchmen).set({ battleId }).where(inArray(henchmen.id, rows.map((h) => h.id)));
    const [n] = await tx
      .select({ n: count() })
      .from(henchmen)
      .where(and(eq(henchmen.battleId, battleId), eq(henchmen.familyId, familyId)));
    if (n!.n > max) throw conflict("HENCHMAN_BUSY", `A side can commit at most ${max} henchmen.`);
    return n!.n;
  }

  /** Commits the family's fit guards on a territory to the battle for it, up to `max`. */
  async commitGuards(tx: Tx, familyId: string, territoryId: string, battleId: string, now: Date, max: number): Promise<void> {
    const guards = await tx
      .select({ id: henchmen.id })
      .from(henchmen)
      .where(
        and(
          eq(henchmen.familyId, familyId),
          eq(henchmen.assignedTerritoryId, territoryId),
          eq(henchmen.status, "active"),
          isNull(henchmen.battleId),
          or(isNull(henchmen.injuredUntil), lte(henchmen.injuredUntil, now)),
        ),
      )
      .orderBy(asc(henchmen.id))
      .limit(max)
      .for("update");
    if (guards.length > 0) await tx.update(henchmen).set({ battleId }).where(inArray(henchmen.id, guards.map((g) => g.id)));
  }

  /** Releases some (or, with no ids, all) of a battle's henchmen. */
  async release(tx: Tx, battleId: string, familyId?: string, ids?: readonly string[]): Promise<void> {
    await tx
      .update(henchmen)
      .set({ battleId: null })
      .where(and(eq(henchmen.battleId, battleId), familyId ? eq(henchmen.familyId, familyId) : undefined, ids ? inArray(henchmen.id, [...ids]) : undefined));
  }

  /** A battle's committed henchmen who are still with their family, by family. Locked, in id order. */
  async committed(tx: Tx, battleId: string): Promise<Row[]> {
    return tx
      .select()
      .from(henchmen)
      .where(and(eq(henchmen.battleId, battleId), eq(henchmen.status, "active")))
      .orderBy(asc(henchmen.id))
      .for("update");
  }

  /** Marks henchmen injured until `until`. */
  async injure(tx: Tx, ids: readonly string[], until: Date): Promise<void> {
    if (ids.length > 0) await tx.update(henchmen).set({ injuredUntil: until }).where(inArray(henchmen.id, [...ids]));
  }

  /** Changes morale (clamped to 0–100) for henchmen who are still with their family. */
  async shiftMorale(tx: Tx, ids: readonly string[], delta: number): Promise<void> {
    if (ids.length === 0) return;
    await tx
      .update(henchmen)
      .set({ morale: sql`least(100, greatest(0, ${henchmen.morale} + ${delta}))` })
      .where(and(inArray(henchmen.id, [...ids]), eq(henchmen.status, "active")));
  }

  /** Active henchmen guarding any of these territories, locked, in id order. Called by EventsService. */
  async guardsOn(tx: Tx, territoryIds: readonly string[]): Promise<Row[]> {
    if (territoryIds.length === 0) return [];
    return tx
      .select()
      .from(henchmen)
      .where(and(inArray(henchmen.assignedTerritoryId, [...territoryIds]), eq(henchmen.status, "active")))
      .orderBy(asc(henchmen.id))
      .for("update");
  }

  /** A family's henchmen committed to a battle, unlocked, for display. */
  async committedView(battleId: string, familyId: string): Promise<Row[]> {
    return this.db
      .select()
      .from(henchmen)
      .where(and(eq(henchmen.battleId, battleId), eq(henchmen.familyId, familyId)))
      .orderBy(asc(henchmen.id));
  }

  async committedCount(battleId: string, familyId: string): Promise<number> {
    const [n] = await this.db
      .select({ n: count() })
      .from(henchmen)
      .where(and(eq(henchmen.battleId, battleId), eq(henchmen.familyId, familyId)));
    return n!.n;
  }

  /** Henchmen by id (any status), for battle reports. */
  async byIds(ids: readonly string[]): Promise<Row[]> {
    if (ids.length === 0) return [];
    return this.db.select().from(henchmen).where(inArray(henchmen.id, [...ids]));
  }

  /** Everyone leaves a disbanded family. Called by FamiliesService inside its transaction. */
  async dismissAll(tx: Tx, familyId: string): Promise<void> {
    const rows = (await tx
      .select()
      .from(henchmen)
      .where(and(eq(henchmen.familyId, familyId), eq(henchmen.status, "active")))
      .orderBy(asc(henchmen.id))
      .for("update")) as ActiveRow[];
    for (const h of rows) await this.leave(tx, h, "dismissed");
  }

  /** Settles wages that have fallen due. Same shape and guarantees as TerritoriesService.sweepUpkeep. */
  async sweepWages(now: Date = this.clock.now(), limit = 1000): Promise<WageSweepResult> {
    const result: WageSweepResult = { paid: 0, unpaid: 0, deserted: 0 };
    for (let i = 0; i < limit; i++) {
      const outcome = await this.db.transaction(async (tx) => {
        const [h] = await tx
          .select()
          .from(henchmen)
          .where(
            and(
              eq(henchmen.status, "active"),
              lte(henchmen.wagePaidUntil, now),
              or(isNull(henchmen.lastEvaluatedAt), lt(henchmen.lastEvaluatedAt, now)),
            ),
          )
          .orderBy(asc(henchmen.wagePaidUntil))
          .limit(1)
          .for("update", { skipLocked: true });
        return h ? this.settle(tx, h as ActiveRow, now) : null;
      });
      if (!outcome) break;
      result[outcome]++;
    }
    if (result.paid + result.unpaid + result.deserted > 0) this.logger.log(`wage sweep: ${JSON.stringify(result)}`);
    return result;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async settle(tx: Tx, h: ActiveRow, now: Date): Promise<keyof WageSweepResult> {
    const treasury = await this.ledger.treasuryId(tx, h.familyId);
    const wages = await this.ledger.systemAccount("wages", tx);
    let paidUntil = h.wagePaidUntil;
    let morale = h.morale;
    let overdue = h.wageOverdue;
    while (paidUntil.getTime() <= now.getTime()) {
      try {
        if (h.wage > 0) {
          await tx.transaction((sp) =>
            this.ledger.post(sp, {
              kind: "wage",
              idempotencyKey: `wage:${h.id}:${paidUntil.toISOString()}`,
              ref: { type: "henchman", id: h.id },
              lines: [
                { accountId: treasury, amount: -h.wage, reason: "wage" },
                { accountId: wages, amount: h.wage, reason: "wage" },
              ],
            }),
          );
        }
      } catch (err) {
        if (!(err instanceof InsufficientFunds)) throw err;
        if (upkeepStatus(paidUntil.getTime(), now.getTime()) === "lapsed") {
          await this.leave(tx, h, "deserted");
          await this.activity.record(tx, { familyId: h.familyId, actorPlayerId: null, type: "henchman.deserted", payload: { name: h.name } });
          return "deserted";
        }
        const firstMiss = !overdue;
        await tx
          .update(henchmen)
          .set({ wagePaidUntil: paidUntil, wageOverdue: true, morale: firstMiss ? moraleAfter(morale, false) : morale, lastEvaluatedAt: now })
          .where(eq(henchmen.id, h.id));
        if (firstMiss) {
          await this.activity.record(tx, { familyId: h.familyId, actorPlayerId: null, type: "henchman.unpaid", payload: { name: h.name, wage: h.wage } });
        }
        return "unpaid";
      }
      paidUntil = new Date(paidUntil.getTime() + UPKEEP_PERIOD_MS);
      morale = moraleAfter(morale, true);
      overdue = false;
    }
    await tx.update(henchmen).set({ wagePaidUntil: paidUntil, wageOverdue: false, morale, lastEvaluatedAt: now }).where(eq(henchmen.id, h.id));
    return "paid";
  }

  private async leave(tx: Tx, h: Row, status: "deserted" | "dismissed"): Promise<void> {
    await tx
      .update(henchmen)
      .set({ status, assignedTerritoryId: null, battleId: null, wagePaidUntil: null, wageOverdue: false, leftAt: this.clock.now() })
      .where(eq(henchmen.id, h.id));
  }

  private requireNotFighting(h: Row): void {
    if (h.battleId) throw conflict("HENCHMAN_BUSY", `${h.name} is committed to a battle until it ends.`);
  }

  private async lockActive(tx: Tx, henchmanId: string, familyId: string): Promise<ActiveRow> {
    const [h] = await tx
      .select()
      .from(henchmen)
      .where(and(eq(henchmen.id, henchmanId), eq(henchmen.familyId, familyId), eq(henchmen.status, "active")))
      .for("update");
    if (!h) throw notFound("Henchman");
    return h as ActiveRow;
  }

  private async one(id: string): Promise<Henchman> {
    const [h] = (await this.db.select().from(henchmen).where(eq(henchmen.id, id))) as ActiveRow[];
    const slug = h!.assignedTerritoryId ? ((await this.holdings.slugsOf([h!.assignedTerritoryId])).get(h!.assignedTerritoryId) ?? null) : null;
    return this.toDto(h!, slug);
  }

  private toDto(h: ActiveRow, assignedTo: string | null): Henchman {
    return {
      id: h.id,
      archetype: h.archetype,
      name: h.name,
      attributes: {
        combat: h.combat,
        leadership: h.leadership,
        discipline: h.discipline,
        negotiation: h.negotiation,
        logistics: h.logistics,
        reliability: h.reliability,
        loyalty: h.loyalty,
      },
      traits: h.traits,
      morale: h.morale,
      wage: h.wage,
      wagePaidUntil: h.wagePaidUntil.toISOString(),
      wageOverdue: h.wageOverdue,
      assignedTo,
      hiredAt: h.hiredAt.toISOString(),
      injuredUntil: h.injuredUntil?.toISOString() ?? null,
      battleId: h.battleId,
    };
  }
}
