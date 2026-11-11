# Shared by scripts/deploy-dev.sh and scripts/preview.sh (sourced, not run).
REPO=justmytwospence/switchyard
NUC=${SWITCHYARD_DEV_NUC:-nuc}
HOMELAB=${SWITCHYARD_DEV_HOMELAB:-'~/Projects/homelab'}
DOMAIN=spencerboucher.com

step() { printf '\n==> %s\n' "$*"; }

# require_pushed <branch>: a clean checkout of <branch> whose HEAD is origin/<branch>. Sets SHA.
require_pushed() {
  local branch=$1
  step "Checking $branch is clean and pushed"
  [ "$(git rev-parse --abbrev-ref HEAD)" = "$branch" ] || { echo "Not on $branch" >&2; exit 1; }
  local dirty
  dirty=$(git status --porcelain)
  [ -z "$dirty" ] || { echo "Working tree is not clean:" >&2; echo "$dirty" >&2; exit 1; }
  git fetch -q origin "$branch"
  SHA=$(git rev-parse HEAD)
  [ "$SHA" = "$(git rev-parse "origin/$branch")" ] || {
    echo "HEAD ($SHA) is not origin/$branch; push first" >&2
    exit 1
  }
  echo "$SHA"
}

# wait_for_ci <sha> <branch>: wait for the push CI run of <branch> at <sha>, which also publishes
# its image. The branch matters: a new branch cut from dev shares dev's commit and CI run.
wait_for_ci() {
  local sha=$1 branch=$2 run=""
  step "Waiting for CI (image) on $branch at ${sha:0:7}"
  for _ in $(seq 1 30); do
    run=$(gh run list -R "$REPO" --workflow ci --branch "$branch" --commit "$sha" --json databaseId,event \
      --jq '[.[] | select(.event == "push")][0].databaseId // empty')
    [ -n "$run" ] && break
    sleep 10
  done
  [ -n "$run" ] || { echo "No CI run found for $sha" >&2; exit 1; }
  gh run watch -R "$REPO" "$run" --exit-status --interval 20 >/dev/null
  echo "CI run $run passed"
}

# image_revision <container>: the commit the NUC container's image was built from.
image_revision() {
  ssh "$NUC" "docker inspect $1 --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}'"
}
