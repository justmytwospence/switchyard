import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clientConfigPath, defaultDataDir, type Env } from "./paths.js";

export interface ClientConfig {
  coordinatorUrl: string;
  credential: string;
  deviceId?: string;
}

export function parseClientConfig(raw: unknown): ClientConfig {
  const v = raw as Partial<ClientConfig> | null;
  if (!v || typeof v !== "object") throw new Error("expected an object");
  if (typeof v.coordinatorUrl !== "string" || !v.coordinatorUrl) {
    throw new Error("coordinatorUrl is missing");
  }
  if (typeof v.credential !== "string" || !v.credential) throw new Error("credential is missing");
  const out: ClientConfig = { coordinatorUrl: v.coordinatorUrl, credential: v.credential };
  if (typeof v.deviceId === "string") out.deviceId = v.deviceId;
  return out;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function readClientConfig(path: string): ClientConfig | null {
  if (!existsSync(path)) return null;
  try {
    return parseClientConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    throw new CliError(`Invalid client config ${path}: ${(err as Error).message}`);
  }
}

/** Write JSON atomically with mode 0600 (directory 0700). */
export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function writeClientConfig(path: string, cfg: ClientConfig): void {
  writePrivateJson(path, parseClientConfig(cfg));
}

export function adminTokenPath(dataDir: string): string {
  return join(dataDir, "admin.token");
}

/** `SWITCHYARD_ADMIN_TOKEN`, else `<dataDir>/admin.token`, else null. */
export function readAdminToken(dataDir: string, env: Env = process.env): string | null {
  const fromEnv = env.SWITCHYARD_ADMIN_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const p = adminTokenPath(dataDir);
  if (!existsSync(p)) return null;
  const t = readFileSync(p, "utf8").trim();
  return t || null;
}

/** Where a running coordinator on this machine can be reached (written by `up` and `start`). */
export const ENDPOINT_FILE = "cli-endpoint.json";

export function writeEndpoint(dataDir: string, endpoint: { localUrl: string; publicUrl: string }) {
  writePrivateJson(join(dataDir, ENDPOINT_FILE), endpoint);
}

export function readEndpoint(dataDir: string): { localUrl: string; publicUrl: string } | null {
  const p = join(dataDir, ENDPOINT_FILE);
  if (!existsSync(p)) return null;
  try {
    const v = JSON.parse(readFileSync(p, "utf8")) as { localUrl?: unknown; publicUrl?: unknown };
    if (typeof v.localUrl === "string" && typeof v.publicUrl === "string") {
      return { localUrl: v.localUrl, publicUrl: v.publicUrl };
    }
  } catch {
    // ignore
  }
  return null;
}

export const DEFAULT_LOCAL_URL = "http://127.0.0.1:7400";

export interface Connection {
  url: string;
  credential: string;
  source: "flags" | "env" | "client.json" | "admin.token";
}

export interface ConnectionFlags {
  coordinator?: string;
  credential?: string;
  dataDir?: string;
}

/** Whether `url` points at this machine (localhost, 127.x.x.x or ::1). */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * Resolve where and as whom work commands talk to the coordinator. The coordinator is
 * `--coordinator`, else `SWITCHYARD_URL`. The credential is `--credential`, then
 * `SWITCHYARD_TOKEN`, then `~/.config/switchyard/client.json` (when it is for that coordinator),
 * then the local `admin.token` in the data dir, but only against a loopback URL or the
 * `localUrl` in `cli-endpoint.json`: the admin token never goes to another coordinator.
 */
export function resolveConnection(
  flags: ConnectionFlags,
  env: Env = process.env,
  paths: { clientConfig?: string; dataDir?: string } = {},
): Connection {
  const cfg = readClientConfig(paths.clientConfig ?? clientConfigPath(env));
  const dataDir = flags.dataDir ?? paths.dataDir ?? defaultDataDir(env);
  const raw = flags.coordinator?.trim() || env.SWITCHYARD_URL?.trim() || undefined;
  const target = raw ? trimUrl(raw) : undefined;
  if (flags.credential) {
    const url = target ?? cfg?.coordinatorUrl;
    if (!url) throw new CliError("--credential needs --coordinator <url> (or SWITCHYARD_URL)");
    return { url: trimUrl(url), credential: flags.credential, source: "flags" };
  }
  if (env.SWITCHYARD_TOKEN?.trim()) {
    const url = target ?? cfg?.coordinatorUrl;
    if (!url) throw new CliError("SWITCHYARD_TOKEN needs SWITCHYARD_URL or --coordinator");
    return { url: trimUrl(url), credential: env.SWITCHYARD_TOKEN.trim(), source: "env" };
  }
  if (cfg && (!target || target === trimUrl(cfg.coordinatorUrl))) {
    return { url: trimUrl(cfg.coordinatorUrl), credential: cfg.credential, source: "client.json" };
  }
  const admin = readAdminToken(dataDir, env);
  const localUrl = readEndpoint(dataDir)?.localUrl;
  if (admin && (!target || isLoopbackUrl(target) || (localUrl && target === trimUrl(localUrl)))) {
    return {
      url: target ?? trimUrl(localUrl ?? DEFAULT_LOCAL_URL),
      credential: admin,
      source: "admin.token",
    };
  }
  if (target) {
    throw new CliError(
      `Not signed in to ${target}; run \`switchyard login --coordinator ${target}\``,
    );
  }
  throw new CliError(
    "Not signed in. Run `switchyard login --coordinator <url>`, or set SWITCHYARD_URL and SWITCHYARD_TOKEN.",
  );
}

export function trimUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}
