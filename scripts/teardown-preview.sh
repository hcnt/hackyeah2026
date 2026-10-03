#!/usr/bin/env bash
# Runs on the VPS (from any directory). Removes preview stacks and their checkouts.
#   teardown-preview.sh <PR number>...      remove these previews
#   teardown-preview.sh --keep <N>...       remove every preview NOT in this list
set -euo pipefail
PREVIEW_ROOT=/opt/hackyeah2026-previews

remove() {
  echo "removing pr-$1"
  # -p works without the compose file, so this also cleans up if the checkout is gone.
  docker compose -p "pr-$1" down -v --rmi local --remove-orphans
  rm -rf "${PREVIEW_ROOT:?}/pr-$1"
}

if [[ ${1:-} == --keep ]]; then
  shift
  declare -A keep=()
  for n in "$@"; do keep[$n]=1; done
  for p in $(docker compose ls -a -q | grep -E '^pr-[0-9]+$' || true); do
    n=${p#pr-}
    [[ -n ${keep[$n]:-} ]] || remove "$n"
  done
  docker builder prune -f --filter until=72h
else
  for n in "$@"; do
    [[ $n =~ ^[0-9]+$ ]] || { echo "bad PR number: $n" >&2; exit 2; }
    remove "$n"
  done
fi
