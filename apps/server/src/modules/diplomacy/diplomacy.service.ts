import { Inject, Injectable, Logger } from "@nestjs/common";
import { CITY, DIPLOMACY, TRADES } from "@kots/content";
import { checkFamilyAction, checkProposalTerms, oldEnoughToTrade, PROPOSAL_TTL_MS, type ProposalTerms } from "@kots/rules";
import type { ChatChannel, Proposal, RoomState } from "@kots/shared";
import { and, asc, count, desc, eq, gt, inArray, lte, ne, or } from "drizzle-orm";
import { CLOCK, type Clock } from "../../common/clock";
import { AppError, badRequest, conflict, forbidden, notFound } from "../../common/errors";
import { canonicalJson } from "../../common/idempotency-key";
import { DB, type Database } from "../../db/db";
import { ceasefires, players, proposals, proposalSignatures } from "../../db/schema";
import type { DbOrTx, Tx } from "../../db/tx";
import { ActivityService } from "../activity/activity.service";
import { ChatService } from "../chat/chat.service";
import { MembershipsService, type FamilyFacts } from "../families/memberships.service";
import { InsufficientFunds, LedgerService } from "../ledger/ledger.service";
import { HoldingsService } from "../territories/holdings.service";
import { TerritoriesService } from "../territories/territories.service";

type ProposalRow = typeof proposals.$inferSelect;

const TERMS_MESSAGE = {
  unknown_territory: "There's no such territory.",
  bad_price: `The price must be a whole amount from ₦0 to ₦${DIPLOMACY.maxPrice.toLocaleString("en-NG")}.`,
  bad_length: `A ceasefire lasts ${DIPLOMACY.ceasefireHours.map((h) => h / 24).join(", ")} days.`,
} as const;

const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;
const sorted = (a: string, b: string) => (a < b ? [a, b] : [b, a]) as [string, string];
const termsOf = (p: ProposalRow) => p.terms as ProposalTerms;

/** One line describing the terms, for history and notifications. */
function summarize(terms: ProposalTerms, from: FamilyFacts, to: FamilyFacts): string {
  if (terms.kind === "ceasefire") return `a ${terms.hours / 24}-day ceasefire`;
  const [giver, receiver] = terms.giver === "proposer" ? [from, to] : [to, from];
  const name = CITY.territories.get(terms.territory)?.name ?? terms.territory;
  return `${name} from [${giver.tag}] to [${receiver.tag}]${terms.price > 0 ? ` for ${naira(terms.price)}` : ""}`;
}

/**
 * Proposals between two families, made in their diplomacy room. Nothing happens until both families have signed
 * (a Don or Underboss for each); the second signature runs the terms at once, in one transaction that re-checks
 * everything. Lock order: both families (id order) → the signer's membership → the proposal → territory → henchmen
 * → treasuries.
 */
@Injectable()
export class DiplomacyService {
  private readonly logger = new Logger(DiplomacyService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly chat: ChatService,
    private readonly memberships: MembershipsService,
    private readonly holdings: HoldingsService,
    private readonly territories: TerritoriesService,
    private readonly ledger: LedgerService,
    private readonly activity: ActivityService,
  ) {}

  // ── Reads ────────────────────────────────────────────────────────────────

  openRoom(playerId: string, tag: string): Promise<ChatChannel> {
    return this.chat.openRoom(playerId, tag);
  }

  /** Open proposals and the 10 latest closed ones, and the end of any ceasefire in force. */
  async room(viewerId: string, roomId: string): Promise<RoomState> {
    const room = await this.chat.requireRoom(this.db, viewerId, roomId);
    const now = this.clock.now();
    const open = await this.db
      .select()
      .from(proposals)
      .where(and(eq(proposals.channelId, room.id), eq(proposals.status, "open"), gt(proposals.expiresAt, now)))
      .orderBy(desc(proposals.id));
    const closed = await this.db
      .select()
      .from(proposals)
      .where(and(eq(proposals.channelId, room.id), or(ne(proposals.status, "open"), lte(proposals.expiresAt, now))))
      .orderBy(desc(proposals.id))
      .limit(10);
    const [a, b] = sorted(room.familyA, room.familyB);
    const [cease] = await this.db
      .select({ endsAt: ceasefires.endsAt })
      .from(ceasefires)
      .where(and(eq(ceasefires.familyA, a), eq(ceasefires.familyB, b), gt(ceasefires.endsAt, now)))
      .orderBy(desc(ceasefires.endsAt))
      .limit(1);
    return { proposals: await this.toDtos([...open, ...closed]), ceasefireUntil: cease?.endsAt.toISOString() ?? null };
  }

  /** The end of the latest ceasefire in force between two families, if any. For battles. */
  async ceasefireUntil(db: DbOrTx, familyX: string, familyY: string, now: Date): Promise<Date | null> {
    const [a, b] = sorted(familyX, familyY);
    const [row] = await db
      .select({ endsAt: ceasefires.endsAt })
      .from(ceasefires)
      .where(and(eq(ceasefires.familyA, a), eq(ceasefires.familyB, b), gt(ceasefires.endsAt, now)))
      .orderBy(desc(ceasefires.endsAt))
      .limit(1);
    return row?.endsAt ?? null;
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  /** Makes a proposal to the other family in the room. If the proposer may sign, it counts as their family's signature. */
  /** A retry with the same Idempotency-Key returns the proposal it made, so a lost response can't make a second one. */
  async propose(actorId: string, roomId: string, requestKey: string, terms: ProposalTerms): Promise<Proposal> {
    const check = checkProposalTerms(terms);
    if (!check.ok) throw badRequest(TERMS_MESSAGE[check.reason]);
    const now = this.clock.now();

    const id = await this.db.transaction(async (tx) => {
      const actor = await this.memberships.lockActing(tx, actorId, { kind: "diplomacy_propose" });
      const room = await this.chat.requireRoom(tx, actorId, roomId);
      // The family row is locked, so a retry with the same key waits here and then finds the first proposal.
      const [prior] = await tx
        .select({ id: proposals.id, channelId: proposals.channelId, terms: proposals.terms })
        .from(proposals)
        .where(and(eq(proposals.fromFamilyId, actor.familyId), eq(proposals.requestKey, requestKey)));
      if (prior) {
        if (prior.channelId !== room.id || canonicalJson(prior.terms) !== canonicalJson(terms)) throw badRequest("That Idempotency-Key was already used for a different proposal.");
        return prior.id;
      }
      const otherId = room.familyA === actor.familyId ? room.familyB : room.familyA;
      const fams = await this.memberships.familiesById([actor.familyId, otherId], tx);
      const [own, other] = [fams.get(actor.familyId)!, fams.get(otherId)!];
      if (other.disbandedAt) throw conflict("PROPOSAL_CLOSED", `${other.name} [${other.tag}] has disbanded.`);
      this.requireOldEnough([own, other], now);
      if (terms.kind === "territory_transfer") {
        const giver = terms.giver === "proposer" ? own : other;
        const held = await this.holdings.ownerOf(terms.territory, tx);
        if (held?.owner !== giver.id) throw conflict("TERRITORY_NOT_HELD", `${giver.name} [${giver.tag}] doesn't hold ${held?.name ?? terms.territory}.`);
      }

      const [open] = await tx
        .select({ n: count() })
        .from(proposals)
        .where(and(eq(proposals.channelId, room.id), eq(proposals.status, "open"), gt(proposals.expiresAt, now)));
      if (open!.n >= DIPLOMACY.maxOpenPerPair) {
        throw conflict("TOO_MANY_PROPOSALS", `There are already ${DIPLOMACY.maxOpenPerPair} open proposals between your families. Settle or withdraw one first.`);
      }

      const [row] = await tx
        .insert(proposals)
        .values({
          channelId: room.id,
          fromFamilyId: own.id,
          toFamilyId: other.id,
          kind: terms.kind,
          terms,
          createdBy: actorId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + PROPOSAL_TTL_MS),
          requestKey,
        })
        .returning({ id: proposals.id });
      if (checkFamilyAction(actor.role, { kind: "diplomacy_sign" }).ok) {
        await tx.insert(proposalSignatures).values({ proposalId: row!.id, familyId: own.id, signedBy: actorId, signedAt: now });
      }
      const summary = summarize(terms, own, other);
      await this.activity.record(tx, { familyId: own.id, actorPlayerId: actorId, type: "proposal.made", payload: { with: other.tag, summary } });
      await this.activity.record(tx, { familyId: other.id, actorPlayerId: actorId, type: "proposal.received", payload: { with: own.tag, summary } });
      return row!.id;
    });
    return this.one(id);
  }

  /**
   * Signs for the actor's family. The second family's signature runs the proposal; if anything no longer holds (the
   * territory changed hands, the money isn't there) the signature is refused and the proposal stays open.
   * Signing again, or signing a proposal that already ran, returns it unchanged.
   */
  async sign(actorId: string, proposalId: string): Promise<Proposal> {
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      const [peek] = await tx.select().from(proposals).where(eq(proposals.id, proposalId));
      if (!peek) throw notFound("Proposal");
      const { member, families } = await this.memberships.lockActingAmong(tx, actorId, [peek.fromFamilyId, peek.toFamilyId], { kind: "diplomacy_sign" });
      const p = await this.lock(tx, proposalId);
      if (p.status === "executed") return;
      this.requireOpen(p, now);
      const signed = await tx.select({ familyId: proposalSignatures.familyId }).from(proposalSignatures).where(eq(proposalSignatures.proposalId, p.id));
      if (signed.some((s) => s.familyId === member.familyId)) return;

      const from = families.get(p.fromFamilyId)!;
      const to = families.get(p.toFamilyId)!;
      if (from.disbandedAt || to.disbandedAt) throw conflict("PROPOSAL_CLOSED", "One of the families has disbanded.");
      await tx.insert(proposalSignatures).values({ proposalId: p.id, familyId: member.familyId, signedBy: actorId, signedAt: now });
      const summary = summarize(termsOf(p), from, to);
      const other = member.familyId === from.id ? to : from;
      const own = member.familyId === from.id ? from : to;

      if (signed.length === 0) {
        await this.activity.record(tx, { familyId: own.id, actorPlayerId: actorId, type: "proposal.signed", payload: { with: other.tag, summary } });
        await this.activity.record(tx, { familyId: other.id, actorPlayerId: actorId, type: "proposal.signed", payload: { with: own.tag, summary } });
        return;
      }
      // Both families have now signed.
      this.requireOldEnough([from, to], now);
      await this.execute(tx, p, from, to, actorId, now);
      await tx.update(proposals).set({ status: "executed", closedBy: actorId, closedAt: now }).where(and(eq(proposals.id, p.id), eq(proposals.status, "open")));
      await this.activity.record(tx, { familyId: from.id, actorPlayerId: actorId, type: "proposal.executed", payload: { with: to.tag, summary } });
      await this.activity.record(tx, { familyId: to.id, actorPlayerId: actorId, type: "proposal.executed", payload: { with: from.tag, summary } });
    });
    return this.one(proposalId);
  }

  async decline(actorId: string, proposalId: string): Promise<Proposal> {
    return this.close(actorId, proposalId, "declined");
  }

  async withdraw(actorId: string, proposalId: string): Promise<Proposal> {
    return this.close(actorId, proposalId, "withdrawn");
  }

  /** Closes proposals past their expiry. Rows locked by a signature in progress are skipped (see TradesService). */
  async sweepExpired(now: Date = this.clock.now(), limit = 500): Promise<number> {
    const expired = await this.db.transaction(async (tx) => {
      const due = await tx
        .select({ id: proposals.id })
        .from(proposals)
        .where(and(eq(proposals.status, "open"), lte(proposals.expiresAt, now)))
        .orderBy(asc(proposals.expiresAt))
        .limit(limit)
        .for("update", { skipLocked: true });
      if (due.length === 0) return [];
      const rows = await tx
        .update(proposals)
        .set({ status: "expired", closedAt: now })
        .where(and(inArray(proposals.id, due.map((d) => d.id)), eq(proposals.status, "open")))
        .returning();
      const fams = await this.memberships.familiesById(rows.flatMap((r) => [r.fromFamilyId, r.toFamilyId]), tx);
      for (const r of rows) {
        const [from, to] = [fams.get(r.fromFamilyId)!, fams.get(r.toFamilyId)!];
        const summary = summarize(termsOf(r), from, to);
        await this.activity.record(tx, { familyId: from.id, actorPlayerId: null, type: "proposal.expired", payload: { with: to.tag, summary } });
        await this.activity.record(tx, { familyId: to.id, actorPlayerId: null, type: "proposal.expired", payload: { with: from.tag, summary } });
      }
      return rows;
    });
    if (expired.length > 0) this.logger.log(`proposal expiry: ${expired.length} proposals`);
    return expired.length;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Runs the terms. The caller holds both family locks and the proposal lock. */
  private async execute(tx: Tx, p: ProposalRow, from: FamilyFacts, to: FamilyFacts, actorId: string, now: Date): Promise<void> {
    const terms = termsOf(p);
    if (terms.kind === "ceasefire") {
      const [a, b] = sorted(from.id, to.id);
      const endsAt = new Date(now.getTime() + terms.hours * 60 * 60 * 1000);
      await tx.insert(ceasefires).values({ familyA: a, familyB: b, proposalId: p.id, startsAt: now, endsAt });
      for (const [fam, other] of [
        [from, to],
        [to, from],
      ] as const) {
        await this.activity.record(tx, { familyId: fam.id, actorPlayerId: actorId, type: "ceasefire.agreed", payload: { with: other.tag, hours: terms.hours, endsAt: endsAt.toISOString() } });
      }
      return;
    }

    const [giver, receiver] = terms.giver === "proposer" ? [from, to] : [to, from];
    const name = await this.territories.transfer(tx, terms.territory, giver.id, receiver.id, actorId, now);
    if (terms.price > 0) {
      try {
        await this.ledger.post(tx, {
          kind: "transfer",
          idempotencyKey: `proposal:${p.id}`,
          actorPlayerId: actorId,
          ref: { type: "territory", id: terms.territory },
          lines: [
            { accountId: await this.ledger.treasuryId(tx, receiver.id), amount: -terms.price, reason: "territory_transfer" },
            { accountId: await this.ledger.treasuryId(tx, giver.id), amount: terms.price, reason: "territory_transfer" },
          ],
        });
      } catch (err) {
        if (!(err instanceof InsufficientFunds)) throw err;
        throw new AppError(409, "INSUFFICIENT_FUNDS", `${receiver.name} [${receiver.tag}] can't pay ${naira(terms.price)} for ${name}.`);
      }
    }
    const payload = { slug: terms.territory, name, price: terms.price };
    await this.activity.record(tx, { familyId: giver.id, actorPlayerId: actorId, type: "territory.transferred", payload: { ...payload, with: receiver.tag, direction: "out" } });
    await this.activity.record(tx, { familyId: receiver.id, actorPlayerId: actorId, type: "territory.transferred", payload: { ...payload, with: giver.tag, direction: "in" } });
  }

  /** Decline (the receiving family, by someone who can sign) or withdraw (the proposing family). */
  private async close(actorId: string, proposalId: string, status: "declined" | "withdrawn"): Promise<Proposal> {
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      const actor = await this.memberships.lockActing(tx, actorId, { kind: status === "declined" ? "diplomacy_sign" : "diplomacy_propose" });
      const p = await this.lock(tx, proposalId);
      const side = status === "declined" ? p.toFamilyId : p.fromFamilyId;
      if (actor.familyId !== side) {
        if (actor.familyId !== p.fromFamilyId && actor.familyId !== p.toFamilyId) throw notFound("Proposal");
        throw forbidden(status === "declined" ? "Only the family the proposal was made to can decline it." : "Only the family that made the proposal can withdraw it.");
      }
      this.requireOpen(p, now);
      await tx.update(proposals).set({ status, closedBy: actorId, closedAt: now }).where(and(eq(proposals.id, p.id), eq(proposals.status, "open")));
      const fams = await this.memberships.familiesById([p.fromFamilyId, p.toFamilyId], tx);
      const [from, to] = [fams.get(p.fromFamilyId)!, fams.get(p.toFamilyId)!];
      const summary = summarize(termsOf(p), from, to);
      const type = status === "declined" ? "proposal.declined" : "proposal.withdrawn";
      await this.activity.record(tx, { familyId: from.id, actorPlayerId: actorId, type, payload: { with: to.tag, summary } });
      await this.activity.record(tx, { familyId: to.id, actorPlayerId: actorId, type, payload: { with: from.tag, summary } });
    });
    return this.one(proposalId);
  }

  private async lock(tx: Tx, id: string): Promise<ProposalRow> {
    const [p] = await tx.select().from(proposals).where(eq(proposals.id, id)).for("update");
    if (!p) throw notFound("Proposal");
    return p;
  }

  private requireOpen(p: ProposalRow, now: Date): void {
    if (p.status !== "open") throw conflict("PROPOSAL_CLOSED", `This proposal is already ${p.status}.`);
    if (p.expiresAt.getTime() <= now.getTime()) throw conflict("PROPOSAL_CLOSED", "This proposal has expired.");
  }

  private requireOldEnough(fams: FamilyFacts[], now: Date): void {
    const young = fams.find((f) => !oldEnoughToTrade(f.foundedAt.getTime(), now.getTime()));
    if (young) throw conflict("TOO_NEW", `Families can make agreements once they are ${TRADES.minFamilyAgeDays} days old; ${young.name} [${young.tag}] isn't yet.`);
  }

  private async one(id: string): Promise<Proposal> {
    const [row] = await this.db.select().from(proposals).where(eq(proposals.id, id));
    return (await this.toDtos([row!]))[0]!;
  }

  private async toDtos(rows: ProposalRow[], db: DbOrTx = this.db): Promise<Proposal[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const sigs = await db
      .select({ proposalId: proposalSignatures.proposalId, familyId: proposalSignatures.familyId, by: players.handle, at: proposalSignatures.signedAt })
      .from(proposalSignatures)
      .leftJoin(players, eq(players.id, proposalSignatures.signedBy))
      .where(inArray(proposalSignatures.proposalId, ids))
      .orderBy(asc(proposalSignatures.signedAt));
    const creators = rows.map((r) => r.createdBy).filter((x): x is string => x !== null);
    const handles = new Map(
      creators.length === 0 ? [] : (await db.select({ id: players.id, handle: players.handle }).from(players).where(inArray(players.id, creators))).map((p) => [p.id, p.handle]),
    );
    const fams = await this.memberships.familiesById(rows.flatMap((r) => [r.fromFamilyId, r.toFamilyId]), db);
    const ref = (id: string) => {
      const f = fams.get(id)!;
      return { id: f.id, name: f.name, tag: f.tag };
    };
    const now = this.clock.now();
    return rows.map((r) => ({
      id: r.id,
      roomId: r.channelId,
      from: ref(r.fromFamilyId),
      to: ref(r.toFamilyId),
      terms: termsOf(r),
      // An open proposal past its expiry is reported as expired, even before the sweep closes it.
      status: r.status === "open" && r.expiresAt.getTime() <= now.getTime() ? "expired" : r.status,
      signatures: sigs.filter((s) => s.proposalId === r.id).map((s) => ({ familyId: s.familyId, by: s.by, at: s.at.toISOString() })),
      createdBy: r.createdBy ? (handles.get(r.createdBy) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      closedAt: r.closedAt?.toISOString() ?? null,
    }));
  }
}
