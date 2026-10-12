# King of the Streets — Architecture (approved Phase 0, 2026-10-09)

## Context
This is the approved Phase 0 architecture for the game described in `docs/BRIEF.md`. Update this file whenever a major architectural decision changes, and record the date and the reason.

---

## 1. Key decisions

| Area | Decision | Why |
|---|---|---|
| Shape | Modular monolith: one NestJS codebase with two process roles, **api** and **worker** | Simple to build. Either role can scale horizontally later, because neither holds game state in memory. |
| Rules | A pure TS package, `packages/rules`. No Nest, no DB, no Phaser, no `Date`, no `Math.random`. Uses a seeded RNG. | Battles must be deterministic and replayable. Formulas live in one place and can be unit-tested without I/O. |
| Persistent state | **PostgreSQL 16** is the only authority for money, inventory, ownership, battles and chat. | Transactions, constraints and row locks protect the economy. |
| DB access | **Drizzle** with SQL migrations. *Deviation from the prompt (Prisma), approved 2026-10-09.* | The integrity paths need `SELECT … FOR UPDATE`, conditional `UPDATE … WHERE … RETURNING` and `ON CONFLICT`, and Drizzle writes these directly. The owner also knows it from LagosFighter. |
| Jobs | **pg-boss**, a job queue stored in Postgres. *Approved 2026-10-09.* | A job can be queued in the same transaction as the state change that caused it, so there are no lost jobs. It's durable, retries jobs, and supports singleton and throttled jobs. It also avoids running Redis for the MVP. |
| Realtime | **Socket.IO** on the api process, used only to push to clients. Commands go over HTTP. | Rooms map naturally to channels and families. A Redis adapter can be added when there's a second gateway. |
| Client | One **Vite** app: **React** for panels, chat and forms, plus **Phaser 4** for the map and battle view. *Deviation from the prompt (Phaser 3), approved 2026-10-09.* | No SSR or SEO is needed, so Next.js isn't worth it. Phaser 4 is the stable line and the owner already uses it. |
| Validation | **Zod** schemas in `packages/shared`, used by the client and by a Nest validation pipe. | One definition per DTO, strict parsing, and no mass assignment. |
| Auth | Email + password (argon2id). Opaque session IDs stored in Postgres and sent in an `httpOnly`, `Secure`, `SameSite=Lax` cookie. Origin check on state-changing requests. | Sessions can be revoked and work on any instance. No JWT refresh-token complexity. |
| Tests | **Vitest** for unit and integration tests against real Postgres in Docker. Playwright for a few critical flows later. k6 for load tests in Phase 10. | Concurrency bugs only show up against a real database. |
| Redis | **Not in the MVP.** Added when there is a second api instance (Socket.IO adapter and shared rate limits) or a measured cache need. Never the authority for money, inventory or ownership. | No infrastructure without a concrete need. |
| Not used | Kafka, Kubernetes, microservices, GraphQL, Redux, ECS libraries | Only adopt one if a measured or organisational need appears. |

> **Phase 1 decision (2026-10-09):** TypeScript is pinned to **6.0**, not 7. typescript-eslint, which provides the approved lint rules, doesn't support TS 7 yet (its peer range is `<6.1`). Revisit when it does.

> **Phase 3 decisions (2026-10-10):**
> - Map loading is per district, chosen by the districts on screen. There's no `bbox` endpoint yet: with only 3 districts it would add nothing. Add one if districts get large.
> - The isometric and viewport maths lives in `apps/client/src/map/iso.ts`, not `packages/rules`, because only the client uses it.
> - Max zoom is 2×, and static layers are baked at world resolution. See `docs/MAP.md` for the rendering and performance design.

> **Phase 4a decisions (2026-10-10):** see `docs/ECONOMY.md` for the rules.
> - System ledger accounts record entries but don't keep a balance, so postings don't all queue on the same rows. Only family treasuries keep (and enforce) a balance.
> - No `player_wallet` accounts yet: nothing pays players directly. Add the kind when something does.
> - No `territories.version` column and no `families.protection_until` yet. Row locks cover every write so far; protection belongs with battles (Phase 7).
> - Modules that act for a family lock the family and membership through `MembershipsService` (families module), not `FamiliesService`. FamiliesService itself calls territories and the ledger on disband, so this avoids an import cycle.
> - Time-based rules read an injectable `Clock` (`common/clock.ts`), so tests move game time instead of waiting.
> - `players.last_active_at` (refreshed with the session, at most hourly, and on login) measures activity for succession.

> **Phase 4b decisions (2026-10-10):** see `docs/ECONOMY.md`.
> - The module is `henchmen` (the table is `henchmen`), not `npcs`. NPC officials are a different thing and arrive with events (Phase 8).
> - Henchman status is `active | deserted | dismissed`, plus a nullable assigned territory. `injured` and `dead` arrive with battles. `experience` and `fatigue` aren't columns yet, for the same reason.
> - The recruitment board isn't stored: it's recomputed from a seed (the family and the day), and a unique recruit key stops a candidate being hired twice.
> - `HoldingsService` (territories module) checks ownership for henchmen. `TerritoriesService` calls `HenchmenService` to clear guards when a territory changes hands, so this avoids an import cycle.
> - Lock order is now families → family_invitations → family_memberships → territories → henchmen → currency_accounts.
> - Queries inside a transaction must run on that transaction, never on the pool. A second connection per transaction deadlocks the pool under load. A test runs 16 concurrent hires against the 10-connection pool to catch this.

> **Phase 5a decisions (2026-10-10):** see `docs/ECONOMY.md`.
> - The planned `economy` module is split into `inventory` (stacks and storage, which trades will also use), `market` and, in 5b, `trades`.
> - A market is identified by its territory (`npc_market_state` is keyed by territory id and good). Prices aren't stored; they're computed from stock by `rules/market.ts`, which the client also uses to quote.
> - `market_orders` (not in the original draft) records each filled order. Its unique `(family_id, request_key)` makes the `Idempotency-Key` header work: a retried order returns the first receipt instead of filling twice.
> - Goods have no size: one unit of any good takes one unit of storage. Going over capacity (by losing a territory) destroys nothing; it only blocks buying.
> - A disbanded family's goods stay in its (now unreachable) stacks.

> **Phase 5b decisions (2026-10-10):** see `docs/ECONOMY.md`.
> - Trade statuses are `open | executed | declined | cancelled | expired`. There's no `accepted` state: accepting runs the trade.
> - Nothing is reserved when an offer is made; acceptance re-checks goods, storage, cash, roles and both families' age under lock.
> - Accepting locks both families in id order (`MembershipsService.lockActingAmong`), then the acceptor's membership, then the trade. Lock order: families → invitations → memberships → trades → territories → henchmen → inventory → market stock → accounts.
> - **Family rows are locked `FOR NO KEY UPDATE`, not `FOR UPDATE`.** Inserting a row that references a family (an activity entry) takes a key-share lock on it, which `FOR UPDATE` blocks. Two families' actions that write each other's activity, or a sweep writing activity for a locked family, deadlocked. The concurrency suite found it; it fails with the old lock and passes with this one.
> - Trades use the trade id for their ledger key and need no `Idempotency-Key`: accepting an executed trade returns it unchanged.
> - The trades UI is a tab in the Market drawer, keeping the phone toolbar to four buttons.
> - The trades browser test reads `pg` from the repo root (a server dependency) to backdate the two families, so they pass the 3-day rule.

> **Phase 6a decisions (2026-10-11):** see `docs/CHAT.md`.
> - New dependencies: `socket.io` (server) and `socket.io-client` (client, and the server's tests). Socket.IO attaches to the api's HTTP server directly, without Nest's WebSocket packages, because it only pushes.
> - Live events travel through **Postgres LISTEN/NOTIFY**, published inside the transaction that caused them, so a rolled-back action sends nothing and the worker can publish too. Each api instance listens and serves its own sockets, so more instances need no Socket.IO adapter and no Redis. WebSocket transport only (no long-polling), so no sticky sessions either.
> - Rooms are `player:{id}`, `family:{id}` and `public`. Direct messages go to both players' rooms, so there are no per-channel rooms to keep in sync.
> - `chat_channel_members` isn't needed: family channel access is checked against the membership on every request, and a direct channel stores its two players (`player_a < player_b`).
> - Notifications are derived from activity entries (`NotificationsService.fromActivity`, called by `ActivityService.record`) in the same transaction, so they are exactly once wherever activity is. A family isn't notified of what its own members did. No `priority` or `ref` columns yet: a `target` (which panel to open) is enough for now.
> - Moderators are players with `is_moderator`, set by `npm run mod:grant <handle>`. Full admin tools are Phase 11. Every moderator action, and every grant, is in `moderation_actions`.
> - The Chat button replaces Districts in the toolbar; the district list opens from a button on the map, keeping four toolbar buttons on a phone.

> **Phase 6b decisions (2026-10-11):** see `docs/CHAT.md`.
> - A diplomacy room is a chat channel (`kind = 'diplomacy'`, `family_a < family_b`), so messages, unread counts and live delivery reuse chat. Its live messages go to the player rooms of members whose role may talk, not to the whole family room. Rooms appear in `GET /chat/channels`; there's no separate `GET /diplomacy/rooms`.
> - No `proposal_parties`: a proposal is always between its room's two families. No `failed` status: if a re-check fails at the second signature, the signature is refused and the proposal stays open.
> - Statuses are `open | executed | declined | withdrawn | expired`. Permissions: `diplomacy.talk` and `diplomacy.propose` (Don, Underboss, Consigliere), `diplomacy.sign` (Don, Underboss). Declining needs `diplomacy.sign`.
> - Lock order gains proposals after trades: families → invitations → memberships → trades → proposals → territories → henchmen → inventory → market stock → accounts.
> - The worker module now gets the server config (`CONFIG`), because ChatService, reached through DiplomacyService, reads the chat rate limit.

> **Phase 7a decisions (2026-10-11):** see `docs/BATTLES.md`.
> - No `battle_participants`: a battle is between exactly two families, stored as `attacker_family_id` and `defender_family_id`. No `battle_units`: a henchman's commitment is `henchmen.battle_id` (owned by the henchmen module), and the fighters are snapshotted into `battles.initial_state` when round 1 begins. Territories gain `contested_battle_id`; henchmen gain `injured_until`.
> - Statuses are `preparing | active | resolved | cancelled`. There's no `declared` state: preparation starts at once.
> - Falling back is the withdraw endpoint (immediate), not a fourth tactic. Tactics are press, hold and flank.
> - Rounds are resolved by a sweep every minute rather than one job per round: simpler, retry-safe, and within a minute of schedule. Orders can be changed until the round resolves (upsert), rather than being unique-once.
> - New-family protection is computed from `founded_at` (3 days), with no `protection_until` column.
> - Lock order gains battles: families → invitations → memberships → trades → proposals → battles → territories → henchmen → inventory → market stock → accounts.

## 2. Repository structure (start small, grow on demand)
```
KOTS/
  apps/
    client/          Vite + React + Phaser 4
      src/map/         Phaser scenes: city/district view, markers, camera
      src/ui/          React panels, chat, forms, notifications
      src/api/         typed HTTP client + socket client
    server/          NestJS
      src/main.api.ts      HTTP + Socket.IO entry point
      src/main.worker.ts   pg-boss worker entry point
      src/modules/<name>/  one folder per module (see §3)
      src/db/              Drizzle schema, migrations, transaction helper
  packages/
    shared/          Zod schemas, DTO types, enums, error codes (client + server)
    rules/           pure deterministic rules: battle resolver, upkeep, pricing, RNG
    content/         game data: districts/territories, NPC archetypes, goods,
                     event types, role permissions, tuning constants (typed TS)
  docs/
  docker-compose.yml Postgres (+ Redis later)
```
Folders are created only in the phase that first needs them. There are no empty placeholder modules.

**How Phaser and React work together:** React owns the app shell and all panels. Phaser is mounted in one `<div>`, and the two communicate through a small typed event bus: `marker:selected`, `map:focus(territoryId)` and so on. Server state lives in React-side query caches. Phaser receives map snapshots and diffs and never fetches anything itself.

## 3. Backend modules

| Module | Owns tables | Notes |
|---|---|---|
| auth | users, sessions, players | registration, login, logout, session guard, player lookup. *Players live here because they're created in the same transaction as the user (Phase 2, 2026-10-10).* |
| profiles | (none of its own) | read-only `GET /me` and `GET /players/:handle`, combining auth and families |
| families | families, family_memberships, family_invitations | roles, permission guard, succession |
| activity | activity_log | append-only. Other modules write to it through `ActivityService.record()` |
| map | districts, territories | `GET /map/districts`, `GET /map/territories?district=`. Static rows are seeded from content (`npm run db:seed`). Geometry ships with the client. See `docs/MAP.md`. |
| territories | territory ownership fields, territory_ownership_history | claim, abandon, upkeep sweep, release on disband. `GET/POST /territories/:slug[/claim\|/abandon]`, `GET /families/:id/territories` |
| ledger | currency_accounts, ledger_transactions, ledger_entries | the **only** module that changes balances. `GET /families/:id/treasury[/entries]` |
| henchmen | henchmen | recruitment board, hiring, assignment, dismissal, wages and morale. `GET/POST /families/:id/recruits`, `GET /families/:id/henchmen`, `PATCH /henchmen/:id`, `POST /henchmen/:id/dismiss` |
| inventory | inventory_stacks | goods a family holds and its storage capacity; the only module that writes stacks. `GET /families/:id/inventory` |
| market | goods (seeded), npc_market_state, market_orders | NPC markets: prices from stock, orders with an `Idempotency-Key`, drift job. `GET /markets/:slug`, `POST /markets/:slug/orders` |
| trades | trades, trade_lines | offers between families, acceptance (one transaction across both families), decline, cancel, expiry job. `GET/POST /families/:id/trades`, `POST /trades/:id/accept\|decline\|cancel` |
| realtime | (none; Postgres NOTIFY) | `RealtimeService.publish` (both processes) queues a live event in the caller's transaction; `RealtimeGateway` (api only) runs Socket.IO and delivers what it hears on LISTEN. See `docs/CHAT.md`. |
| chat | chat_channels, chat_messages, chat_reads, player_blocks, message_reports, moderation_actions | write first, then broadcast. Family, public and direct channels, blocks, reports, moderator deletes (audited). `GET /chat/channels`, `POST /chat/direct`, `GET/POST /chat/channels/:id/messages`, `POST /chat/channels/:id/read`, `DELETE /chat/messages/:id`, `POST /chat/messages/:id/report`, `GET/POST/DELETE /blocks`, `GET /moderation/reports`, `POST /moderation/reports/:id/dismiss` |
| diplomacy | proposals, proposal_signatures, ceasefires | proposals made in diplomacy rooms (chat channels of kind `diplomacy`, owned by chat). The second signature runs the terms in one transaction, through `TerritoriesService.transfer` and the ledger. `POST /diplomacy/rooms`, `GET /diplomacy/rooms/:id`, `POST /diplomacy/rooms/:id/proposals`, `POST /proposals/:id/sign\|decline\|withdraw`, expiry job. See `docs/CHAT.md`. |
| battles | battles, battle_orders, battle_rounds | declaring, committing, orders, withdrawing, the round sweep; uses `rules` to resolve rounds and the territories, henchmen and ledger services for effects. `POST /territories/:slug/battles`, `GET /families/:id/battles`, `GET /battles/:id`, `POST /battles/:id/commit\|release\|orders\|withdraw`. See `docs/BATTLES.md`. |
| events | world_events | event framework, scheduling, eligibility checks, effects |
| notifications | notifications | stored first, then pushed. Derived from activity entries in the same transaction. `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all` |
| admin | (none of its own) | inspect and adjust **through other modules' services**, always audited |

**Boundary rule:** a module reads and writes only its own tables. Other modules go through its exported service. A cross-module operation, such as a trade that moves both money and items, runs in **one DB transaction**. The caller opens it and passes the transaction handle to each service. Circular module imports are a lint error.

## 4. Data model (MVP draft)
This is the first draft. Columns are refined in each phase's migration. Unless noted, IDs are `uuid` (v7, so they sort by time) and timestamps are `timestamptz` in UTC. Money is a `bigint` count of whole ₦ units, never a float.

### Accounts and families
- `users`: id, email (`citext`, unique), password_hash, status (`active|banned`), created_at
- `sessions`: id (random 256-bit, stored as a hash), user_id, created_at, expires_at, last_seen_at. Index on `(user_id)`.
- `players`: id, user_id (unique), handle (`citext`, unique), created_at
- `families`: id, name (`citext`, unique), tag (unique), stage, founded_at, protection_until, disbanded_at
- `family_memberships`: player_id (**PK**, so a player is in at most one family), family_id, role (enum), joined_at. Index on `(family_id, role)`. A partial unique index enforces exactly one `don` per family.
- `family_invitations`: id, family_id, player_id, invited_by, status, expires_at. A partial unique index allows only one pending invitation per (family, player).
- `activity_log`: id (`bigserial`), family_id, actor_player_id, type, payload (`jsonb`), created_at. Index on `(family_id, id desc)`. Old rows are deleted on a retention schedule.

Role permissions are **data** in `packages/content` (role → set of permission strings), not a table. The rank and permission check is one pure function, `checkFamilyAction` in `packages/rules`. The server uses it to authorise, and the client uses it only to hide controls. Deferred from Phase 2: automatic succession for an inactive Don (Phase 4, with the worker), and email verification and password reset (Phase 11). The server checks a permission **inside the same transaction** as the action, after locking the membership row, so a demotion that happens at the same moment can't slip through.

### Map and territory
- `districts`: id, slug (unique), name, bounds (polygon in map coordinates). Seeded from `content`.
- `territories`: id, district_id, slug (unique), name, kind (`commercial|residential|logistics|industrial|civic|waterfront`), map position, base_income, base_upkeep, **owner_family_id** (null means neutral), state (`stable|neglected|contested|under_attack`), stability (0–100, check constraint), upkeep_paid_until, last_evaluated_at, version. Indexes on `(district_id)` and `(owner_family_id)`.
- `territory_ownership_history`: id, territory_id, from_family_id, to_family_id, cause (`claim|transfer|battle|abandon|admin`), ref_id, created_at

**Upkeep is computed from timestamps.** A territory is overdue when `now > upkeep_paid_until`. Its state follows from how long it has been overdue, compared against the grace periods in `content`. A worker sweep only selects rows where `upkeep_paid_until < now` and the state needs to advance (indexed), and processes them in batches. Offline time is never an instant loss.

### Ledger (money)
- `currency_accounts`: id, family_id (nullable), player_id (nullable), kind (`family_treasury|player_wallet|system`), balance (`bigint`). A check requires exactly one owner for non-system accounts. `CHECK (balance >= 0 OR kind = 'system')`.
- `ledger_transactions`: id, kind (`purchase|trade|upkeep|reward|transfer|admin_adjust|…`), idempotency_key (**unique**), actor_player_id, ref_type, ref_id, created_at
- `ledger_entries`: id (`bigserial`), transaction_id, account_id, amount (signed `bigint`), balance_after. Index on `(account_id, id desc)`.

Every movement of money is double-entry: the entries in a transaction sum to zero. NPC sinks and sources, such as markets, upkeep and recruitment, are `system` accounts. The ledger service is the **only** code that writes these tables. A debit is a conditional `UPDATE … SET balance = balance - $n WHERE id = $id AND balance >= $n RETURNING balance`, so no read-modify-write race can drive a balance negative. Tests assert that every ledger transaction sums to zero.

### NPC henchmen
- `henchmen`: id, family_id, archetype (`content` key), name, combat, leadership, discipline, experience, loyalty, negotiation, logistics, reliability (all small ints with range checks), morale, fatigue, traits (`jsonb`, extensible), status (`idle|assigned|injured|deserted|dead`), assigned_territory_id, upkeep, hired_at, last_evaluated_at

Core attributes are real columns because battles and queries use them. Only the open-ended personality traits go in `jsonb`. Archetypes live in `content`, so adding an archetype needs no code change.

### Economy
- Goods are defined in `content`. `goods` is a seeded table so other tables can reference it with foreign keys.
- `inventory_stacks`: family_id, good_id, quantity (`CHECK >= 0`). PK `(family_id, good_id)`. Storage capacity comes from territories and bases, computed by `rules`.
- `npc_market_state`: market_id, good_id, stock, price, updated_at. NPC demand and supply drift on a scheduled job.
- `trades`: id, from_family_id, to_family_id, status (`proposed|accepted|executed|cancelled|expired`), created_by, expires_at, executed_at
- `trade_lines`: trade_id, side, good_id or currency, quantity

**Running a trade:** in one transaction, lock both families' relevant rows in a **deterministic order** (sorted by id, to avoid deadlocks), re-check permissions and current balances and stock, move goods with conditional updates, write the ledger transaction, and set `status = 'executed'` only `WHERE status = 'accepted'`. A trade can't execute twice.

### Chat and diplomacy
- `chat_channels`: id, kind (`family|public|direct|diplomacy|battle`), family_id (for `family`), created_at
- `chat_channel_members`: channel_id, player_id, PK both. Family channel members are derived from memberships and synced when a membership changes. *(Not built in 6a: access is checked against memberships directly, and direct channels store their two players. Revisit for diplomacy rooms in 6b.)*
- `chat_messages`: id (`bigserial`), channel_id, author_player_id, body (length-limited), created_at, deleted_at. Index on `(channel_id, id desc)`. Pagination uses a keyset ("before id") rather than offsets.
- `proposals`: id, channel_id, kind (`ceasefire|territory_transfer|trade|alliance|…`), terms (`jsonb` validated by a Zod schema for each kind), status, expires_at, executed_at
- `proposal_parties`: proposal_id, family_id, required_permission
- `proposal_signatures`: proposal_id, family_id, signed_by_player_id, signed_at. Unique on `(proposal_id, family_id)`.

A proposal executes only when every party has signed, inside one transaction that re-checks every term against current state. Chat text never changes game state.

### Battles
- `battles`: id, kind (`territory|base|war`), target_territory_id, status (`declared|preparing|active|resolved|cancelled`), seed (`bigint`), initial_state (`jsonb` snapshot), current_round, next_round_at, resolved_at, outcome (`jsonb`)
- `battle_participants`: battle_id, family_id, side, objective, joined_at, withdrawn_at. PK on both IDs.
- `battle_orders`: battle_id, round_no, family_id, orders (`jsonb`, validated by Zod), submitted_at. **Unique** on `(battle_id, round_no, family_id)`.
- `battle_rounds`: battle_id, round_no, result (`jsonb`), resolved_at. **PK `(battle_id, round_no)`**, so a round can only be resolved once.

**Resolving a round:** a worker job locks the battle row (`FOR UPDATE`) and checks `current_round`. It calls `rules.resolveRound(state, orders, seed, round)`, which is pure. It then inserts the `battle_rounds` row and applies effects, all in one transaction. If a job is retried, it finds the round already resolved and does nothing. Any battle can be replayed from `initial_state + seed + orders`.

### Events and notifications
- `world_events`: id, scope (`city|district|territory|family|npc|market|battle`), scope_id, type (`content` key), state (`scheduled|active|resolved|expired`), severity, starts_at, expires_at, payload (`jsonb`), **dedupe_key (unique)**. (Phase 8a built the subset its event types need; see `docs/EVENTS.md`.)
- `notifications`: id (`bigserial`), player_id, priority, type, ref_type, ref_id, body, created_at, read_at. Index on `(player_id, id desc)`.

The dedupe key, for example `upkeep-warning:{territory}:{due_date}`, makes event creation safe to retry. When a player returns, the server builds a summary from notifications since `last_seen_at`.

### Cross-cutting
- `idempotency_keys`: key, player_id, route, response_hash, created_at, with a short retention period. The client sends an `Idempotency-Key` header on every non-repeatable command.
- pg-boss manages its own schema.
- Every table that holds state has `created_at`. Rows that change often have `version` for optimistic checks where row locks would be overkill.

## 5. API and realtime principles
- REST over HTTP with commands named as resources (`POST /families/:id/trades`). Every input is parsed by Zod. Responses are typed DTOs and never raw rows.
- **Ownership is always derived on the server.** The acting player comes from the session and their family from the membership row. Any player or family ID sent by the client counts only as a *target* and is authorised separately, which prevents insecure direct object references.
- Errors have one shape: `{ code, message, details?, correlationId }`. Every request gets a correlation ID that is logged with every line.
- Pagination is keyset-based with a hard maximum page size. Request bodies have a size limit.
- Map loading: `GET /map/districts` returns a light city overview. `GET /map/territories?district=` or `?bbox=` returns only what's in view. Markers are clustered on the client at city zoom.
- **Socket.IO** pushes only. A connection joins `player:{id}`, `public` and its family's `family:{id}` after the same session and Origin checks as HTTP. Rooms are re-checked when membership changes. A client that reconnects fetches what it missed over HTTP and doesn't rely on missed socket messages. (Phase 6a: events reach every api instance through Postgres NOTIFY.)
- Rate limits are per session and per IP. They're in memory for the single instance in the MVP and move to Redis when a second instance arrives.

## 6. Security model
- Never trust anything the client sends about identity, permissions, prices, balances, outcomes or ownership. The client sends **intents** and the server computes the effects.
- Sensitive actions check, in the same transaction: active session → membership → role permission → resource state.
- argon2id for passwords. Login rate limiting and lockout. Sessions are revocable, and a ban kills all of a user's sessions.
- Moderation from Phase 6: report, block, moderator delete. Moderator actions are written to an audit log (`moderation_actions`).
- Anti-abuse, starting in the MVP: trade limits for new accounts, caps on reward size, cooldowns on repeat battle pairings, protection windows for new families, and an admin view of suspicious transfers. This reduces alt-account abuse but can't fully prevent it.

## 7. Game time and scheduling
- Game time is real UTC time. The browser never decides that time has passed.
- **Scheduling uses timestamps and sweeps rather than ticks.** Entities store `*_at` and `*_until` fields. Recurring pg-boss jobs (upkeep sweep, market drift, event generation, NPC evaluation) select only due rows, in batches of N with a time limit per batch. Battle rounds are one-off jobs scheduled for `next_round_at`.
- Every job is idempotent through unique keys, conditional state transitions, or both. A job that runs twice changes nothing the second time.
- Tuning values (grace periods, round intervals, upkeep rates) live in `packages/content` so they can be changed without touching logic.

## 8. Scaling path
| Trigger (measured) | Step |
|---|---|
| More API load than one instance can handle | More api instances behind a load balancer. Live events already reach every instance through Postgres NOTIFY; add Redis for shared rate limits (and a Socket.IO adapter only if NOTIFY volume becomes the bottleneck). |
| Job backlog | Run more worker processes. pg-boss distributes jobs safely. |
| DB connection pressure | PgBouncer in transaction mode. |
| Read-heavy map or leaderboard queries | Short-TTL Redis or HTTP caching of map snapshots, then a read replica. |
| Tables with huge volumes (chat, activity, ledger entries) | Partition by time, and enforce retention or archiving. |
| Only after measurements and with a clear boundary | Split out a service, most likely realtime or battles. |

No capacity numbers will be claimed until the Phase 10 load tests.

## 9. Testing strategy
- **`rules`:** pure unit tests, plus determinism tests (same input gives the same output across runs) and property tests for invariants such as "battle casualties never exceed committed units".
- **Server integration:** tests run against real Postgres in Docker, with a fresh schema per run. **Concurrency tests run from the first money feature onward**: fire N parallel purchases or trades and assert that balances, stock and ledger sums are still correct. Duplicate requests with the same idempotency key must take effect once.
- **Job retry tests:** run each job twice and on overlapping workers, then assert there is a single effect.
- **Permission tests:** every sensitive endpoint is called by a member without the permission, a non-member and a banned user.
- **Migrations:** every run applies all migrations from empty.
- **Later:** Playwright for a few critical flows (Phase 6+), and k6 for load (Phase 10).
- Each checkpoint reports which commands actually ran and their results.

## 10. Phases
Each phase needs explicit approval before it starts, and each one ends with a checkpoint report.

| Phase | Scope | Status |
|---|---|---|
| 0 | Discovery and architecture: BRIEF, ARCHITECTURE, CLAUDE.md, git init | Done (2026-10-09) |
| 1 | Foundation: npm workspaces, strict TS, Docker Postgres, Drizzle and migrations, Nest api and worker skeletons with a health check, Vite + React + Phaser shell, Vitest, typecheck/lint/test scripts | Done (2026-10-09) |
| 2 | Accounts and families: auth, sessions, profiles, families, roles and permissions, invitations, activity log | Done (2026-10-10) |
| 3 | Interactive map: content-driven districts and territories, isometric rendering, camera, markers and clustering, contextual panel, viewport loading | Done (2026-10-10) |
| 4 | Ledger and treasury, territory claiming and ownership, timestamp upkeep with sweeps, pg-boss scheduler, NPC recruitment. Split: **4a** ledger, claiming, upkeep, scheduler, Don succession; **4b** henchmen | Done (2026-10-10) |
| 5 | Goods, inventory, NPC market, player-to-player trades, concurrency test suite. Split: **5a** goods, inventory, storage, NPC market; **5b** trades and the concurrency suite | done (2026-10-11) |
| 6 | Chat (family, public, direct), diplomacy rooms, structured proposals, notifications, basic moderation. Split: **6a** live updates, chat, notifications, moderation; **6b** diplomacy rooms and proposals | done (2026-10-11) |
| 7 | Territory battles: declaration, preparation, orders, scheduled round resolution, report and replay. Split: **7a** rules and server; **7b** screens | done (2026-10-11): 7a rules and server, 7b screens |
| 8 | Event framework and first event types, first NPC influence profiles. Split: **8a** event framework and four event types; **8b** NPC officials and **8c** basic admin tools, each still to be proposed | in progress: 8a built (2026-10-11) |
| — | **MVP complete** at the end of Phase 8 | |
| 9 | Multiplayer reliability: concurrency, reconnects, retries, access control, recovery | — |
| 10 | Performance and scaling: profiling, k6 load tests, optimisation, deployment design, hosting choice | — |
| 11 | Beta operations: admin and moderation, monitoring, backups and restore drills, CI/CD, balancing tools | — |

After the MVP: base assaults, multi-family wars and coalitions, deeper NPC politics, seasons, and map expansion. Each is proposed and approved separately.
