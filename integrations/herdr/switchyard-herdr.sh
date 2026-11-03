#!/bin/sh
# Runs `switchyard herdr ...` with the settings in ~/.config/switchyard-herdr/env:
#   SWITCHYARD_CLI            how to run switchyard (default: switchyard on PATH),
#                             e.g. "node $HOME/Projects/switchyard/packages/cli/dist/main.js"
#   SWITCHYARD_CLIENT_CONFIG  client.json written by `switchyard login` (default: the usual one)
set -eu
ENV_FILE="${SWITCHYARD_HERDR_ENV:-${XDG_CONFIG_HOME:-$HOME/.config}/switchyard-herdr/env}"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi
if [ -n "${SWITCHYARD_CLIENT_CONFIG:-}" ]; then
  export SWITCHYARD_CLIENT_CONFIG
fi
# Unquoted on purpose: SWITCHYARD_CLI may be "node /path/to/main.js".
# shellcheck disable=SC2086
exec ${SWITCHYARD_CLI:-switchyard} herdr "$@"
