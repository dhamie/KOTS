# Performance (Phase 10)

How the game is load-tested, what the first measurements show, and what to look at next. **These numbers come from a 3-core development laptop that also runs the load generator. They show where the server slows down. They are not a capacity promise for production** (see "Limits of these numbers").

## Running a load test
```bash
npm run test:load        # bash load/run.sh: about 12 minutes; results in load/results/<time>/
```
`load/run.sh` does the following:
1. Resets `kots_test` and seeds the map and markets.
2. Seeds **500 players** in 125 families of four with `npm run seed:load`. The seed refuses any database whose name doesn't end in `_test`.
3. Starts the api with `LOAD_TEST=1` on :4102, and a worker serving every queue.
4. Runs, at the same time:
   - **k6** (`grafana/k6:2.3.0` in Docker, `load/play.js`): three levels in turn, **100, 250 and 500 active players**, for 3, 3 and 4 minutes. Each player loops a visit and then waits 3–8 s. A visit is a map view, the family view, the market (dons buy and sell), chat (dons post sometimes) or trades and battles. A visit fires its requests at once, as the browser does.
   - **`load/sockets.mjs`**: 1,000 live connections (two per player), plus a probe message posted to the public channel every 5 s. It measures how long each probe takes to reach every socket.
   - A sampler (`resources.csv`) every 5 s: CPU and memory of the api and the worker, Postgres CPU, database connections, and machine load.
5. Saves `pg_stat_statements` (top queries) and the pg-boss job durations.

`LOAD_TEST=1` lifts only the per-IP rate limits, because every virtual player shares one IP. Per-player and per-account limits are unchanged, and the switch refuses to start with `NODE_ENV=production`. `load/results/` holds the seeded players' session cookies and is git-ignored.

Don't run other heavy work during a test: the generator, the api and Postgres share the same cores.

## Baseline (2026-10-28, two runs)
Machine: WSL2 with 3 cores. Load average 1.1–2.4 at the start, rising to **7–12** at 500 players, mostly from the test itself.

### Response times (all routes, ms)
| Active players | Median | 95th pct | 99th pct | Failed requests |
|---|---|---|---|---|
| 100 | 16 | 84–92 | 1,290–1,640 | 0.2–0.3 % |
| 250 | 17 | 108–202 | 1,250–1,390 | 0.3–0.4 % |
| 500 | **570–2,150** | **2,140–5,580** | 3,180–7,520 | 0.7–1.0 % |

The ranges cover runs 1 and 2. Run 2 ran on a busier machine. Throughput was 143–175 requests a second over the whole test.

**Almost every failure is in the harness, not the server.** 588 of 595 (run 1) and 644 (run 2) were `dial: i/o timeout`: k6's container couldn't open a connection through Docker Desktop's port forwarding. This is the same loss the browser tests hit in Phase 8. The api never received these requests. The few others (7 in run 1) are HTTP errors from the api; the api doesn't log requests during a load test, so they aren't classified yet.

### By route, run 2 (median / 95th pct, ms)
| Route | 100 players | 250 | 500 |
|---|---|---|---|
| `GET /chat/channels` | 13 / 69 | 17 / 324 | 4,057 / 8,690 |
| `GET /families/:id/inventory` | 16 / 105 | 18 / 212 | 3,019 / 6,560 |
| `GET /families/:id` (and the other family reads) | 17–18 / 77–103 | 19–20 / 173–204 | 2,250–2,430 / 5,390–5,550 |
| `GET /map/territories` | 16 / 83 | 19 / 239 | 2,424 / 5,536 |
| `GET /me` | 15 / 79 | 17 / 189 | 1,545 / 4,350 |
| `GET /markets/:slug` | 9 / 44 | 10 / 99 | 1,446 / 4,379 |
| `POST /markets/:slug/orders` | 21 / 110 | 28 / 153 | 1,550 / 4,590 |
| `POST /chat/channels/:id/messages` | 13 / 95 | 18 / 95 | 869 / 2,873 |

The full per-route table for each run is in `load/results/<time>/k6-summary.json`.

### Live connections
All 1,000 sockets stayed connected in both runs, with no drops. Every probe reached every socket: 115,000 and 109,000 deliveries. Delivery latency was a median of 43–46 ms, a 95th percentile of 1.3–2.7 s, and a maximum of 3.4–6.7 s. The slow tail comes from the 500-player level.

### Resources
| Active players | api CPU (% of one core) | api memory | Postgres CPU | DB connections |
|---|---|---|---|---|
| 100 | 25–45 | ~195 MB | 15–50 % | 15–19 |
| 250 | 50–57 | ~295 MB | 28–67 % | 15–16 |
| 500 | **104–135** | ~387 MB | 43–80 % | 13–19 |

The worker stayed under 5 % CPU and about 110 MB.

### Database
Every query in the top 25 by total time averages **under 7 ms**, and most average under 1 ms:
- **Session lookup** runs on every request (113k and 93k calls), at 0.2 ms mean.
- **Market stock lock** (`npc_market_state … for update`) is the slowest: 3.4–6.8 ms mean and up to 713 ms. Every order for the same good at the same market waits for that one row.
- **Listing chat channels writes to the database every time.** `GET /chat/channels` runs `INSERT … ON CONFLICT DO NOTHING` to create the family channel on first use, so every listing writes.

### Jobs
Every sweep finished in under 0.7 s, even at 500 players. With 23 territories, a few live battles and two events, the sweeps have little to do at this size.

## What the numbers say
1. **At 500 players the api's one Node process is the bottleneck.** Its CPU passes one core (104–135 %), every route slows by about the same amount, and the database stays fast. Requests are queueing in the event loop, not waiting on queries. Live delivery slows for the same reason.
2. **Up to 250 active players, one api process on this machine is comfortable:** a 17 ms median and a 95th percentile of about 200 ms.
3. **The ceiling here is lower than it would be on a dedicated server.** The load generator (k6 plus 1,000 sockets) competes with the api for the same 3 cores, so where the slowdown starts on a real server is still unknown.
4. **The sweeps are not a concern at this map size.**

## Candidates for 10b, ranked
| # | Finding | Possible fix | Expected effect |
|---|---|---|---|
| 1 | The api saturates one core at 500 players | Profile with `node --cpu-prof` at 250 players to see where CPU goes per request. Then either cut the cost, or run several api processes (Node cluster or more instances), which needs the rate limits moved to Redis or Postgres (ARCHITECTURE §8) | The main gain |
| 2 | `GET /chat/channels` writes every time, and is the slowest route | Create the family channel when the family is created (or check before inserting) | Less write load; a faster chat view |
| 3 | Session lookup on every request | A short in-process cache (a few seconds), cleared on logout and ban through the existing `session-ended` signal | ~1 query per request saved |
| 4 | Market stock is one locked row per good per market | Leave it unless profiling shows it matters: it only serialises orders for the same good at the same market, and the price must stay exact | Small |
| 5 | Docker Desktop forwarding drops new connections (~0.5–1 % of k6 requests) | Run k6 outside Docker (a native binary), or on another machine, for cleaner numbers | Cleaner measurements, not a game change |

## Limits of these numbers
- **One shared 3-core laptop** runs the generator, the api, the worker and Postgres under Docker Desktop. A production server would give the api its own cores.
- **Visits are scripted, not real play:** fixed weights and think time, and only dons write.
- **The map has 23 territories**, so ownership-heavy work (claims, upkeep, battles) is small here. A bigger map would load the sweeps more.
- **The network is local.** Latency from Nigeria to the chosen host is a 10c question.

## 10b: Optimisation (2026-10-28)
### What changed
| Change | Where | Why (from the 10a profile) |
|---|---|---|
| **Prepared statements** for the session lookup, the caller's membership, the `/me` membership summary and the two map queries | `SessionsService`, `MembershipsService.memberOf` (outside transactions), `FamiliesService.membershipOf`, `MapService` | Drizzle rebuilt the same SQL on every request: about a quarter of the api's CPU |
| **Session cache**: a session looked up in the last 10 s (`SESSION_CACHE_MS`) skips the database | `SessionsService.resolve` / `forget` | The lookup was a third of all queries. Logout clears it at once; a ban (or a logout on another api process) clears it through `session-ended`, which every api process hears. A status-only change made straight in the database takes effect within 10 s. |
| **Listing chat channels only reads** once the family channel exists | `ChatService.familyChannel` | It ran `INSERT … ON CONFLICT` on every listing |

### Measured: old and new side by side
Machine load changes a lot over a day, so the two builds were run **back to back, alternating** (old, new, old, new) with 250 active players and 500 sockets for 3 minutes each, under the same harness.

| At 250 players | Old (two runs) | New (two runs) | Change |
|---|---|---|---|
| api CPU per request (5 s sampler) | 8.8–8.9 ms | 6.8–7.4 ms | **−16 to −24 %** |
| api CPU per request (CPU profile) | 6.7–6.9 ms | 5.3–5.7 ms | −17 to −22 % |
| Drizzle's share of api CPU | 23 % | 16 % | |
| Postgres CPU | 51–55 % | 33 % | **about −40 %** |
| Throughput | 133–138 req/s | 153–159 req/s | +12–15 % |
| Median / 95th pct | 445–628 ms / 4.2–5.9 s | 115–141 ms / 2.4–3.4 s | |
| Failed requests | 0.30 % | 0.35–0.46 % | the Docker forwarding loss, as in 10a |

### The machine slowed down during the day
The old build needed **8.8 ms** of api CPU per request at 250 players in the afternoon, against **3.2 ms** in the 10a runs that morning. The laptop was about 2.7 times slower, most likely from thermal throttling after hours of load, or from work on the Windows side. In one full 10b run it stopped completely for 22 minutes. So:
- the full 10-minute runs taken in the afternoon (`load/results/20261028-1536*`, `-1549*`) can't be compared with the 10a baseline, and their absolute numbers mean little;
- **only side-by-side comparisons like the table above are reliable on this machine.** Capacity has to be measured on the target hardware (10c).

### Found while testing: the api can hang on shutdown
A load-test api stayed alive after SIGTERM, idle, waiting on two connections the k6 container had left half-open through Docker Desktop. Only SIGKILL ended it. A proxy or load balancer can leave connections like that in production too, and a deploy or restart would then hang. **Fixed as a separate step after 10b** (2026-10-28): the api closes remaining connections when it shuts down, with a 10 s deadline as a backstop. See `docs/RELIABILITY.md`.
