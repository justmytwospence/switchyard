#!/bin/sh
# Runs `switchyard herdr ...` for the herdr session this process belongs to. A herdr session is
# paired with a Switchyard coordinator by ~/.config/switchyard-herdr/<herdr session>.env:
#   SWITCHYARD_CLI            how to run switchyard (default: switchyard on PATH),
#                             e.g. "node $HOME/Projects/switchyard/packages/cli/dist/main.js"
#   SWITCHYARD_CLIENT_CONFIG  client.json written by `switchyard login` (default: the usual one)
#   SWITCHYARD_VIEW           name or id of the view to mirror (default: every session)
# The file is optional: without it the session mirrors the view named after it, if one exists.
set -eu
SWITCHYARD_HERDR_ROOT=$(cd "$(dirname "$0")" && pwd)
export SWITCHYARD_HERDR_ROOT

case "${HERDR_SOCKET_PATH:-}" in
*/sessions/*/herdr.sock)
  name=${HERDR_SOCKET_PATH%/herdr.sock}
  name=${name##*/}
  ;;
*) name=${HERDR_SESSION:-default} ;;
esac
SWITCHYARD_HERDR_SESSION=$name
export SWITCHYARD_HERDR_SESSION

ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/switchyard-herdr/$name.env"
# The env file is optional: it only overrides how switchyard runs and which view is mirrored.
if [ -f "$ENV_FILE" ]; then
# shellcheck disable=SC1090
  . "$ENV_FILE"
fi
if [ -n "${SWITCHYARD_CLIENT_CONFIG:-}" ]; then
  export SWITCHYARD_CLIENT_CONFIG
fi
if [ -n "${SWITCHYARD_VIEW:-}" ]; then
  export SWITCHYARD_VIEW
fi
if [ "${1:-}" = "new-here" ]; then
  shift
  set -- new --here "$@"
fi
# Unquoted on purpose: SWITCHYARD_CLI may be "node /path/to/main.js".
# shellcheck disable=SC2086
exec ${SWITCHYARD_CLI:-switchyard} herdr "$@"
