# Switchyard for herdr

A [herdr](https://herdr.dev) plugin that gives every live Switchyard terminal session its own herdr space, showing Pi's own TUI, with the session's state (working, blocked, idle) in herdr's sidebar.

herdr is one client of Switchyard's terminal sessions, not a requirement: everything here is `switchyard herdr ...` commands built on `switchyard tui`, and Switchyard works the same without it. Terminal sessions are experimental; see [docs/terminal-sessions.md](../../docs/terminal-sessions.md).

- **One space per session.** A sync daemon (the plugin's startup hook) compares the coordinator's sessions with herdr's spaces every 5 seconds. A new live terminal session gets a space, and a session that is no longer live has its space closed after two checks. After a herdr restart, a restored pane sitting at its shell gets its terminal back.
- **The pane is the session.** It runs `switchyard herdr pane <session>`, which attaches Pi's terminal through the coordinator (`switchyard tui`). `Ctrl+]` detaches: Enter reattaches, `q` leaves the pane as a plain shell and stops the daemon from reopening it until you reattach.
- **Actions:** sync now, and list which pane shows which session.

## Setup

1. Sign in this machine's CLI to the coordinator: `switchyard login --coordinator <url> --token <link>` (a link from Settings › Devices › Add device).
2. Optionally create `~/.config/switchyard-herdr/env`:

   ```sh
   # How to run switchyard (default: switchyard on PATH)
   SWITCHYARD_CLI="node $HOME/Projects/switchyard/packages/cli/dist/main.js"
   # Which client.json to use (default: ~/.config/switchyard/client.json)
   SWITCHYARD_CLIENT_CONFIG="$HOME/.config/switchyard-dev/client.json"
   ```

3. Link or install the plugin: `herdr plugin link <repo>/integrations/herdr`.

## Files

State and logs live in `~/.local/state/switchyard-herdr/` (`$XDG_STATE_HOME`): `daemon.log`, `daemon.pid`, and `sessions/<session id>/`, which is each pane's working directory and how panes are found again after a herdr restart.

MIT licensed, like Switchyard.
