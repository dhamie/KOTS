# Economy (Phases 4–5)

How money, territory, upkeep, henchmen, goods and the markets work, and where to tune them. All amounts are whole ₦.

## Where things live
| What | Where |
|---|---|
| Tuning values | `packages/content/src/economy.ts` (`ECONOMY`) |
| Territory income and base upkeep | `packages/content/src/map/territories.ts`, copied into the DB by `npm run db:seed` |
| Formulas (pure) | `packages/rules/src/economy.ts` (`claimQuote`, `territoryUpkeep`, `checkClaim`, `upkeepStatus`); succession in `rules/src/family.ts` (`pickSuccessor`) |
| Who may do what | `packages/content/src/roles.ts` (`territory.claim`, `territory.abandon`, `treasury.view`, `henchmen.*`, `market.trade`, `trade.propose`, `trade.accept`) |
| Money movements | `apps/server/src/modules/ledger` (the only code that changes balances) |
| Claims, upkeep sweep | `apps/server/src/modules/territories` |
| Henchman archetypes, names, traits, board and morale tuning | `packages/content/src/henchmen.ts` (`ARCHETYPES`, `RECRUITMENT`) |
| Board generation, pricing, morale (pure) | `packages/rules/src/henchmen.ts` (`generateBoard`, `boardDay`, `moraleAfter`) |
| Hiring, assignment, wages | `apps/server/src/modules/henchmen` |
| Goods, markets, storage and market tuning | `packages/content/src/goods.ts` (`GOODS`, `MARKETS`, `MARKET`, `STORAGE`), copied into the DB by `npm run db:seed` |
| Prices, quotes, storage, drift (pure) | `packages/rules/src/market.ts` (`midPrice`, `quoteOrder`, `storageCapacity`, `driftStock`) |
| Inventory; market orders and drift | `apps/server/src/modules/inventory`; `apps/server/src/modules/market` |
| Trade limits; offer checks (pure) | `packages/content/src/economy.ts` (`TRADES`); `packages/rules/src/trades.ts` (`checkTerms`, `oldEnoughToTrade`) |
| Offers, acceptance, expiry | `apps/server/src/modules/trades` |
| Schedules | `apps/server/src/worker` (upkeep and wages every 5 min, trade expiry every 5 min, market drift at :01 and :31, succession hourly at :17) |

## Rules
- **Starting grant:** a new family's treasury gets ₦20,000.
- **Claiming:** a neutral territory costs `fee + first period's upkeep`. The fee is 5 × base upkeep, waived while the family holds nothing. Claims by one family run one at a time (its family row is locked), so two clicks can't both pass the fee or adjacency check.
- **Adjacency:** a family's first territory can be anywhere. After that, the target must border one it holds: a shared edge on the map grid, or the two ends of a bridge (Third Mainland: Akoka–Obalende, Carter: Iddo–Ebute Ero, Eko: Ijora–Idumota). Borders are computed from the map in `content/src/map/layout.ts`.
- **Upkeep growth:** each territory's upkeep is `base × (1 + 0.1 × (holdings − 1))`, rounded.
- **Upkeep periods:** each territory has its own 24 h period, starting when it was claimed. `upkeep_paid_until` is the end of the paid period.
- **Settling a period:** one posting credits the territory's income and charges its upkeep. It goes through only if the treasury can cover the net amount.
  - Paid: `upkeep_paid_until` moves on 24 h. Missed periods (e.g. a worker outage) are all settled in order.
  - Not paid: the territory is **neglected** and earns nothing until it is paid. The sweep retries every run.
  - Unpaid 48 h past the end of the paid period: it returns to **neutral** (`lapsed` in the ownership history).
- **Abandoning:** the territory becomes neutral at once; nothing is refunded.
- **Disbanding:** every territory becomes neutral, and the remaining balance moves to the `disbanded` system account.
- **Succession:** if a Don has had no activity for 7 days, the most senior member active in that window (highest rank, then earliest joiner) becomes Don and the old Don becomes Underboss. If nobody else is active, nothing changes. Activity is the session refresh (at most hourly) and logging in.

## Henchmen
- **Five archetypes:** Agbero (muscle), Driver (logistics), Fixer (negotiation), Bookkeeper (discipline and reliability), Ex-soldier (combat and discipline, expensive). Each has a range for every attribute, a hire cost, a daily wage and a weight on the board. Adding one is a data change.
- **The daily board:** 4 candidates per family, replaced at midnight Lagos time (23:00 UTC). It's computed from the family id and the day with the seeded RNG, so there's no table, and everyone in the family sees the same board. Its key, `{family}:{day}:{slot}`, is unique, so a candidate can only be hired once.
- **Price:** a candidate's hire cost and wage are the archetype's, scaled 0.8×–1.2× by how good their rolls are within the archetype's ranges.
- **Hiring** costs `hire cost + the first day's wage` and needs `henchmen.recruit` (Don, Underboss, Capo, Quartermaster).
- **Assigning** to a territory the family holds needs `henchmen.assign` (Don, Underboss, Capo). Several henchmen can guard one territory. Assignments have no effect until battles (Phase 7). When a territory changes hands, its guards go back to idle.
- **Dismissing** needs `henchmen.dismiss` (Don, Underboss). Nothing is refunded. Disbanding a family dismisses everyone.
- **Wages** work like upkeep: one 24 h period at a time from the hire, settled by the sweep, all missed periods caught up in order.
  - Paid: morale +5 (max 100). New hires start at 70.
  - Unpaid: the wage is overdue and morale drops 25, once per lapse.
  - Unpaid 48 h past the end of the paid period: the henchman deserts.
- Morale, loyalty and the other attributes are stored and shown, but nothing else uses them until battles and events.

## Goods and markets
- **Five goods:** fuel (₦120), textiles (₦200), imported goods (₦350), electronics (₦700), contraband (₦1,200). Each also has an elasticity (how hard its price reacts to stock) and a volatility (how much its stock wobbles).
- **Three markets,** one per district: Tejuosho (Yaba), Balogun (Lagos Island), Apapa Wharf. Each market has a normal stock and a price factor for every good: imports are cheap at the wharf, most things sell well on the Island, textiles are cheap at Tejuosho.
- **Price:** `base × factor × (normal stock ÷ stock)^elasticity`, kept between 0.5× and 2× of `base × factor`. It isn't stored; it's computed from stock.
- **Orders are priced one unit at a time:** every unit bought takes stock down one and raises the next unit's price; every unit sold does the reverse. Markets charge 5% above the price and pay 5% below it, so buying and selling straight back always loses.
- **Limits:** at most 500 units per order. A market won't sell stock it doesn't have, and stops buying a good at 3× its normal stock.
- **Who:** Don, Underboss and Quartermaster (`market.trade`). Any family can use any market. Prices are visible to every player; a family's goods only to its members.
- **The price guard:** an order carries `limitTotal`, the quote the player saw. If the price has moved past it (someone traded first), the order is refused with `PRICE_CHANGED` and nothing changes.
- **Retries:** each order needs an `Idempotency-Key` header. The same key from the same family fills once and returns the same receipt; reusing it for a different order is refused. A refused order can be retried with its key.
- **Drift:** every 30 minutes each market's stock moves 10% of the way back to normal, plus a seeded random wobble of up to the good's volatility. A step is applied once (`drift_step`), however often the job runs. A missed step isn't caught up; the next run just applies the current one.

## Storage
- A family can hold 50 units, plus per territory held: logistics 100, industrial 60, commercial 40, others 20. One unit of any good takes one unit of space.
- Buying past capacity is refused (`STORAGE_FULL`). Losing territory can leave a family over capacity: nothing is destroyed, it just can't buy until it's back under.

## Trades between families
- **An offer** lists what the offering family gives and what it wants: up to 5 items each side, each a good and quantity or cash (at most ₦10,000,000 a side), each listed once. One side may be empty (a gift or a request), not both. The other family is named by its tag.
- **Who:** Don, Underboss and Quartermaster make and cancel offers (`trade.propose`) and accept and decline them (`trade.accept`). An offer belongs to the family, not the member who made it.
- **Age rule:** both families must be at least 3 days old, checked when the offer is made and again when it's accepted, so throwaway families can't pass their starting grants on.
- **Limits:** at most 10 open outgoing offers per family; offers expire after 24 hours.
- **Nothing is reserved.** Accepting re-checks everything and runs the trade in one transaction: goods leave both families first (so a swap of the same good fits), then arrive, then cash moves in one ledger posting between the two treasuries. Cash on both sides is netted, so only the net payer needs the money. If any family is short of goods, storage or cash, nothing moves, the offer stays open, and the error names the family.
- **Exactly once:** the trade is marked executed only `WHERE status = 'open'`, under its row lock. Accepting an executed trade again returns it unchanged. Cancel, decline, accept and expiry race safely: exactly one wins.
- **Expiry:** a worker job marks offers past their time as expired every 5 minutes; accepting checks the time itself, so a late sweep never lets an old offer through. A family that disbands can't complete its open offers.
- Both families' activity logs record offers, trades, declines, cancellations and expiries. There are no notifications yet (Phase 6).

## Balance notes
- A single territory always earns more than its upkeep, so with today's numbers neglect comes from spending (claims now; henchmen and battles later), or from growth. Upkeep overtakes a territory's income at this many holdings: Tinubu Square 8, most others 12–14, the residential mainland 16–17. Beyond that, extra territory costs money every day.
- Henchman wages (₦100–420 a day) are a real drain next to territory income (₦450–1,200 a day per territory). A small family can run a few, not a dozen.
- Market gaps are around 10–25% before slippage. Twenty imported goods bought at the wharf and sold on the Island make about ₦1,000; fifty make only about ₦1,200, because each unit moves the price. Drift refills a market slowly, so repeating the same run pays less each time.
- Trading is instant: there's no travel time or risk in moving goods yet. That's the main lever if trading proves too easy.
- These numbers are first guesses. Change them in `ECONOMY` or in the territory data; the rules tests show the expected shape of each formula.

## Ledger
- Every movement is a balanced posting (its entries sum to zero) with a unique idempotency key: `grant:{family}`, `claim:{history id}`, `upkeep:{territory}:{period end}`, `disband:{family}`, `hire:{family}:{day}:{slot}`, `wage:{henchman}:{period end}`, `market:{order id}`, `trade:{trade id}`, `proposal:{proposal id}` (the price of a territory transfer, Phase 6b; see `docs/CHAT.md`), `battle:{id}:fee` and `battle:{id}:refund` (Phase 7; see `docs/BATTLES.md`). Posting a key twice does nothing.
- A debit is a conditional update (`balance + n >= 0`), and a check constraint backs it up, so concurrent spending can't take a treasury negative.
- **System accounts** (`grants`, `territory_income`, `territory_upkeep`, `claim_fees`, `disbanded`, `recruitment`, `wages`, `market`) record entries but don't track a balance. Updating one row on every posting in the game would serialise them all. Their totals are the sum of their entries.
- Tests check after each scenario that every posting sums to zero and every treasury's balance equals its entries (`apps/server/test/economy.test.ts`), and that goods add up: each family holds exactly what its orders bought minus what they sold, and the market account's entries equal the order totals (`apps/server/test/market.test.ts`). Trades are included: goods moved by executed trades count toward each family's expected holdings.
- `apps/server/test/concurrency.test.ts` fires trades and market orders at the same moment (duplicate accepts, trades in both directions, a trade racing a market sale, accept against cancel, decline and expiry, and a mixed load of about 200 actions) and runs the checks above after each.
