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

# find_ci_run <sha> <branch>: the push CI run of <branch> at <sha> (sets RUN). The branch matters:
# a new branch cut from dev shares dev's commit but has its own run.
find_ci_run() {
  local sha=$1 branch=$2
  RUN=""
  for _ in $(seq 1 30); do
    RUN=$(gh run list -R "$REPO" --workflow ci --branch "$branch" --commit "$sha" --json databaseId,event \
      --jq '[.[] | select(.event == "push")][0].databaseId // empty')
    [ -n "$RUN" ] && return 0
    sleep 10
  done
  echo "No CI run found for $sha on $branch" >&2
  exit 1
}

# wait_for_image <sha> <branch>: wait for that run's image job, which publishes the branch's image.
# The tests run alongside and keep running; promote.sh requires the whole run to pass.
wait_for_image() {
  local sha=$1 branch=$2 state=""
  step "Waiting for the image (CI image job) on $branch at ${sha:0:7}"
  find_ci_run "$sha" "$branch"
  for _ in $(seq 1 120); do
    state=$(gh run view -R "$REPO" "$RUN" --json jobs \
      --jq '[.jobs[] | select(.name == "image")][0] | "\(.status) \(.conclusion)"')
    case "$state" in
      "completed success") echo "Image built (CI run $RUN)"; return 0 ;;
      "completed cancelled") echo "CI run $RUN was cancelled (superseded by a newer push?); deploy the latest commit" >&2; exit 1 ;;
      completed*) echo "The image job failed: https://github.com/$REPO/actions/runs/$RUN" >&2; exit 1 ;;
    esac
    sleep 10
  done
  echo "Timed out waiting for the image job of CI run $RUN" >&2
  exit 1
}

# report_tests: where the still-running tests can be followed (call after wait_for_image).
report_tests() {
  echo "Tests: https://github.com/$REPO/actions/runs/$RUN (promote.sh requires them green)"
}

# image_revision <container>: the commit the NUC container's image was built from.
image_revision() {
  ssh "$NUC" "docker inspect $1 --format '{{index .Config.Labels \"org.opencontainers.image.revision\"}}'"
}
