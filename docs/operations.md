# Operations

Commands below assume the `switchyard` CLI. In the Docker image `switchyard` is on `PATH` and `SWITCHYARD_DATA_DIR=/data` is set, so `docker compose exec switchyard switchyard <args>` (or `docker exec <container> switchyard <args>`) works without flags; the image entrypoint is the CLI, so `docker compose run --rm switchyard <args>` runs a one-off command. Elsewhere, install it with `npm install -g @spencerboucher/switchyard`; from a source checkout use `node packages/cli/dist/main.js <args>`.

## Data directory

| Path | Contents |
|---|---|
| `coordinator.db` (+ `-wal`, `-shm`) | SQLite database in WAL mode: identities (devices, hosts, passkeys), whether the server is set up, projects, tasks, runs, automations, the durable event log, push subscriptions, settings (including VAPID keys). |
| `admin.token` | Admin token for the local CLI (`pair` and local work commands), mode 0600. Grants full access. Not part of a database backup; a new one is created if it is missing. |
| `coordinator.lock` | Pid file written while a coordinator runs; a second coordinator on the same directory is refused, and `restore` checks it. |
| `cli-endpoint.json` | The local URL of the running coordinator, written by `up` and `coordinator start` for `pair` and local admin-token commands. |
| `host/` | Local host agent config (`host.json`) and state in standalone mode (`switchyard up`). |

Default locations are in [deployment.md](deployment.md). In the Docker deployment this is the `./data` bind mount at `/data` (the image sets `SWITCHYARD_DATA_DIR=/data`).

## Backup

```
switchyard coordinator backup <out> [--data-dir <dir>]
docker compose exec switchyard switchyard coordinator backup /data/backups/coordinator-$(date +%F).db
```

The backup uses SQLite `VACUUM INTO`, which produces a consistent, compacted copy and is safe while the coordinator is running. It refuses to overwrite an existing file. The backup includes who the owner is (the set-up marker and passkeys) and every device and host credential hash, so protect it like the data dir. Copying `coordinator.db` by hand while the coordinator runs is not safe because of the WAL; use the command.

Host state is separate. `switchyard host backup <out>` copies `host.db` the same way (outbox, receipts, dispatches, interactions). Pi's own session files and your repositories are not part of either backup. `host.json` and `client.json` (credentials) are not included; re-enroll if you lose them.

## Restore

```
switchyard coordinator restore <file> [--data-dir <dir>]
```

Restore refuses to run while a live coordinator holds `coordinator.lock`, checks the backup's integrity and schema level, and refuses a backup whose schema is newer than the running build (upgrade first). The previous database is kept as `coordinator.db.bak-<timestamp>` in the data dir.

In Docker, stop the service first, then restore from a file inside the data mount:

```
docker compose stop switchyard
cp coordinator-2026-11-02.db data/
docker compose run --rm switchyard coordinator restore /data/coordinator-2026-11-02.db
docker compose up -d
```

Migrations run at the next start if the backup is from an older schema. Hosts reconnect and replay their outboxes; clients behind the retained event window receive a snapshot.

## Migrations

Schema changes are explicit numbered migrations applied automatically at coordinator start and recorded in `schema_migrations`. `switchyard coordinator migrate [--data-dir]` applies them without starting the server. The current level and the latest known level are shown in diagnostics.

## Retention

The durable event log keeps 30 days by default. A sweep runs at start and then hourly: it deletes events older than the window and records the highest deleted sequence as `minRetainedSeq`. A client reconnecting with a cursor older than that gets a full snapshot instead of an event replay. Host-side dedupe rows older than the window are removed in the same sweep.

The window is the `retentionDays` row in the coordinator's `settings` table. There is no CLI flag, environment variable or API endpoint to change it in this version; the value in effect is reported under `events.retentionDays` in `GET /api/diagnostics`. Transcript items, tasks, runs and sessions are not subject to this sweep.

On each host, the outbox keeps acknowledged events for 24 hours (for diagnostics) and then prunes them; unacknowledged events are never pruned.

## Logs

The coordinator writes structured JSON (pino) to stdout. Set the level with `SWITCHYARD_LOG_LEVEL` (default `info`).

```
docker compose logs -f switchyard
```

These fields are redacted and appear as `[redacted]`: `req.headers.authorization`, `req.headers.cookie`, and any nested `credential`, `token`, `keys`, `p256dh` or `auth` field. Sign-in and enrollment links contain a single-use token and are never written to the log: `pair` and `up` print them to your terminal only. Device links expire after 10 minutes, host enrollments after 30. A server without single sign-on and with no device or passkey logs and prints only the hint to run `switchyard pair`.

## Webhooks

`POST /api/hooks/<automationId>` (bearer webhook token) fires a webhook automation. Each delivery becomes one occurrence, keyed for deduplication:

- With an `Idempotency-Key` header (or GitHub's `X-GitHub-Delivery`), the key is that value: a redelivery with the same value returns the original occurrence (`duplicate: true`) and fires nothing.
- Without either header, the key is the SHA-256 of the JSON body plus the current 10-minute window (UTC, aligned to the epoch). A sender that retries the same body within the window gets the original occurrence back. Two identical bodies sent on purpose within one window are also treated as one delivery, and a retry that crosses a window boundary fires again; senders that need exact semantics should send an `Idempotency-Key`.

## Health

| Endpoint | Meaning |
|---|---|
| `GET /healthz` | Liveness. Returns `{"ok":true}` while the process serves requests. The Docker `HEALTHCHECK` uses it. |
| `GET /readyz` | Readiness. Runs a database query; returns `{"ok":true}` or 503 when the database is not ready. |

Both are unauthenticated.

## Diagnostics

`GET /api/diagnostics` (authenticated) returns:

- versions (coordinator, protocol, Node, SQLite), the migration level and the latest known level, and the public URL;
- hosts with agent and Pi versions, Pi compatibility, connectivity, last seen time and unsupported capabilities;
- adapter diagnostics (the latest 100 `diagnostic` events) and the adapters each host loaded;
- the event sequence range (min, max, current, `minRetainedSeq`, retention days);
- push configuration (VAPID configured, subscription count);
- the number of connected client devices.

The web app shows this under Settings > Diagnostics.

`switchyard doctor` runs local checks and prints PASS, WARN or FAIL per line; it exits non-zero when any check fails:

- Node >=24;
- Pi installed and in the supported range (>=1.4.0 <1.6.0);
- git available;
- the coordinator answers `/healthz`;
- a "Sign-in" line: PASS when single sign-on or a passkey is available (showing both), WARN when neither is;
- the client credential works (`/api/me`);
- a host link config (`host.json`, or the standalone one in the data dir) exists, and the coordinator sees that host as connected;
- push is configured (VAPID keys) and at least one device subscribed.

A missing Pi or git is a FAIL only on a machine with a host config; elsewhere (a pure client) it is a WARN. Not being signed in, an offline host and no push subscriptions are WARNs.

`switchyard host status` reports this machine's host link (`--instance <name>` with `--config` and `--state-dir` for a second agent). It asks the coordinator about the link only with a client credential for that coordinator.

## Upgrading

1. Back up (`coordinator backup`).
2. Change the image tag in `deploy/compose.yaml` (for example `ghcr.io/justmytwospence/switchyard:0.8.0` to the new release), then `docker compose pull && docker compose up -d` (from `deploy/`). From source, pull, rebuild and restart.
3. Migrations apply automatically at start. If something goes wrong, stop the service and restore the backup with the previous image.

Hosts are upgraded separately: `npm update -g @spencerboucher/switchyard`, then restart the installed service (`launchctl kickstart -k gui/$(id -u)/com.switchyard.host` on macOS, `systemctl --user restart switchyard-host` on Linux). Hosts and the coordinator reconnect on their own; running Pi sessions on a host stop when its agent restarts: sessions that were working show as interrupted until resumed; idle ones show as stopped and resume when you send to them.

## Revoking devices and hosts

Revoke a lost browser, phone or terminal in Settings > Devices, and a retired host in Settings > Hosts; remove a passkey in Settings > Sign-in (see [auth.md](auth.md#revocation)). A revoked device's credential stops working, its push subscriptions are deleted and its open sockets receive `force_logout`. The local admin token cannot be revoked from the app; rotate it by stopping the coordinator and deleting `admin.token` (a new one is created at the next start).
