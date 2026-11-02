# Switchyard

Switchyard is a self-hosted metaharness for the [Pi](https://github.com/earendil-works/pi) coding agent. It combines interactive coding, remote headless execution, plugin interfaces and scheduled background work: one persistent Pi session is reachable from the terminal, a desktop browser and a phone PWA, and a task card, a notification and a conversation all point at the same work. A coordinator owns tasks, scheduling, attention and sync; native host agents on your machines own the real `pi --mode rpc` processes, repositories and credentials.

## Features

- Standalone (one process) or server operation (coordinator in a container, native hosts enroll) with identical protocols
- Owner sign-in with passkeys or any OpenID Connect provider, plus pairing by QR code; a server is owned before it serves anything
- Persistent Pi conversations with repo-local git worktrees and workspace discovery
- Tasks with dependencies, kanban board, review flow, bounded continuation and acceptance checks
- Automations: cron, once, webhook and dependency triggers with overlap and missed-run policies
- Plugin interactions: Pi dialogs and extension UI rendered in every client, with adapters (owner, plugin and project tiers; Pi packages can ship their own)
- Attention queue and coordinated notifications (Web Push, presence-aware routing, quiet hours, private previews)
- Human takeover and return to automation
- Responsive web app (PWA), Ink terminal client and a scriptable CLI
- Per-device revocable credentials, backup, restore, migrations and diagnostics

Switchyard does not assume a network or an identity provider. Run it on your laptop, behind a reverse proxy (Caddy, Traefik, nginx) or on a VPN or tailnet.

## Requirements

- Node >=24
- pnpm 12 (to build from source)
- git
- Pi >=1.4.0 <1.6.0 on every host that runs sessions (see [docs/compatibility.md](docs/compatibility.md))

## Quick start

On one machine, from source:

```
pnpm i && pnpm build && node packages/cli/dist/main.js up
```

`up` runs the coordinator and a local host agent on `http://localhost:7400`, prints a single-use sign-in link (with a QR code) and opens it in your browser. Add a passkey under Settings › Sign-in so other devices can sign in without a link, or use Settings › Devices › Add device.

As a server, from the container image (the coordinator only; hosts run Pi on your machines):

```
docker run -d --name switchyard -p 127.0.0.1:7400:7400 -v switchyard-data:/data \
  -e SWITCHYARD_PUBLIC_URL=http://localhost:7400 \
  ghcr.io/justmytwospence/switchyard:0.2.0
docker exec switchyard switchyard init
```

`init` prints a single-use link for your first device. For a real deployment use [`deploy/compose.yaml`](deploy/compose.yaml) and put a reverse proxy or VPN in front: see [docs/deployment.md](docs/deployment.md). Then enroll a host on the machine with your repositories (Settings › Hosts › Add host) and install it as a service with `switchyard host install-service`.

From a terminal:

```
switchyard login --coordinator http://localhost:7400 --token <enrollment token or link>
switchyard attach
```

In the terminal client: `/` searches sessions, Enter sends (while the agent runs it queues a follow-up, Ctrl+S steers), Alt+Enter inserts a newline, Tab moves to a pending question (arrows and Enter to choose, Space to toggle multi-select options), Ctrl+T takes over or returns control to automation, Ctrl+X stops (after confirming), Esc goes back, `?` shows help. Ctrl+C only detaches: sessions keep running on their hosts.

## Architecture

```
 phone PWA / desktop web / Ink terminal / CLI
          | REST + /ws/client (device credential)
   +------v-------------------------------------------+
   | coordinator (Fastify, SQLite WAL)                |
   | identities, projects, tasks, runs, scheduler,    |
   | dispatcher, attention, presence, push, event log |
   +------^-------------------------------------------+
          | /ws/host (outbound from host; commands + receipts; events + acks)
   +------+-------------------------------------------+
   | host-agent (native, runs as the OS user)         |
   | SQLite outbox/receipts/dispatches/interactions,  |
   | git/worktrees, adapters, session supervisor      |
   +------+-------------------------------------------+
          | stdio JSONL (pi --mode rpc) + bridge socket
        pi processes (one per live session)
```

| Area | Owner |
|---|---|
| Tasks, automations and dispatch decisions | Coordinator |
| Processes, interactions, filesystem and git truth | Host |
| Native history (session JSONL) | Pi |
| Transcript items for presentation | Coordinator (cached) |

Hosts connect outbound, so the coordinator needs neither the host's home directory nor the Docker socket. Pi runs with the host agent's OS-user privileges; see the privilege model in [docs/deployment.md](docs/deployment.md#privilege-model).

## Packages

| Package | Role |
|---|---|
| `protocol` | Shared zod schemas and types: entities, events, host and client wire, REST API |
| `pi-runtime` | Pi RPC client, session runtime, version gate and the bridge extension |
| `adapter-sdk` | Adapter manifest, server hooks and portable UI components |
| `adapter-examples` | Example adapter for adapter authors |
| `host-agent` | Native host agent: Pi supervisor, worktrees, outbox, dispatch and enrollment |
| `coordinator` | Fastify and SQLite coordinator: auth, tasks, scheduler, attention, push, ops |
| `web` | React PWA (desktop and mobile layouts, kanban, attention, automations, settings) |
| `terminal` | Ink terminal client for attaching to sessions |
| `cli` | The `switchyard` command |
| `test-fixtures` | Scripted mock model server and isolated Pi environments for tests |

## CLI

| Command | Purpose |
|---|---|
| `up` | Standalone coordinator plus local host (auto-enrolled); sets the server up on first start |
| `init` | Set up this server and print a single-use sign-in link for your first device |
| `coordinator start` / `backup` / `restore` / `migrate` | Run the coordinator; back up, restore and migrate its database |
| `host enroll` / `run` / `install-service` / `backup` / `status` | Enroll (`--token` or `--secret`) and run a host agent (it waits for enrollment instead of exiting), install it as a launchd or systemd user service, back up and inspect it |
| `pair [--host]` | Create a device (or host) enrollment and print the URL and a terminal QR; also the recovery path when every device is lost |
| `login` | Enroll this terminal as a device (`--coordinator`, `--token <token or enrollment link>`) |
| `doctor` | Check Node, Pi, git, coordinator, credentials, host link and push (PASS/FAIL/WARN) |
| `sessions list` / `import` | List sessions; import an inactive Pi session file |
| `attach [sessionId]` | Open the terminal client |
| `tasks create` / `list` / `move` | Create, list and move tasks |
| `automations list` / `run` | List and run automations |

List commands accept `--json`.

Environment variables (the full table, with defaults, is in [docs/deployment.md](docs/deployment.md#environment-reference)):

| Variable | Used by |
|---|---|
| `SWITCHYARD_DATA_DIR`, `SWITCHYARD_PUBLIC_URL`, `SWITCHYARD_TRUSTED_ORIGINS` (comma-separated), `SWITCHYARD_WEB_DIST`, `SWITCHYARD_LOG_LEVEL` | Coordinator (`up`, `coordinator start`) |
| `SWITCHYARD_LISTEN` (`host:port`), `SWITCHYARD_TRUSTED_PROXIES`, `SWITCHYARD_OIDC_*` | `coordinator start` (`up` uses `--port` and `--host`) |
| `SWITCHYARD_HOST_ENROLL_SECRET` | Coordinator (enables secret enrollment) and hosts |
| `SWITCHYARD_COORDINATOR_URL`, `SWITCHYARD_HOST_NAME` | Hosts that enroll themselves |
| `SWITCHYARD_ADMIN_TOKEN` | `init`, `pair` |
| `SWITCHYARD_URL`, `SWITCHYARD_TOKEN` | Work commands (override `client.json`) |
| `SWITCHYARD_HOST_CONFIG`, `SWITCHYARD_STATE_DIR`, `SWITCHYARD_PI_BIN` | Host agent |

Work commands (`sessions`, `tasks`, `automations`, `attach`, `doctor`) take credentials from `--coordinator`/`--credential`, then `SWITCHYARD_URL`/`SWITCHYARD_TOKEN`, then `~/.config/switchyard/client.json`, then the local `admin.token` in the data dir against the locally running coordinator (default `http://127.0.0.1:7400`).

## Development

```
pnpm build      # tsc -b for every TS package, then the web bundle
pnpm test       # vitest run
pnpm lint       # biome check .
pnpm test:e2e   # Playwright web tests
```

## Documentation

- [docs/deployment.md](docs/deployment.md): local, server, reverse proxy and VPN patterns, hosts, environment reference, privilege model
- [docs/auth.md](docs/auth.md): the owner model, passkeys, single sign-on, pairing devices, enrolling hosts, revocation
- [docs/operations.md](docs/operations.md): backup, restore, migrations, retention, logs, health, diagnostics
- [docs/spec.md](docs/spec.md): the product specification
- [docs/adapters.md](docs/adapters.md): writing adapters
- [docs/compatibility.md](docs/compatibility.md): tested Pi versions and capabilities
