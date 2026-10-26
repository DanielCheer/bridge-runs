#!/bin/bash
# scripts/release.sh "summary of what shipped" — run AFTER a deploy is verified.
# Appends a row to RELEASES.md and lays an annotated tag, so every live version is findable and
# revertible by name: `git checkout rel-YYYYMMDD-HHMM` + restart = code rollback (the launcher
# boots the working tree); data rollback is a separate, deliberate scripts/restore-backup.mjs step.
set -e
cd "$(dirname "${BASH_SOURCE[0]}")/.."   # the repo root (this script lives in scripts/)
SUMMARY="$1"
[ -n "$SUMMARY" ] || { echo "usage: scripts/release.sh \"summary of what shipped\""; exit 2; }
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "working tree has uncommitted changes — commit the release first, then tag it"; exit 1;
fi
TAG="rel-$(date +%Y%m%d-%H%M)"
SHA=$(git rev-parse --short HEAD)
DATE=$(date +%Y-%m-%d)
# Insert the new row directly under the table header (keeps newest-first order).
node -e "
const fs=require('fs');const f='RELEASES.md';let s=fs.readFileSync(f,'utf8');
const row='| $DATE | $TAG | $SHA | '+process.argv[1].replace(/\|/g,'/')+' |';
s=s.replace(/(\|---\|---\|---\|---\|\n)/, '\$1'+row+'\n');
fs.writeFileSync(f,s);
" "$SUMMARY"
git add RELEASES.md
git commit -m "release: $TAG — $SUMMARY"
git tag -a "$TAG" -m "$SUMMARY"
echo "tagged $TAG ($SHA) — revert with: git checkout $TAG"
