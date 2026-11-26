#!/usr/bin/env bash
DIR="$(cd "$(dirname "$0")" && pwd)"
tmux set-hook -g session-created "run-shell -b 'SWITCHYARD_TMUX_SESSION=#{hook_session_name} sh $DIR/switchyard-tmux.sh daemon --ensure'"
tmux bind-key S new-window "sh $DIR/switchyard-tmux.sh new"
tmux run-shell -b "sh $DIR/switchyard-tmux.sh daemon --ensure"
