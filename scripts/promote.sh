#!/usr/bin/env bash
# Promote dev to main: fast-forward origin/main to the pushed, CI-green dev HEAD.
# Production still moves only on v* tags (docs/development.md, Releases).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=justmytwospence/switchyard
[ "$(git rev-parse --abbrev-ref HEAD)" = dev ] || { echo "Not on dev" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "Working tree is not clean" >&2; exit 1; }
git fetch -q origin dev main
SHA=$(git rev-parse HEAD)
[ "$SHA" = "$(git rev-parse origin/dev)" ] || { echo "HEAD is not origin/dev; push first" >&2; exit 1; }
CONC=$(gh run list -R "$REPO" --workflow ci --commit "$SHA" --json conclusion,event \
  --jq '[.[] | select(.event == "push")][0].conclusion // empty')
[ "$CONC" = success ] || { echo "CI on ${SHA:0:7} is '${CONC:-missing}'; wait for it or fix it" >&2; exit 1; }
git merge-base --is-ancestor origin/main "$SHA" || {
  echo "main has commits dev lacks; merge origin/main into dev first" >&2; exit 1; }
git push origin "$SHA:refs/heads/main"
echo "main is now ${SHA:0:7}. Tag vX.Y.Z when production should move."
