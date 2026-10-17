# Development

## Requirements
- Node 22.12+ (pg-boss needs it) and npm 10+.
- Docker with Compose, for Postgres.

## First run
```bash
npm install
npm run db:up        # Postgres 16 on localhost:5434 (creates kots and kots_test)
npm run db:setup     # migrations + seed (static content: the map, goods and market stock); same as db:migrate then db:seed
```
Run `npm run db:seed` again whenever content in `packages/content` changes (for example the map; see `docs/MAP.md`). It's idempotent.

## Running the game locally (three terminals)
```bash
npm run dev:api      # builds the server, then serves http://localhost:4100/api
npm run dev:worker   # builds the server, then runs the job worker (pg-boss)
npm run dev:client   # Vite on http://localhost:5180, proxies /api (and the live connection, /api/socket.io) to the API
```
The API and worker don't run migrations themselves. Run `npm run db:migrate` after pulling new migrations. That way several instances never race to migrate the database.

pg-boss creates and upgrades its own `pgboss` schema when the worker starts. The worker runs the territory upkeep and wage sweeps (every 5 minutes), trade-offer and diplomacy-proposal expiry (every 5 minutes), the battle and city-event sweeps (every minute), market drift (every 30 minutes), the Don succession check and the city-event roll (hourly). Without it, claims still work, but upkeep is never charged, neglect never happens, battle rounds are never fought and no city events happen. `WORKER_QUEUES` (comma-separated queue names, e.g. `battles.sweep`) limits which jobs a worker runs; the browser tests use it. The worker's live events (notifications, family refreshes) reach browsers through Postgres NOTIFY and the API, so the API must be running for them to arrive (see `docs/CHAT.md`).

## Moderators
```bash
npm run mod:grant <handle>    # make a player a chat moderator (audited)
npm run mod:revoke <handle>
```
Moderators see a Reports tab in Chat and can delete any message. Set `DATABASE_URL` to target another database.

## Admin tools
```bash
npm run admin -- inspect family <tag>                 # also: inspect player <handle>
npm run admin -- adjust <tag> +5000 "<reason>"         # credit or debit a treasury (audited)
npm run admin -- ban <handle> "<reason>"               # also: unban <handle>
```
See `docs/ADMIN.md`. Set `DATABASE_URL` to target another database.

## City events
```bash
npm run event:trigger street_festival lagos-island   # start a city event now (audited); see docs/EVENTS.md
```

## Checks
| Command | What it does | Needs DB |
|---|---|---|
| `npm run typecheck` | `tsc` for every workspace and the browser tests | no |
| `npm run lint` | ESLint: typescript-eslint, no circular imports, purity rules for `packages/rules` | no |
| `npm test` | Unit tests (`packages/*`, `apps/client`) | no |
| `npm run test:db` | Server tests against `kots_test`. The schema is dropped and re-migrated from empty on each run. | yes |
| `npm run test:e2e` | Browser tests (Chromium renders WebGL in software here, so they're slow and use long timeouts) (Playwright in Docker, `mcr.microsoft.com/playwright:v1.64.0-noble`) against a production build, the API on :4101, a worker running only the battle and event sweeps, and the test database | yes |
| `npm run build` | Production builds: `apps/client/dist`, `apps/server/dist/{api,worker,seed,mod,event}.cjs` | no |

When a browser test fails, look in `test-results/`: the run logs every API request in `e2e-api.log` (on arrival, and when done or aborted) and every proxied one in `e2e-web.log` (`LOG_REQUESTS=1`). Each failed test also keeps a Playwright trace. A request the browser sent that has no line in either log never reached the proxy.

The Vite proxy drops the API's `Connection: close` from its replies (`configureProxy` in `apps/client/vite.config.ts`), so the browser keeps its connection to the proxy open. Without that, the browser opens a new connection for each request. (The proxy still opens a fresh connection to the API each time: a keep-alive agent there reused connections the API had just closed and returned 502s.) The browser container reaches this machine through Docker Desktop's network forwarding, which occasionally loses a new connection, and those lost connections were what made the browser tests time out. Don't run heavy commands (tsc, eslint) during a browser run, and don't let the machine sleep: a test running across a sleep fails on its 2-minute limit.

## Database changes
1. Edit `apps/server/src/db/schema.ts`.
2. `npm run db:generate` writes a new SQL migration to `apps/server/drizzle/`. Read it before committing.
3. `npm run db:migrate`.

For SQL Drizzle can't express (extensions, partial indexes, check constraints it doesn't model), run `npx drizzle-kit generate --custom --name <name>` in `apps/server` and write the SQL by hand.

Never edit a migration that has already been applied anywhere shared.

## Ports
| Port | Service |
|---|---|
| 5434 | Postgres (Docker) |
| 4100 | API (`API_PORT`) |
| 5180 | Vite dev client |
| 4101, 5181 | API and client used by `npm run test:e2e` |

These are chosen not to clash with LagosFighter (5433, 4000, 5173, 3000).

## Environment
See `.env.example`. `ALLOWED_ORIGINS` (comma-separated) lists the origins allowed to make state-changing requests. Set it to the site's public origin in production. Every variable has a working local default, so nothing needs setting for development.
