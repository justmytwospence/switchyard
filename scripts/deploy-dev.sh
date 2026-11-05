#!/usr/bin/env bash
# Deploy the current dev branch to switchyard-dev (https://switchyard-dev.spencerboucher.com):
#   1. require a clean dev that is pushed (HEAD == origin/dev);
#   2. wait for CI on that commit, which publishes ghcr.io/justmytwospence/switchyard:edge;
#   3. on the NUC, pull and recreate the switchyard-dev coordinator and its host (homelab's
#      switchyard-dev compose project) and check the running image is this commit;
#   4. on this Mac, rebuild this checkout (the dev worktree) and restart the dev host agent
#      (launchd com.switchyard.host.dev runs packages/cli/dist/main.js from this checkout).
# Prints the URL and revision for review.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO=justmytwospence/switchyard
NUC=${SWITCHYARD_DEV_NUC:-nuc}
HOMELAB=${SWITCHYARD_DEV_HOMELAB:-'~/Projects/homelab'}
URL=https://switchyard-dev.spencerboucher.com
LABEL=com.switchyard.host.dev

step() { printf '\n==> %s\n' "$*"; }

step "Checking dev is clean and pushed"
[ "$(git rev-parse --abbrev-ref HEAD)" = dev ] || { echo "Not on dev (run it from the dev worktree, .worktrees/dev)" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "Working tree is not clean" >&2; exit 1; }
git fetch -q origin dev
SHA=$(git rev-parse HEAD)
[ "$SHA" = "$(git rev-parse origin/dev)" ] || {
  echo "HEAD ($SHA) is not origin/dev; push first" >&2
  exit 1
}
echo "$SHA"

step "Waiting for CI (edge image) on ${SHA:0:7}"
RUN=""
for _ in $(seq 1 30); do
  RUN=$(gh run list -R "$REPO" --workflow ci --commit "$SHA" --json databaseId,event \
    --jq '[.[] | select(.event == "push")][0].databaseId // empty')
  [ -n "$RUN" ] && break
  sleep 10
done
[ -n "$RUN" ] || { echo "No CI run found for $SHA" >&2; exit 1; }
gh run watch -R "$REPO" "$RUN" --exit-status --interval 20 >/dev/null
echo "CI run $RUN passed"

step "Deploying :edge on $NUC"
ssh "$NUC" "cd $HOMELAB && docker compose -f switchyard-dev/docker-compose.yaml pull -q \
  && docker compose -f switchyard-dev/docker-compose.yaml up -d"
REV=$(ssh "$NUC" "docker inspect switchyard-dev --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}'")
[ "$REV" = "$SHA" ] || { echo "switchyard-dev runs $REV, expected $SHA" >&2; exit 1; }
echo "switchyard-dev runs $REV"

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  grep -qF "$PWD/packages/cli/dist/main.js" "$PLIST" || {
    echo "$LABEL runs another checkout. Reinstall it from here:" >&2
    echo "  node packages/cli/dist/main.js host install-service --instance dev --config ~/.config/switchyard-dev/host.json --state-dir \"\$HOME/Library/Application Support/switchyard-dev\"" >&2
    exit 1
  }
  step "Rebuilding this checkout and restarting $LABEL"
  pnpm build >/dev/null
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
fi

step "Ready for review"
echo "$URL  (revision ${SHA:0:7})"
