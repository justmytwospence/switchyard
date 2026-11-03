# Switchyard for herdr

A [herdr](https://herdr.dev) plugin that turns one whole herdr session into another interface to a Switchyard coordinator. herdr only shows things: every pane is a client, and Pi runs on whichever host owns the session.

| Switchyard | herdr |
|---|---|
| Workspace (main checkout or worktree) | Space, labelled `project` or `project · branch` (plus `· host` when the project has checkouts on several hosts) |
| Session (not archived) | Tab, labelled with the session title |
| Terminal session | Pi's own TUI in the tab |
| Session without a Pi terminal (its host can't run one) | Not shown; use the web app |

herdr is one client of Switchyard, not a requirement: this is `switchyard herdr ...` commands, and Switchyard works the same without it.

## What you can do in the paired session

- **Open a tab** in a space: it asks `Start a Switchyard session in <space>? [Y/n]`. Answer n to keep a plain shell.
- **Open a space**: it asks for a project and a workspace, or a new worktree.
- **The `switchyard: new session` action** does the same in a new tab of the focused space.
- **Rename a tab** to rename its session.
- **Close a tab** to archive its session. A running session is not archived: herdr shows a notice and the tab comes back. Stop the run first.
- **In a session's tab, Ctrl+] detaches**. Then Enter reattaches, and `q` closes the tab (which archives the session). A stopped session shows `Enter: resume`.
- **After a herdr restart**, tabs come back attached to the same sessions (each pane registers a resume command with herdr).

Sessions started anywhere else (the web app, your phone, automations) appear here within a moment, and archived ones disappear.

## Setup

1. Sign this machine's CLI in to the coordinator: `switchyard login --coordinator <url> --token <link>`, with a link from Settings › Devices › Add device. Set `SWITCHYARD_CLIENT_CONFIG` to keep a separate login per coordinator.
2. Pair a herdr session by creating `~/.config/switchyard-herdr/<herdr session>.env`, for example `switchyard-dev.env`:

   ```sh
   # How to run switchyard (default: switchyard on PATH)
   SWITCHYARD_CLI="node $HOME/Projects/switchyard/packages/cli/dist/main.js"
   # Which client.json to use (default: ~/.config/switchyard/client.json)
   SWITCHYARD_CLIENT_CONFIG="$HOME/.config/switchyard-dev/client.json"
   ```

   Use `switchyard.env` for a production coordinator. Herdr sessions without an env file, including your default one, are left alone.
3. Link or install the plugin: `herdr plugin link <repo>/integrations/herdr`.
4. Start the paired session: `herdr --session switchyard-dev`. Its startup hook starts the mirror.

## Files

State and logs live in `~/.local/state/switchyard-herdr/` (`$XDG_STATE_HOME`):

- `switchyard-herdr`: the stable launcher that herdr's resume commands run;
- `<herdr session>/daemon.log` and `daemon.pid`;
- `<herdr session>/spaces.json`: which spaces and tabs the mirror created. It only ever closes spaces it created.

MIT licensed, like Switchyard.
