import { Inject, Injectable, Logger } from "@nestjs/common";
import { CITY } from "@kots/content";
import { canReceive, checkClaim, checkFamilyAction, claimQuote, territoryUpkeep, UPKEEP_PERIOD_MS, upkeepStatus } from "@kots/rules";
import type { ClaimRefusal, FamilyHoldings, TerritoryDetail } from "@kots/shared";
import { and, asc, count, eq, isNotNull, isNull, lt, lte, or } from "drizzle-orm";
import { CLOCK, type Clock } from "../../common/clock";
import { AppError, conflict, forbidden, notFound } from "../../common/errors";
import { uuidv7 } from "../../common/uuid";
import { DB, type Database } from "../../db/db";
import { families, territories, territoryOwnershipHistory, type OwnershipCause } from "../../db/schema";
import type { DbOrTx, Tx } from "../../db/tx";
import { ActivityService } from "../activity/activity.service";
import { MembershipsService } from "../families/memberships.service";
import { HenchmenService } from "../henchmen/henchmen.service";
import { InsufficientFunds, LedgerService, type PostingLine } from "../ledger/ledger.service";

type Territory = typeof territories.$inferSelect;
type Held = Territory & { ownerFamilyId: string; upkeepPaidUntil: Date; ownedSince: Date };

export interface SweepResult {
  paid: number;
  neglected: number;
  lapsed: number;
}

const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;

/**
 * Territory ownership: claiming, abandoning, and upkeep. Upkeep is timestamp-based: a territory is paid up to
 * `upkeep_paid_until`, and the worker's sweep settles each period as it falls due (see docs/ECONOMY.md).
 * Lock order: families → family_memberships → territories → henchmen → currency_accounts.
 */
@Injectable()
export class TerritoriesService {
  private readonly logger = new Logger(TerritoriesService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly memberships: MembershipsService,
    private readonly ledger: LedgerService,
    private readonly activity: ActivityService,
    private readonly henchmen: HenchmenService,
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────────

  async detail(viewerId: string, slug: string): Promise<TerritoryDetail> {
    const [row] = await this.db
      .select({ t: territories, ownerName: families.name, ownerTag: families.tag })
      .from(territories)
      .leftJoin(families, eq(families.id, territories.ownerFamilyId))
      .where(eq(territories.slug, slug));
    if (!row) throw notFound("Territory");
    const { t } = row;
    const viewer = await this.memberships.memberOf(viewerId);
    const mine = viewer !== null && t.ownerFamilyId === viewer.familyId;

    let holding: TerritoryDetail["holding"] = null;
    if (mine) {
      const held = await this.heldCount(this.db, viewer.familyId);
      holding = { paidUntil: t.upkeepPaidUntil!.toISOString(), upkeep: territoryUpkeep(t.baseUpkeep, held), income: t.baseIncome };
    }

    let claim: TerritoryDetail["claim"] = null;
    if (!mine) {
      const held = viewer ? await this.heldSlugs(this.db, viewer.familyId) : [];
      const quote = claimQuote(t.baseUpkeep, held.length);
      let refusal: ClaimRefusal | null = null;
      if (!viewer) refusal = "not_in_family";
      else if (!checkFamilyAction(viewer.role, { kind: "claim_territory" }).ok) refusal = "missing_permission";
      else if (t.ownerFamilyId) refusal = "owned";
      else if (!checkClaim(CITY.territories.get(slug)?.borders ?? [], held).ok) refusal = "not_adjacent";
      else if ((await this.ledger.balance(viewer.familyId)) < quote.total) refusal = "insufficient_funds";
      claim = { ...quote, refusal };
    }

    return {
      slug: t.slug,
      owner: t.ownerFamilyId && row.ownerName && row.ownerTag ? { id: t.ownerFamilyId, name: row.ownerName, tag: row.ownerTag } : null,
      state: t.state,
      ownedSince: t.ownedSince?.toISOString() ?? null,
      holding,
      battleId: t.contestedBattleId,
      claim,
    };
  }

  async holdings(viewerId: string, familyId: string): Promise<FamilyHoldings> {
    await this.memberships.requireMemberOf(viewerId, familyId);
    const rows = await this.db.select().from(territories).where(eq(territories.ownerFamilyId, familyId)).orderBy(asc(territories.slug));
    const list = rows.map((t) => ({
      slug: t.slug,
      state: t.state,
      paidUntil: t.upkeepPaidUntil!.toISOString(),
      upkeep: territoryUpkeep(t.baseUpkeep, rows.length),
      income: t.baseIncome,
    }));
    return { territories: list, income: list.reduce((s, t) => s + t.income, 0), upkeep: list.reduce((s, t) => s + t.upkeep, 0) };
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  async claim(actorId: string, slug: string): Promise<TerritoryDetail> {
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      // The family row lock makes one family's claims run one at a time, so fees and adjacency see every holding.
      const actor = await this.memberships.lockActing(tx, actorId, { kind: "claim_territory" });
      const [t] = await tx.select().from(territories).where(eq(territories.slug, slug)).for("update");
      if (!t) throw notFound("Territory");
      if (t.ownerFamilyId === actor.familyId) throw conflict("TERRITORY_OWNED", "Your family already holds this territory.");
      if (t.ownerFamilyId) throw conflict("TERRITORY_OWNED", "Another family holds this territory.");

      const held = await this.heldSlugs(tx, actor.familyId);
      if (!checkClaim(CITY.territories.get(slug)?.borders ?? [], held).ok) {
        throw conflict("NOT_ADJACENT", "You can only claim territory that borders land you hold, or is across a bridge from it.");
      }

      const quote = claimQuote(t.baseUpkeep, held.length);
      const historyId = uuidv7();
      const treasury = await this.ledger.treasuryId(tx, actor.familyId);
      const lines: PostingLine[] = [
        { accountId: treasury, amount: -quote.total, reason: "territory_claim" },
        { accountId: await this.ledger.systemAccount("territory_upkeep", tx), amount: quote.firstUpkeep, reason: "territory_upkeep" },
      ];
      if (quote.fee > 0) lines.push({ accountId: await this.ledger.systemAccount("claim_fees", tx), amount: quote.fee, reason: "claim_fee" });
      try {
        await this.ledger.post(tx, {
          kind: "territory_claim",
          idempotencyKey: `claim:${historyId}`,
          actorPlayerId: actorId,
          ref: { type: "territory", id: slug },
          lines,
        });
      } catch (err) {
        if (err instanceof InsufficientFunds) {
          throw new AppError(409, "INSUFFICIENT_FUNDS", `Claiming ${t.name} costs ${naira(quote.total)}, more than the treasury holds.`);
        }
        throw err;
      }

      await tx
        .update(territories)
        .set({
          ownerFamilyId: actor.familyId,
          ownedSince: now,
          upkeepPaidUntil: new Date(now.getTime() + UPKEEP_PERIOD_MS),
          state: "stable",
          lastEvaluatedAt: null,
        })
        .where(eq(territories.id, t.id));
      await tx.insert(territoryOwnershipHistory).values({ id: historyId, territoryId: t.id, toFamilyId: actor.familyId, cause: "claim", actorPlayerId: actorId });
      await this.activity.record(tx, { familyId: actor.familyId, actorPlayerId: actorId, type: "territory.claimed", payload: { slug, name: t.name, cost: quote.total } });
    });
    return this.detail(actorId, slug);
  }

  /**
   * Hands a held territory to another family, inside the caller's transaction (a signed diplomacy proposal). The caller
   * has locked both families. The paid upkeep period and state go with it; guards are stood down. Returns its name.
   */
  async transfer(tx: Tx, slug: string, fromFamilyId: string, toFamilyId: string, actorId: string, now: Date): Promise<string> {
    const [t] = await tx.select().from(territories).where(eq(territories.slug, slug)).for("update");
    if (!t) throw notFound("Territory");
    if (t.ownerFamilyId !== fromFamilyId) throw conflict("TERRITORY_NOT_HELD", `${t.name} is no longer held by the family giving it.`);
    if (t.contestedBattleId) throw conflict("TERRITORY_CONTESTED", `${t.name} is being fought over; it can't change hands until the battle ends.`);
    if (!canReceive(slug, await this.heldSlugs(tx, toFamilyId))) {
      throw conflict("NOT_ADJACENT", `The receiving family can only take ${t.name} if it borders their land (or they hold none).`);
    }
    await tx.update(territories).set({ ownerFamilyId: toFamilyId, ownedSince: now }).where(eq(territories.id, t.id));
    await this.henchmen.unassignFrom(tx, t.id);
    await tx.insert(territoryOwnershipHistory).values({ territoryId: t.id, fromFamilyId, toFamilyId, cause: "transfer", actorPlayerId: actorId });
    return t.name;
  }

  // ── Battles (called by BattlesService inside its transaction, after it has locked both families) ──

  /** Locks a territory for a battle and returns it. */
  async lockForBattle(tx: Tx, slug: string): Promise<typeof territories.$inferSelect> {
    const [t] = await tx.select().from(territories).where(eq(territories.slug, slug)).for("update");
    if (!t) throw notFound("Territory");
    return t;
  }

  async lockById(tx: Tx, id: string): Promise<typeof territories.$inferSelect> {
    const [t] = await tx.select().from(territories).where(eq(territories.id, id)).for("update");
    return t!;
  }

  async setContested(tx: Tx, territoryId: string, battleId: string | null): Promise<void> {
    await tx.update(territories).set({ contestedBattleId: battleId }).where(eq(territories.id, territoryId));
  }

  /** The attacker won: the territory changes hands, keeping its paid upkeep period; the loser's guards stand down. */
  async conquer(tx: Tx, territoryId: string, fromFamilyId: string, toFamilyId: string, now: Date): Promise<void> {
    await tx.update(territories).set({ ownerFamilyId: toFamilyId, ownedSince: now, contestedBattleId: null }).where(eq(territories.id, territoryId));
    await this.henchmen.unassignFrom(tx, territoryId);
    await tx.insert(territoryOwnershipHistory).values({ territoryId, fromFamilyId, toFamilyId, cause: "battle", actorPlayerId: null });
  }

  async abandon(actorId: string, slug: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const actor = await this.memberships.lockActing(tx, actorId, { kind: "abandon_territory" });
      const [t] = await tx.select().from(territories).where(eq(territories.slug, slug)).for("update");
      if (!t) throw notFound("Territory");
      if (t.ownerFamilyId !== actor.familyId) throw forbidden("Your family doesn't hold this territory.");
      if (t.contestedBattleId) throw conflict("TERRITORY_CONTESTED", `${t.name} is being fought over; it can't be abandoned until the battle ends.`);
      await this.release(tx, t as Held, "abandon", actorId);
    });
  }

  /** Releases every territory a family holds. Called by disband, inside its transaction (after it locks the family). */
  async releaseAll(tx: Tx, familyId: string, actorId: string): Promise<void> {
    const held = await tx.select().from(territories).where(eq(territories.ownerFamilyId, familyId)).orderBy(asc(territories.id)).for("update");
    for (const t of held) await this.release(tx, t as Held, "disband", actorId);
  }

  /**
   * Settles every territory whose paid period has ended, one transaction per territory, oldest first.
   * Each due period credits the territory's income and charges its upkeep in one posting. If the treasury can't
   * cover the net amount the territory is neglected; once the grace period has passed too, it returns to neutral.
   * Safe to run concurrently (SKIP LOCKED) and to retry (each period has its own idempotency key).
   */
  async sweepUpkeep(now: Date = this.clock.now(), limit = 1000): Promise<SweepResult> {
    const result: SweepResult = { paid: 0, neglected: 0, lapsed: 0 };
    for (let i = 0; i < limit; i++) {
      const outcome = await this.db.transaction(async (tx) => {
        const [t] = await tx
          .select()
          .from(territories)
          .where(
            and(
              isNotNull(territories.ownerFamilyId),
              lte(territories.upkeepPaidUntil, now),
              // Skips rows already looked at in this sweep (an unpaid row stays due).
              or(isNull(territories.lastEvaluatedAt), lt(territories.lastEvaluatedAt, now)),
            ),
          )
          .orderBy(asc(territories.upkeepPaidUntil))
          .limit(1)
          .for("update", { skipLocked: true });
        return t ? this.settle(tx, t as Held, now) : null;
      });
      if (!outcome) break;
      result[outcome]++;
    }
    if (result.paid + result.neglected + result.lapsed > 0) this.logger.log(`upkeep sweep: ${JSON.stringify(result)}`);
    return result;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async settle(tx: Tx, t: Held, now: Date): Promise<keyof SweepResult> {
    const held = await this.heldCount(tx, t.ownerFamilyId);
    const upkeep = territoryUpkeep(t.baseUpkeep, held);
    const treasury = await this.ledger.treasuryId(tx, t.ownerFamilyId);
    const [incomeAccount, upkeepAccount] = [await this.ledger.systemAccount("territory_income", tx), await this.ledger.systemAccount("territory_upkeep", tx)];

    let paidUntil = t.upkeepPaidUntil;
    // Catch up on every period that has ended, so a worker outage never costs a family anything.
    while (paidUntil.getTime() <= now.getTime()) {
      const lines: PostingLine[] = [];
      if (t.baseIncome > 0) {
        lines.push({ accountId: treasury, amount: t.baseIncome, reason: "territory_income" }, { accountId: incomeAccount, amount: -t.baseIncome, reason: "territory_income" });
      }
      if (upkeep > 0) {
        lines.push({ accountId: treasury, amount: -upkeep, reason: "territory_upkeep" }, { accountId: upkeepAccount, amount: upkeep, reason: "territory_upkeep" });
      }
      try {
        if (lines.length > 0) {
          // A savepoint, so a refused payment leaves this transaction usable for marking the territory.
          await tx.transaction((sp) =>
            this.ledger.post(sp, {
              kind: "upkeep",
              idempotencyKey: `upkeep:${t.id}:${paidUntil.toISOString()}`,
              ref: { type: "territory", id: t.slug },
              lines,
            }),
          );
        }
      } catch (err) {
        if (!(err instanceof InsufficientFunds)) throw err;
        if (upkeepStatus(paidUntil.getTime(), now.getTime()) === "lapsed") {
          await this.release(tx, t, "lapsed", null);
          return "lapsed";
        }
        await tx.update(territories).set({ upkeepPaidUntil: paidUntil, state: "neglected", lastEvaluatedAt: now }).where(eq(territories.id, t.id));
        if (t.state !== "neglected") {
          await this.activity.record(tx, { familyId: t.ownerFamilyId, actorPlayerId: null, type: "territory.neglected", payload: { slug: t.slug, name: t.name, upkeep } });
        }
        return "neglected";
      }
      paidUntil = new Date(paidUntil.getTime() + UPKEEP_PERIOD_MS);
    }
    await tx.update(territories).set({ upkeepPaidUntil: paidUntil, state: "stable", lastEvaluatedAt: now }).where(eq(territories.id, t.id));
    return "paid";
  }

  private async release(tx: Tx, t: Held, cause: OwnershipCause, actorId: string | null): Promise<void> {
    await tx
      .update(territories)
      .set({ ownerFamilyId: null, ownedSince: null, upkeepPaidUntil: null, state: "stable", lastEvaluatedAt: null, contestedBattleId: null })
      .where(eq(territories.id, t.id));
    await this.henchmen.unassignFrom(tx, t.id);
    await tx.insert(territoryOwnershipHistory).values({ territoryId: t.id, fromFamilyId: t.ownerFamilyId, cause, actorPlayerId: actorId });
    if (cause !== "disband") {
      await this.activity.record(tx, {
        familyId: t.ownerFamilyId,
        actorPlayerId: actorId,
        type: cause === "lapsed" ? "territory.lost" : "territory.abandoned",
        payload: { slug: t.slug, name: t.name },
      });
    }
  }

  private async heldSlugs(db: DbOrTx, familyId: string): Promise<string[]> {
    return (await db.select({ slug: territories.slug }).from(territories).where(eq(territories.ownerFamilyId, familyId))).map((r) => r.slug);
  }

  private async heldCount(db: DbOrTx, familyId: string): Promise<number> {
    const [row] = await db.select({ n: count() }).from(territories).where(eq(territories.ownerFamilyId, familyId));
    return row?.n ?? 0;
  }
}
