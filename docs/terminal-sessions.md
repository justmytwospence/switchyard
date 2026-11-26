# TUI sessions and terminals

Two words, two things:

- A **TUI session** is a session whose Pi runs its own interactive TUI in Switchyard's holder (`Session.terminal` on the wire), so you can open the real Pi interface from any terminal, the web app or a herdr tab, while phones and browsers keep their structured view: questions as cards, notifications, review.
- A **terminal** is a herdr or tmux session on one of your machines. It holds Pi you start there by hand, and can mirror Switchyard's sessions as tabs ([below](#views-and-terminals)).

A session's Pi runs in one of three ways: **held** in Switchyard's holder (a TUI session), **in your own pane** (a Pi you started by hand, [enrolled](#sessions-you-start-yourself)), or **headless** (RPC); Details names the terminal under Runs in for the second. TUI sessions are the default on every host that can run them; a host that cannot falls back to headless RPC sessions.

## How it works

- **A holder per session.** The host agent starts a small detached process, the terminal holder, which runs interactive `pi` in a pseudo-terminal (`node-pty`). The holder outlives the host agent, so restarting or upgrading the agent no longer interrupts sessions: the next agent reattaches. While no agent is attached, the holder buffers the session's events and hands them over on reattach.
- **An extension as the control channel.** Switchyard loads an extension into that Pi (`switchyard-terminal.js`). It answers the same commands the host sends over RPC (prompt, steer, follow-up, abort, state, stats) and reports session events in the same shape, so the rest of Switchyard treats both kinds of session alike.
- **Questions go to the terminal and to your phone.** Every extension's `ctx.ui` is one shared object in Pi. The extension wraps `select`, `confirm`, `input` and `editor` on it, so a question shows in the terminal and as a card at the same time, and the first answer wins. A card answered remotely closes the terminal dialog: through Pi's abort signal, or with Esc for the editor. A question answered in the terminal shows "Answered in the terminal" on the card. If that object cannot be patched (a future Pi might freeze it), the extension says so at startup, and cards tell you to answer in the terminal instead.
- **Terminal bytes go through the coordinator.** `switchyard tui <session>` connects to `/ws/terminal/<session>` on the coordinator, which relays to the host over the existing host link, which connects to the holder. It works from any machine signed in to the coordinator, and hosts still need no open ports. A headless terminal in the holder repaints the current screen for each new viewer.

## Turning it off

TUI sessions are on by default (the setting keeps its old name, `terminalSessions`). To run a host's sessions headless (RPC), set `"terminalSessions": false` in its `host.json` or `SWITCHYARD_TERMINAL_SESSIONS=0`, and restart the host agent. The agent logs `terminal sessions enabled` at start, or the reason they are unavailable (for example `node-pty is not available`), in which case sessions run headless.

Requirements:

- `node-pty`, an optional native dependency. It ships prebuilt binaries for macOS; on Linux it compiles on install (python3, make and a C++ compiler). The container image includes it.
- A coordinator that relays terminals (this version or later). An older coordinator simply never opens a terminal.

## Using it

```sh
switchyard tui <session id>       # Ctrl+] detaches; the session keeps running
```

`tui` resumes a stopped session first. Several viewers can watch the same session; they share one terminal size. By default the smallest attached viewer sets it (a phone viewer shrinks every other viewer); set `SWITCHYARD_TERMINAL_SIZING=latest` in the host agent's environment for the old behavior, where the last viewer to attach or resize wins. It applies to terminals started afterwards. Quitting Pi in the terminal (`/quit`, Ctrl+D) stops the session, and the next prompt or `tui` resumes it.

The herdr integration in [`modules/herdr/`](../modules/herdr/README.md) turns a herdr session into a mirror: a space per workspace and a tab per active branch, showing Pi's own TUI in each. Sessions without a TUI are left out of it.

Policy approval requests show a Switchyard URL in Pi; answer through the existing web interaction flow, not a native terminal policy picker. A healthy approval wait can outlast 30 seconds, but loss of coordinator communication fails closed. Older live holders may lack the current bridge and remain unprotected until explicitly reloaded or restarted; see [policies.md](policies.md).

## Sessions you start yourself

A Pi you start by hand in your own terminal can show up in Switchyard too, so you can follow it and answer it from your phone. Load Switchyard's extension into every Pi on the machine with a one-line global extension:

```sh
echo "export { default } from \"$(switchyard host pi-extension)\";" > ~/.pi/agent/extensions/switchyard.js
```

An interactive Pi with a terminal then enrols with the host agent on that machine (the one whose state directory is `SWITCHYARD_STATE_DIR` or the default; set `SWITCHYARD_ENROLL_STATE_DIR` to pick another, such as a dev agent's). Within a few seconds it is a live session in the workspace containing its working directory. If that directory is in a worktree Switchyard has not seen yet, it rescans the checkout and moves the session to that worktree. Pi that Switchyard starts, print and RPC runs, `--no-session` and `SWITCHYARD_ENROLL=0` never enrol, and without a host agent nothing happens. In a Pi that Switchyard starts, only the copy its holder loads (`SWITCHYARD_TERMINAL_EXTENSION`) runs, so a global shim of another version stays out of the way.

It records the terminal and pane it runs in: `herdr:<session>@<machine>` in herdr, `tmux:<session>@<machine>` in tmux (herdr wins when herdr runs inside tmux). The session keeps that place after you quit Pi, until Switchyard starts it. In the web app, such a Pi's row on Sessions names the terminal it runs in, and the Where layout groups sessions by it; "Only this" on that terminal's header shows just what is open there. Details says where it runs (Runs in), or after it stops where it last ran by hand. A mirror in the same terminal opens no tab for it, and focusing its pane in an attached herdr or tmux session counts as reading it.

The terminal stays yours:

- Web and phone can prompt, steer, queue, stop the current turn, change model and effort, and answer `select`, `confirm` and `input` questions (first answer wins). Pi's editor dialog is answered in the terminal only.
- Stop and archive never quit your Pi. Quitting it leaves a stopped session, and sending to it from Switchyard resumes it as an ordinary Switchyard session.
- There is no TUI relay: `switchyard tui`, the web terminal and mirror tabs do not show it. Running it in Switchyard's holder instead (held mode) is planned in [#25](https://github.com/justmytwospence/switchyard/issues/25).
- No `switchyard_*` agent tools and no policy hooks: the session shows as unprotected ([policies.md](policies.md#enrolled-sessions)).

## Views and terminals

A view is a named part of your work, managed with `switchyard views` or in the web app: the sessions in a set of projects that you choose, or that a [tracker](trackers.md) keeps (the sessions on its issues' branches plus live sessions in its repositories), plus any session you pin. A pin is membership only: it does not keep a session from being archived, and archiving removes it. A view does not depend on where a session was started: a Pi you start by hand in any terminal belongs to the views that hold its project, and starting a session in the web app with a view selected does not pin it. `switchyard herdr new` and `switchyard tmux new` pin the new session to the view their terminal mirrors only when the view would not show it otherwise (a pinned-only view, or a project or host outside it), and say so.

Every herdr or tmux session where the Switchyard plugin runs and the CLI is signed in is a **terminal** (`herdr:<session>@<machine>`). Switchyard records what each one mirrors:

- **nothing** (the default): the plugin opens and closes nothing. Pi you start there by hand still enrols, shows under Where and in its views, and counts as read while focused;
- **everything**: every session, in every view;
- **a view**, recorded by id, so renaming the view keeps it. Deleting the view makes its terminals mirror nothing.

Choose with `switchyard terminals bind herdr:<session> --all | --view <name> | --none` (`terminals list` shows every terminal; `herdr pair` and `tmux pair` take the same flags), or in the web app under Settings > Terminals. A name never binds anything: a herdr session named like a view mirrors nothing until you choose.

A mirror shows **branches**: a tab (tmux: a window) for each branch's primary session while the branch is active (live or waiting for input, unread, or active in the last 48 hours). A pin is membership only and opens no tab by itself. With hundreds of stopped sessions, "everything" still opens only the work in hand. A tab the mirror opened closes once its branch goes inactive, unless you are in it. Extras open on demand: a new tab in a branch's space offers that workspace's sessions to open. A tab you open stays while its session exists.

Closing a primary's tab archives the session everywhere (a running session is refused); closing an extra's tab only hides it until it is active again. A session whose Pi you started by hand in that terminal gets no mirror tab there.

The session in the focused pane or window of an attached terminal (a herdr client or tmux client on that session) counts as viewed, as in the web app: it is not marked unread when it finishes, and notifications for it stay inline. The plugin refreshes this every 15 seconds while something is focused.

`switchyard views list` shows the terminals mirroring each view, the web navigator and Board say where a view is mirrored, and Settings > Devices lists each device's terminals. Use one herdr session for everything, a terminal per view, or both. See the [herdr](../modules/herdr/README.md) and [tmux](../modules/tmux/README.md) integrations, and [model.md](model.md).

### From 0.19

0.19 bound a herdr or tmux session to `SWITCHYARD_VIEW` from its env file, else to the view named after it. On its first start, the new plugin records that once: `SWITCHYARD_VIEW` if set, else the view named after the session only if the plugin was actually mirroring it (it had created spaces or windows). Every other terminal records nothing, so it mirrors nothing. After that, `SWITCHYARD_VIEW` is ignored (the daemon log says so when it disagrees) and `pair` no longer writes it. Against a coordinator older than this version, the plugin keeps 0.19's binding.

## Limits

- Slash commands from Switchyard clients run Pi's extension commands, prompt templates and skills. Switchyard itself handles /model, /thinking, /compact and /name. Pi's other built-in commands (/tree, /settings, /login, ...) work only in the terminal.
- "Clear queue" cannot clear Pi's own queue, and the queue shown in clients is reconstructed by the extension, so it can lag what Pi shows.
- `ctx.ui.custom()` interfaces show in the terminal; clients show "Waiting in the terminal" unless the extension also asks through Switchyard's remote UI service (`switchyard.remote-ui.v1` on `pi.events`), as pi-plan-mode and pi-ask-user-question do. Then the question is a card too and the first answer wins.
- No retry notices, and no extension error diagnostics in clients: Pi does not expose those events to extensions.
- A message that is streaming while the host agent restarts can appear twice in clients.
- The systemd unit uses `KillMode=process`, so holders survive agent restarts on Linux too; reinstall the unit with `switchyard host install-service` to pick it up. A host agent in a container loses its TUI sessions when the container is recreated.
- Holders and their logs live next to the host's bridge sockets (`<state dir>/runtime`, or `/tmp/switchyard-<uid>` when that path is too long for a socket).
