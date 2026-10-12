import { Inject, Injectable } from "@nestjs/common";
import type { GoodKey } from "@kots/content";
import { storageCapacity } from "@kots/rules";
import type { Inventory } from "@kots/shared";
import { and, asc, eq, gt, gte, sql } from "drizzle-orm";
import { conflict } from "../../common/errors";
import { DB, type Database } from "../../db/db";
import { inventoryStacks } from "../../db/schema";
import type { DbOrTx, Tx } from "../../db/tx";
import { MembershipsService } from "../families/memberships.service";
import { HoldingsService } from "../territories/holdings.service";

/**
 * Goods a family holds. The only code that writes inventory_stacks. Callers that change a family's goods hold its
 * family row lock (MembershipsService.lockActing), so the storage check and the change can't race.
 */
@Injectable()
export class InventoryService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly memberships: MembershipsService,
    private readonly holdings: HoldingsService,
  ) {}

  async view(viewerId: string, familyId: string): Promise<Inventory> {
    await this.memberships.requireMemberOf(viewerId, familyId);
    const items = await this.db
      .select({ good: inventoryStacks.good, quantity: inventoryStacks.quantity })
      .from(inventoryStacks)
      .where(and(eq(inventoryStacks.familyId, familyId), gt(inventoryStacks.quantity, 0)))
      .orderBy(asc(inventoryStacks.good));
    return { capacity: await this.capacity(familyId), used: items.reduce((s, i) => s + i.quantity, 0), items };
  }

  /** Adds goods, refusing with STORAGE_FULL if they don't fit. */
  async add(tx: Tx, familyId: string, good: GoodKey, quantity: number): Promise<void> {
    const capacity = await this.capacity(familyId, tx);
    const used = await this.used(familyId, tx);
    if (used + quantity > capacity) {
      throw conflict("STORAGE_FULL", `Your family can store ${capacity} units and holds ${used}; ${quantity} more won't fit.`);
    }
    await tx
      .insert(inventoryStacks)
      .values({ familyId, good, quantity })
      .onConflictDoUpdate({ target: [inventoryStacks.familyId, inventoryStacks.good], set: { quantity: sql`${inventoryStacks.quantity} + ${quantity}` } });
  }

  /** Removes goods with a conditional update, refusing with INSUFFICIENT_STOCK if the family holds fewer. */
  async remove(tx: Tx, familyId: string, good: GoodKey, quantity: number): Promise<void> {
    const [row] = await tx
      .update(inventoryStacks)
      .set({ quantity: sql`${inventoryStacks.quantity} - ${quantity}` })
      .where(and(eq(inventoryStacks.familyId, familyId), eq(inventoryStacks.good, good), gte(inventoryStacks.quantity, quantity)))
      .returning({ quantity: inventoryStacks.quantity });
    if (!row) throw conflict("INSUFFICIENT_STOCK", `Your family doesn't hold ${quantity} of that.`);
  }

  private async capacity(familyId: string, db: DbOrTx = this.db): Promise<number> {
    return storageCapacity(await this.holdings.kindsHeld(familyId, db));
  }

  private async used(familyId: string, db: DbOrTx): Promise<number> {
    const [row] = await db
      .select({ used: sql<number>`coalesce(sum(${inventoryStacks.quantity}), 0)::int` })
      .from(inventoryStacks)
      .where(eq(inventoryStacks.familyId, familyId));
    return row!.used;
  }
}
