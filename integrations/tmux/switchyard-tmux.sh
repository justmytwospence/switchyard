#!/bin/sh
# Runs `switchyard tmux ...` for the tmux session this process belongs to. A tmux session is
# paired with a Switchyard coordinator by ~/.config/switchyard-tmux/<tmux session>.env:
#   SWITCHYARD_CLI            how to run switchyard (default: switchyard on PATH)
#   SWITCHYARD_CLIENT_CONFIG  client.json written by `switchyard login` (default: the usual one)
#   SWITCHYARD_VIEW           name or id of the view to mirror (default: every session)
# Without that file the plugin does nothing in this tmux session.
set -eu
SWITCHYARD_TMUX_ROOT=$(cd "$(dirname "$0")" && pwd)
export SWITCHYARD_TMUX_ROOT

if [ -n "${SWITCHYARD_TMUX_SESSION:-}" ]; then
  name=$SWITCHYARD_TMUX_SESSION
elif [ -n "${TMUX:-}" ]; then
  name=$(tmux display-message -p '#S' 2>/dev/null || echo switchyard)
else
  name=switchyard
fi
SWITCHYARD_TMUX_SESSION=$name
export SWITCHYARD_TMUX_SESSION

ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/switchyard-tmux/$name.env"
if [ ! -f "$ENV_FILE" ]; then
  case "${1:-}" in
  daemon | new) exit 0 ;;
  esac
  echo "switchyard-tmux: tmux session \"$name\" is not paired with Switchyard (create $ENV_FILE)" >&2
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
# Unquoted on purpose: SWITCHYARD_CLI may be "node /path/to/main.js".
# shellcheck disable=SC2086
exec ${SWITCHYARD_CLI:-switchyard} tmux "$@"
