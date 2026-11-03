# CLI

Everything is one command, `switchyard`. Install it with `npm install -g @spencerboucher/switchyard` (Node 24 or newer); in the container image it is already on `PATH`, and from a source checkout it is `node packages/cli/dist/main.js`. `switchyard <command> --help` shows every flag.

## Commands

| Command | Purpose |
|---|---|
| `up` | Run a coordinator and a local host in one process; sets the server up on first start and opens a sign-in link (`--no-open` to only print it) |
| `init` | Set up this server and print a single-use sign-in link for your first device; on a set-up server, print a new link |
| `pair [--host]` | Create a single-use link and QR for another device (or a host token); also the recovery path when every device is lost |
| `coordinator start` / `backup` / `restore` / `migrate` | Run the coordinator; back up, restore and migrate its database |
| `host enroll` / `run` / `install-service` / `backup` / `status` | Enroll this machine (`--token` or `--secret`), run the host agent (it waits for enrollment instead of exiting), install it as a launchd or systemd user service (`--instance <name>` with `--config` and `--state-dir` installs a second agent, e.g. for a development coordinator), back it up and inspect it |
| `login` | Enroll this terminal as a device (`--coordinator`, `--token <token or enrollment link>`) |
| `tui <sessionId>` | Open a terminal session's Pi TUI (Ctrl+] detaches; see [terminal-sessions.md](terminal-sessions.md)) |
| `herdr daemon` / `pane` / `new` / `status` | The herdr integration: mirror Switchyard into a paired herdr session, a space per workspace and a tab per session ([integrations/herdr](../integrations/herdr/README.md)) |
| `hosts list` / `folders` / `scan` | List hosts; show or change a host's project folders (`--set`, `--add`, `--remove`, `--clear`; quote `~`); scan them now |
| `sessions list` / `import` | List sessions; import an inactive Pi session file |
| `tasks create` / `list` / `move` | Create, list and move tasks |
| `automations list` / `run` | List automations; fire one now |
| `doctor` | Check Node, Pi, git, the coordinator, sign-in, credentials, the host link and push (PASS/FAIL/WARN) |

List commands accept `--json`.

## Credentials

`init` and `pair` act as the server's local administrator: they read `admin.token` from the data directory (or `SWITCHYARD_ADMIN_TOKEN`) and talk to the coordinator running on this machine.

Work commands (`sessions`, `tasks`, `automations`, `tui`, `doctor`) look for credentials in this order:

1. `--coordinator` and `--credential`
2. `SWITCHYARD_URL` and `SWITCHYARD_TOKEN`
3. `~/.config/switchyard/client.json`, written by `switchyard login`
4. the local `admin.token`, against the coordinator running on this machine (default `http://127.0.0.1:7400`)

## Environment

The full table, with defaults, is in [deployment.md](deployment.md#environment-reference).

| Variable | Used by |
|---|---|
| `SWITCHYARD_DATA_DIR`, `SWITCHYARD_PUBLIC_URL`, `SWITCHYARD_TRUSTED_ORIGINS`, `SWITCHYARD_WEB_DIST`, `SWITCHYARD_LOG_LEVEL` | The coordinator (`up`, `coordinator start`) |
| `SWITCHYARD_LISTEN`, `SWITCHYARD_TRUSTED_PROXIES`, `SWITCHYARD_OIDC_*` | The coordinator (`up` uses `--port` and `--host` instead of `SWITCHYARD_LISTEN`) |
| `SWITCHYARD_HOST_ENROLL_SECRET` | The coordinator (enables secret enrollment) and hosts |
| `SWITCHYARD_COORDINATOR_URL`, `SWITCHYARD_HOST_NAME` | Hosts that enroll themselves |
| `SWITCHYARD_HOST_CONFIG`, `SWITCHYARD_STATE_DIR`, `SWITCHYARD_PI_BIN` | The host agent |
| `SWITCHYARD_ADMIN_TOKEN` | `init`, `pair` |
| `SWITCHYARD_URL`, `SWITCHYARD_TOKEN` | Work commands |
| `SWITCHYARD_CLIENT_CONFIG` | Work commands and `login`: use this client.json instead of `~/.config/switchyard/client.json` |
| `SWITCHYARD_TERMINAL_SESSIONS` | The host agent: `0` runs sessions headless instead of as [terminal sessions](terminal-sessions.md) (the default) |

## Pi terminal

```sh
switchyard login --coordinator https://switchyard.example.com --token <enrollment token or link>
switchyard tui <session id>
```

`tui` opens the session's real Pi terminal through the coordinator; Ctrl+] detaches and the session keeps running. See [terminal-sessions.md](terminal-sessions.md). There is no Switchyard-specific terminal UI: use Pi's terminal or the web app.
