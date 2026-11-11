#!/usr/bin/env bash
# Nightly database backup (Phase 10c). Run on the server from cron, e.g.:
#   15 3 * * * cd /srv/kots && bash deploy/backup.sh >> deploy/backups/backup.log 2>&1
# Writes deploy/backups/kots-<UTC time>.dump (pg_dump custom format), checks it can be read back, and deletes
# dumps older than KEEP_DAYS (default 14). Set BACKUP_COPY to a shell command to also copy each dump off the server;
# the dump's path is in $BACKUP_FILE, e.g. BACKUP_COPY='rclone copy "$BACKUP_FILE" offsite:kots-backups'.
# Restoring is described in docs/DEPLOYMENT.md.
set -euo pipefail
cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f deploy/compose.yml)
DIR=deploy/backups
KEEP_DAYS=${KEEP_DAYS:-14}
mkdir -p "$DIR"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
final="$DIR/kots-$stamp.dump"
partial="$final.partial"

# Dump inside the db container, so the host needs no Postgres tools and no password.
"${COMPOSE[@]}" exec -T db pg_dump -U kots -d kots --format=custom > "$partial"
# A dump that pg_restore can't list is broken; keep the partial file for a look, and fail.
"${COMPOSE[@]}" exec -T db pg_restore --list < "$partial" > /dev/null
mv "$partial" "$final"
echo "$(date -u +%FT%TZ) backed up to $final ($(du -h "$final" | cut -f1))"

if [[ -n "${BACKUP_COPY:-}" ]]; then
  BACKUP_FILE="$final" bash -c "$BACKUP_COPY"
  echo "$(date -u +%FT%TZ) copied $final off the server"
fi

find "$DIR" -name 'kots-*.dump' -mtime +"$KEEP_DAYS" -print -delete
