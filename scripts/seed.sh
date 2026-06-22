#!/usr/bin/env bash
# Seed the example `products` collection end-to-end against the selected Convex
# deployment (local or cloud). Wraps the multi-step lifecycle into one command:
#   1. products:seed       -> sync the collection config + index the 6 samples
#                             (this is what creates the component collection)
#   2. products:seedChain  -> self-chaining background load up to TOTAL docs
#   3. poll products:indexStats until out_of reaches the target (or stalls)
#
# Usage:
#   scripts/seed.sh [TOTAL] [BATCH]
#     TOTAL  number of synthetic products to index (default 5000)
#     BATCH  docs indexed per scheduled mutation (default 50, max 50)
#
# Examples:
#   scripts/seed.sh            # seed 5000
#   scripts/seed.sh 1000       # seed 1000
#   scripts/seed.sh 200 25     # seed 200 in batches of 25
#
# Requires a running/selected Convex deployment:
#   local: `npx convex deployment select local && npx convex dev` (in another shell)
#   cloud: the default dev deployment from .env.local
set -euo pipefail

TOTAL="${1:-5000}"
BATCH="${2:-50}"
POLL_INTERVAL=5      # seconds between progress polls
MAX_POLLS=120        # give up after ~10 min of no completion

# Run from the repo root regardless of where the script is invoked.
cd "$(dirname "$0")/.."

echo "==> Seeding products collection: target=${TOTAL} docs, batch=${BATCH}"

# 1. Sync the collection + index the 6 samples. products:seed syncs the config
#    (creating the collection) and indexes the hand-written samples; this guarantees
#    the collection exists before seedChain's upsertMany runs.
echo "==> [1/3] products:seed (sync collection + 6 samples)"
npx convex run products:seed '{}' >/dev/null
echo "    collection synced."

# 2. Kick off the self-chaining background load to TOTAL.
echo "==> [2/3] products:seedChain start=0 total=${TOTAL} batch=${BATCH}"
npx convex run products:seedChain "{\"start\":0,\"total\":${TOTAL},\"batch\":${BATCH}}" >/dev/null
echo "    background load scheduled; polling progress..."

# 3. Poll indexStats.out_of until it reaches TOTAL (or stalls).
echo "==> [3/3] waiting for indexing to reach ${TOTAL}"
prev=-1
stall=0
for ((i = 1; i <= MAX_POLLS; i++)); do
  # indexStats returns JSON with "out_of": N; extract it (tolerate CollectionNotFound early).
  out=$(npx convex run products:indexStats '{}' 2>/dev/null | grep -oE '"out_of": *[0-9]+' | grep -oE '[0-9]+' || echo 0)
  printf "    poll %2d: out_of=%s\n" "$i" "$out"
  if [ "$out" -ge "$TOTAL" ] 2>/dev/null; then
    echo "==> DONE: ${out} documents indexed."
    exit 0
  fi
  if [ "$out" = "$prev" ]; then
    stall=$((stall + 1))
  else
    stall=0
  fi
  if [ "$stall" -ge 4 ]; then
    echo "==> STALLED at out_of=${out} (4 polls with no progress). Check the deployment logs."
    exit 1
  fi
  prev=$out
  sleep "$POLL_INTERVAL"
done

echo "==> TIMED OUT after $((MAX_POLLS * POLL_INTERVAL))s; last out_of=${prev}. Indexing may still be running in the background."
exit 1
