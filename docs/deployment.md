# Deployment

Switchyard runs in two shapes that use the same protocols and schemas:

- **Standalone**: one process on one machine runs the coordinator and a local host agent.
- **Hub**: the coordinator runs in Docker Compose with persistent storage; native host agents on the machines that own your repositories enroll with it and connect outbound.

Requirements: Node >=24, pnpm 12 (to build from source), git, and Pi >=1.4.0 <1.6.0 on every host that runs sessions. See [compatibility.md](compatibility.md).

## Standalone

```
pnpm i && pnpm build
node packages/cli/dist/main.js up
```

`switchyard up` starts the coordinator and a local host agent in one process.

| Setting | Default | Override |
|---|---|---|
| Port | 7400 | `--port` |
| Bind address | `0.0.0.0` | `--host` |
| Public URL | `http://127.0.0.1:<port>` | `--public-url`, `SWITCHYARD_PUBLIC_URL` |
| Trusted origins | the public URL's origin (plus `http://localhost:<port>` with the default URL) | `--trusted-origins`, `SWITCHYARD_TRUSTED_ORIGINS` |
| Web app | `packages/web/dist` next to the CLI, when built | `--web-dist`, `SWITCHYARD_WEB_DIST` |
| Data dir | `$XDG_DATA_HOME/switchyard`, else `~/.local/share/switchyard` (Linux); `~/Library/Application Support/switchyard/coordinator` (macOS) | `--data-dir`, `SWITCHYARD_DATA_DIR` |

- The local host is enrolled automatically on first start (a host enrollment created with the admin token, redeemed like any other host; `--name` sets its name). Its `host.json` and state (`host.db`, bridge sockets, logs) live in `<data-dir>/host/`, and it connects to the coordinator over loopback with the normal host protocol.
- `--dev` also trusts the Vite dev server origins (`http://localhost:5173`, `http://127.0.0.1:5173`) and turns on debug logs.
- `up` and `coordinator start` record the local URL in `<data-dir>/cli-endpoint.json`, so `pair` and admin-token commands on the same machine find the running coordinator.
- On first start with no devices enrolled, the coordinator prints a bootstrap enrollment link and a terminal QR to stderr (and logs the URL). Open it on the device you want to enroll, or run `switchyard pair` for a fresh link.
- Schedules (cron, once, webhooks, dependency triggers) only run while the process is awake. A sleeping laptop fires nothing; missed cron occurrences follow each automation's missed-run policy when it wakes.

Remote hosts can still enroll with a standalone coordinator, as described below.

## Hub: coordinator in Docker Compose

```
cd deploy
export SWITCHYARD_PUBLIC_URL=https://switchyard.example.com
mkdir -p data && sudo chown 1000:1000 data
docker compose up -d --build
```

[`deploy/compose.yaml`](../deploy/compose.yaml) builds the root `Dockerfile` (multi-stage, `node:26-bookworm-slim`, runs as the `node` user) and mounts `./data` at `/data`. The container runs `switchyard coordinator start --data-dir /data --listen 0.0.0.0:7400` and has a `HEALTHCHECK` on `/healthz`.

| Variable | Meaning |
|---|---|
| `SWITCHYARD_PUBLIC_URL` | The URL clients and hosts use. Drives enrollment links and the `Secure` cookie flag (https). |
| `SWITCHYARD_TRUSTED_ORIGINS` | Comma-separated browser origins allowed to call the API and open sockets. Defaults to the origin of the public URL. Set it only if browsers use additional origins (for example a LAN name next to a public name). |
| `SWITCHYARD_LOG_LEVEL` | pino level, default `info`. |
| `SWITCHYARD_LISTEN` | `host:port` to listen on (the image passes `--listen 0.0.0.0:7400`). |
| `SWITCHYARD_DATA_DIR` | Data directory (the image passes `--data-dir /data`). |
| `SWITCHYARD_WEB_DIST` | Directory of the built web app; the image sets `/app/packages/web/dist`. |

The coordinator container needs neither a host home directory nor the Docker socket, and the compose file mounts neither. Execution never happens in the container.

### Enroll a host

On the machine that has the repositories and Pi credentials:

1. Create a host enrollment token. Either run `switchyard pair --host` where you can reach the coordinator (it needs the admin token, see below), or use Settings > Hosts in the web app. The token is single use and expires after 30 minutes.

   In Docker:

   ```
   docker compose exec switchyard node /app/packages/cli/dist/main.js pair --host \
     --coordinator http://127.0.0.1:7400 --data-dir /data
   ```

2. On the host, enroll:

   ```
   switchyard host enroll --coordinator https://switchyard.example.com --token <token> [--name laptop]
   ```

   This writes `~/.config/switchyard/host.json` (mode 0600) with the coordinator URL, host id and credential. `SWITCHYARD_HOST_CONFIG` overrides the path.

3. Run the agent, either in the foreground or as a service:

   ```
   switchyard host run
   switchyard host install-service
   ```

   `host install-service` renders a template from `deploy/launchd` or `deploy/systemd` with the absolute paths of this Node binary, the CLI and `host.json` (plus your current `PATH`, so `pi` and `git` resolve), writes it, loads it and prints the file and every command it runs:

   | OS | File | Loaded with |
   |---|---|---|
   | macOS | `~/Library/LaunchAgents/com.switchyard.host.plist` | `launchctl bootout gui/<uid>/com.switchyard.host` (if loaded), then `launchctl bootstrap gui/<uid> <plist>` |
   | Linux | `~/.config/systemd/user/switchyard-host.service` | `systemctl --user daemon-reload`, `enable --now`, `restart` |

   `--print` shows the rendered file without writing it; `--no-load` writes it without loading. The service runs `switchyard host run --config <host.json>` and logs to `<host state dir>/logs/host.log` (launchd) or the user journal (systemd). Nothing is installed or started unless you run the command. On Linux, `loginctl enable-linger <user>` keeps user services running while you are logged out.

Host state (`host.db`, `runtime/`, `logs/`) defaults to `~/Library/Application Support/switchyard` on macOS and `~/.local/state/switchyard` on Linux (`SWITCHYARD_STATE_DIR`). The Pi binary defaults to `pi` on `PATH` (`SWITCHYARD_PI_BIN`). Check the link with `switchyard host status`.

## Connectivity

Hosts always connect outbound to `<coordinator>/ws/host`; the coordinator never dials a host. Browsers and terminals use REST plus `/ws/client`. Any of these works:

- **LAN**: `http://<lan-ip>:7400`. Plain HTTP is fine for hosts and terminals and for a browser tab, but push notifications and PWA install need HTTPS (see below).
- **VPN** (Tailscale, WireGuard): use the VPN address or name as the coordinator URL. Add it to `SWITCHYARD_TRUSTED_ORIGINS` if browsers use it and it is not the public URL.
- **Reverse proxy with HTTPS**: put Traefik (or Caddy, nginx) in front. The proxy must pass WebSocket upgrades for `/ws/client` and `/ws/host` (`Upgrade` and `Connection` headers) and must not buffer streamed responses. Set `SWITCHYARD_PUBLIC_URL` to the URL clients use; an `https://` URL turns on `Secure` cookies.

For Traefik, [`deploy/compose.yaml`](../deploy/compose.yaml) carries commented Docker labels (router rule, `websecure` entrypoint, TLS, service port 7400, external `proxy` network) and [`deploy/traefik.example.yaml`](../deploy/traefik.example.yaml) is the file-provider equivalent. Traefik forwards WebSocket upgrades automatically; add no buffering or compression middleware. When only Traefik should reach the coordinator, remove the `ports` mapping.

**QR enrollment does not provide connectivity.** A QR code (or enrollment link) only carries a URL and a single-use token (device: 10 minutes, host: 30 minutes). The device must already be able to reach that URL over the network.

## Pairing devices

`switchyard pair` creates a device enrollment and prints the URL plus a terminal QR. It authenticates with the coordinator's admin token: `admin.token` from the data dir, or `SWITCHYARD_ADMIN_TOKEN`. In Docker:

```
docker compose exec switchyard node /app/packages/cli/dist/main.js pair \
  --coordinator http://127.0.0.1:7400 --data-dir /data
```

Settings > Devices in the web app creates the same single-use QR link. Open the link on the new device (a phone camera works from the terminal QR) and it receives its own revocable credential.

Terminal clients enroll with a token from the same flow (`--token` also accepts the whole enrollment link, in which case `--coordinator` is optional):

```
switchyard login --coordinator https://switchyard.example.com --token <token>
switchyard attach
```

`login` writes `~/.config/switchyard/client.json` (mode 0600) and registers the terminal as a device of kind `terminal`.

Work commands (`sessions`, `tasks`, `automations`, `attach`, `doctor`) resolve credentials in this order: `--coordinator`/`--credential` flags, `SWITCHYARD_URL` and `SWITCHYARD_TOKEN`, `~/.config/switchyard/client.json`, then the local `admin.token` in the data dir (`--data-dir` or the default) against the coordinator recorded in `cli-endpoint.json`, else `http://127.0.0.1:7400`.

## iOS Home Screen push onboarding

Web Push on iPhone and iPad (iOS/iPadOS 16.4 or later) works only for a site added to the Home Screen and opened from that icon, over HTTPS with a valid certificate.

1. Reach the coordinator over HTTPS with a certificate the device trusts (a reverse proxy with a real certificate; a self-signed certificate will not work).
2. In Safari, open Switchyard, then Share > Add to Home Screen.
3. Open Switchyard from the new Home Screen icon and sign in with an enrollment link (the installed app normally does not share cookies with Safari, so enroll from the installed app).
4. Go to Settings > Notifications and enable notifications. The permission prompt must be triggered by a tap inside the installed app; the browser tab cannot request it.
5. Use the test notification in the same panel to confirm delivery. The panel shows the current permission state.

Limits:

- Delivery is not guaranteed; it depends on Apple's push service and device conditions.
- Clearing a notification across devices is best effort. The coordinator uses notification tags and sends clear messages when attention is resolved, but iOS may not remove an already delivered notification.
- Quiet hours, private previews and the preferred mobile device are coordinator settings (Settings > Notifications), not per-device OS settings. During quiet hours the attention item is still recorded and shown in the app.

## Privilege model

- Pi runs with the privileges of the host agent's OS user. Anything that user can read, write or execute, Pi and its extensions can too. Run the host agent as a user you are willing to give that to.
- Provider credentials stay on the hosts. The coordinator never receives them.
- The Docker deployment does not sandbox execution, because execution never happens in the coordinator container. The coordinator needs neither the host home directory nor the Docker socket.
- Custom adapters (server modules under the owner, plugin or project tiers) are trusted code that runs in the host agent. Web renderers receive restricted capabilities. See [adapters.md](adapters.md).
- `admin.token` in the data dir grants full access to the coordinator, including enrolling devices. Protect the data dir (file mode 0600 for the token, restricted directory access, careful backups).
- Revoke a lost device or a retired host in Settings; see [operations.md](operations.md).
