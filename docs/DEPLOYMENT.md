# Deployment (Phase 10c)

How King of the Streets runs in production, and how to set up, update, back up and restore it. 10c-1 (this file and `deploy/`) was built and checked on the development machine. **Nothing has been deployed yet**: the first real deployment is 10c-2, proposed separately.

## The choice: one rented server in Europe (option A, chosen 2026-10-31)
| | |
|---|---|
| **Where** | A VPS in Western Europe (London, Amsterdam, Frankfurt, Paris or Nuremberg), from Hetzner, OVH or DigitalOcean |
| **Size** | 4 vCPU, 8 GB RAM, 80+ GB SSD. Ubuntu 24.04 LTS |
| **Cost** | Roughly €10–50 a month, depending on the provider. Check current prices before signing up |
| **What runs on it** | Docker Compose (`deploy/compose.yml`): Caddy, the api, the worker and Postgres 16 |

**Why:**
- It's the cheapest option, and the whole stack runs from one compose file, much as it does in development.
- The load tests (docs/PERFORMANCE.md) showed one api process is enough for beta. Postgres was never the limit.
- **Moving later is cheap.** The same images run on a managed platform (option B), and live updates already work across several api instances (ARCHITECTURE §8).

**The cost of this choice:**
- One server is a single point of failure. Recovery is the backup plus this runbook.
- OS updates and backups are ours to look after; the steps are below.

### Latency from Nigeria
Western Europe is usually around 80–130 ms from Lagos. South African regions are often no faster, because much Nigerian traffic goes through Europe. For a strategy game with server-side battles, around 100 ms is fine. **Measure before choosing the region**: from a phone or laptop in Nigeria, on the networks players use (MTN, Airtel, Glo, home broadband), run:
```bash
ping -c 20 <test host>      # or: mtr -c 20 <test host>
```
Use the provider's published test hosts for each region, such as DigitalOcean's `speedtest-lon1.digitalocean.com`, `speedtest-ams3.digitalocean.com` and `speedtest-fra1.digitalocean.com`, or Hetzner's `fsn1-speed.hetzner.com` and `nbg1-speed.hetzner.com`. Check the hostnames on the provider's site. Pick the region with the lowest median, and note its jitter.

## What's in `deploy/`
| File | What it is |
|---|---|
| `Dockerfile` | Multi-stage. Target `server` holds the bundled api, worker, migrate, seed and admin commands, plus runtime dependencies only (about 320 MB). Target `web` is Caddy with the built client (about 90 MB). Base images are pinned: `node:22.23.2-alpine`, `caddy:2.11.4-alpine`, `postgres:16.15-alpine` |
| `compose.yml` | The stack. Only Caddy publishes ports (80, 443 and 443/udp). Postgres and the api are reachable only on the private compose network |
| `Caddyfile` | HTTPS with automatic certificates, security headers and compression. Serves the client, and forwards `/api` (including the websocket) to the api |
| `.env.example` | The settings to fill in, as `deploy/.env`, which is git-ignored |
| `backup.sh` | A nightly `pg_dump` with a read-back check and 14-day retention, plus an optional off-server copy |

The repository root's `.dockerignore` keeps `node_modules`, build output, `.env` files, backups and load-test results (which hold session cookies) out of the images.

### What starts, in order
1. **`db`** starts and must be healthy.
2. **`migrate`** runs once and exits: `node dist/migrate.cjs` (drizzle-orm's migrator; it reads the same migration history as `npm run db:migrate`), then `node dist/seed.cjs` (static content, which never resets live state).
3. **`api`** and **`worker`** start only if `migrate` succeeded. The api has a health check (`/api/health`).
4. **`web`** (Caddy) starts once the api is healthy.

### Production settings the api enforces
With `NODE_ENV=production` (set in the image), the api and the worker refuse to start:
- without `DATABASE_URL`;
- without `ALLOWED_ORIGINS`, or with any origin that isn't `https://`. The session cookie is `Secure`, so an http origin could never sign in;
- with `LOAD_TEST=1`.

`TRUST_PROXY=1` is set in `compose.yml`. The api then reads the player's address from the one proxy in front of it, Caddy, for the per-IP rate limits. Caddy discards any `X-Forwarded-For` a client sends. **If you put another proxy or load balancer in front of Caddy** (a CDN, for example), the hop count changes: set `TRUST_PROXY=2`, and make Caddy trust that proxy's addresses (`trusted_proxies`). Otherwise all players share one rate limit, or a client can pick its own address.

## First deployment
On a new Ubuntu server, logged in as a sudo user with an SSH key:
1. **Harden the server:**
   - turn off SSH password login (`PasswordAuthentication no`);
   - turn on unattended security upgrades (`sudo apt install unattended-upgrades`);
   - open the firewall only for SSH, 80 and 443:
     ```bash
     sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw allow 443/udp && sudo ufw enable
     ```
   Docker's published ports bypass ufw, which is why only Caddy publishes any.
2. **Install Docker Engine** and the Compose plugin, following docs.docker.com for Ubuntu.
3. **Point DNS at the server:** an A record (and AAAA if it has IPv6) for the game's domain. Caddy needs it to issue the certificate.
4. **Get the code:**
   ```bash
   git clone https://github.com/dhamie/KOTS.git /srv/kots && cd /srv/kots
   ```
   If the repository is private, use a deploy key.
5. **Configure:** `cp deploy/.env.example deploy/.env`, then set:
   - `SITE_ADDRESS` and `ALLOWED_ORIGINS`;
   - `POSTGRES_PASSWORD`: `openssl rand -hex 24` (letters and digits only, because it goes into a URL).

   Then `chmod 600 deploy/.env`.
6. **Start:**
   ```bash
   docker compose -f deploy/compose.yml up -d --build
   ```
   Then check `docker compose -f deploy/compose.yml ps`: `migrate` should be "Exited (0)" and the rest "Up" (the api "healthy").
7. **Check:** open `https://<domain>`, register, and see the map. `curl https://<domain>/api/health` should answer `{"status":"ok","db":"ok"}`.
8. **Grant yourself moderator** if needed:
   ```bash
   docker compose -f deploy/compose.yml exec api node dist/mod.cjs grant <handle>
   ```
9. **Schedule backups** (see below).

## Updating
```bash
cd /srv/kots && git pull
docker compose -f deploy/compose.yml up -d --build
```
- `migrate` runs again before the new api and worker start. Then Compose replaces the api; it stops within its 10 s shutdown deadline.
- **Expect a few seconds' break.** Players see "Reconnecting…", and live updates resume on their own (Phase 9c). Requests in that gap fail with "The server didn't answer"; retries are safe (Phase 9b).
- **Take a backup first** if the update has a migration: `bash deploy/backup.sh`.

To tag releases, so they can be rolled back, set `KOTS_VERSION` in `deploy/.env` to the git tag being deployed. Each version's images are then kept.

## Rolling back
- **If the bad version added no migration:**
  ```bash
  git checkout <previous tag>
  ```
  Set `KOTS_VERSION` to that tag, then `docker compose -f deploy/compose.yml up -d` (`--build` if its images aren't on the server).
- **If it added a migration:** migrations only go forward, and the older code may not work with the newer schema. Either fix forward, or restore the backup taken before the update (below), accepting the loss of anything since.

## Admin commands on the server
These run inside the running api container, with its settings:
```bash
docker compose -f deploy/compose.yml exec api node dist/admin.cjs inspect player <handle>
docker compose -f deploy/compose.yml exec api node dist/admin.cjs adjust <TAG> <±amount> "<reason>"
docker compose -f deploy/compose.yml exec api node dist/admin.cjs ban <handle> "<reason>"
docker compose -f deploy/compose.yml exec api node dist/event.cjs <event type> [market or district]   # e.g. street_festival lagos-island
```
See docs/ADMIN.md and docs/EVENTS.md.

**Logs:**
```bash
docker compose -f deploy/compose.yml logs -f api worker
```
Docker keeps 5 × 10 MB per service.

## Backups
`deploy/backup.sh`:
- dumps the database inside the `db` container to `deploy/backups/kots-<UTC time>.dump`;
- checks that `pg_restore` can read the dump back;
- deletes dumps older than `KEEP_DAYS` (14).

Schedule it with `crontab -e`:
```
15 3 * * * cd /srv/kots && bash deploy/backup.sh >> deploy/backups/backup.log 2>&1
```
**Copy backups off the server.** A dump on the same disk doesn't survive losing the server. Set `BACKUP_COPY` to a command that uses `$BACKUP_FILE`, for example with rclone and the provider's object storage:
```
15 3 * * * cd /srv/kots && BACKUP_COPY='rclone copy "$BACKUP_FILE" offsite:kots-backups' bash deploy/backup.sh >> deploy/backups/backup.log 2>&1
```

### Restoring
```bash
cd /srv/kots
docker compose -f deploy/compose.yml stop api worker web
docker compose -f deploy/compose.yml exec -T db dropdb -U kots kots
docker compose -f deploy/compose.yml exec -T db createdb -U kots kots
docker compose -f deploy/compose.yml exec -T db pg_restore -U kots -d kots --no-owner < deploy/backups/<file>.dump
docker compose -f deploy/compose.yml up -d
```
**Restore into a scratch database first** (`createdb -U kots kots_restore`, then `-d kots_restore`) to check the dump before dropping anything. Regular restore drills are Phase 11.

## Secrets checklist
- **`deploy/.env`** holds the only secret, the Postgres password. Keep it on the server only, mode 600, and never commit it. Keep a copy in a password manager.
- **The `caddy-data` volume** holds the TLS keys and certificates. Keep it. Losing it means re-issuing certificates, which is rate-limited.
- **The `db-data` volume** holds all game state. Never run `docker compose down -v` on the server.

## Checked locally (2026-10-31)
The stack ran on the development machine with `SITE_ADDRESS=localhost` (Caddy's local certificate) on ports 8080/8443.

| Check | Result |
|---|---|
| Images build from a clean `npm ci` | `server` 322 MB, `web` 91 MB, 3 min 43 s |
| `migrate` runs, then the api, worker and Caddy start | migrations applied; 3 districts, 23 territories, 5 goods and 3 markets seeded; api healthy |
| Client over HTTPS | page served; HSTS, `nosniff` and `DENY` headers, no `Server` header; `index.html` `no-cache`; hashed assets `immutable`; deep links fall back to the client |
| `/api/health` through Caddy | `{"status":"ok","db":"ok"}` |
| Register | 204; cookie `HttpOnly; Secure; SameSite=Lax` |
| Write from a foreign `Origin` | 403 |
| Create a family and claim a territory | 201, 200, owner correct |
| Websocket through Caddy, chat message posted | connected; the `chat.message` live update arrived |
| 31 failed logins, each with a different invented `X-Forwarded-For` | the first 30 got 401, the 31st 429: invented addresses are ignored |
| `stop api` | 1.7 s, exit code 0 |
| `down`, then `up` (volumes kept) | session, player and territory ownership all intact; the second `migrate` run had nothing to do |
| Ports published | only Caddy's (8080, 8443); Postgres and the api are internal |
| `backup.sh`, then restore into a scratch database | 156 KB dump; identical row counts in all 35 tables; ledger sums to 0 in both |
| `admin.cjs inspect player` inside the api container | worked |

**Not checked here:**
- a real domain and a Let's Encrypt certificate;
- the off-server copy;
- the cron schedule;
- load on the real server.

Those belong to 10c-2.
