# Multiplayer reliability (Phase 9)

Phase 9 is split into three steps: **9a** access control, **9b** concurrency and retries, **9c** recovery. This file grows with each.

## 9a: Access control
### Where things live
| What | Where |
|---|---|
| Login check | `AuthGuard` (`modules/auth/auth.guard.ts`), declared on each controller; session lookup (`SessionsService.resolve`) also requires an active (unbanned) account |
| Family permissions | `ROLE_PERMISSIONS` (`packages/content/src/roles.ts`), checked by `checkFamilyAction` inside the action's transaction |
| The access table and its tests | `apps/server/test/access.test.ts` |

### What the tests guarantee
- **Every route has a rule.** The test reads the routes the running api actually serves and compares them with the `ACCESS` table. A route with no row (or a row with no route) fails the build, so a new endpoint can't ship without a decision about who may call it.
- **Only three routes are public:** `GET /api/health`, `POST /api/auth/register`, `POST /api/auth/login`. Every other route answers 401 `UNAUTHENTICATED` to a caller with no session, and to a banned player whose session row still exists (so the account-status check in session lookup is tested on its own, not only the session deletion a ban does). A banned player can't open a live connection either.
- **Family routes refuse outsiders and under-ranked members.** Each family route is called by another family's Don and by an associate (a member whose only permission is `activity.view`), with a valid request, so a refusal can't be a validation error in disguise. The expected status for each is in the table.

### Decisions recorded by the table
- Any player may view a family's public page. Every member sees the treasury balance, the territories, the recruitment board, the henchmen, the goods, the trades and the battles; the treasury history needs `treasury.view`.
- Outsiders get **404** for things private to the families involved (a battle, a diplomacy room, a chat channel or message, an invitation, someone else's notification), and **403** where the family is named in the path.
- Some routes answer 403 rather than 404, so an outsider who guesses an id learns only that it exists: answering a trade (`accept`, `decline`, `cancel`), `POST /api/proposals/:id/sign`, `PATCH /api/henchmen/:id`, `POST /api/battles/:id/withdraw` and `DELETE /api/chat/messages/:id`. Their siblings answer 404. Ids are random UUIDs, so this is recorded rather than changed.

### Adding a route
Add its row to `ACCESS` in `access.test.ts`. If it's a family route, add a valid request body or query in `request()`, and the statuses an outsider and an associate should get.

## 9b: Concurrency and retries
### Repeated requests
A player whose response was lost (no reply, or a 5xx from the proxy) may send the same request again. No write may then act twice.

| Write | A repeat… |
|---|---|
| Market order, trade offer, diplomacy proposal | carries the same `Idempotency-Key` and gets the first result back. The same key with a different request is refused (400). The header is required. |
| Claim, hire, declare a battle, invite, create a family | is refused (409): the first already happened. |
| Abandon, dismiss, decline/revoke/accept an invitation, kick, leave, transfer leadership, disband | is refused (403/404): the thing is already gone or changed hands. |
| Decline, cancel or withdraw a trade or proposal, withdraw from a battle | is refused (409 `…_CLOSED`). |
| Accept a trade, sign a proposal, assign, commit, release, battle order, open a room or direct chat, block, unblock, mark read | ends in the same state and answers the same: the second changes nothing. |
| Send a chat message | posts it again. Harmless, and the player sees it. |

`apps/server/test/retries.test.ts` sends every write twice and checks both answers and that the effect happened once. It also sends five copies of a keyed offer and proposal at the same moment (one is made).

**Keys in the client** (`apps/client/src/ui/useRequestKey.ts`): a form keeps its key until the server gives a definite answer. If the response is lost and the player submits again, the retry reuses the key. A success or a refusal (which changes nothing) starts a new key. Market orders used a new key for every click before 9b, which protected only against duplicates in transit; they now use the same hook.

Offers and proposals made before migration 0012 have no key (`request_key` is null); the unique index is per sending family.

### Races
Already covered by the earlier suites: claims, hiring, battle declarations and sweeps, proposal signatures, invitation accepts, family creation, leadership transfers, role changes against kicks, trades, the market, and the jobs' sweeps.

`apps/server/test/races.test.ts` adds, each run three times with the actions fired at the same moment:
- committing, dismissing and reposting one henchman: the answers match its final state;
- a kick and the member leaving: exactly one succeeds;
- a leadership transfer and the succession sweep: exactly one Don;
- disbanding while accepting a trade, a festival paying out and an admin credit: the closed treasury ends at zero, and the trade is either fully run or refused;
- abandoning a territory while a battle is declared on it: either the battle starts on held land, or the land is left and no battle (and no fee);
- abandoning a territory while the upkeep sweep takes it back: it is released once.

None needed a code change: the family row lock and the conditional updates already serialise them. No deadlock appeared, so no deadlock retry or lock timeout was added.
