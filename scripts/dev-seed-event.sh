#!/usr/bin/env bash
# Creates the widget's demo event on a dev backend (events live in memory, so rerun after a restart).
# Usage: scripts/dev-seed-event.sh [backend_url]   (default http://localhost:8000)
set -euo pipefail
BACKEND=${1:-http://localhost:8000}
NOW=$(date +%s)
curl -fsS -X POST "$BACKEND/api/oracle/dev/events" -H 'Content-Type: application/json' -d @- <<JSON
{
  "event_id": "AttendNowDemoEvent1111111111111111111111111",
  "organizer": "3JSNyprAEU5iC7BxPhEk61KykP54meF5K6vh88RuhaCH",
  "start_ts": $((NOW - 3600)),
  "end_ts": $((NOW + 2 * 86400)),
  "min_seen_secs": 3,
  "name": "HackYeah Day 2 Opening",
  "venue": "Tauron Arena",
  "reward_lamports": 50000000,
  "max_payouts": 100
}
JSON
echo
