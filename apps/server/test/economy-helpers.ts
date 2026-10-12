import { FamilyDetail, Treasury } from "@kots/shared";
import { sql } from "drizzle-orm";
import { expect } from "vitest";
import { uuidv7 } from "../src/common/uuid";
import { LedgerService } from "../src/modules/ledger/ledger.service";
import { newPlayer, type TestApi } from "./helpers";

type Role = "underboss" | "consigliere" | "capo" | "enforcer" | "quartermaster" | "associate";

/** Family, money and ledger helpers shared by the economy and henchmen tests. `api()` is read lazily (set in beforeAll). */
export function economyHelpers(api: () => TestApi, prefix: string) {
  let n = 0;
  const rows = async <T>(q: ReturnType<typeof sql>) => (await api().db.execute(q)).rows as T[];

  /** A Don with a fresh family, plus `roles.length` members who joined and were given those roles. */
  async function family(roles: Role[] = []) {
    const k = ++n; // read before any await, so concurrent calls get distinct names
    const don = await newPlayer(api().base);
    const created = await don.client.post("/families", { name: `${prefix} ${k} ${Date.now() % 1e5}`, tag: `${prefix.slice(0, 2).toUpperCase()}${k}` });
    expect([created.status, created.body?.code]).toEqual([201, undefined]);
    const fam = FamilyDetail.parse(created.body);
    const members = [];
    for (const role of roles) {
      const m = await newPlayer(api().base);
      const inv = await don.client.post(`/families/${fam.id}/invitations`, { handle: m.handle });
      expect((await m.client.post(`/invitations/${inv.body.id}/accept`)).status).toBe(200);
      if (role !== "associate") expect((await don.client.patch(`/families/${fam.id}/members/${m.id}`, { role })).status).toBe(200);
      members.push(m);
    }
    return { don, id: fam.id, tag: fam.tag, members };
  }

  const balance = async (client: { get: (p: string) => Promise<{ body: unknown }> }, familyId: string) =>
    Treasury.parse((await client.get(`/families/${familyId}/treasury`)).body).balance;

  /** Moves money between a treasury and the grants account through the ledger, so every invariant still holds. */
  async function adjust(familyId: string, amount: number): Promise<void> {
    if (amount === 0) return;
    const ledger = api().app.get(LedgerService);
    await api().db.transaction(async (tx) =>
      ledger.post(tx, {
        kind: "grant",
        idempotencyKey: `test:${uuidv7()}`,
        lines: [
          { accountId: await ledger.treasuryId(tx, familyId), amount, reason: "test_adjustment" },
          { accountId: await ledger.systemAccount("grants", tx), amount: -amount, reason: "test_adjustment" },
        ],
      }),
    );
  }
  const setBalance = async (familyId: string, target: number) => adjust(familyId, target - (await api().app.get(LedgerService).balance(familyId)));

  /** Every posting sums to zero, every treasury's balance matches its entries, and none is negative. */
  async function expectLedgerConsistent(): Promise<void> {
    expect(await rows(sql`select transaction_id from ledger_entries group by transaction_id having sum(amount) <> 0`)).toEqual([]);
    expect(
      await rows(sql`
        select a.id from currency_accounts a
        left join ledger_entries e on e.account_id = a.id
        where a.kind = 'family_treasury'
        group by a.id, a.balance
        having a.balance <> coalesce(sum(e.amount), 0) or a.balance < 0`),
    ).toEqual([]);
    // The newest entry's balance_after is the account's balance.
    expect(
      await rows(sql`
        select a.id from currency_accounts a
        join lateral (select balance_after from ledger_entries where account_id = a.id order by id desc limit 1) last on true
        where a.kind = 'family_treasury' and last.balance_after <> a.balance`),
    ).toEqual([]);
  }

  /**
   * Goods and market money add up: no stack or stock is negative; each family holds exactly what its market orders
   * bought minus what they sold, plus what executed trades moved in minus what they moved out; and the market
   * account's entries equal the order totals.
   */
  async function expectMarketConsistent(): Promise<void> {
    expect(await rows(sql`select 1 from inventory_stacks where quantity < 0 union all select 1 from npc_market_state where stock < 0`)).toEqual([]);
    expect(
      await rows(sql`
        with flows as (
          select family_id, good, case side when 'buy' then quantity else -quantity end as q from market_orders
          union all
          select case l.side when 'gives' then t.from_family_id else t.to_family_id end, l.good, -l.quantity
          from trade_lines l join trades t on t.id = l.trade_id where t.status = 'executed' and l.good is not null
          union all
          select case l.side when 'gives' then t.to_family_id else t.from_family_id end, l.good, l.quantity
          from trade_lines l join trades t on t.id = l.trade_id where t.status = 'executed' and l.good is not null
        ),
        net as (select family_id, good, sum(q)::int as net from flows group by family_id, good)
        select coalesce(n.family_id, s.family_id) as family_id, n.net, s.quantity from net n
        full join inventory_stacks s on s.family_id = n.family_id and s.good = n.good
        where coalesce(n.net, 0) <> coalesce(s.quantity, 0)`),
    ).toEqual([]);
    const [money] = await rows<{ entries: string | null; orders: string | null }>(sql`
      select
        (select sum(e.amount) from ledger_entries e join currency_accounts a on a.id = e.account_id where a.code = 'market') as entries,
        (select sum(case side when 'buy' then total else -total end) from market_orders) as orders`);
    expect(Number(money!.entries ?? 0)).toBe(Number(money!.orders ?? 0));
  }

  /** Makes a family old enough to trade (TRADES.minFamilyAgeDays). */
  const ageForTrading = (familyId: string) => api().db.execute(sql`update families set founded_at = founded_at - interval '4 days' where id = ${familyId}`);

  return { rows, family, balance, adjust, setBalance, expectLedgerConsistent, expectMarketConsistent, ageForTrading };
}
