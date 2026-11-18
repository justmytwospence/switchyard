#!/usr/bin/env bash
# Deploy the current dev branch to https://dev.switchyard.spencerboucher.com:
#   1. require a clean dev that is pushed (HEAD == origin/dev);
#   2. wait for CI's image job on that commit, which publishes ghcr.io/justmytwospence/switchyard:dev
#      (the tests keep running; promote.sh requires them);
#   3. on the NUC, pull and recreate the dev coordinator and its host (homelab's switchyard-dev
#      compose project) and check the running image is this commit;
#   4. on this Mac, rebuild this checkout (started first, alongside CI) and restart the dev host agent
#      (launchd com.switchyard.host.dev runs packages/cli/dist/main.js from this checkout).
# Prints the URL and revision for review. Branches use scripts/preview.sh instead.
set -euo pipefail

cd "$(dirname "$0")/.."
. scripts/lib.sh
URL=https://dev.switchyard.$DOMAIN
LABEL=com.switchyard.host.dev

require_pushed dev

# The Mac's dev host agent runs this checkout's build; rebuild it while CI builds the image.
BUILD_PID=""
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  grep -qF "$PWD/packages/cli/dist/main.js" "$PLIST" || {
    echo "$LABEL runs another checkout. Reinstall it from here:" >&2
    echo "  node packages/cli/dist/main.js host install-service --instance dev --config ~/.config/switchyard-dev/host.json --state-dir \"\$HOME/Library/Application Support/switchyard-dev\"" >&2
    exit 1
  }
  BUILD_LOG=$(mktemp)
  pnpm build >"$BUILD_LOG" 2>&1 &
  BUILD_PID=$!
fi

wait_for_image "$SHA" dev

step "Deploying :dev on $NUC"
ssh "$NUC" "cd $HOMELAB && docker compose -f switchyard-dev/docker-compose.yaml pull -q \
  && docker compose -f switchyard-dev/docker-compose.yaml up -d"
REV=$(image_revision switchyard-dev)
[ "$REV" = "$SHA" ] || { echo "switchyard-dev runs $REV, expected $SHA" >&2; exit 1; }
echo "switchyard-dev runs $REV"

if [ -n "$BUILD_PID" ]; then
  step "Restarting $LABEL on this checkout's build"
  wait "$BUILD_PID" || { echo "pnpm build failed:" >&2; cat "$BUILD_LOG" >&2; exit 1; }
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
fi

step "Ready for review"
echo "$URL  (revision ${SHA:0:7})"
report_tests
