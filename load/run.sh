#!/usr/bin/env bash
# Load test (Phase 10a): a fresh test database seeded with LOAD_PLAYERS players, the api (LOAD_TEST=1) on :4102 and a
# worker with every queue, then k6 (in Docker) driving three load levels while load/sockets.mjs holds the live
# connections. Results go to load/results/<time>/. Don't run other heavy work meanwhile: it skews the numbers.
set -euo pipefail
cd "$(dirname "$0")/.."

API_PORT=4102
TEST_DATABASE_URL=${TEST_DATABASE_URL:-postgres://kots:kots@localhost:5434/kots_test}
HOST_IP=$(hostname -I | awk '{print $1}')
ORIGIN=http://load.test
OUT=load/results/$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"
psql() { docker compose exec -T db psql -q -U kots -d kots_test "$@"; }

pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
}
trap cleanup EXIT

docker compose up -d --wait db
psql -c "DROP SCHEMA IF EXISTS public, drizzle, pgboss CASCADE; CREATE SCHEMA public;"
DATABASE_URL="$TEST_DATABASE_URL" npm run db:migrate >/dev/null
npm run build >/dev/null
DATABASE_URL="$TEST_DATABASE_URL" node apps/server/dist/seed.cjs
DATABASE_URL="$TEST_DATABASE_URL" LOAD_SESSIONS="$OUT/sessions.json" node apps/server/dist/seed-load.cjs
psql -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements; SELECT pg_stat_statements_reset();" >/dev/null

LOAD_TEST=1 API_PORT=$API_PORT DATABASE_URL="$TEST_DATABASE_URL" ALLOWED_ORIGINS="$ORIGIN" node apps/server/dist/api.cjs > "$OUT/api.log" 2>&1 &
api=$!
pids+=($api)
DATABASE_URL="$TEST_DATABASE_URL" node apps/server/dist/worker.cjs > "$OUT/worker.log" 2>&1 &
worker=$!
pids+=($worker)
for _ in $(seq 1 30); do curl -s -o /dev/null "http://localhost:$API_PORT/api/health" && break; sleep 1; done

# CPU (per cent of one core over the last 5 s) and memory of the api and the worker, Postgres's CPU, database
# connections and the machine's load, every 5 s.
(
  ticks() { awk '{print $14 + $15}' "/proc/$1/stat" 2>/dev/null || echo 0; }
  hz=$(getconf CLK_TCK)
  echo "time,load1,api_cpu,api_rss_mb,worker_cpu,worker_rss_mb,db_cpu,db_connections"
  a0=$(ticks "$api"); w0=$(ticks "$worker")
  while true; do
    sleep 5
    a1=$(ticks "$api"); w1=$(ticks "$worker")
    arss=$(ps -o rss= -p "$api" || echo 0); wrss=$(ps -o rss= -p "$worker" || echo 0)
    dcpu=$(docker stats --no-stream --format '{{.CPUPerc}}' kots-db-1 | tr -d '%')
    conns=$(psql -Atc "select count(*) from pg_stat_activity where datname = 'kots_test'")
    echo "$(date +%T),$(cut -d' ' -f1 /proc/loadavg),$(( (a1 - a0) * 100 / (5 * hz) )),$((arss / 1024)),$(( (w1 - w0) * 100 / (5 * hz) )),$((wrss / 1024)),$dcpu,$conns"
    a0=$a1; w0=$w1
  done
) > "$OUT/resources.csv" 2>/dev/null &
pids+=($!)

echo "Load test running (about 11 minutes); results in $OUT"
uptime | tee "$OUT/uptime-start.txt"
API_URL="http://localhost:$API_PORT" ORIGIN=$ORIGIN SESSIONS="$OUT/sessions.json" SOCKETS=1000 DURATION=600 RESULTS="$OUT/sockets.json" \
  node load/sockets.mjs > "$OUT/sockets.log" 2>&1 &
sockets=$!
pids+=($sockets)
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/load":/load:ro -v "$PWD/$OUT":/results \
  -e BASE_URL="http://$HOST_IP:$API_PORT" -e ORIGIN=$ORIGIN -e SESSIONS=/results/sessions.json \
  grafana/k6:2.3.0 run --quiet /load/play.js > "$OUT/k6.log" 2>&1 || true
wait "$sockets" || true
uptime | tee "$OUT/uptime-end.txt"

# The slowest queries, and how long each job took.
psql -Atc "select round(mean_exec_time::numeric, 2) || ' ms mean, ' || round(max_exec_time::numeric, 1) || ' ms max, ' || calls || ' calls: ' || left(regexp_replace(query, '\s+', ' ', 'g'), 220)
  from pg_stat_statements where dbid = (select oid from pg_database where datname = 'kots_test') order by total_exec_time desc limit 25" > "$OUT/top-queries.txt"
psql -Atc "select name, count(*), round(avg(extract(epoch from completed_on - started_on))::numeric * 1000) || ' ms avg', round(max(extract(epoch from completed_on - started_on))::numeric * 1000) || ' ms max'
  from pgboss.job where state = 'completed' group by name order by name" > "$OUT/jobs.txt"
echo "Done: $OUT"
