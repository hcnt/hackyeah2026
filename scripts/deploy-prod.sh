#!/usr/bin/env bash
# Runs on the VPS from the prod checkout. Brings up the edge router and the prod stack.
set -euo pipefail
cd "$(dirname "$0")/.."
export STACK=prod
PROD_HOST=${PROD_HOST:-onsight.site}

# Build before touching anything running: a failed build leaves the old version up.
docker compose -p prod build

# One-time migration from win_hackathon's pre-edge layout, where compose project
# "win_hackathon" held 127.0.0.1:8080 itself. A no-op once that project is gone.
docker compose -p win_hackathon down --remove-orphans

docker compose -p edge -f edge/compose.yaml up -d --build
docker compose -p prod up -d --remove-orphans
docker image prune -f

# Through the edge router, so routing is checked too.
for _ in $(seq 1 30); do
  curl -fsS -H "Host: $PROD_HOST" http://127.0.0.1:8080/api/health && echo && exit 0
  sleep 2
done
docker compose -p prod logs --tail 50
exit 1
