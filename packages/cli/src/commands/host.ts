import { existsSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  defaultConfigPath,
  defaultStateDir,
  enroll,
  loadConfig,
  runHostAgent,
} from "@switchyard/host-agent";
import { detectPi, SUPPORTED_RANGE } from "@switchyard/pi-runtime";
import { ApiClient } from "@switchyard/terminal";
import { CliError, type Connection, resolveConnection, trimUrl } from "../config.js";
import type { Ctx } from "../context.js";
import { waitForSignal } from "./coordinator.js";
import { serviceFilePath, serviceKindFor, serviceNames } from "./service.js";

export interface HostEnrollFlags {
  coordinator: string;
  /** Single-use host enrollment token; exactly one of `token` or `secret`. */
  token?: string;
  /** Shared host enrollment secret (`SWITCHYARD_HOST_ENROLL_SECRET` on the coordinator). */
  secret?: string;
  name?: string;
  config?: string;
}

export async function hostEnroll(ctx: Ctx, flags: HostEnrollFlags): Promise<void> {
  if (!flags.token === !flags.secret) {
    throw new CliError("Pass exactly one of --token or --secret");
  }
  const name = flags.name ?? hostname().replace(/\.local$/, "");
  const cfg = await enroll({
    coordinatorUrl: flags.coordinator,
    ...(flags.token ? { token: flags.token } : { secret: flags.secret! }),
    name,
    configPath: flags.config ?? defaultConfigPath(ctx.env),
    fetch: ctx.fetch as typeof fetch,
  });
  ctx.out(`Enrolled host "${cfg.name}" (${cfg.hostId}) with ${cfg.coordinatorUrl}.`);
  ctx.out(`Config written to ${cfg.configPath} (mode 0600).`);
  ctx.out(
    "Start it with `switchyard host run`, or `switchyard host install-service` to run it at login.",
  );
}

export async function hostRun(
  ctx: Ctx,
  flags: { config?: string; stateDir?: string },
): Promise<void> {
  const configPath = flags.config ?? defaultConfigPath(ctx.env);
  if (!existsSync(configPath)) {
    ctx.err(
      `No host config at ${configPath} yet: waiting for it (with SWITCHYARD_HOST_ENROLL_SECRET and SWITCHYARD_COORDINATOR_URL set, the host enrolls itself).`,
    );
  }
  // Without host.json the agent waits (self-enrolling with the shared secret when configured).
  const agent = await runHostAgent({
    configPath,
    stateDir: flags.stateDir,
    handleSignals: false,
  });
  ctx.err(`Switchyard host agent ${agent.hostId} running (Ctrl+C stops it and its Pi sessions)`);
  const sig = await waitForSignal();
  ctx.err(`${sig}: stopping host agent`);
  await agent.stop();
}

/** Consistent copy of the host database (`VACUUM INTO`), safe while the agent runs. */
export function hostBackup(ctx: Ctx, out: string, flags: { stateDir?: string }): void {
  const stateDir = flags.stateDir ?? defaultStateDir(ctx.env);
  const src = join(stateDir, "host.db");
  if (!existsSync(src)) throw new CliError(`No host database at ${src}`);
  const dest = resolve(out);
  if (existsSync(dest)) throw new CliError(`${dest} already exists`);
  mkdirSync(dirname(dest), { recursive: true });
  const db = new DatabaseSync(src);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("VACUUM INTO ?").run(dest);
  } finally {
    db.close();
  }
  ctx.out(`Backed up ${src} to ${dest}`);
  ctx.out("host.json (the host credential) is not included; keep it private.");
}

export async function hostStatus(
  ctx: Ctx,
  flags: { config?: string; stateDir?: string; instance?: string; json?: boolean },
): Promise<void> {
  if (flags.instance !== undefined) {
    serviceNames(flags.instance); // validates the name
    if (!(flags.config && flags.stateDir)) {
      throw new CliError(
        "--instance needs --config and --state-dir, so the status describes that agent's enrollment and state",
      );
    }
  }
  const configPath = flags.config ?? defaultConfigPath(ctx.env);
  const stateDir = flags.stateDir ?? defaultStateDir(ctx.env);
  const status: Record<string, unknown> = { configPath, stateDir };
  if (!existsSync(configPath)) {
    status.enrolled = false;
  } else {
    const cfg = loadConfig(configPath);
    status.enrolled = true;
    status.hostId = cfg.hostId;
    status.name = cfg.name;
    status.coordinatorUrl = cfg.coordinatorUrl;
    try {
      const res = await ctx.fetch(`${cfg.coordinatorUrl.replace(/\/+$/, "")}/healthz`);
      status.coordinatorReachable = res.ok;
    } catch {
      status.coordinatorReachable = false;
    }
    // With a client credential for this host's own coordinator, ask how it sees this host.
    let conn: Connection | null = null;
    try {
      conn = resolveConnection({}, ctx.env, ctx.paths);
    } catch {
      // not signed in
    }
    if (!conn || trimUrl(conn.url) !== trimUrl(cfg.coordinatorUrl)) {
      status.connectivity = "unknown";
      status.connectivityNote = `no client credential for ${trimUrl(cfg.coordinatorUrl)}`;
    } else {
      try {
        const api = new ApiClient({
          coordinatorUrl: conn.url,
          credential: conn.credential,
          fetch: ctx.fetch,
        });
        const h = await api.get<{
          connectivity: string;
          lastSeenAt: string | null;
          piVersion: string | null;
        }>(`/api/hosts/${encodeURIComponent(cfg.hostId)}`);
        status.connectivity = h.connectivity;
        status.lastSeenAt = h.lastSeenAt;
      } catch {
        status.connectivity = "unknown";
      }
    }
  }
  status.instance = flags.instance ?? null;
  const pi = await detectPi(ctx.env.SWITCHYARD_PI_BIN ?? "pi");
  status.pi = { version: pi.version, compatible: pi.compatible, reason: pi.reason };
  try {
    const kind = serviceKindFor(process.platform);
    const file = serviceFilePath(kind, undefined, flags.instance);
    status.service = { kind, file, installed: existsSync(file) };
  } catch {
    status.service = null;
  }
  if (flags.json) {
    ctx.out(JSON.stringify(status, null, 2));
    return;
  }
  if (!status.enrolled) {
    ctx.out(
      `Not enrolled (no ${configPath}). Run: switchyard host enroll --coordinator <url> --token <t>`,
    );
  } else {
    ctx.out(`Host:         ${status.name} (${status.hostId})`);
    ctx.out(
      `Coordinator:  ${status.coordinatorUrl} (${status.coordinatorReachable ? "reachable" : "unreachable"})`,
    );
    const note = status.connectivityNote as string | undefined;
    ctx.out(
      `Link:         ${status.connectivity}${note ? ` (${note}; run switchyard login --coordinator ${status.coordinatorUrl})` : ""}`,
    );
  }
  ctx.out(`Config:       ${configPath}`);
  ctx.out(`State dir:    ${stateDir}`);
  ctx.out(
    `Pi:           ${pi.version ?? "not found"} (${pi.compatible ? `supported ${SUPPORTED_RANGE}` : (pi.reason ?? "unsupported")})`,
  );
  const svc = status.service as { kind: string; file: string; installed: boolean } | null;
  if (svc) ctx.out(`Service:      ${svc.installed ? `installed (${svc.file})` : "not installed"}`);
}
