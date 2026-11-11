#!/bin/bash
# Refresh NightDream data snapshots (data/snapshots/) from Koios/NightForge.
# Designed to run every 6h next to the hourly improvement loop on the same
# tree: it never rebases or commits while another session has uncommitted
# non-snapshot work, and it only ever commits data/snapshots/.
set -u
# Run from the repo root no matter where the script is called from.
cd "$(dirname "$0")/.." || exit 1

# Any uncommitted work outside data/snapshots? (belongs to another session)
DIRTY_OTHER=$(git status --porcelain | grep -v '^.. data/snapshots/' || true)

git fetch origin -q || true
if [ -z "$DIRTY_OTHER" ]; then
  git rebase origin/main -q 2>/dev/null || git rebase --abort 2>/dev/null || true
fi

node scripts/koios-snapshot.mjs || exit 1

git add data/snapshots
if git diff --cached --quiet; then
  echo "snapshots unchanged"
  exit 0
fi
if [ -n "$DIRTY_OTHER" ]; then
  # Leave the refreshed files in the tree; the owning session will commit them
  # with its own work, or the next clean run will pick them up.
  echo "tree has other uncommitted work; snapshots refreshed locally, commit deferred"
  exit 0
fi
git -c user.name=nightdream-snapshots \
    -c user.email=actions@users.noreply.github.com \
    commit -q -m "data: refresh Koios/Midnight snapshots"
git push origin main -q || { echo "push failed; will retry next run"; exit 1; }
echo "snapshots refreshed and pushed"
