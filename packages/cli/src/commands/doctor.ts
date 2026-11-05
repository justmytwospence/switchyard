import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { defaultConfigPath } from "@switchyard/host-agent";
import { detectPi, type PiDetection, SUPPORTED_RANGE } from "@switchyard/pi-runtime";
import type { SetupState } from "@switchyard/protocol";
import { ApiClient, ApiRequestError } from "@switchyard/terminal";
import {
  type ConnectionFlags,
  DEFAULT_LOCAL_URL,
  readEndpoint,
  resolveConnection,
  trimUrl,
} from "../config.js";
import type { Ctx } from "../context.js";
import { defaultDataDir, standaloneHostPaths } from "../paths.js";

export type CheckStatus = "PASS" | "WARN" | "FAIL";

export interface CheckResult {
  status: CheckStatus;
  name: string;
  detail: string;
}

export interface DoctorDeps {
  nodeVersion: string;
  detectPi: () => Promise<PiDetection>;
  /** `git --version` output, or null when git is missing. */
  gitVersion: () => Promise<string | null>;
  /** Candidate host.json paths (enrolled host, standalone host). */
  hostConfigPaths: string[];
  readFile: (path: string) => string | null;
}

export function defaultDoctorDeps(ctx: Ctx): DoctorDeps {
  const dataDir = ctx.paths?.dataDir ?? defaultDataDir(ctx.env);
  return {
    nodeVersion: process.versions.node,
    detectPi: () => detectPi(ctx.env.SWITCHYARD_PI_BIN ?? "pi"),
    gitVersion: () =>
      new Promise((resolve) =>
        execFile("git", ["--version"], (err, stdout) => resolve(err ? null : stdout.trim())),
      ),
    hostConfigPaths: [defaultConfigPath(ctx.env), standaloneHostPaths(dataDir).configPath],
    readFile: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
  };
}

interface HostCfg {
  coordinatorUrl: string;
  hostId: string;
  name: string;
  path: string;
}

function findHostConfig(deps: DoctorDeps): HostCfg | null {
  for (const path of deps.hostConfigPaths) {
    const raw = deps.readFile(path);
    if (raw === null) continue;
    try {
      const v = JSON.parse(raw) as Partial<HostCfg>;
      if (v.coordinatorUrl && v.hostId) {
        return { coordinatorUrl: v.coordinatorUrl, hostId: v.hostId, name: v.name ?? "", path };
      }
    } catch {
      // reported below as missing
    }
  }
  return null;
}

/**
 * Environment checks: Node, Pi version range, git, coordinator health, client credential, host
 * link config and push. Pi and git are required only on execution hosts (WARN elsewhere).
 */
export async function runDoctor(
  ctx: Ctx,
  deps: DoctorDeps,
  flags: ConnectionFlags = {},
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = (status: CheckStatus, name: string, detail: string) =>
    results.push({ status, name, detail });

  const major = Number.parseInt(deps.nodeVersion.split(".")[0] ?? "0", 10);
  if (major >= 24) add("PASS", "Node.js", `v${deps.nodeVersion} (>=24)`);
  else add("FAIL", "Node.js", `v${deps.nodeVersion}; Switchyard needs Node.js 24 or newer`);

  const hostCfg = findHostConfig(deps);
  const missing: CheckStatus = hostCfg ? "FAIL" : "WARN";
  const hostNote = hostCfg ? "" : " (needed only on execution hosts)";

  const pi = await deps.detectPi();
  if (pi.compatible) add("PASS", "Pi", `${pi.version} (supported ${SUPPORTED_RANGE})`);
  else if (pi.version)
    add("FAIL", "Pi", pi.reason ?? `${pi.version} is outside ${SUPPORTED_RANGE}`);
  else add(missing, "Pi", `${pi.reason ?? "pi not found"}${hostNote}`);

  const git = await deps.gitVersion();
  if (git) add("PASS", "git", git);
  else add(missing, "git", `git not found on PATH${hostNote}`);

  // Which coordinator, and as whom.
  let conn: { url: string; credential: string; source: string } | null = null;
  let connError: string | null = null;
  try {
    conn = resolveConnection(flags, ctx.env, ctx.paths);
  } catch (err) {
    connError = (err as Error).message;
  }
  const dataDir = flags.dataDir ?? ctx.paths?.dataDir ?? defaultDataDir(ctx.env);
  const url = trimUrl(
    conn?.url ??
      flags.coordinator ??
      hostCfg?.coordinatorUrl ??
      readEndpoint(dataDir)?.localUrl ??
      DEFAULT_LOCAL_URL,
  );

  let reachable = false;
  try {
    const res = await ctx.fetch(`${url}/healthz`);
    reachable = res.ok;
    if (res.ok) add("PASS", "Coordinator", `${url}/healthz answered`);
    else add("FAIL", "Coordinator", `${url}/healthz returned HTTP ${res.status}`);
  } catch (err) {
    add("FAIL", "Coordinator", `${url} is not reachable: ${(err as Error).message}`);
  }
  if (reachable) await checkSignIn(ctx, url, add);

  let api: ApiClient | null = null;
  if (!conn) {
    add("WARN", "Client credential", connError ?? "Not signed in");
  } else if (reachable) {
    const client = new ApiClient({
      coordinatorUrl: conn.url,
      credential: conn.credential,
      fetch: ctx.fetch,
    });
    try {
      const me = await client.get<{
        device: { id: string; name: string; kind: string };
        admin: boolean;
      }>("/api/me");
      api = client;
      add(
        "PASS",
        "Client credential",
        me.admin
          ? `local admin token (${conn.source})`
          : `${me.device.name} (${me.device.kind}, ${me.device.id}) from ${conn.source}`,
      );
    } catch (err) {
      const msg =
        err instanceof ApiRequestError && (err.status === 401 || err.code === "device_revoked")
          ? `rejected (${err.code}); run \`switchyard login\` again`
          : (err as Error).message;
      add("FAIL", "Client credential", `${conn.source}: ${msg}`);
    }
  } else {
    add("WARN", "Client credential", "not checked: coordinator unreachable");
  }

  if (!hostCfg) {
    add("WARN", "Host link", "no host enrolled on this machine (switchyard host enroll)");
  } else {
    let detail = `${hostCfg.name || hostCfg.hostId} -> ${hostCfg.coordinatorUrl} (${hostCfg.path})`;
    let status: CheckStatus = "PASS";
    if (api) {
      try {
        const h = await api.get<{
          connectivity: string;
          revokedAt: string | null;
          piCompatible: boolean;
        }>(`/api/hosts/${encodeURIComponent(hostCfg.hostId)}`);
        if (h.revokedAt) {
          status = "FAIL";
          detail += "; this host was revoked";
        } else if (h.connectivity !== "connected") {
          status = "WARN";
          detail += `; coordinator sees it as ${h.connectivity} (is \`switchyard host run\` or the service running?)`;
        } else detail += "; connected";
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) {
          status = "WARN";
          detail +=
            "; the coordinator does not know this host (enrolled with another coordinator?)";
        }
      }
    }
    add(status, "Host link", detail);
  }

  if (api) {
    try {
      const d = await api.get<{ push?: { vapidConfigured: boolean; subscriptions: number } }>(
        "/api/diagnostics",
      );
      const push = d.push;
      if (!push?.vapidConfigured) add("FAIL", "Push", "VAPID keys are not configured");
      else if (push.subscriptions === 0) {
        add(
          "WARN",
          "Push",
          "configured, but no device has enabled notifications yet (Settings > Notifications)",
        );
      } else add("PASS", "Push", `configured; ${push.subscriptions} subscription(s)`);
    } catch (err) {
      add("WARN", "Push", `could not read diagnostics: ${(err as Error).message}`);
    }
  } else {
    add("WARN", "Push", "not checked: no valid credential");
  }
  return results;
}

/** The coordinator's owner setup (`GET /api/setup`, public). */
async function checkSignIn(
  ctx: Ctx,
  url: string,
  add: (status: CheckStatus, name: string, detail: string) => void,
): Promise<void> {
  try {
    const api = new ApiClient({ coordinatorUrl: url, credential: null, fetch: ctx.fetch });
    const s = await api.get<SetupState>("/api/setup");
    const passkey = !s.passkey.available
      ? `unavailable, ${s.passkey.reason ?? "unsupported"}`
      : s.passkey.registered
        ? "registered"
        : "none registered yet";
    const sso = s.oidc ? `on (${s.oidc.label})` : "off";
    if (!s.oidc && !s.passkey.registered) {
      add(
        "WARN",
        "Sign-in",
        "no single sign-on and no passkey: sign in with a link from `switchyard pair` on the server",
      );
      return;
    }
    add("PASS", "Sign-in", `passkey: ${passkey}, single sign-on: ${sso}`);
  } catch (err) {
    add("WARN", "Sign-in", `could not read the setup state: ${(err as Error).message}`);
  }
}

export function printDoctor(ctx: Ctx, results: CheckResult[]): number {
  for (const r of results) ctx.out(`${r.status.padEnd(4)}  ${r.name}: ${r.detail}`);
  const failed = results.filter((r) => r.status === "FAIL").length;
  const warned = results.filter((r) => r.status === "WARN").length;
  ctx.out("");
  ctx.out(
    failed > 0
      ? `${failed} check(s) failed${warned ? `, ${warned} warning(s)` : ""}.`
      : `All required checks passed${warned ? ` (${warned} warning(s))` : ""}.`,
  );
  return failed > 0 ? 1 : 0;
}
