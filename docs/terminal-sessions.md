# Terminal sessions (experimental)

A terminal session runs Pi's own interactive TUI instead of `pi --mode rpc`, so you can open the real Pi interface for any session from any terminal while phones and browsers keep their structured view: questions as cards, notifications, review. It is off by default.

## How it works

- **A holder per session.** The host agent starts a small detached process, the terminal holder, which runs interactive `pi` in a pseudo-terminal (`node-pty`). The holder outlives the host agent, so restarting or upgrading the agent no longer interrupts sessions: the next agent reattaches. While no agent is attached, the holder buffers the session's events and hands them over on reattach.
- **An extension as the control channel.** Switchyard loads an extension into that Pi (`switchyard-terminal.js`). It answers the same commands the host sends over RPC (prompt, steer, follow-up, abort, state, stats) and reports session events in the same shape, so the rest of Switchyard treats both kinds of session alike.
- **Questions go to the terminal and to your phone.** Every extension's `ctx.ui` is one shared object in Pi. The extension wraps `select`, `confirm`, `input` and `editor` on it, so a question shows in the terminal and as a card at the same time, and the first answer wins. A card answered remotely closes the terminal dialog: through Pi's abort signal, or with Esc for the editor. A question answered in the terminal shows "Answered in the terminal" on the card. If that object cannot be patched (a future Pi might freeze it), the extension says so at startup, and cards tell you to answer in the terminal instead.
- **Terminal bytes go through the coordinator.** `switchyard tui <session>` connects to `/ws/terminal/<session>` on the coordinator, which relays to the host over the existing host link, which connects to the holder. It works from any machine signed in to the coordinator, and hosts still need no open ports. A headless terminal in the holder repaints the current screen for each new viewer.

## Enabling it on a host

Add `"terminalSessions": true` to the host's `host.json`, or set `SWITCHYARD_TERMINAL_SESSIONS=1`, and restart the host agent. New and resumed sessions on that host become terminal sessions. The agent logs `terminal sessions enabled`, or the reason they are unavailable (for example `node-pty is not available`), in which case sessions keep using RPC.

Requirements:

- `node-pty`, an optional native dependency. It ships prebuilt binaries for macOS; on Linux it compiles on install (python3, make and a C++ compiler).
- A coordinator that relays terminals (this version or later). An older coordinator simply never opens a terminal.

## Using it

```sh
switchyard tui <session id>       # Ctrl+] detaches; the session keeps running
```

`tui` resumes a stopped session first. Several viewers can watch the same session; they share one terminal size, and the most recent viewer to attach or resize sets it. Quitting Pi in the terminal (`/quit`, Ctrl+D) stops the session, and the next prompt or `tui` resumes it.

The herdr integration in [`integrations/herdr/`](../integrations/herdr/README.md) pairs a whole herdr session with a coordinator: a space per workspace and a tab per session, showing Pi's own TUI for terminal sessions.

## Limits

- Slash commands sent from Switchyard clients are refused in terminal sessions ("type it in the terminal"): Pi's extension API cannot run them.
- "Clear queue" cannot clear Pi's own queue, and the queue shown in clients is reconstructed by the extension, so it can lag what Pi shows.
- `ctx.ui.custom()` interfaces work in the terminal only; clients show "Waiting in the terminal".
- No retry notices, and no extension error diagnostics in clients: Pi does not expose those events to extensions.
- A message that is streaming while the host agent restarts can appear twice in clients.
- On Linux under systemd, the host unit's default `KillMode` stops holders together with the agent. Use `KillMode=process` if terminal sessions should survive agent restarts there.
- Holders and their logs live next to the host's bridge sockets (`<state dir>/runtime`, or `/tmp/switchyard-<uid>` when that path is too long for a socket).
