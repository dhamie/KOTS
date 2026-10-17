# Admin tools (Phase 8c)

The operator's tools: inspect a player or a family, adjust a family's treasury, ban or unban a player. They run from the command line, not the game: there is no admin login or admin API. A web admin screen belongs to Phase 11.

## Where things live
| What | Where |
|---|---|
| The command | `apps/server/src/main.admin.ts` (`npm run admin -- …`) |
| What each command does | `AdminService` (`apps/server/src/modules/admin/admin.service.ts`) |
| Its application context | `AdminModule` (`modules/admin/admin.module.ts`) |
| Audit log | `moderation_actions` (owned by `ModerationService`), actions `adjust_treasury`, `ban_player`, `unban_player` |
| Money for adjustments | the `admin` system account, ledger kind `admin_adjust` (migration 0011) |

The admin module owns no tables. It works through the services that own the data (accounts, sessions, ledger, activity, moderation and the family, territory, henchmen and inventory reads), the same classes the api uses. Each change and its audit entry are written in one transaction.

## Commands
```bash
npm run admin -- inspect player <handle>
npm run admin -- inspect family <tag>
npm run admin -- adjust <tag> <amount> "<reason>"   # +5000 credits the treasury, -5000 debits it
npm run admin -- ban <handle> "<reason>"
npm run admin -- unban <handle> ["<reason>"]
```
They use the dev database; set `DATABASE_URL` to target another. `npm run admin` builds first; `node apps/server/dist/admin.cjs …` runs the last build.

### Inspect
- **Player:** email, account status, moderator flag, joined, last active, family and role, and the last 10 admin and moderation entries about them.
- **Family:** founded and stage, treasury, members and roles, territories, henchmen and where they're posted, goods and storage, the last 20 ledger entries, and the last 10 admin entries.

### Adjust
- The money moves between the treasury and the `admin` system account through the ledger, like every other balance change. Each run gets its own idempotency key (`admin:<uuid>`).
- A debit can't take the treasury below zero. It's refused and nothing is written.
- The family history shows "An administrator credited ₦X: reason". Members who can see the treasury are notified.
- The family row is locked first, so a family disbanding at the same moment can't receive the money.

### Ban
- The account is marked `banned`, every session it has is deleted, and its live connections are dropped (`session-ended`, as at logout). An open page goes back to the login screen without a reload, and logging in says "This account is banned."
- Family membership is untouched. A banned Don stays Don until the usual inactivity succession (`pickSuccessor`, the worker's hourly job; see `docs/ECONOMY.md`) hands the family on.
- Unban lets the player log in again.

## Tests
- Server (`apps/server/test/admin.test.ts`): credits and debits go through the ledger with history, notifications and audit; overdrafts and bad input write nothing; a ban ends every session, drops the socket, blocks login and is audited, and unban restores login; a ban leaves the family alone; inspect reports the right figures.
- Browser (`e2e/admin.spec.ts`): a signed-in player banned from the command line is returned to the login screen, refused, then let back in after unban.

## Limits and follow-ups (Phase 11)
- No web admin screen and no admin role: whoever can run commands against the database is the operator.
- No territory reassignment, no editing of henchmen or goods, no view of suspicious transfers.
- A ban doesn't remove the player from their family or hand over leadership at once.
- A retried command is a new adjustment: each run has its own key.
