# Battles (Phase 7)

How territory battles work, and where to tune them. 7a is the rules and the server; 7b is the screens.

## Where things live
| What | Where |
|---|---|
| Tuning (times, fee, protection, cooldown, limits, strength and injury numbers) | `packages/content/src/battles.ts` (`BATTLES`, `TACTICS`, `BEATS`, `DEFAULT_TACTIC`) |
| Who may do what | `packages/content/src/roles.ts`: `war.declare` (Don, Underboss), `war.command` (Don, Underboss, Capo, Enforcer) |
| The resolver and declaration checks (pure, deterministic) | `packages/rules/src/battles.ts` (`resolveRound`, `replay`, `battleOver`, `battleWinner`, `checkDeclaration`) |
| Declaring, committing, orders, withdrawing, the round sweep | `apps/server/src/modules/battles` |
| Schedule | `apps/server/src/worker/battle-sweep.job.ts` (every minute) |
| Screens | `apps/client/src/ui/battles/BattlePanel.tsx`; declaring in `ui/map/TerritoryPanel.tsx`; the list in `ui/family/FamilyView.tsx`; the contested ring in `map/CityScene.ts` |

## How a battle runs
1. **Declaring** (`POST /api/territories/:slug/battles`, Don or Underboss). The target must be held by another family and border land the attacker holds. Refused if: it's the defender's last territory; either family is under 3 days old; a ceasefire is in force; the two families fought in the last 24 h; the attacker is already attacking somewhere; the territory is already contested; the treasury can't pay the fee (3 days of the territory's base upkeep, to the `battle_fees` system account).
2. **Preparation, 6 h.** The defender's guards on the territory are committed automatically. Commanders (Don, Underboss, Capo, Enforcer) commit or release up to 8 of their family's fit henchmen (`POST /api/battles/:id/commit`, `/release`). While the battle lasts, the territory can't be abandoned or transferred, and committed henchmen can't be reassigned or dismissed.
3. **Rounds, every 2 h, at most 3.** Commanders send a tactic for the next round (`POST /api/battles/:id/orders`), and can change it until the round resolves. Press beats flank, flank beats hold, hold beats press. Without orders the attacker presses and the defender holds.
4. **Resolving a round** (worker, `resolveRound`): each side's strength is its fighters' combat (steadied by discipline), lifted by its best leader, scaled by average morale, times the tactic matchup (×1.25 / ×0.8), the defender's bonus (×1.15) and a seeded roll of ±15%. The stronger side wins the round. Each fighter may be injured (10% if their side won the round, 20% on a draw, 35% if it lost); injured henchmen can't fight for 24 h. Nobody dies.
5. **Ending:** after round 3, or when a side has nobody fit left. The side left standing against nobody wins; otherwise most rounds won, and a tie goes to the defender. An attacker who wins takes the territory (ownership history `battle`; the paid upkeep period goes with it; the loser's guards stand down). Winners' morale +5, losers' −10. Everyone is released.
6. **Withdrawing** (`POST /api/battles/:id/withdraw`, Don or Underboss) ends it at once and the other side wins: an attacker keeps nothing; a defender gives up the territory.
7. **Cancelled** if the territory changes hands another way (for example, lapsed upkeep) or a family disbands before a round. The fee is refunded to an attacker that still exists.

## Screens (7b)
- **Territory panel.** On a territory another family holds, "Declare battle for ₦X", or the reason it isn't possible. The reason comes from `GET /api/territories/:slug/attack`, which makes the same checks as declaring, without locks. A contested territory shows "Battle in progress"; members of either side get "View the battle".
- **Battle panel.** A drawer, not a toolbar button. It opens from the territory panel, from the Battles list in the family panel (where battle notifications lead) and from a henchman's "in battle" link. It shows:
  - both sides, the status, the score and a countdown to the next round (from the browser's clock; the server decides when rounds happen);
  - your committed henchmen and the fit ones you can commit or release before round 1; for the other side, only how many;
  - tactic orders for the next round;
  - the report, with a step-through replay (strength bars and a narration line);
  - withdrawing.

  It reloads on live family events, which include every round and the end.
- **Map.** A contested territory's marker gets a thick red ring (`battleId` in the district state). The map reloads that district when the battle panel sees the battle's state differ from the map's.
- **Henchmen panel.** "Injured until …" and "in battle" badges; posting and dismissing are disabled while committed.

## Determinism and replay
A battle stores its seed, its starting state (the fighters committed when round 1 begins) and, for every round, the tactics and anyone who left the family in between (`battle_rounds.result`). `replay(initial_state, seed, inputs)` reproduces every stored round exactly; a test checks this for a real battle. The server picks the seed when the battle is declared.

## Integrity
- Lock order: families (both, id order) → memberships → battles → territories → henchmen → treasuries. The sweep reads due battles without locks, then for each one locks both families and the battle and re-checks that the round is still due, so concurrent or retried sweeps resolve each round once (and `battle_rounds` has the round as its primary key).
- One live battle per territory and per attacker (partial unique indexes).
- Money: the fee is a ledger posting keyed `battle:{id}:fee`; a refund is keyed `battle:{id}:refund`.

## Notifications
| Activity | Who is told |
|---|---|
| `battle.attacked` | every member of the defending family |
| `battle.round` | commanders of both families |
| `battle.won`, `battle.lost`, `battle.cancelled` | every member of both families |

## Tests
- `packages/rules/test/battles.test.ts`: strength factors, the tactic cycle, determinism, replay, invariants over 500 random battles, balance (equal sides favour the defender; ~15% stronger is even; the right tactic swings an even round), declaration refusals.
- `apps/server/test/battles.test.ts`: the attack quote for each reason, agreeing with declaring, and the map's `battleId`; declaring (fee, contest, auto-committed guards, notifications, visibility) and every refusal; the contested lock; committing and its limits; rounds on schedule with sent and default orders, and replay of the stored report; both outcomes; withdrawing; cancellation with refund; races (concurrent sweeps, two attackers, a round against a withdrawal, a round against the upkeep sweep).

## Known limits
- Balance numbers are first guesses; they need playtesting.
- A ceasefire blocks new declarations but doesn't stop a battle already running.
- Two-family battles only.
- The replay is drawn in React (bars and text). A Phaser battle scene can come with real art.
- Other families' maps show a new contested ring when that district next reloads (it goes stale after a minute in view, or on a page load); only the two sides' maps update straight away.
- `e2e/battles.spec.ts`: a full battle in two browsers:
  - declaring from the map, committing, ordering and the contested ring;
  - the defender following the notification;
  - the real worker resolving round 1 after the test moves `next_round_at` to now;
  - both panels updating live; the report, the replay and the change of owner;
  - the phone layout.

  `e2e/run.sh` starts a worker limited to the battle sweep (`WORKER_QUEUES=battles.sweep`), so the test waits up to about a minute for the sweep.
