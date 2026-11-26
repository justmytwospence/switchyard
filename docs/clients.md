# Clients

A client is anything signed in that shows your work. All of them look at the same sessions; none of them owns one, and closing one never stops the work.

## What a client is

| Client | What it shows |
|---|---|
| The web app, in a browser or installed on a phone | Whatever you select there: every session, or one [scope](scopes.md) |
| The CLI | What you ask for (`switchyard sessions list`, `switchyard tui <session>`) |
| A herdr or tmux session | What Switchyard records for it: nothing, everything, or one scope, as a tab or window per active branch |

A **device** is the credential a client signs in with: a browser, an installed app, or a machine's CLI. The herdr and tmux sessions on a machine are clients under that machine's CLI device. Settings > Clients lists the devices, with the herdr and tmux sessions on each; revoking a device signs all of them out.

herdr and tmux are **client modules**: each is a plugin for that multiplexer plus a daemon in the Switchyard CLI ([herdr](../modules/herdr/README.md), [tmux](../modules/tmux/README.md)). Another multiplexer can be added the same way: the coordinator accepts any kind ([modules.md](modules.md#what-another-project-can-write-today)).

Every herdr or tmux session where the Switchyard plugin runs and the CLI is signed in is a client, with the id `<kind>:<session>@<machine>` (`herdr:work@mac`). It does two separate things:

- **It holds Pi you start there by hand.** Such a Pi enrols, shows up in Switchyard and belongs to the scopes that hold its project ([terminal-sessions.md](terminal-sessions.md#sessions-you-start-yourself)). This needs no binding.
- **It can mirror Switchyard**, if you choose what.

## What a client mirrors

Switchyard records what each herdr or tmux client mirrors:

- **nothing** (the default): the plugin opens and closes nothing. Pi you start there by hand still enrols, shows under Where and in its scopes, and counts as read while focused;
- **everything**: every session, in every scope;
- **a scope**, recorded by id, so renaming the scope keeps it. Deleting the scope makes its clients mirror nothing.

Choose with `switchyard clients bind herdr:<session> --all | --scope <name> | --none` (`clients list` shows every client; `herdr pair` and `tmux pair` take the same flags), or in the web app under Settings > Clients. A name never binds anything: a herdr session named like a scope mirrors nothing until you choose.

A mirror shows **branches**: a tab (tmux: a window) for each branch's primary session while the branch is active (live or waiting for input, unread, or active in the last 48 hours). A pin is membership only and opens no tab by itself. With hundreds of stopped sessions, "everything" still opens only the work in hand. A tab the mirror opened closes once its branch goes inactive, unless you are in it. Extras open on demand: a new tab in a branch's space offers that workspace's sessions to open. A tab you open stays while its session exists.

Closing a primary's tab archives the session everywhere (a running session is refused); closing an extra's tab only hides it until it is active again. A session whose Pi you started by hand in that client gets no mirror tab there. Only [terminal sessions](terminal-sessions.md) are mirrored: a session running over RPC has no Pi TUI to show.

Starting a session in the web app with a scope selected does not pin it. `switchyard herdr new` and `switchyard tmux new` pin the new session to the scope their client mirrors only when the scope would not show it otherwise (a pinned-only scope, or a project or host outside it), and say so.

`switchyard scopes list` shows the clients mirroring each scope, the scope's Edit dialog says where it is mirrored, and Settings > Clients lists each device's herdr and tmux sessions. Use one herdr session for everything, a client per scope, or both.

## Focus counts as reading

The session in the focused pane or window of a herdr or tmux client you are attached to counts as viewed, as in the web app: it is not marked unread when it finishes, and notifications for it stay inline. The plugin refreshes this every 15 seconds while something is focused. This holds for every client, mirroring or not.

## From 0.19

0.19 bound a herdr or tmux session to `SWITCHYARD_VIEW` from its env file, else to the view named after it. On its first start, a later plugin records that once: `SWITCHYARD_VIEW` if set, else the scope named after the session only if the plugin was actually mirroring it (it had created spaces or windows). Every other session records nothing, so it mirrors nothing. After that, `SWITCHYARD_VIEW` is ignored (the daemon log says so when it disagrees) and `pair` no longer writes it.

## From 0.20

- A herdr or tmux session was called a **terminal**; it is a client now, and "terminal" means only a [terminal session](terminal-sessions.md). `switchyard terminals` is `switchyard clients`, `--view` is `--scope`, and Settings > Terminals and Settings > Devices are one page, Settings > Clients. The old command and flag still work and print a notice.
- Recorded bindings carry over. A session that mirrored a tracker's view mirrors the same work as a GitHub scope.
- The plugins moved from `integrations/` to `modules/`. Link the herdr plugin again (`herdr plugin unlink switchyard`, then `herdr plugin link <repo>/modules/herdr`), and load `<repo>/modules/tmux/switchyard.tmux` in `.tmux.conf`.
- A daemon from 0.20 keeps working against a newer coordinator until you upgrade the CLI ([compatibility.md](compatibility.md#scopes-and-clients-021)). A newer CLI needs a coordinator at least as new: upgrade the coordinator first.
