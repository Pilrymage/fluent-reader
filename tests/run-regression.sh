#!/usr/bin/env bash
set -uo pipefail
tests=(
  keyboard-shortcuts
  scroll-geometry
  item-shortcuts
  card-events
  fever-icons
  custom-runtime
  pending-read-states
  feed-first-page
  feed-paging
  focus-virtualized
  network-diagnostics
  network-route
  network-regressions
  fever-network
  web-article-frame
  static-cache-policy
)
failed=()
for t in "${tests[@]}"; do
  if node "tests/$t.cjs" >/dev/null 2>&1; then
    echo "PASS $t"
  else
    echo "FAIL $t"
    failed+=("$t")
  fi
done
echo "failed=${#failed[@]}: ${failed[*]}"
exit "${#failed[@]}"
