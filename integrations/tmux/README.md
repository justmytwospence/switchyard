# Switchyard for tmux

A tmux plugin that turns one tmux session into another interface to a Switchyard coordinator. tmux only shows things: every window is a client, and Pi runs on whichever host owns the session.

| Switchyard | tmux |
|---|---|
| Session (not archived, in the bound view) | Window, named `project · title` |
| Terminal session | Pi's own TUI in the window |
| Session without a Pi terminal | Not shown; use the web app |

## What you can do in the paired session

- **New window**: `prefix S` opens a window with the new-session picker. A window you open yourself with `prefix c` is a plain shell.
- **Rename a window** to rename its session (keep the `project · ` prefix or drop it).
- **Close a window** (`kill-window`) to archive its session. A running session is not archived: tmux shows a message and the window comes back.
- **`q` in a session's window** closes it (and archives the session) after you detach with Ctrl+]. Enter reattaches.
- **A crashed pane** is respawned, never archived: mirror windows use `remain-on-exit`.

Sessions started anywhere else (the web app, herdr, your phone) appear here within a moment, and archived ones disappear.

## Setup

1. Sign this machine's CLI in: `switchyard login --coordinator <url>`.
2. Pair a tmux session: `switchyard tmux pair --session work --view work` (writes `~/.config/switchyard-tmux/work.env`; `--cli` and `--client-config` set `SWITCHYARD_CLI` and `SWITCHYARD_CLIENT_CONFIG`).
3. Load the plugin: with TPM, `set -g @plugin '<repo>/integrations/tmux'`; otherwise `run-shell <repo>/integrations/tmux/switchyard.tmux` in `.tmux.conf`.
4. Start the session: `tmux new-session -s work`. Sessions without an env file are left alone.

## Views

`SWITCHYARD_VIEW` binds the session to a view (`switchyard views create`). Several tmux and herdr sessions can share one view: a close in one archives the session everywhere. Without a view, every session is mirrored.

## Files

State and logs live in `~/.local/state/switchyard-tmux/` (`$XDG_STATE_HOME`): the stable launcher, and per session `daemon.log`, `daemon.pid` and `windows.json`.
