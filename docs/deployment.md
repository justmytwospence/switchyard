# Deployment

Switchyard has three parts, and you can place them on one machine or several:

- the **coordinator**, which stores state and serves the web app and the sockets;
- **hosts**, the machines that run Pi, hold your repositories and keep your provider credentials, and connect outbound to the coordinator;
- **devices**, the browsers, phones and terminals you use.

Pick the pattern that fits where you run it. None of them requires a particular network, proxy or identity provider. Who may sign in is covered in [auth.md](auth.md); backups and upgrades in [operations.md](operations.md).

Requirements: Node >=24 and pnpm 12 (to build from source), git, and Pi >=1.4.0 <1.6.0 on every host that runs sessions (see [compatibility.md](compatibility.md)). The container image needs only Docker for the coordinator.

## Choosing a pattern

| You want | Use |
|---|---|
| Try it, or use it on one machine | [Local](#local-switchyard-up) |
| An always-on server you reach from several devices | [A server](#a-server) behind a reverse proxy or a VPN, plus [hosts](#hosts) |

Three rules hold in every pattern:

1. Set `SWITCHYARD_PUBLIC_URL` to the exact URL people type in the browser. It drives sign-in links, the OIDC redirect URI, the `Secure` cookie flag and the passkey domain.
2. Use HTTPS with a real name if you want passkeys, push notifications or an installed app. Plain HTTP works for a browser tab, a host or a terminal.
3. Do not put a proxy-level login (basic auth, forward auth) in front of Switchyard. Host agents, webhooks and installed apps cannot pass it, and Switchyard has its own sign-in.

## Local: `switchyard up`

```
pnpm i && pnpm build
node packages/cli/dist/main.js up
```

`up` runs the coordinator and a local host agent in one process. On first start it sets the server up, prints a single-use sign-in link with a QR code, and opens it in your browser when run in a terminal.

| Setting | Default | Override |
|---|---|---|
| Port | 7400 | `--port` |
| Bind address | `0.0.0.0` | `--host` (use `127.0.0.1` to keep it on this machine) |
| Public URL | `http://localhost:<port>` | `--public-url`, `SWITCHYARD_PUBLIC_URL` |
| Trusted origins | the public URL's origin (plus `http://127.0.0.1:<port>` with the default URL) | `--trusted-origins`, `SWITCHYARD_TRUSTED_ORIGINS` |
| Web app | `packages/web/dist` next to the CLI, when built | `--web-dist`, `SWITCHYARD_WEB_DIST` |
| Data dir | `$XDG_DATA_HOME/switchyard`, else `~/.local/share/switchyard` (Linux); `~/Library/Application Support/switchyard/coordinator` (macOS) | `--data-dir`, `SWITCHYARD_DATA_DIR` |

- The default public URL uses `localhost` so passkeys work on this machine. To reach it from another device, pass `--public-url` with the address that device uses (passkeys then need HTTPS and a domain name, see [auth.md](auth.md#passkeys)).
- The local host is enrolled automatically on first start (`--name` sets its name). Its `host.json` and state live in `<data-dir>/host/`. Pi must be on `PATH` (or `SWITCHYARD_PI_BIN`).
- `--dev` also trusts the Vite dev server origins (`http://localhost:5173`, `http://127.0.0.1:5173`) and turns on debug logs.
- `up` records the local URL in `<data-dir>/cli-endpoint.json`, so `switchyard pair` and `init` on the same machine find it.
- `up` reads the same server variables as `switchyard coordinator start` (the container's command): the ones in the table above plus the OIDC, trusted-proxy and shared-secret variables in the [environment reference](#environment-reference). With an OIDC owner declared it comes up already set up and prints no link.
- Schedules (cron, once, webhooks, dependency triggers) only run while the process is awake. A sleeping laptop fires nothing; missed cron occurrences follow each automation's missed-run policy when it wakes.

## A server

The container image runs the coordinator only. Pi never runs in it.

```
cd deploy
export SWITCHYARD_PUBLIC_URL=https://switchyard.example.com
mkdir -p data && sudo chown 1000:1000 data
docker compose up -d
docker compose exec switchyard switchyard init
```

[`deploy/compose.yaml`](../deploy/compose.yaml) uses `ghcr.io/justmytwospence/switchyard:0.2.1` (multi-arch, `node:26-bookworm-slim`, runs as the `node` user), mounts `./data` at `/data` and has a `HEALTHCHECK` on `/healthz`. If the package is not public, `docker login ghcr.io` with a token that can read packages first. The compose file publishes the port on `127.0.0.1` only, for a proxy on the same machine; change it to `7400:7400` to serve plain HTTP on every interface, or remove it if the proxy shares a Docker network.

`switchyard init` prints your first sign-in link. Alternatively declare an OIDC owner in the environment and the server comes up owned with no manual step ([auth.md](auth.md#single-sign-on-oidc)). To run without Docker, use `switchyard coordinator start` with the same variables.

The coordinator container needs neither a home directory nor the Docker socket, and the compose file mounts neither.

### Environment reference

| Variable | Applies to | Default | Meaning |
|---|---|---|---|
| `SWITCHYARD_PUBLIC_URL` | coordinator, `up` | `http://localhost:<port>` | The URL clients and hosts use. Drives sign-in and enrollment links, the OIDC redirect URI, the `Secure` cookie flag (https) and the passkey domain. |
| `SWITCHYARD_TRUSTED_ORIGINS` | coordinator, `up` | the public URL's origin | Comma-separated browser origins allowed to call the API and open sockets. Set it only when browsers also use other origins (for example a LAN name next to a public name). Passkeys are verified against these origins. |
| `SWITCHYARD_TRUSTED_PROXIES` | coordinator, `up` | none | Comma-separated IPs or CIDRs of reverse proxies whose `X-Forwarded-For` is trusted for the client IP (rate limits). Set it when a proxy is in front. See [auth.md](auth.md#trusted-proxies). |
| `SWITCHYARD_DATA_DIR` | coordinator, CLI | platform default; `/data` in the image | Data directory: `coordinator.db`, `admin.token`, `coordinator.lock`. |
| `SWITCHYARD_LISTEN` | `coordinator start` | `0.0.0.0:7400` | `host:port` to listen on. |
| `SWITCHYARD_WEB_DIST` | coordinator, `up` | `packages/web/dist` when found; `/app/packages/web/dist` in the image | Directory of the built web app. Without it the server is API only. |
| `SWITCHYARD_LOG_LEVEL` | all | `info` | pino level: trace, debug, info, warn, error, fatal, silent. |
| `SWITCHYARD_HOST_ENROLL_SECRET` | coordinator, `up` and host | unset | Shared secret (at least 32 characters). On the coordinator it enables secret enrollment; on a host it is what the host enrolls with. |
| `SWITCHYARD_OIDC_ISSUER`, `SWITCHYARD_OIDC_CLIENT_ID` | coordinator, `up` | unset | Together they enable single sign-on. |
| `SWITCHYARD_OIDC_CLIENT_SECRET` | coordinator, `up` | unset | Client secret (recommended). |
| `SWITCHYARD_OIDC_LABEL` | coordinator, `up` | `Sign in with single sign-on` | Sign-in button text. |
| `SWITCHYARD_OIDC_SCOPES` | coordinator, `up` | `openid profile email groups` | Scopes requested. |
| `SWITCHYARD_OIDC_OWNER_SUBJECT`, `SWITCHYARD_OIDC_OWNER_EMAIL`, `SWITCHYARD_OIDC_OWNER_GROUP` | coordinator, `up` | unset | Who the owner is. At least one is required with OIDC; all that are set must match. |
| `SWITCHYARD_COORDINATOR_URL` | host | unset | With the secret, lets a host without `host.json` enroll itself. |
| `SWITCHYARD_HOST_NAME` | host | the machine's host name | Name given to a self-enrolling host. |
| `SWITCHYARD_HOST_CONFIG` | host, CLI | `~/.config/switchyard/host.json` | Host credential file. |
| `SWITCHYARD_STATE_DIR` | host, CLI | `~/.local/state/switchyard` (Linux), `~/Library/Application Support/switchyard` (macOS) | Host state: `host.db`, `runtime/`, `logs/`. |
| `SWITCHYARD_PI_BIN` | host, CLI | `pi` | The Pi binary. |
| `SWITCHYARD_ADMIN_TOKEN` | CLI | the data dir's `admin.token` | Admin token for `init`, `pair` and local work commands. |
| `SWITCHYARD_URL`, `SWITCHYARD_TOKEN` | CLI | `client.json` | Coordinator URL and device credential for work commands. |

The OIDC variables are explained in [auth.md](auth.md#single-sign-on-oidc).

### Behind a reverse proxy (HTTPS)

Terminate TLS in a proxy on the same machine or network and forward everything to the coordinator on port 7400. The proxy must:

- pass WebSocket upgrades for `/ws/client` (browsers and terminals) and `/ws/host` (host agents);
- not buffer streamed responses, nor compress or retry them;
- allow long-lived connections (idle timeouts of many minutes; clients and hosts reconnect by themselves if one is dropped);
- allow request bodies of at least 32 MB (attachments).

Then set `SWITCHYARD_PUBLIC_URL` to the proxy's URL and `SWITCHYARD_TRUSTED_PROXIES` to the proxy's address, so rate limits see real clients.

**Caddy.** Caddy gets certificates itself and forwards WebSockets without configuration. See [`deploy/Caddyfile.example`](../deploy/Caddyfile.example):

```
switchyard.example.com {
	reverse_proxy switchyard:7400 {
		flush_interval -1
	}
}
```

**Traefik.** [`deploy/compose.yaml`](../deploy/compose.yaml) carries commented Docker labels (router rule, `websecure` entrypoint, TLS, service port 7400, an external network shared with Traefik); [`deploy/traefik.example.yaml`](../deploy/traefik.example.yaml) is the file-provider equivalent. Traefik forwards WebSocket upgrades automatically. Add no buffering, compression or retry middleware.

**nginx.**

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    http2 on;
    server_name switchyard.example.com;
    ssl_certificate     /etc/ssl/switchyard.example.com/fullchain.pem;
    ssl_certificate_key /etc/ssl/switchyard.example.com/privkey.pem;

    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:7400;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # WebSocket upgrade for /ws/client and /ws/host
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

### VPN or tailnet

Reaching the server only over a private network needs no proxy. Run the coordinator, then use the VPN address or name as the URL:

- **WireGuard, a LAN or any other VPN:** use the address or name that devices reach, for example `SWITCHYARD_PUBLIC_URL=http://switchyard.internal:7400`. Plain HTTP is fine for hosts, terminals and a browser tab; passkeys, push and installed apps need HTTPS and a domain name, so add a proxy or certificate if you want them. If browsers use more than one name, list them in `SWITCHYARD_TRUSTED_ORIGINS`.
- **Tailscale:** `tailscale serve` gives the server an HTTPS name on your tailnet with a real certificate, which is enough for passkeys, push and the installed app. With the coordinator on the same machine:

  ```
  tailscale serve --bg 7400
  ```

  then run the coordinator with `SWITCHYARD_PUBLIC_URL=https://<machine>.<tailnet>.ts.net` and `SWITCHYARD_TRUSTED_PROXIES=127.0.0.1` (the serve proxy connects from loopback). Publish the container port on loopback as in the compose file. Check the current `tailscale serve` syntax for your version.

In every case the server is reachable only by those who can reach the URL, and signing in still requires the owner.

## Hosts

A host runs the Pi processes and owns the repositories and provider credentials. It connects outbound to `<coordinator>/ws/host`; the coordinator never dials a host, so hosts can sit behind NAT. Enrollment (single-use token or shared secret) is described in [auth.md](auth.md#hosts).

### Native host service (recommended)

On the machine that has the repositories and Pi credentials, as the user that should run Pi:

```
switchyard host enroll --coordinator https://switchyard.example.com --token <token> [--name laptop]
switchyard host install-service
```

Get the token from Settings › Hosts › Add host. `host enroll` writes `~/.config/switchyard/host.json` (mode 0600). With a shared secret you can skip it: set `SWITCHYARD_COORDINATOR_URL`, `SWITCHYARD_HOST_ENROLL_SECRET` and optionally `SWITCHYARD_HOST_NAME` in the service's environment and the host enrolls itself the first time it runs.

`host install-service` renders a template from `deploy/launchd` or `deploy/systemd` with the absolute paths of this Node binary, the CLI and `host.json` (plus your current `PATH`, so `pi` and `git` resolve), writes it, loads it and prints the file and every command it runs:

| OS | File | Loaded with |
|---|---|---|
| macOS | `~/Library/LaunchAgents/com.switchyard.host.plist` | `launchctl bootout gui/<uid>/com.switchyard.host` (if loaded), then `launchctl bootstrap gui/<uid> <plist>` |
| Linux | `~/.config/systemd/user/switchyard-host.service` | `systemctl --user daemon-reload`, `enable --now`, `restart` |

`--print` shows the rendered file without writing it; `--no-load` writes it without loading. The service runs `switchyard host run --config <host.json>` and logs to `<host state dir>/logs/host.log` (launchd) or the user journal (systemd). Nothing is installed or started unless you run the command. On Linux, `loginctl enable-linger <user>` keeps user services running while you are logged out. To run in the foreground instead, use `switchyard host run`. Check the link with `switchyard host status`.

Host state (`host.db`, `runtime/`, `logs/`) defaults to `~/Library/Application Support/switchyard` on macOS and `~/.local/state/switchyard` on Linux (`SWITCHYARD_STATE_DIR`).

### Host in a container

The same image can run a host agent: `switchyard host run`. Use it only when the machine that owns your repositories is itself managed through containers. It needs:

- **Pi on `PATH`.** The image does not include Pi. Build a small image on top of it, or mount a Pi install and set `SWITCHYARD_PI_BIN`:

  ```
  FROM ghcr.io/justmytwospence/switchyard:0.2.1
  USER root
  RUN npm install -g @earendil-works/pi-coding-agent@1.4.0
  USER node
  ```

- **git.** Included in the image (with an ssh client for git remotes).
- **The user's home directory**, mounted at the same path it has on the machine, with the container running as that user's uid. The repositories, Pi's credentials and sessions, `~/.config/switchyard/host.json` and the host state all live there, and paths the coordinator records must resolve identically inside the container.
- The coordinator's URL, reachable from the container, and either a pre-made `host.json` in that home or the shared secret and URL in the environment so the host enrolls itself.

[`deploy/compose.yaml`](../deploy/compose.yaml) has a commented `switchyard-host` service with these settings.

## Terminal client

Terminal clients enroll with a single-use token from Settings › Devices › Add device or `switchyard pair`:

```
switchyard login --coordinator https://switchyard.example.com --token <token>
switchyard attach
```

`--token` also accepts the whole link, in which case `--coordinator` is optional. `login` writes `~/.config/switchyard/client.json` (mode 0600) and registers the terminal as a device of kind `terminal`.

Work commands (`sessions`, `tasks`, `automations`, `attach`, `doctor`) resolve credentials in this order: `--coordinator`/`--credential` flags, `SWITCHYARD_URL` and `SWITCHYARD_TOKEN`, `~/.config/switchyard/client.json`, then the local `admin.token` in the data dir against the coordinator recorded in `cli-endpoint.json`, else `http://127.0.0.1:7400`.

## iOS Home Screen push

Web Push on iPhone and iPad (iOS/iPadOS 16.4 or later) works only for a site added to the Home Screen and opened from that icon, over HTTPS with a certificate the device trusts (a self-signed certificate will not work).

1. Reach the server over HTTPS with a certificate the device trusts (a reverse proxy, or `tailscale serve`).
2. In Safari, open Switchyard and sign in (a passkey or single sign-on is convenient for the next steps), then Share > Add to Home Screen.
3. Open Switchyard from the new icon and sign in again with a passkey or single sign-on: the installed app does not share cookies with Safari. See [auth.md](auth.md#installed-apps-pwa).
4. Go to Settings › Notifications and enable notifications. The permission prompt must be triggered by a tap inside the installed app.
5. Use the test notification in the same panel to confirm delivery.

Limits:

- Delivery is not guaranteed; it depends on Apple's push service and device conditions.
- Clearing a notification across devices is best effort. The coordinator uses notification tags and sends clear messages when attention is resolved, but iOS may not remove an already delivered notification.
- Quiet hours, private previews and the preferred mobile device are coordinator settings (Settings › Notifications), not per-device OS settings. During quiet hours the attention item is still recorded and shown in the app.

## Privilege model

- Pi runs with the privileges of the host agent's OS user. Anything that user can read, write or execute, Pi and its extensions can too. Run the host agent as a user you are willing to give that to.
- A container host has the same reach as what you mount into it. Mounting a home directory gives it that whole home; mount the least you need, and never the Docker socket.
- Provider credentials stay on the hosts. The coordinator never receives them.
- The coordinator container does not sandbox execution, because execution never happens there. It needs neither a home directory nor the Docker socket.
- Custom adapters (server modules under the owner, plugin or project tiers) are trusted code that runs in the host agent. Web renderers receive restricted capabilities. See [adapters.md](adapters.md).
- `admin.token` in the data dir grants full access to the coordinator, including enrolling devices. Protect the data dir (file mode 0600 for the token, restricted directory access, careful backups). Whoever can run commands in the coordinator container or read that file is the owner.
- `SWITCHYARD_HOST_ENROLL_SECRET` lets its holder add hosts that receive work. Keep it as private as a password.
- Revoke a lost device or a retired host in Settings; see [auth.md](auth.md#revocation) and [operations.md](operations.md).
