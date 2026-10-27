#!/bin/bash
# Gecko Programmes droplet deploy (docs/REPLICATION.md Phase 3 item 2, issue K5).
#
# On the droplet, /root/deploy.sh is a one-liner:  exec /opt/geckolms/scripts/deploy.sh "$@"
# Run it detached so an SSH drop cannot kill it:
#   nohup /root/deploy.sh > /root/deploy.log 2>&1 &
# Success marker: "=== COMPLETE". Failure: grep -E 'failed to solve|exited with code [1-9]|=== ABORT'
# (do NOT grep "ERROR:" — the dashboard Dockerfile echoes a literal guard string).
#
# 4 GB droplet (D13): images are built one at a time (api -> dashboard -> jobs via `up -d --build`),
# never in parallel, and only one deploy may run at a time (flock below).
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/geckolms}"
COMPOSE_FILE="docker-compose.deploy.yaml"
LOCK_FILE="/var/lock/geckolms-deploy.lock"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "=== ABORT $(date -u): another deploy is already running (lock $LOCK_FILE) ==="
  exit 1
fi

cd "$APP_DIR"
echo "=== START $(date -u) ==="
git pull --ff-only
echo "deployed commit: $(git rev-parse HEAD)"

docker compose -f "$COMPOSE_FILE" build api
docker compose -f "$COMPOSE_FILE" build dashboard
docker compose -f "$COMPOSE_FILE" up -d --build
docker compose -f "$COMPOSE_FILE" ps
echo "=== COMPLETE $(date -u) ==="
