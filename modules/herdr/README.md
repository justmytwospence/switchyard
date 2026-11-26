# Switchyard for herdr

The herdr client module: a [herdr](https://herdr.dev) plugin that makes each herdr session a Switchyard **client**. Pi you start in it by hand shows up in Switchyard, and, if you choose, the session mirrors Switchyard as a space per workspace and a tab per active branch. herdr only shows things: Pi runs on whichever host owns the session.

| Switchyard | herdr |
|---|---|
| Workspace (main checkout or worktree) | Space, labelled `project` or `project · branch` (plus `· host` when the project has checkouts on several hosts) |
| Branch, while active | Tab with its primary session, labelled with the session title |
| Extra session on a branch | A tab you open from the new-tab picker |
| Terminal session | Pi's own TUI in the tab |
| RPC session (its host cannot run a terminal session) | Not shown; use the web app |
| Pi you started by hand in a pane | Stays in your pane; Switchyard opens no tab for it here |

herdr is one client of Switchyard, not a requirement: this is `switchyard herdr ...` commands, and Switchyard works the same without it. See [clients](../../docs/clients.md) for what every client has in common.

## What it mirrors

Nothing, until you choose. Every herdr session where the plugin runs and the CLI is signed in registers as a client (`herdr:<session>@<machine>`); Switchyard records what it mirrors:

```sh
switchyard clients list
switchyard clients bind herdr:default --all          # every session
switchyard clients bind herdr:work --scope work      # one scope (by id: renaming the scope keeps it)
switchyard clients bind herdr:scratch --none         # nothing
```

or in the web app under Settings > Clients. A herdr session named like a scope mirrors nothing until you bind it. A mirror opens a tab for each branch's primary while the branch is active: live or waiting for input, unread, or active in the last 48 hours. So "everything" stays usable with hundreds of stopped sessions. A tab the mirror opened closes once its branch goes inactive, unless you are in it.

Several clients can mirror the same scope, herdr and tmux alike. Work in one herdr session for everything, keep a herdr session per scope (for example one per team or customer), or do both.

## What you can do in a mirroring session

- **Open a tab** in a space: it offers the workspace's sessions to open (extras included), a new session there, or another project or workspace. A tab you open stays while its session exists.
- **Open a space**: a fuzzy picker asks for a project, then a workspace. Type a branch name to start a new worktree instead; a project without workspaces only offers that. A title is optional.
- **In the picker**, type to filter, ↑↓, Ctrl+J/K/N/P or Tab/Shift+Tab to move, Enter to choose, Esc to go back a step, and Ctrl+C (or Esc at the first step) to keep a plain shell. Only hosts that run terminal sessions are offered.
- **The `switchyard: new session` action** does the same in a new tab of the focused space.
- **Rename a tab** to rename its session.
- **Close a primary's tab** to archive its session. A running session is not archived: herdr shows a notice and the tab comes back. Stop the run first. **Closing an extra's tab** only hides it until the session is active again.
- **In a session's tab, Ctrl+] detaches**. Then Enter reattaches, and `q` closes the tab. A stopped session shows `Enter: resume`.
- **After a herdr restart**, tabs come back attached to the same sessions (each pane registers a resume command with herdr).

Sessions started anywhere else (the web app, your phone, automations) appear here within a moment, and archived ones disappear. In every herdr session, mirroring or not, the session in the focused pane counts as read while you are attached: it is not marked unread when it finishes, and its notifications stay inline.

## Setup

1. Sign this machine's CLI in to the coordinator: `switchyard login --coordinator <url>` (approve the code in a signed-in browser). Set `SWITCHYARD_CLIENT_CONFIG` to keep a separate login per coordinator.
2. Link or install the plugin: `herdr plugin link <repo>/modules/herdr`. Its startup hook starts the daemon in every herdr session (it stays quiet where the CLI is not signed in).
3. Choose what a session mirrors: `switchyard clients bind herdr:<session> --all` (or `--scope <name>`), or `switchyard herdr pair [--session <name>] [--scope <name> | --all]`, which also writes an env file (below).
4. Start it: `herdr` for `default`, or `herdr --session <name>`.

Upgrading from 0.20: the plugin moved from `integrations/` to `modules/`; link it again from the new path (`herdr plugin unlink switchyard`, then step 2).

An env file is only needed to run a different switchyard or sign in to another coordinator: `~/.config/switchyard-herdr/<herdr session>.env`, for example `switchyard-dev.env`:

```sh
# How to run switchyard (default: switchyard on PATH)
SWITCHYARD_CLI="node $HOME/Projects/switchyard/packages/cli/dist/main.js"
# Which client.json to use (default: ~/.config/switchyard/client.json)
SWITCHYARD_CLIENT_CONFIG="$HOME/.config/switchyard-dev/client.json"
```

`SWITCHYARD_VIEW` is read once, from 0.19 setups: on the first start of a later version, a session with no recorded binding records the scope of that name, and afterwards the variable is ignored. A session without it that was mirroring the scope named after it records that scope; every other session records nothing. See [clients](../../docs/clients.md#from-019).

## Files

State and logs live in `~/.local/state/switchyard-herdr/` (`$XDG_STATE_HOME`):

- `switchyard-herdr`: the stable launcher that herdr's resume commands run;
- `<herdr session>/daemon.log` and `daemon.pid`;
- `<herdr session>/spaces.json`: which spaces and tabs the mirror created. It only ever closes spaces it created.

`daemon --ensure` resolves the coordinator and credential (flags, environment, `client.json`) and passes them to the background daemon in its environment. The daemon finds whether you are attached from the process list (`herdr` or `herdr --session <name>`), since herdr's API does not say.

MIT licensed, like Switchyard.
