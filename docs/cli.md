# CLI and terminal client

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
| `attach [sessionId]` | Open the terminal client |
| `hosts list` / `folders` / `scan` | List hosts; show or change a host's project folders (`--set`, `--add`, `--remove`, `--clear`; quote `~`); scan them now |
| `sessions list` / `import` | List sessions; import an inactive Pi session file |
| `tasks create` / `list` / `move` | Create, list and move tasks |
| `automations list` / `run` | List automations; fire one now |
| `doctor` | Check Node, Pi, git, the coordinator, sign-in, credentials, the host link and push (PASS/FAIL/WARN) |

List commands accept `--json`.

## Credentials

`init` and `pair` act as the server's local administrator: they read `admin.token` from the data directory (or `SWITCHYARD_ADMIN_TOKEN`) and talk to the coordinator running on this machine.

Work commands (`sessions`, `tasks`, `automations`, `attach`, `doctor`) look for credentials in this order:

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

## Terminal client

```sh
switchyard login --coordinator https://switchyard.example.com --token <enrollment token or link>
switchyard attach
```

| Key | Action |
|---|---|
| `/` | Search sessions |
| Enter | Send; while the agent runs, queue a follow-up |
| Ctrl+S | Steer the current turn (when the host supports it) |
| Alt+Enter | New line |
| Tab | Move to a pending question; arrows and Enter choose, Space toggles multi-select options |
| Ctrl+T | Take over, or return control to automation |
| Ctrl+X | Stop the run (after confirming) |
| Esc | Back |
| `?` | Help |
| Ctrl+C | Detach. Sessions keep running on their hosts |
