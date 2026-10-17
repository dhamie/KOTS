# City events (Phase 8a)

How city events work and where to tune them. Every event is fictional and abstract: no real organisation, agency or procedure is modelled.

## Where things live
| What | Where |
|---|---|
| Event types and tuning (weights, durations, cooldowns, effect sizes, the hourly chance, the cap, how long news stays) | `packages/content/src/events.ts` (`EVENT_DEFS`, `EVENTS`) |
| Rolling and planning an event (pure, deterministic) | `packages/rules/src/events.ts` (`rollEvent`, `planEvent`, `eligibleTypes`) |
| Creating, starting and ending events, the news | `apps/server/src/modules/events` |
| Schedules | `apps/server/src/worker/event-generate.job.ts` (hourly, at :07), `event-sweep.job.ts` (every minute) |
| Triggering one by hand | `apps/server/src/main.event.ts` (`npm run event:trigger`) |
| Screens | City news in `ui/map/DistrictNav.tsx`; notes in `ui/map/TerritoryPanel.tsx` and `ui/market/MarketView.tsx`; history text in `ui/family/FamilyView.tsx` |

## The event types
| Type | Covers | Effect, applied once when it starts |
|---|---|---|
| Port congestion | one market | One of imported goods, electronics or textiles drops to 30–50% of its stock there. Prices rise; market drift brings the stock back over a few hours. |
| Fuel scarcity | the city | Fuel drops to 40–60% of its stock at every market. |
| Street festival | one district | Each family holding territory there is paid a day's base income per territory there, from the `events` system account. |
| Police sweep | one district | Henchmen guarding territories there lose 5–10 morale. |

Each stays in the news as current for 6–8 hours, then as ended for a day.

## How an event runs
1. **The hourly roll** (`events.generate`). With a 25% chance, and while fewer than 2 events are current, `rollEvent` picks a type whose cooldown has passed (by weight), then `planEvent` picks the place (for festivals and sweeps, weighted by the district's officials: see docs/OFFICIALS.md) and the effect size. The roll's seed comes from the server. The row is written with the dedupe key `generate:{hour}`, so a retried or overlapping run can't add a second event in the same hour. (A retry after a crash rolls again with a new seed: an hour that rolled nothing may still get an event. At most one either way.)
2. **Starting** (`events.sweep`, every minute). A due event moves `scheduled → active` through a conditional update. Its effect is applied in the same transaction, through the services that own the data: MarketService for stock, LedgerService for payments (key `event:{event}:{family}`), HenchmenService for morale, ActivityService for family history and notifications. A second sweep finds nothing to start, so nothing is applied twice.
3. **Ending.** When `expires_at` passes, the sweep moves it `active → expired`. It stays in the news for `EVENTS.newsHours`.
4. **Live updates.** Starting and ending an event sends `events.changed` to every connected browser, which reloads the news and the market prices. Families an event touched also get `family.changed` and notifications: the festival tells members who can see the treasury; the police sweep tells every member.

Lock order: the event row (by the conditional update) → territories (FOR SHARE, so a festival can't pay for land changing hands) → henchmen → market stock → treasuries in id order. This fits the schema's order (`world_events` sits between `battles` and `territories`).

## Triggering an event
```bash
npm run event:trigger street_festival lagos-island   # a district
npm run event:trigger port_congestion balogun        # a market
npm run event:trigger fuel_scarcity                  # the whole city
npm run event:trigger police_sweep                   # a random district
```
It schedules the event to start now; the worker's sweep starts it within a minute. Each use is written to `moderation_actions` (`trigger_event`). Set `DATABASE_URL` to target another database. The browser test uses it.

## API
`GET /api/events` (signed in): current events, then those that ended in the last day, newest first, at most 20. Each has a headline and body written by the server.

## Tests
- Rules (`packages/rules/test/events.test.ts`): planning and rolling are deterministic; places and effect sizes stay in range; the hourly chance, the cap and cooldowns hold; every type can come up.
- Server (`apps/server/test/events.test.ts`): a festival pays each holder in the district exactly once (two overlapping sweeps), with the right amounts, history, notifications and ledger keys, and pays no one in an empty district; a police sweep lowers only the district's guards' morale, once; port congestion and fuel scarcity cut the right stock, and drift restores it; events don't start early, end on time and leave the news after a day; browsers get `events.changed`; the roll makes at most one event an hour, none at the cap, and respects cooldowns.
- Browser (`e2e/events.spec.ts`): a family claims a territory, an operator triggers a festival there with the command, and the news, the territory panel, the bell, the treasury and the history all update without a reload.

## Limits and follow-ups
- Effects are one-off. There are no lasting modifiers (for example, "income +20% for 6 hours"); that would need every income and price calculation to consult current events.
- The numbers are first guesses. Festivals add money to the economy; police sweeps only cost morale.
- NPC officials (Phase 8b) sway which district a rolled festival or police sweep hits, and are named in those stories. See docs/OFFICIALS.md.
- The data model in ARCHITECTURE.md lists more scopes, a `resolved` state and a `severity` column. Only what these four types need was built: scopes `market|district|city`, states `scheduled|active|expired`, and the effect size in `payload`.
