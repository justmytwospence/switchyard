#!/usr/bin/env bash
# The preview slug of a branch, shared by CI (image tag br-<slug>) and scripts/preview.sh
# (host name, container, launchd instance pv-<slug>): lowercase, every run of other characters
# as "-", at most 29 characters (launchd instance names are 32 at most), no "-" at either end.
set -euo pipefail
slug=$(printf '%s' "${1:?usage: scripts/preview-slug.sh <branch>}" | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/^-+//' | cut -c1-29 | sed -E 's/-+$//')
[ -n "$slug" ] || { echo "no usable characters in branch name: $1" >&2; exit 1; }
printf '%s\n' "$slug"
