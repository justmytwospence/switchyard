#!/usr/bin/env bash
# Branch previews: a throwaway coordinator per branch on the NUC, from the branch's CI image
# (ghcr.io/justmytwospence/switchyard:br-<slug>), at https://<slug>.switchyard-dev.spencerboucher.com,
# with pairing-only sign-in and its own data, plus a host agent on this Mac running this
# checkout's build (launchd com.switchyard.host.pv-<slug>).
#
#   scripts/preview.sh up [branch]     deploy the pushed branch (default: the current one)
#   scripts/preview.sh pair [branch]   print a fresh single-use sign-in link
#   scripts/preview.sh down [branch]   remove the coordinator, its data and the Mac host agent
#   scripts/preview.sh ls              list previews
#   scripts/preview.sh prune           remove previews whose branch is gone or merged into dev
set -euo pipefail

cd "$(dirname "$0")/.."
. scripts/lib.sh

usage() { sed -n '7,11s/^# //p' "$0" >&2; exit 2; }

setup() {
  BRANCH=${1:-$(git rev-parse --abbrev-ref HEAD)}
  SLUG=$(scripts/preview-slug.sh "$BRANCH")
  NAME=switchyard-preview-$SLUG
  HOST=$SLUG.switchyard-dev.$DOMAIN
  URL=https://$HOST
  IMAGE=ghcr.io/justmytwospence/switchyard:br-$SLUG
  DIR="\$HOME/.local/share/switchyard-previews/$SLUG" # expanded on the NUC
  CFG=$HOME/.config/switchyard-preview/$SLUG
  STATE="$HOME/Library/Application Support/switchyard-preview/$SLUG"
  LABEL=com.switchyard.host.pv-$SLUG
  PLIST=$HOME/Library/LaunchAgents/$LABEL.plist
}

refuse_trunk() {
  case "$BRANCH" in
    main | dev) echo "main is production and dev deploys with scripts/deploy-dev.sh" >&2; exit 1 ;;
  esac
}

pair_link() { ssh -t "$NUC" "docker exec $NAME switchyard pair"; }

up() {
  refuse_trunk
  require_pushed "$BRANCH"
  wait_for_ci "$SHA" "$BRANCH"

  step "Starting $NAME on $NUC"
  ssh "$NUC" "mkdir -p $DIR/data && NAME=$NAME IMAGE=$IMAGE HOST=$HOST DIR=$DIR \
    docker compose -p $NAME -f - up -d --wait" < deploy/preview.compose.yaml
  REV=$(image_revision "$NAME")
  [ "$REV" = "$SHA" ] || { echo "$NAME runs $REV, expected $SHA" >&2; exit 1; }
  echo "$NAME runs $REV"

  step "Host agent on this Mac ($LABEL)"
  [ -d node_modules ] || pnpm install --frozen-lockfile
  pnpm build >/dev/null
  if [ ! -f "$CFG/host.json" ]; then
    local token
    token=$(ssh "$NUC" "docker exec $NAME switchyard pair host --json" | jq -r .token)
    node packages/cli/dist/main.js host enroll --coordinator "$URL" --token "$token" \
      --name "$(scutil --get LocalHostName)-$SLUG" --config "$CFG/host.json"
  fi
  if [ -f "$PLIST" ]; then
    launchctl kickstart -k "gui/$(id -u)/$LABEL"
  else
    node packages/cli/dist/main.js host install-service --instance "pv-$SLUG" \
      --config "$CFG/host.json" --state-dir "$STATE"
  fi

  step "Preview ready"
  echo "$URL  (revision ${SHA:0:7})"
  pair_link
}

down() {
  step "Removing preview $SLUG"
  ssh "$NUC" "docker compose -p $NAME down && rm -rf $DIR"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  rm -rf "$CFG" "$STATE"
  echo "Removed preview $SLUG"
}

slugs() { ssh "$NUC" "docker ps -a --format '{{.Names}}'" | sed -n 's/^switchyard-preview-//p'; }

ls_previews() {
  local s
  for s in $(slugs); do echo "$s  https://$s.switchyard-dev.$DOMAIN"; done
}

prune() {
  git fetch -q --prune origin
  local s b found reason
  for s in $(slugs); do
    found=""
    for b in $(git for-each-ref --format='%(refname:strip=3)' refs/remotes/origin); do
      [ "$b" = HEAD ] && continue
      if [ "$(scripts/preview-slug.sh "$b")" = "$s" ]; then found=$b; break; fi
    done
    if [ -z "$found" ]; then
      reason="no branch on origin"
    elif git merge-base --is-ancestor "origin/$found" origin/dev; then
      reason="$found merged into dev"
    else
      continue
    fi
    setup "$s"
    down
    echo "pruned $s ($reason)"
  done
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  up) setup "$@"; up ;;
  pair) setup "$@"; refuse_trunk; pair_link ;;
  down) setup "$@"; down ;;
  ls) ls_previews ;;
  prune) prune ;;
  *) usage ;;
esac
