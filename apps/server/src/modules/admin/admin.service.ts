import { Inject, Injectable } from "@nestjs/common";
import type { FamilyDetail, FamilyHoldings, Henchman, Inventory, LedgerEntry } from "@kots/shared";
import { randomUUID } from "node:crypto";
import { notFound } from "../../common/errors";
import { DB, type Database } from "../../db/db";
import type { moderationActions } from "../../db/schema";
import { ActivityService } from "../activity/activity.service";
import { AccountsService, type AccountRecord } from "../auth/accounts.service";
import { SessionsService } from "../auth/sessions.service";
import { ModerationService } from "../chat/moderation.service";
import { FamiliesService, type MembershipSummary } from "../families/families.service";
import { MembershipsService } from "../families/memberships.service";
import { HenchmenService } from "../henchmen/henchmen.service";
import { InventoryService } from "../inventory/inventory.service";
import { LedgerService } from "../ledger/ledger.service";
import { TerritoriesService } from "../territories/territories.service";

type AuditEntry = typeof moderationActions.$inferSelect;

export interface PlayerReport {
  account: AccountRecord;
  membership: MembershipSummary | null;
  audit: AuditEntry[];
}

export interface FamilyReport {
  family: FamilyDetail;
  balance: number;
  holdings: FamilyHoldings;
  henchmen: Henchman[];
  inventory: Inventory;
  ledger: LedgerEntry[];
  audit: AuditEntry[];
}

/**
 * Operator tools (npm run admin): inspect, adjust a treasury, ban. Owns no tables: everything goes through the
 * owning modules' services, and every change is written to the moderation audit log in the same transaction.
 */
@Injectable()
export class AdminService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly sessions: SessionsService,
    private readonly moderation: ModerationService,
    private readonly families: FamiliesService,
    private readonly memberships: MembershipsService,
    private readonly ledger: LedgerService,
    private readonly activity: ActivityService,
    private readonly territories: TerritoriesService,
    private readonly henchmen: HenchmenService,
    private readonly inventory: InventoryService,
  ) {}

  // ── Inspect ──────────────────────────────────────────────────────────────

  async inspectPlayer(handle: string): Promise<PlayerReport> {
    const account = await this.account(handle);
    return {
      account,
      membership: await this.families.membershipOf(account.playerId),
      audit: await this.moderation.auditFor("player", account.playerId, 10),
    };
  }

  async inspectFamily(tag: string): Promise<FamilyReport> {
    const { id } = await this.family(tag);
    return {
      family: await this.families.getFamily(id),
      balance: await this.ledger.balance(id),
      holdings: await this.territories.holdingsOf(id),
      henchmen: await this.henchmen.activeOf(id),
      inventory: await this.inventory.contentsOf(id),
      ledger: (await this.ledger.treasuryPage(id, undefined, 20)).items,
      audit: await this.moderation.auditFor("family", id, 10),
    };
  }

  // ── Adjust ───────────────────────────────────────────────────────────────

  /**
   * Credits (positive) or debits (negative) a family's treasury from the `admin` system account. A debit can't
   * take the treasury below zero (InsufficientFunds, nothing written). Returns the new balance.
   */
  async adjustTreasury(tag: string, amount: number, reason: string): Promise<number> {
    if (!Number.isSafeInteger(amount) || amount === 0) throw new Error("The amount must be a non-zero whole number of naira.");
    if (!reason.trim()) throw new Error("Give a reason.");
    const { id: familyId } = await this.family(tag);
    return this.db.transaction(async (tx) => {
      // The family row first (the schema's lock order), so a disband can't run between the check and the posting.
      const locked = (await this.memberships.lockFamilies(tx, [familyId])).get(familyId);
      if (!locked || locked.disbandedAt) throw notFound("Family");
      await this.ledger.post(tx, {
        kind: "admin_adjust",
        idempotencyKey: `admin:${randomUUID()}`,
        ref: { type: "family", id: familyId },
        lines: [
          { accountId: await this.ledger.treasuryId(tx, familyId), amount, reason: "admin_adjustment" },
          { accountId: await this.ledger.systemAccount("admin", tx), amount: -amount, reason: "admin_adjustment" },
        ],
      });
      await this.activity.record(tx, { familyId, actorPlayerId: null, type: "admin.adjusted", payload: { amount, reason } });
      await this.moderation.audit(tx, null, "adjust_treasury", "family", familyId, { amount, reason });
      return this.ledger.balance(familyId, tx);
    });
  }

  // ── Ban ──────────────────────────────────────────────────────────────────

  /**
   * Bars the account from logging in, ends all its sessions and disconnects its live connections. Family
   * membership is untouched: a banned Don is replaced by the usual inactivity succession. Returns sessions ended.
   */
  async ban(handle: string, reason: string): Promise<number> {
    if (!reason.trim()) throw new Error("Give a reason.");
    const account = await this.account(handle);
    return this.db.transaction(async (tx) => {
      if (!(await this.accounts.setStatus(tx, account.userId, "banned"))) throw new Error(`${account.handle} is already banned.`);
      const ended = await this.sessions.deleteAllFor(tx, account.userId);
      await this.moderation.audit(tx, null, "ban_player", "player", account.playerId, { reason, sessionsEnded: ended });
      return ended;
    });
  }

  async unban(handle: string, reason: string): Promise<void> {
    const account = await this.account(handle);
    await this.db.transaction(async (tx) => {
      if (!(await this.accounts.setStatus(tx, account.userId, "active"))) throw new Error(`${account.handle} isn't banned.`);
      await this.moderation.audit(tx, null, "unban_player", "player", account.playerId, reason.trim() ? { reason } : {});
    });
  }

  private async account(handle: string): Promise<AccountRecord> {
    const account = await this.accounts.accountByHandle(handle);
    if (!account) throw notFound(`Player ${handle}`);
    return account;
  }

  private async family(tag: string) {
    const family = await this.memberships.familyByTag(tag);
    if (!family) throw notFound(`Family [${tag}]`);
    return family;
  }
}
