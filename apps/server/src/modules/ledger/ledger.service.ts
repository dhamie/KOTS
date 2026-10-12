import { Inject, Injectable } from "@nestjs/common";
import type { LedgerPage } from "@kots/shared";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { AppError } from "../../common/errors";
import { DB, type Database } from "../../db/db";
import { currencyAccounts, ledgerEntries, ledgerTransactions, type LedgerKind } from "../../db/schema";
import type { DbOrTx, Tx } from "../../db/tx";

/** Where money comes from and goes to. Created by migrations 0003, 0004, 0005, 0009 and 0010. */
export const SYSTEM_ACCOUNTS = ["grants", "territory_income", "territory_upkeep", "claim_fees", "disbanded", "recruitment", "wages", "market", "battle_fees", "events"] as const;
export type SystemAccount = (typeof SYSTEM_ACCOUNTS)[number];

export interface PostingLine {
  accountId: string;
  /** Signed whole ₦: positive is money into the account. */
  amount: number;
  reason: string;
}

export interface Posting {
  kind: LedgerKind;
  /** Unique per movement; posting the same key twice does nothing the second time. */
  idempotencyKey: string;
  actorPlayerId?: string | null;
  ref?: { type: string; id: string };
  lines: PostingLine[];
}

/** A debit would take a treasury below zero. Nothing was written. */
export class InsufficientFunds extends AppError {
  constructor() {
    super(409, "INSUFFICIENT_FUNDS", "The treasury doesn't have enough money for that.");
  }
}

/**
 * The only code that changes balances. Every posting is double-entry (its lines sum to zero) and runs inside the
 * caller's transaction. A debit is a conditional update, so concurrent spending can't take a treasury negative.
 * System accounts don't track a balance: they are sources and sinks, and updating them would make every
 * posting in the game queue on the same few rows.
 */
@Injectable()
export class LedgerService {
  private readonly systemIds = new Map<SystemAccount, string>();

  constructor(@Inject(DB) private readonly db: Database) {}

  async openTreasury(tx: Tx, familyId: string): Promise<string> {
    const [row] = await tx.insert(currencyAccounts).values({ kind: "family_treasury", familyId }).returning({ id: currencyAccounts.id });
    return row!.id;
  }

  async treasuryId(db: DbOrTx, familyId: string): Promise<string> {
    const [row] = await db.select({ id: currencyAccounts.id }).from(currencyAccounts).where(eq(currencyAccounts.familyId, familyId));
    if (!row) throw new Error(`family ${familyId} has no treasury`);
    return row.id;
  }

  /** Pass the caller's transaction when inside one, so the lookup doesn't need a second pool connection. */
  async systemAccount(code: SystemAccount, db: DbOrTx = this.db): Promise<string> {
    let id = this.systemIds.get(code);
    if (!id) {
      const [row] = await db.select({ id: currencyAccounts.id }).from(currencyAccounts).where(eq(currencyAccounts.code, code));
      if (!row) throw new Error(`system account ${code} is missing; run the migrations`);
      id = row.id;
      this.systemIds.set(code, id);
    }
    return id;
  }

  async balance(familyId: string, db: DbOrTx = this.db): Promise<number> {
    const [row] = await db.select({ balance: currencyAccounts.balance }).from(currencyAccounts).where(eq(currencyAccounts.familyId, familyId));
    return row?.balance ?? 0;
  }

  /**
   * Writes one balanced transaction. Returns "duplicate" (and writes nothing) if the key was already used.
   * Throws InsufficientFunds if a treasury would go negative; the caller's transaction should then roll back,
   * or the call should run in a savepoint (`tx.transaction(...)`) if the caller wants to carry on.
   */
  async post(tx: Tx, posting: Posting): Promise<"posted" | "duplicate"> {
    const lines = posting.lines;
    if (lines.length < 2) throw new Error("a posting needs at least two lines");
    if (lines.some((l) => !Number.isSafeInteger(l.amount) || l.amount === 0)) throw new Error("posting amounts must be non-zero whole numbers");
    if (lines.reduce((s, l) => s + l.amount, 0) !== 0) throw new Error("posting lines must sum to zero");

    const [txn] = await tx
      .insert(ledgerTransactions)
      .values({
        kind: posting.kind,
        idempotencyKey: posting.idempotencyKey,
        actorPlayerId: posting.actorPlayerId ?? null,
        refType: posting.ref?.type ?? null,
        refId: posting.ref?.id ?? null,
      })
      .onConflictDoNothing({ target: ledgerTransactions.idempotencyKey })
      .returning({ id: ledgerTransactions.id });
    if (!txn) return "duplicate";

    const accountIds = [...new Set(lines.map((l) => l.accountId))].sort();
    const kinds = new Map(
      (await tx.select({ id: currencyAccounts.id, kind: currencyAccounts.kind }).from(currencyAccounts).where(inArray(currencyAccounts.id, accountIds))).map(
        (a) => [a.id, a.kind],
      ),
    );

    const balanceAfter = new Map<PostingLine, number | null>();
    // Accounts in id order, so two postings touching the same treasuries lock them in the same order.
    for (const accountId of accountIds) {
      const own = lines.filter((l) => l.accountId === accountId);
      const kind = kinds.get(accountId);
      if (!kind) throw new Error(`unknown account ${accountId}`);
      if (kind === "system") {
        for (const l of own) balanceAfter.set(l, null);
        continue;
      }
      const net = own.reduce((s, l) => s + l.amount, 0);
      const [row] = await tx
        .update(currencyAccounts)
        .set({ balance: sql`${currencyAccounts.balance} + ${net}` })
        .where(and(eq(currencyAccounts.id, accountId), sql`${currencyAccounts.balance} + ${net} >= 0`))
        .returning({ balance: currencyAccounts.balance });
      if (!row) throw new InsufficientFunds();
      // Walk the account's lines in order, ending at the final balance.
      let running = row.balance - net;
      for (const l of own) {
        running += l.amount;
        balanceAfter.set(l, running);
      }
    }

    await tx.insert(ledgerEntries).values(
      lines.map((l) => ({ transactionId: txn.id, accountId: l.accountId, amount: l.amount, balanceAfter: balanceAfter.get(l) ?? null, reason: l.reason })),
    );
    return "posted";
  }

  /** Moves whatever is left in a disbanded family's treasury to the `disbanded` system account. */
  async closeTreasury(tx: Tx, familyId: string, actorPlayerId: string): Promise<void> {
    const [account] = await tx
      .select({ id: currencyAccounts.id, balance: currencyAccounts.balance })
      .from(currencyAccounts)
      .where(eq(currencyAccounts.familyId, familyId))
      .for("update");
    if (!account || account.balance === 0) return;
    await this.post(tx, {
      kind: "disband",
      idempotencyKey: `disband:${familyId}`,
      actorPlayerId,
      ref: { type: "family", id: familyId },
      lines: [
        { accountId: account.id, amount: -account.balance, reason: "family_disbanded" },
        { accountId: await this.systemAccount("disbanded", tx), amount: account.balance, reason: "family_disbanded" },
      ],
    });
  }

  /** A family treasury's entries, newest first. Authorisation is the caller's job. */
  async treasuryPage(familyId: string, before: string | undefined, limit: number): Promise<LedgerPage> {
    const accountId = await this.treasuryId(this.db, familyId);
    const rows = await this.db
      .select({
        id: ledgerEntries.id,
        amount: ledgerEntries.amount,
        balanceAfter: ledgerEntries.balanceAfter,
        reason: ledgerEntries.reason,
        kind: ledgerTransactions.kind,
        refType: ledgerTransactions.refType,
        refId: ledgerTransactions.refId,
        createdAt: ledgerTransactions.createdAt,
      })
      .from(ledgerEntries)
      .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.transactionId))
      .where(and(eq(ledgerEntries.accountId, accountId), before ? lt(ledgerEntries.id, BigInt(before)) : undefined))
      .orderBy(desc(ledgerEntries.id))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map((r) => ({
      id: r.id.toString(),
      kind: r.kind,
      reason: r.reason,
      amount: r.amount,
      balanceAfter: r.balanceAfter ?? 0,
      ref: r.refType && r.refId ? { type: r.refType, id: r.refId } : null,
      createdAt: r.createdAt.toISOString(),
    }));
    return { items, nextCursor: rows.length > limit ? items[items.length - 1]!.id : null };
  }
}
