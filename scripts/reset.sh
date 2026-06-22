#!/usr/bin/env bash
# DESTRUCTIVE full reset against the selected Convex deployment. Wipes BOTH sides
# back to empty:
#   - the component: every collection, all index tables (searchDocs, terms,
#     trigrams, facetCounts, collections, deletions) + both aggregates (docCount,
#     sortIndex) — via products:resetEverything -> search.resetAll (batched +
#     self-scheduling, safe at any size).
#   - the app's own tables: productDocs, placeDocs, profiles.
#
# After this, re-sync + re-seed (e.g. scripts/seed.sh). Dev/admin/test only.
#
# Usage:
#   scripts/reset.sh           # reset everything, wait until fully drained
#
# Requires a running/selected Convex deployment (local: `npx convex dev`).
set -euo pipefail

POLL_INTERVAL=3
MAX_POLLS=200   # ~10 min ceiling for very large datasets

cd "$(dirname "$0")/.."

echo "==> FULL RESET: wiping the component (all collections + indexes + aggregates)"
echo "    and the app tables (productDocs, placeDocs, profiles)."

# Kick off the reset. resetEverything clears the app tables synchronously and
# starts the component's self-scheduling resetAll chain.
npx convex run products:resetEverything '{}' >/dev/null
echo "==> reset started; waiting for the component to drain to empty..."

# Poll indexStats until the products collection no longer exists (CollectionNotFound)
# — i.e. the component teardown chain has completed.
for ((i = 1; i <= MAX_POLLS; i++)); do
  # indexStats throws CollectionNotFound once the collection is gone; treat any
  # non-numeric / error output as "drained".
  out=$(npx convex run products:indexStats '{}' 2>&1 | grep -oE '"out_of": *[0-9]+' | grep -oE '[0-9]+' || echo "")
  if [ -z "$out" ]; then
    echo "==> DONE: component fully reset (collection gone, all tables/aggregates empty)."
    exit 0
  fi
  printf "    poll %2d: out_of still %s — draining...\n" "$i" "$out"
  sleep "$POLL_INTERVAL"
done

echo "==> TIMED OUT after $((MAX_POLLS * POLL_INTERVAL))s; last out_of=${out}. The self-scheduled reset may still be running."
exit 1
