# Switchyard for tmux

A tmux plugin that makes each tmux session a Switchyard **terminal**: Pi you start in it by hand shows up in Switchyard, and, if you choose, the session mirrors Switchyard as a window per active branch. tmux only shows things: every mirror window is a client, and Pi runs on whichever host owns the session.

| Switchyard | tmux |
|---|---|
| Branch, while active | Window with its primary session, named `project · title` |
| Extra session on a branch | A window you open from the picker |
| TUI session | Pi's own TUI in the window |
| Session without a TUI | Not shown; use the web app |
| Pi you started by hand in a pane | Stays in your pane; Switchyard opens no window for it here |

## What it mirrors

Nothing, until you choose: `switchyard terminals bind tmux:<session> --all` (every session), `--view <name>` (one view, recorded by id) or `--none`, or Settings > Terminals in the web app. A tmux session named like a view mirrors nothing until you bind it. A mirror opens a window for each branch's primary while the branch is active: live or waiting for input, unread, or active in the last 48 hours. A window the mirror opened closes once its branch goes inactive, unless you are in it. Several tmux and herdr sessions can mirror one view.

## What you can do in a mirroring session

- **New window**: `prefix S` opens a window with the picker: a session to open in the current window's workspace (extras included), a new session, or another project. A window you open yourself with `prefix c` is a plain shell.
- **Rename a window** to rename its session (keep the `project · ` prefix or drop it).
- **Close a primary's window** (`kill-window`) to archive its session. A running session is not archived: tmux shows a message and the window comes back. **Closing an extra's window** only hides it until the session is active again.
- **`q` in a session's window** closes it after you detach with Ctrl+]. Enter reattaches.
- **A crashed pane** is respawned, never archived: mirror windows use `remain-on-exit`.

Sessions started anywhere else (the web app, herdr, your phone) appear here within a moment, and archived ones disappear. In every tmux session, mirroring or not, the session in the active window counts as read while a client is attached.

## Setup

1. Sign this machine's CLI in: `switchyard login --coordinator <url>`.
2. Load the plugin: with TPM, `set -g @plugin '<repo>/integrations/tmux'`; otherwise `run-shell <repo>/integrations/tmux/switchyard.tmux` in `.tmux.conf`. It starts the daemon in every tmux session (quiet where the CLI is not signed in).
3. Choose what a session mirrors: `switchyard terminals bind tmux:work --view work`, or `switchyard tmux pair --session work --view work`, which also writes `~/.config/switchyard-tmux/work.env` (`--cli` and `--client-config` set `SWITCHYARD_CLI` and `SWITCHYARD_CLIENT_CONFIG`; the file is only needed for those).
4. Start the session: `tmux new-session -s work`.

`SWITCHYARD_VIEW` in an env file is read once, from 0.19 setups, and recorded as the binding when none is recorded; see [terminal-sessions.md](../../docs/terminal-sessions.md#from-019).

## Files

State and logs live in `~/.local/state/switchyard-tmux/` (`$XDG_STATE_HOME`): the stable launcher, and per session `daemon.log`, `daemon.pid` and `windows.json`.
