# Chat, diplomacy, notifications and live updates (Phase 6)

How players talk, how they hear about what happened, and how the browser stays current without reloading.

## Where things live
| What | Where |
|---|---|
| Chat limits, report reasons | `packages/content/src/chat.ts` (`CHAT`, `REPORT_REASONS`) |
| Request/response shapes, live event types | `packages/shared/src/chat.ts` (`ServerEvent`, `SOCKET_PATH`) |
| Publishing live events (api and worker) | `apps/server/src/modules/realtime/realtime.service.ts` |
| Socket.IO, LISTEN, rooms (api only) | `apps/server/src/modules/realtime/realtime.gateway.ts` |
| Channels, messages, reads, deletes, reports | `apps/server/src/modules/chat/chat.service.ts` |
| Blocks, report queue, audit log | `apps/server/src/modules/chat/moderation.service.ts` |
| Which activity notifies whom | `apps/server/src/modules/notifications/notifications.service.ts` (`RULES`) |
| Appointing moderators | `apps/server/src/main.mod.ts` (`npm run mod:grant <handle>`, `npm run mod:revoke <handle>`) |
| Diplomacy tuning; term checks (pure) | `packages/content/src/diplomacy.ts` (`DIPLOMACY`); `packages/rules/src/diplomacy.ts` (`checkProposalTerms`, `canReceive`) |
| Rooms (chat channels), proposals, ceasefires | `apps/server/src/modules/chat/chat.service.ts` (`openRoom`, `requireRoom`); `apps/server/src/modules/diplomacy` |
| Client | `apps/client/src/api/live.ts`, `ui/chat/` (diplomacy in `Diplomacy.tsx`), `ui/notifications/NotificationBell.tsx` |

## Live updates
- The browser opens one Socket.IO connection (WebSocket only) at `/api/socket.io` once signed in. It's authenticated like an HTTP request: the session cookie, and an allowed `Origin`.
- Each socket is in `player:{id}`, `public`, and `family:{id}` while the player is a member. When a membership or role changes, the server takes the player's sockets out of their family room at once and puts them in the right one, then sends `me.changed`.
- **How events travel:** a service calls `RealtimeService.publish(tx, rooms, event)` inside its transaction. That is a Postgres `NOTIFY`, which Postgres delivers only when the transaction commits. Each api process `LISTEN`s on one dedicated connection and emits to its own sockets. So:
  - a rolled-back action never reaches a browser;
  - the worker's sweeps (upkeep, wages, trade expiry, succession) reach browsers through the api;
  - a second api instance works without Redis or a Socket.IO adapter.
- **Events are hints.** `family.changed` (any family activity) and `notification` make the client reload what it shows; `chat.message` and `chat.deleted` carry the change itself. If the listening connection drops, the api reconnects every 2 s and sends `resync` to every socket; a browser that reconnects also resyncs. Either way the client reloads over HTTP.
- Logging out disconnects that session's sockets.

## Chat
- **Channels:** one per family (created on first use, open to its current members), one city-wide channel "Lagos" (created by migration 0007), and direct channels between two players (opened by handle).
- **Access** is checked on every request. A channel the player can't use answers 404, like one that doesn't exist. A kicked member loses the family channel at once.
- **Messages** are 1–500 characters after trimming, stored before they're broadcast, and paged newest first with a `before` cursor (50 per page). Chat never changes game state.
- **Rate limit:** 5 messages per 10 seconds per player across all channels (in memory, per api instance), answered with 429 `RATE_LIMITED`.
- **Unread** is per player and channel: others' messages after the player's last-read mark, not counting deleted messages or blocked authors, capped at 99. Opening a channel marks it read.
- **Deleting:** authors can delete their own messages; moderators can delete any. Deletion is soft (`deleted_at`), so reports and the audit log still point at the message.

## Diplomacy (Phase 6b)
- **Rooms:** a private channel between two families, opened by either side with the other's tag. Each side's Don, Underboss and Consigliere can use it (checked against current roles on every request). Its live messages go only to them.
- **Proposals** are made in a room, by a Don, Underboss or Consigliere, to the other family. Terms never change; to change them, withdraw and propose again. They expire after 48 hours. At most 5 open proposals between two families.
- **Signing:** each family needs one signature from its Don or Underboss. A proposal made by someone who can sign counts as their family's signature. When the second family signs, the terms run at once, in one transaction that re-checks everything; if anything fails, the signature is refused and the proposal stays open.
- **Closing:** the receiving family's Don or Underboss can decline; the proposing family can withdraw; the worker expires the rest every 5 minutes.
- **Territory transfer:** one family hands a territory to the other, for a price (₦0–₦10M) paid by the receiving family. Checked when it runs: the giver still holds it; the receiver borders it or holds none (the claim rule); both families are at least 3 days old; the receiver can pay. The paid upkeep period and state go with the territory; guards are stood down; ownership history records `transfer`; the price is one ledger posting keyed `proposal:{id}`.
- **Ceasefire:** 1, 3 or 7 days, recorded in `ceasefires` and shown in the room. Battles (Phase 7) will enforce it.
- **History and notifications:** `proposal.made/received/signed/executed/declined/withdrawn/expired`, `territory.transferred`, `ceasefire.agreed` in both families' history; diplomacy roles are notified about the other family's moves (see the table below).

## Moderation
- **Block:** the blocker no longer sees the blocked player's messages (history, live, unread). Neither can message the other directly, whoever blocked whom.
- **Report:** any message the player can see, except their own, with a reason (`spam`, `abuse`, `cheating`, `other`) and an optional note. One report per player per message.
- **Moderators** (`players.is_moderator`) see open reports in a Reports tab, delete messages (which closes their open reports as `actioned`) and dismiss reports. Every one of these, and every grant or revoke, is written to `moderation_actions`.

## Notifications
Written in the same transaction as the family activity entry they come from, so a retried sweep that changes nothing notifies nobody. A family isn't notified about what its own members did, only about other families' actions and the server's sweeps.

| Activity | Who is told | Opens |
|---|---|---|
| `member.invited` | the invited player | family panel (invitations) |
| `trade.received` | roles with `trade.accept` | Market → Trades |
| `trade.executed`, `trade.declined`, `trade.expired` | roles with `trade.propose` | Market → Trades |
| `territory.neglected`, `territory.lost` | roles with `treasury.view` | family panel |
| `henchman.unpaid`, `henchman.deserted` | roles with `treasury.view` | henchmen panel |
| `leadership.succeeded` | every member | family panel |
| `proposal.received`, `proposal.signed`, `proposal.executed`, `proposal.declined`, `proposal.withdrawn`, `proposal.expired` | roles with `diplomacy.talk` | Chat → Diplomacy |

## Tests
- `apps/server/test/chat.test.ts`: channel access (including after a kick), direct channels, validation, paging, unread, the rate limit, deletes, reports, moderator actions and their audit rows, blocks.
- `apps/server/test/notifications.test.ts`: who is and isn't notified for each kind, exactly once under repeated and concurrent sweeps, paging and marking read.
- `apps/server/test/realtime.test.ts`: socket authentication and Origin, logout, room membership (family, public, direct; kick and join without reconnecting), no delivery on rollback, delivery from another connection, the listener reconnecting with `resync`.
- `apps/server/test/diplomacy.test.ts`: room access by role (including after a demotion), live room messages only to diplomats, ceasefire and transfer end to end (ownership, history, guards, ledger), every re-check at signing, permissions, the proposal limit, expiry once, and races (ten simultaneous signatures; sign/decline/withdraw; a signature against the upkeep sweep that loses the land).
- `packages/rules/test/diplomacy.test.ts`: term checks, the receiving rule, diplomacy permissions.
- `e2e/diplomacy.spec.ts`: one family proposes a transfer in a room; the other follows the notification, reads the message, signs; both see the result live.
- `e2e/chat.spec.ts`: an invitation raises the bell live; two members chat in real time; unread on another tab; a trade offer raises the other family's bell and leads to the offer.

## Known limits
- Chat, notification and audit tables grow without bound; retention arrives with Phase 10–11.
- A socket opened before its session expires stays connected until it disconnects (it only receives hints; every HTTP call is still checked).
- Live chat from a blocked player is hidden by the client; the server hides it in history and unread counts.
