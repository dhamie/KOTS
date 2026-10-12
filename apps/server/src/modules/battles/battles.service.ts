import { Inject, Injectable, Logger } from "@nestjs/common";
import { BATTLES, CITY, DEFAULT_TACTIC, type Tactic } from "@kots/content";
import {
  battleOver,
  battleWinner,
  checkDeclaration,
  checkFamilyAction,
  declarationFee,
  INJURY_MS,
  initialState,
  PAIR_COOLDOWN_MS,
  PREPARATION_MS,
  resolveRound,
  ROUND_MS,
  type BattleState,
  type DeclarationRefusal,
  type Fighter,
  type RoundResult,
  type Side,
} from "@kots/rules";
import type { AttackQuote, AttackRefusal, Battle, BattleSummary } from "@kots/shared";
import { and, asc, desc, eq, gt, inArray, lte, or } from "drizzle-orm";
import { randomInt } from "node:crypto";
import { CLOCK, type Clock } from "../../common/clock";
import { AppError, badRequest, conflict, forbidden, notFound, uniqueViolation } from "../../common/errors";
import { uuidv7 } from "../../common/uuid";
import { DB, type Database } from "../../db/db";
import { battleOrders, battleRounds, battles, territories } from "../../db/schema";
import type { DbOrTx, Tx } from "../../db/tx";
import { ActivityService } from "../activity/activity.service";
import { DiplomacyService } from "../diplomacy/diplomacy.service";
import { MembershipsService, type FamilyFacts } from "../families/memberships.service";
import { HenchmenService } from "../henchmen/henchmen.service";
import { InsufficientFunds, LedgerService } from "../ledger/ledger.service";
import { HoldingsService } from "../territories/holdings.service";
import { TerritoriesService } from "../territories/territories.service";

type BattleRow = typeof battles.$inferSelect;
type HenchmanRow = Awaited<ReturnType<HenchmenService["committed"]>>[number];

const LIVE = ["preparing", "active"] as const;
const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;
const placeName = (slug: string) => CITY.territories.get(slug)?.name ?? slug;

const REFUSAL: Record<DeclarationRefusal, [code: ConstructorParameters<typeof AppError>[1], message: string]> = {
  not_adjacent: ["NOT_ADJACENT", "You can only attack a territory that borders land your family holds."],
  last_territory: ["LAST_TERRITORY", "That is the family's last territory; a family's last territory can't be attacked."],
  attacker_protected: ["PROTECTED", `Your family can't start battles until it is ${BATTLES.protectionDays} days old.`],
  defender_protected: ["PROTECTED", `That family is under new-family protection until it is ${BATTLES.protectionDays} days old.`],
  ceasefire: ["CEASEFIRE", "Your families have a ceasefire in force."],
  cooldown: ["BATTLE_COOLDOWN", `Your families fought within the last ${BATTLES.pairCooldownHours} hours.`],
};

const fighterOf = (h: HenchmanRow): Fighter => ({ id: h.id, combat: h.combat, leadership: h.leadership, discipline: h.discipline, morale: h.morale });

/**
 * Battles for a territory between its holder and an attacking family. Declaring locks both families, then the
 * territory; every round is resolved by the worker's sweep, which locks both families, then the battle, territory,
 * henchmen and treasuries. The rules (packages/rules/src/battles.ts) are pure and replayable from the stored inputs.
 */
@Injectable()
export class BattlesService {
  private readonly logger = new Logger(BattlesService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly memberships: MembershipsService,
    private readonly holdings: HoldingsService,
    private readonly territories: TerritoriesService,
    private readonly henchmen: HenchmenService,
    private readonly ledger: LedgerService,
    private readonly activity: ActivityService,
    private readonly diplomacy: DiplomacyService,
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────────

  async list(viewerId: string, familyId: string): Promise<BattleSummary[]> {
    await this.memberships.requireMemberOf(viewerId, familyId);
    const rows = await this.db
      .select()
      .from(battles)
      .where(or(eq(battles.attackerFamilyId, familyId), eq(battles.defenderFamilyId, familyId)))
      .orderBy(desc(battles.declaredAt))
      .limit(20);
    return this.summaries(rows, familyId);
  }

  async get(viewerId: string, battleId: string): Promise<Battle> {
    const [b] = await this.db.select().from(battles).where(eq(battles.id, battleId));
    const member = await this.memberships.memberOf(viewerId);
    if (!b || !member || (member.familyId !== b.attackerFamilyId && member.familyId !== b.defenderFamilyId)) throw notFound("Battle");
    const side: Side = member.familyId === b.attackerFamilyId ? "attacker" : "defender";
    const [summary] = await this.summaries([b], member.familyId);
    const now = this.clock.now();

    // Live: who is committed now. Over: who started.
    const live = (LIVE as readonly string[]).includes(b.status);
    const initial = b.initialState as BattleState | null;
    const state = b.state as BattleState | null;
    const myIds = live ? null : (initial?.fit[side].map((f) => f.id) ?? []);
    const mine = live ? await this.henchmen.committedView(b.id, member.familyId) : await this.henchmen.byIds(myIds!);
    const injured = new Set(state?.injured[side] ?? []);
    const enemyCommitted = live ? await this.henchmen.committedCount(b.id, side === "attacker" ? b.defenderFamilyId : b.attackerFamilyId) : (initial?.fit[side === "attacker" ? "defender" : "attacker"].length ?? 0);
    const [order] = live
      ? await this.db
          .select({ tactic: battleOrders.tactic })
          .from(battleOrders)
          .where(and(eq(battleOrders.battleId, b.id), eq(battleOrders.roundNo, b.currentRound + 1), eq(battleOrders.side, side)))
      : [];
    const rounds = await this.db.select().from(battleRounds).where(eq(battleRounds.battleId, b.id)).orderBy(asc(battleRounds.roundNo));
    return {
      ...summary!,
      committed: mine.map((h) => ({
        id: h.id,
        name: h.name,
        archetype: h.archetype,
        combat: h.combat,
        leadership: h.leadership,
        discipline: h.discipline,
        morale: h.morale,
        injured: injured.has(h.id) || (h.injuredUntil !== null && h.injuredUntil.getTime() > now.getTime()),
      })),
      enemyCommitted,
      nextOrder: order?.tactic ?? null,
      report: rounds.map((r) => {
        const x = r.result as unknown as RoundResult;
        return {
          round: x.round,
          tactics: x.tactics,
          fighters: x.fighters,
          roll: x.roll,
          strength: x.strength,
          winner: x.winner,
          injured: { attacker: x.injured.attacker.length, defender: x.injured.defender.length },
        };
      }),
    };
  }

  /** Whether the viewer's family could declare on `slug` now, and the fee. The same checks `declare` makes, unlocked. */
  async attackQuote(viewerId: string, slug: string): Promise<AttackQuote> {
    const target = await this.holdings.ownerOf(slug);
    if (!target) throw notFound("Territory");
    const fee = declarationFee(target.baseUpkeep);
    const quote = (refusal: AttackRefusal | null): AttackQuote => ({ fee, refusal });
    const viewer = await this.memberships.memberOf(viewerId);
    if (!viewer) return quote("not_in_family");
    if (!checkFamilyAction(viewer.role, { kind: "declare_battle" }).ok) return quote("missing_permission");
    if (!target.owner || target.owner === viewer.familyId) return quote("not_held");
    if (target.battleId) return quote("contested");
    const [live] = await this.db
      .select({ id: battles.id })
      .from(battles)
      .where(and(eq(battles.attackerFamilyId, viewer.familyId), inArray(battles.status, [...LIVE])));
    if (live) return quote("already_fighting");
    const fams = await this.memberships.familiesById([viewer.familyId, target.owner]);
    const check = await this.checkDeclaration(this.db, slug, fams.get(viewer.familyId)!, fams.get(target.owner)!, this.clock.now());
    if (!check.ok) return quote(check.reason);
    if ((await this.ledger.balance(viewer.familyId)) < fee) return quote("insufficient_funds");
    return quote(null);
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  /** Declares a battle for a territory another family holds. The fee is charged now; the defender's guards are committed. */
  async declare(actorId: string, slug: string): Promise<Battle> {
    const now = this.clock.now();
    let id: string;
    try {
      id = await this.db.transaction(async (tx) => {
        const peek = await this.memberships.memberOf(actorId, tx);
        if (!peek) throw forbidden("You need to be in a family to do that.");
        const target = await this.holdings.ownerOf(slug, tx);
        if (!target) throw notFound("Territory");
        if (!target.owner) throw conflict("TERRITORY_NOT_HELD", `Nobody holds ${target.name}; claim it instead.`);
        if (target.owner === peek.familyId) throw badRequest("Your family already holds this territory.");

        const { member, families } = await this.memberships.lockActingAmong(tx, actorId, [peek.familyId, target.owner], { kind: "declare_battle" });
        if (member.familyId !== peek.familyId) throw forbidden("You can only declare for your own family.");
        const t = await this.territories.lockForBattle(tx, slug);
        if (t.ownerFamilyId !== target.owner) throw conflict("TERRITORY_NOT_HELD", `${t.name} has just changed hands. Look again.`);
        if (t.contestedBattleId) throw conflict("TERRITORY_CONTESTED", `${t.name} is already being fought over.`);
        const attacker = families.get(member.familyId)!;
        const defender = families.get(t.ownerFamilyId)!;

        const [live] = await tx
          .select({ id: battles.id })
          .from(battles)
          .where(and(eq(battles.attackerFamilyId, attacker.id), inArray(battles.status, [...LIVE])));
        if (live) throw conflict("ALREADY_FIGHTING", "Your family is already attacking somewhere. Finish that battle first.");
        const check = await this.checkDeclaration(tx, slug, attacker, defender, now);
        if (!check.ok) {
          const [code, message] = REFUSAL[check.reason];
          throw conflict(code, message);
        }

        const battleId = uuidv7();
        const fee = declarationFee(t.baseUpkeep);
        await tx.insert(battles).values({
          id: battleId,
          territoryId: t.id,
          attackerFamilyId: attacker.id,
          defenderFamilyId: defender.id,
          seed: randomInt(0, 2 ** 31 - 1),
          fee,
          declaredBy: actorId,
          declaredAt: now,
          nextRoundAt: new Date(now.getTime() + PREPARATION_MS),
        });
        await this.territories.setContested(tx, t.id, battleId);
        await this.henchmen.commitGuards(tx, defender.id, t.id, battleId, now, BATTLES.maxCommittedPerSide);
        try {
          await this.ledger.post(tx, {
            kind: "battle",
            idempotencyKey: `battle:${battleId}:fee`,
            actorPlayerId: actorId,
            ref: { type: "territory", id: slug },
            lines: [
              { accountId: await this.ledger.treasuryId(tx, attacker.id), amount: -fee, reason: "battle_fee" },
              { accountId: await this.ledger.systemAccount("battle_fees", tx), amount: fee, reason: "battle_fee" },
            ],
          });
        } catch (err) {
          if (err instanceof InsufficientFunds) throw new AppError(409, "INSUFFICIENT_FUNDS", `Declaring on ${t.name} costs ${naira(fee)}, more than the treasury holds.`);
          throw err;
        }
        const payload = { battle: battleId, slug, name: t.name, fee, startsAt: new Date(now.getTime() + PREPARATION_MS).toISOString() };
        await this.activity.record(tx, { familyId: attacker.id, actorPlayerId: actorId, type: "battle.declared", payload: { ...payload, with: defender.tag } });
        await this.activity.record(tx, { familyId: defender.id, actorPlayerId: actorId, type: "battle.attacked", payload: { ...payload, with: attacker.tag } });
        return battleId;
      });
    } catch (err) {
      const constraint = uniqueViolation(err);
      if (constraint === "battles_territory_live_unique") throw conflict("TERRITORY_CONTESTED", "That territory is already being fought over.");
      if (constraint === "battles_attacker_live_unique") throw conflict("ALREADY_FIGHTING", "Your family is already attacking somewhere.");
      throw err;
    }
    return this.get(actorId, id);
  }

  /** Commits the actor's family's henchmen, before round 1. */
  async commit(actorId: string, battleId: string, ids: readonly string[]): Promise<Battle> {
    await this.db.transaction(async (tx) => {
      const { actor, battle } = await this.lockForCommand(tx, actorId, battleId);
      if (battle.status !== "preparing") throw conflict("BATTLE_CLOSED", "Henchmen can only be committed before round 1.");
      await this.henchmen.commit(tx, actor.familyId, ids, battle.id, this.clock.now(), BATTLES.maxCommittedPerSide);
    });
    return this.get(actorId, battleId);
  }

  async release(actorId: string, battleId: string, ids: readonly string[]): Promise<Battle> {
    await this.db.transaction(async (tx) => {
      const { actor, battle } = await this.lockForCommand(tx, actorId, battleId);
      if (battle.status !== "preparing") throw conflict("BATTLE_CLOSED", "Henchmen can only be released before round 1.");
      await this.henchmen.release(tx, battle.id, actor.familyId, ids);
    });
    return this.get(actorId, battleId);
  }

  /** Sets the side's tactic for the next round. It can be changed until the round is resolved. */
  async order(actorId: string, battleId: string, round: number, tactic: Tactic): Promise<Battle> {
    await this.db.transaction(async (tx) => {
      const { actor, battle } = await this.lockForCommand(tx, actorId, battleId);
      if (!(LIVE as readonly string[]).includes(battle.status)) throw conflict("BATTLE_CLOSED", "This battle is over.");
      if (round !== battle.currentRound + 1) throw conflict("BATTLE_CLOSED", `Orders now are for round ${battle.currentRound + 1}.`);
      const side: Side = actor.familyId === battle.attackerFamilyId ? "attacker" : "defender";
      const now = this.clock.now();
      await tx
        .insert(battleOrders)
        .values({ battleId: battle.id, roundNo: round, side, tactic, submittedBy: actorId, submittedAt: now })
        .onConflictDoUpdate({ target: [battleOrders.battleId, battleOrders.roundNo, battleOrders.side], set: { tactic, submittedBy: actorId, submittedAt: now } });
    });
    return this.get(actorId, battleId);
  }

  /** The actor's family falls back: the battle ends at once and the other side wins (an attacker withdrawing keeps nothing). */
  async withdraw(actorId: string, battleId: string): Promise<Battle> {
    await this.db.transaction(async (tx) => {
      const [peek] = await tx.select().from(battles).where(eq(battles.id, battleId));
      if (!peek) throw notFound("Battle");
      const { member } = await this.memberships.lockActingAmong(tx, actorId, [peek.attackerFamilyId, peek.defenderFamilyId], { kind: "declare_battle" });
      const battle = await this.lockBattle(tx, battleId);
      if (!(LIVE as readonly string[]).includes(battle.status)) throw conflict("BATTLE_CLOSED", "This battle is over.");
      const loser: Side = member.familyId === battle.attackerFamilyId ? "attacker" : "defender";
      const territory = await this.territories.lockById(tx, battle.territoryId);
      await this.finish(tx, battle, loser === "attacker" ? "defender" : "attacker", "withdrawn", territory, actorId);
    });
    return this.get(actorId, battleId);
  }

  // ── Scheduled ────────────────────────────────────────────────────────────

  /** Resolves every round that is due (and starts battles whose preparation is over). Safe to run concurrently and to retry. */
  async sweep(now: Date = this.clock.now(), limit = 50): Promise<number> {
    const due = await this.db
      .select({ id: battles.id })
      .from(battles)
      .where(and(inArray(battles.status, [...LIVE]), lte(battles.nextRoundAt, now)))
      .orderBy(asc(battles.nextRoundAt))
      .limit(limit);
    let resolved = 0;
    for (const { id } of due) {
      try {
        if (await this.db.transaction((tx) => this.advance(tx, id, now))) resolved++;
      } catch (err) {
        // One bad battle must not stop the others; it is retried on the next sweep.
        this.logger.error(`battle ${id}: ${(err as Error).message}`);
      }
    }
    if (resolved > 0) this.logger.log(`battle sweep: ${resolved} rounds`);
    return resolved;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Resolves the battle's next round if it's still due. Returns whether it did anything. */
  private async advance(tx: Tx, battleId: string, now: Date): Promise<boolean> {
    const [peek] = await tx.select().from(battles).where(eq(battles.id, battleId));
    if (!peek) return false;
    const families = await this.memberships.lockFamilies(tx, [peek.attackerFamilyId, peek.defenderFamilyId]);
    const battle = await this.lockBattle(tx, battleId);
    // Another sweep got here first.
    if (!(LIVE as readonly string[]).includes(battle.status) || !battle.nextRoundAt || battle.nextRoundAt.getTime() > now.getTime()) return false;

    const territory = await this.territories.lockById(tx, battle.territoryId);
    const attacker = families.get(battle.attackerFamilyId)!;
    const defender = families.get(battle.defenderFamilyId)!;
    if (attacker.disbandedAt || defender.disbandedAt) {
      await this.cancel(tx, battle, "disbanded", territory, !attacker.disbandedAt);
      return true;
    }
    if (territory.ownerFamilyId !== defender.id) {
      await this.cancel(tx, battle, "territory_lost", territory, true);
      return true;
    }

    const committed = await this.henchmen.committed(tx, battle.id);
    let state = battle.state as BattleState | null;
    if (battle.status === "preparing") {
      const fit = (familyId: string) => committed.filter((h) => h.familyId === familyId && !(h.injuredUntil && h.injuredUntil.getTime() > now.getTime())).map(fighterOf);
      state = initialState(fit(attacker.id), fit(defender.id));
      await tx.update(battles).set({ status: "active", initialState: state as unknown as Record<string, unknown> }).where(eq(battles.id, battle.id));
    }
    const present = new Set(committed.map((h) => h.id));
    const absent = [...state!.fit.attacker, ...state!.fit.defender].map((f) => f.id).filter((id) => !present.has(id));
    const round = battle.currentRound + 1;
    const orders = await tx
      .select({ side: battleOrders.side, tactic: battleOrders.tactic })
      .from(battleOrders)
      .where(and(eq(battleOrders.battleId, battle.id), eq(battleOrders.roundNo, round)));
    const tactics = {
      attacker: orders.find((o) => o.side === "attacker")?.tactic ?? DEFAULT_TACTIC.attacker,
      defender: orders.find((o) => o.side === "defender")?.tactic ?? DEFAULT_TACTIC.defender,
    };

    const step = resolveRound(state!, { tactics, absent }, battle.seed);
    await tx.insert(battleRounds).values({ battleId: battle.id, roundNo: round, result: step.result as unknown as Record<string, unknown>, resolvedAt: now });
    await this.henchmen.injure(tx, [...step.result.injured.attacker, ...step.result.injured.defender], new Date(now.getTime() + INJURY_MS));
    await tx
      .update(battles)
      .set({ state: step.state as unknown as Record<string, unknown>, currentRound: round, nextRoundAt: new Date(battle.nextRoundAt.getTime() + ROUND_MS) })
      .where(eq(battles.id, battle.id));
    const name = territory.name;
    for (const [fam, other, side] of [
      [attacker, defender, "attacker"],
      [defender, attacker, "defender"],
    ] as const) {
      const outcome = step.result.winner === "draw" ? "draw" : step.result.winner === side ? "won" : "lost";
      await this.activity.record(tx, { familyId: fam.id, actorPlayerId: null, type: "battle.round", payload: { battle: battle.id, with: other.tag, name, slug: territory.slug, round, outcome } });
    }

    if (battleOver(step.state)) await this.finish(tx, { ...battle, state: step.state as unknown as Record<string, unknown> }, battleWinner(step.state), null, territory, null);
    return true;
  }

  /** Ends a battle with a winner: the territory goes to an attacker who won; morale moves; everyone is released. */
  private async finish(tx: Tx, battle: BattleRow, winner: Side, reason: string | null, territory: typeof territories.$inferSelect, actorId: string | null): Promise<void> {
    const now = this.clock.now();
    const fams = await this.memberships.familiesById([battle.attackerFamilyId, battle.defenderFamilyId], tx);
    const [attacker, defender] = [fams.get(battle.attackerFamilyId)!, fams.get(battle.defenderFamilyId)!];
    if (winner === "attacker" && territory.ownerFamilyId === defender.id) await this.territories.conquer(tx, territory.id, defender.id, attacker.id, now);
    else await this.territories.setContested(tx, territory.id, null);

    const committed = await this.henchmen.committed(tx, battle.id);
    const ofSide = (f: FamilyFacts) => committed.filter((h) => h.familyId === f.id).map((h) => h.id);
    const [winners, losers] = winner === "attacker" ? [attacker, defender] : [defender, attacker];
    await this.henchmen.shiftMorale(tx, ofSide(winners), BATTLES.moraleWin);
    await this.henchmen.shiftMorale(tx, ofSide(losers), BATTLES.moraleLoss);
    await this.henchmen.release(tx, battle.id);

    await tx
      .update(battles)
      .set({ status: "resolved", winner, endReason: reason, endedAt: now, nextRoundAt: null })
      .where(and(eq(battles.id, battle.id), inArray(battles.status, [...LIVE])));
    const payload = { battle: battle.id, name: territory.name, slug: territory.slug, reason };
    await this.activity.record(tx, { familyId: winners.id, actorPlayerId: actorId, type: "battle.won", payload: { ...payload, with: losers.tag, side: winner } });
    await this.activity.record(tx, { familyId: losers.id, actorPlayerId: actorId, type: "battle.lost", payload: { ...payload, with: winners.tag, side: winner === "attacker" ? "defender" : "attacker" } });
  }

  /** Calls a battle off (the territory changed hands another way, or a family disbanded). The fee is refunded if possible. */
  private async cancel(tx: Tx, battle: BattleRow, reason: string, territory: typeof territories.$inferSelect, refund: boolean): Promise<void> {
    const now = this.clock.now();
    if (territory.contestedBattleId === battle.id) await this.territories.setContested(tx, territory.id, null);
    await this.henchmen.release(tx, battle.id);
    if (refund && battle.fee > 0) {
      await this.ledger.post(tx, {
        kind: "battle",
        idempotencyKey: `battle:${battle.id}:refund`,
        ref: { type: "territory", id: territory.slug },
        lines: [
          { accountId: await this.ledger.systemAccount("battle_fees", tx), amount: -battle.fee, reason: "battle_refund" },
          { accountId: await this.ledger.treasuryId(tx, battle.attackerFamilyId), amount: battle.fee, reason: "battle_refund" },
        ],
      });
    }
    await tx.update(battles).set({ status: "cancelled", endReason: reason, endedAt: now, nextRoundAt: null }).where(eq(battles.id, battle.id));
    const fams = await this.memberships.familiesById([battle.attackerFamilyId, battle.defenderFamilyId], tx);
    const [attacker, defender] = [fams.get(battle.attackerFamilyId)!, fams.get(battle.defenderFamilyId)!];
    const payload = { battle: battle.id, name: territory.name, slug: territory.slug, reason, refunded: refund ? battle.fee : 0 };
    await this.activity.record(tx, { familyId: attacker.id, actorPlayerId: null, type: "battle.cancelled", payload: { ...payload, with: defender.tag } });
    await this.activity.record(tx, { familyId: defender.id, actorPlayerId: null, type: "battle.cancelled", payload: { ...payload, with: attacker.tag } });
  }

  /** Locks the actor's family (they must command it) and the battle, which must involve their family. */
  private async lockForCommand(tx: Tx, actorId: string, battleId: string) {
    const actor = await this.memberships.lockActing(tx, actorId, { kind: "command_battle" });
    const battle = await this.lockBattle(tx, battleId);
    if (actor.familyId !== battle.attackerFamilyId && actor.familyId !== battle.defenderFamilyId) throw notFound("Battle");
    return { actor, battle };
  }

  private async lockBattle(tx: Tx, id: string): Promise<BattleRow> {
    const [b] = await tx.select().from(battles).where(eq(battles.id, id)).for("update");
    if (!b) throw notFound("Battle");
    return b;
  }

  private async checkDeclaration(db: DbOrTx, slug: string, attacker: FamilyFacts, defender: FamilyFacts, now: Date) {
    return checkDeclaration({
      targetBorders: CITY.territories.get(slug)?.borders ?? [],
      attackerHeld: await this.holdings.slugsHeld(attacker.id, db),
      defenderHeldCount: (await this.holdings.slugsHeld(defender.id, db)).length,
      attackerFoundedAtMs: attacker.foundedAt.getTime(),
      defenderFoundedAtMs: defender.foundedAt.getTime(),
      nowMs: now.getTime(),
      ceasefire: (await this.diplomacy.ceasefireUntil(db, attacker.id, defender.id, now)) !== null,
      recentBattle: await this.foughtRecently(db, attacker.id, defender.id, now),
    });
  }

  private async foughtRecently(tx: DbOrTx, a: string, b: string, now: Date): Promise<boolean> {
    const pair = or(and(eq(battles.attackerFamilyId, a), eq(battles.defenderFamilyId, b)), and(eq(battles.attackerFamilyId, b), eq(battles.defenderFamilyId, a)));
    const rows = await tx
      .select({ id: battles.id })
      .from(battles)
      .where(and(pair, or(inArray(battles.status, [...LIVE]), gt(battles.endedAt, new Date(now.getTime() - PAIR_COOLDOWN_MS)))))
      .limit(1);
    return rows.length > 0;
  }

  private async summaries(rows: BattleRow[], viewerFamilyId: string): Promise<BattleSummary[]> {
    if (rows.length === 0) return [];
    const fams = await this.memberships.familiesById(rows.flatMap((r) => [r.attackerFamilyId, r.defenderFamilyId]));
    const places = new Map(
      (await this.db.select({ id: territories.id, slug: territories.slug, name: territories.name }).from(territories).where(inArray(territories.id, rows.map((r) => r.territoryId)))).map(
        (t) => [t.id, t],
      ),
    );
    const ref = (id: string) => {
      const f = fams.get(id)!;
      return { id: f.id, name: f.name, tag: f.tag };
    };
    return rows.map((r) => {
      const t = places.get(r.territoryId)!;
      const state = r.state as BattleState | null;
      return {
        id: r.id,
        territory: { slug: t.slug, name: t.name ?? placeName(t.slug) },
        attacker: ref(r.attackerFamilyId),
        defender: ref(r.defenderFamilyId),
        status: r.status,
        fee: r.fee,
        declaredAt: r.declaredAt.toISOString(),
        currentRound: r.currentRound,
        rounds: BATTLES.rounds,
        nextRoundAt: r.nextRoundAt?.toISOString() ?? null,
        winner: r.winner,
        endReason: r.endReason,
        endedAt: r.endedAt?.toISOString() ?? null,
        points: state?.points ?? { attacker: 0, defender: 0 },
        mySide: viewerFamilyId === r.attackerFamilyId ? "attacker" : "defender",
      };
    });
  }
}
