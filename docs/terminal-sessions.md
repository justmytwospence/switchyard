# Terminal sessions

A terminal session runs Pi's own interactive TUI instead of `pi --mode rpc`, so you can open the real Pi interface for any session from any terminal while phones and browsers keep their structured view: questions as cards, notifications, review. It is the default on every host that can run it; a host that cannot falls back to headless RPC sessions.

## How it works

- **A holder per session.** The host agent starts a small detached process, the terminal holder, which runs interactive `pi` in a pseudo-terminal (`node-pty`). The holder outlives the host agent, so restarting or upgrading the agent no longer interrupts sessions: the next agent reattaches. While no agent is attached, the holder buffers the session's events and hands them over on reattach.
- **An extension as the control channel.** Switchyard loads an extension into that Pi (`switchyard-terminal.js`). It answers the same commands the host sends over RPC (prompt, steer, follow-up, abort, state, stats) and reports session events in the same shape, so the rest of Switchyard treats both kinds of session alike.
- **Questions go to the terminal and to your phone.** Every extension's `ctx.ui` is one shared object in Pi. The extension wraps `select`, `confirm`, `input` and `editor` on it, so a question shows in the terminal and as a card at the same time, and the first answer wins. A card answered remotely closes the terminal dialog: through Pi's abort signal, or with Esc for the editor. A question answered in the terminal shows "Answered in the terminal" on the card. If that object cannot be patched (a future Pi might freeze it), the extension says so at startup, and cards tell you to answer in the terminal instead.
- **Terminal bytes go through the coordinator.** `switchyard tui <session>` connects to `/ws/terminal/<session>` on the coordinator, which relays to the host over the existing host link, which connects to the holder. It works from any machine signed in to the coordinator, and hosts still need no open ports. A headless terminal in the holder repaints the current screen for each new viewer.

## Turning it off

Terminal sessions are on by default. To run a host's sessions headless (RPC), set `"terminalSessions": false` in its `host.json` or `SWITCHYARD_TERMINAL_SESSIONS=0`, and restart the host agent. The agent logs `terminal sessions enabled` at start, or the reason they are unavailable (for example `node-pty is not available`), in which case sessions run headless.

Requirements:

- `node-pty`, an optional native dependency. It ships prebuilt binaries for macOS; on Linux it compiles on install (python3, make and a C++ compiler). The container image includes it.
- A coordinator that relays terminals (this version or later). An older coordinator simply never opens a terminal.

## Using it

```sh
switchyard tui <session id>       # Ctrl+] detaches; the session keeps running
```

`tui` resumes a stopped session first. Several viewers can watch the same session; they share one terminal size. By default the smallest attached viewer sets it (a phone viewer shrinks every other viewer); set `SWITCHYARD_TERMINAL_SIZING=latest` in the host agent's environment for the old behavior, where the last viewer to attach or resize wins. It applies to terminals started afterwards. Quitting Pi in the terminal (`/quit`, Ctrl+D) stops the session, and the next prompt or `tui` resumes it.

The herdr integration in [`integrations/herdr/`](../integrations/herdr/README.md) pairs a whole herdr session with a coordinator: a space per workspace and a tab per session, showing Pi's own TUI in each. Sessions without a Pi terminal are left out of it.

## Views and TUI clients

A view is a named filter over sessions (projects, hosts, pinned sessions), managed with `switchyard views`. A herdr or tmux session bound to a view (`SWITCHYARD_VIEW`, set by `switchyard herdr pair --view` or `switchyard tmux pair --view`) mirrors only that view, and any number of clients can share one: closing a tab or window archives the session, so every client and the web app stay in sync. The web navigator has a view switcher and shows which clients have a view open. See the [herdr](../integrations/herdr/README.md) and [tmux](../integrations/tmux/README.md) integrations.

## Limits

- Slash commands from Switchyard clients run Pi's extension commands, prompt templates and skills. Switchyard itself handles /model, /thinking, /compact and /name. Pi's other built-in commands (/tree, /settings, /login, ...) work only in the terminal.
- "Clear queue" cannot clear Pi's own queue, and the queue shown in clients is reconstructed by the extension, so it can lag what Pi shows.
- `ctx.ui.custom()` interfaces show in the terminal; clients show "Waiting in the terminal" unless the extension also asks through Switchyard's remote UI service (`switchyard.remote-ui.v1` on `pi.events`), as pi-plan-mode and pi-ask-user-question do. Then the question is a card too and the first answer wins.
- No retry notices, and no extension error diagnostics in clients: Pi does not expose those events to extensions.
- A message that is streaming while the host agent restarts can appear twice in clients.
- The systemd unit uses `KillMode=process`, so holders survive agent restarts on Linux too; reinstall the unit with `switchyard host install-service` to pick it up. A host agent in a container loses its terminal sessions when the container is recreated.
- Holders and their logs live next to the host's bridge sockets (`<state dir>/runtime`, or `/tmp/switchyard-<uid>` when that path is too long for a socket).
