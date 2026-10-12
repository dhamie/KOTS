#!/usr/bin/env bash
# Browser tests: production client build (vite preview) on :5181 + API on :4101 + a worker (battle and event sweeps only)
# against the test database, with Chromium running in the Playwright Docker image.
set -euo pipefail
cd "$(dirname "$0")/.."

API_PORT=4101
WEB_PORT=5181
TEST_DATABASE_URL=${TEST_DATABASE_URL:-postgres://kots:kots@localhost:5434/kots_test}
# The browser container reaches this machine through its own IP (not localhost) under Docker Desktop/WSL.
HOST_IP=$(hostname -I | awk '{print $1}')

free_port() {
  local pids
  pids=$(ss -ltnpH "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u || true)
  if [ -n "$pids" ]; then kill $pids 2>/dev/null || true; sleep 1; fi
}

pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  free_port "$API_PORT"
  free_port "$WEB_PORT"
}
trap cleanup EXIT

docker compose up -d --wait db
# Fresh test database, migrated from empty.
docker compose exec -T db psql -q -U kots -d kots_test -c "DROP SCHEMA IF EXISTS public, drizzle, pgboss CASCADE; CREATE SCHEMA public;"
DATABASE_URL="$TEST_DATABASE_URL" npm run db:migrate >/dev/null
npm run build >/dev/null
DATABASE_URL="$TEST_DATABASE_URL" node apps/server/dist/seed.cjs

free_port "$API_PORT"
free_port "$WEB_PORT"
mkdir -p test-results
LOG_REQUESTS=1 API_PORT=$API_PORT DATABASE_URL="$TEST_DATABASE_URL" ALLOWED_ORIGINS="http://$HOST_IP:$WEB_PORT" \
  node apps/server/dist/api.cjs > test-results/e2e-api.log 2>&1 &
pids+=($!)
# Only the battle and event sweeps: the battle test waits for a round, the event test for an event it triggers.
# Other jobs (market drift, upkeep, the hourly event roll) would change state under the other tests.
DATABASE_URL="$TEST_DATABASE_URL" WORKER_QUEUES=battles.sweep,events.sweep node apps/server/dist/worker.cjs > test-results/e2e-worker.log 2>&1 &
pids+=($!)
(cd apps/client && LOG_REQUESTS=1 API_PORT=$API_PORT npx vite preview --port "$WEB_PORT" --strictPort --host 0.0.0.0 > ../../test-results/e2e-web.log 2>&1) &
pids+=($!)
for _ in $(seq 1 30); do curl -s -o /dev/null "http://localhost:$API_PORT/api/health" && break; sleep 1; done
for _ in $(seq 1 30); do curl -s -o /dev/null "http://localhost:$WEB_PORT/" && break; sleep 1; done

# Run as the current user, so result files aren't owned by root.
docker run --rm --ipc=host --user "$(id -u):$(id -g)" -e HOME=/tmp -e BASE_URL="http://$HOST_IP:$WEB_PORT" \
  -e E2E_DATABASE_URL="postgres://kots:kots@$HOST_IP:5434/kots_test" -v "$PWD":/work -w /work \
  mcr.microsoft.com/playwright:v1.64.0-noble npx playwright test -c e2e/playwright.config.ts "$@"
