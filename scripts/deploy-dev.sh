#!/usr/bin/env bash
# Deploy the current dev branch to https://dev.switchyard.spencerboucher.com:
#   1. require a clean dev that is pushed (HEAD == origin/dev);
#   2. wait for CI on that commit, which publishes ghcr.io/justmytwospence/switchyard:dev;
#   3. on the NUC, pull and recreate the dev coordinator and its host (homelab's switchyard-dev
#      compose project) and check the running image is this commit;
#   4. on this Mac, rebuild this checkout and restart the dev host agent
#      (launchd com.switchyard.host.dev runs packages/cli/dist/main.js from this checkout).
# Prints the URL and revision for review. Branches use scripts/preview.sh instead.
set -euo pipefail

cd "$(dirname "$0")/.."
. scripts/lib.sh
URL=https://dev.switchyard.$DOMAIN
LABEL=com.switchyard.host.dev

require_pushed dev
wait_for_ci "$SHA"

step "Deploying :dev on $NUC"
ssh "$NUC" "cd $HOMELAB && docker compose -f switchyard-dev/docker-compose.yaml pull -q \
  && docker compose -f switchyard-dev/docker-compose.yaml up -d"
REV=$(image_revision switchyard-dev)
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
