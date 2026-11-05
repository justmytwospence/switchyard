#!/bin/sh
# Runs `switchyard herdr ...` for the herdr session this process belongs to. A herdr session is
# paired with a Switchyard coordinator by ~/.config/switchyard-herdr/<herdr session>.env:
#   SWITCHYARD_CLI            how to run switchyard (default: switchyard on PATH),
#                             e.g. "node $HOME/Projects/switchyard/packages/cli/dist/main.js"
#   SWITCHYARD_CLIENT_CONFIG  client.json written by `switchyard login` (default: the usual one)
#   SWITCHYARD_VIEW           name or id of the view to mirror (default: every session)
# Without that file the plugin does nothing in this herdr session.
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
if [ ! -f "$ENV_FILE" ]; then
  case "${1:-}" in
  daemon | new-here) exit 0 ;;
  esac
  echo "switchyard-herdr: herdr session \"$name\" is not paired with Switchyard (create $ENV_FILE)" >&2
  exit 1
fi
# shellcheck disable=SC1090
. "$ENV_FILE"
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
