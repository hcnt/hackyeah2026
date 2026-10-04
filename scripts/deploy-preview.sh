#!/usr/bin/env bash
# Runs on the VPS from a preview checkout. Usage: deploy-preview.sh <PR number>
set -euo pipefail
cd "$(dirname "$0")/.."
N=${1:?usage: deploy-preview.sh <PR number>}
[[ $N =~ ^[0-9]+$ ]] || { echo "bad PR number: $N" >&2; exit 2; }
export STACK="pr-$N" ENV=preview
HOST="pr-$N.onsight.site"

docker network inspect edge >/dev/null 2>&1 \
  || { echo "edge network missing: deploy main first" >&2; exit 1; }

docker compose -p "$STACK" up -d --build --remove-orphans

for _ in $(seq 1 30); do
  curl -fsS -H "Host: $HOST" http://127.0.0.1:8080/api/health && echo && exit 0
  sleep 2
done
docker compose -p "$STACK" logs --tail 50
exit 1
