import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { HostEnrollResponse, SwitchyardError } from "@switchyard/protocol";
import { z } from "zod";

export const HostConfigSchema = z.object({
  coordinatorUrl: z.string().min(1),
  hostId: z.string().min(1),
  credential: z.string().min(1),
  name: z.string().min(1),
});
export type HostConfig = z.infer<typeof HostConfigSchema>;

type Env = Record<string, string | undefined>;

/** `SWITCHYARD_HOST_CONFIG` or `~/.config/switchyard/host.json`. */
export function defaultConfigPath(env: Env = process.env, home = homedir()): string {
  const fromEnv = env.SWITCHYARD_HOST_CONFIG?.trim();
  if (fromEnv) return fromEnv;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(home, ".config"), "switchyard", "host.json");
}

/**
 * `SWITCHYARD_STATE_DIR`, else `~/Library/Application Support/switchyard` on macOS and
 * `${XDG_STATE_HOME:-~/.local/state}/switchyard` elsewhere.
 */
export function defaultStateDir(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  const fromEnv = env.SWITCHYARD_STATE_DIR?.trim();
  if (fromEnv) return fromEnv;
  if (platform === "darwin") return join(home, "Library", "Application Support", "switchyard");
  const xdg = env.XDG_STATE_HOME?.trim();
  return join(xdg || join(home, ".local", "state"), "switchyard");
}

export interface StatePaths {
  root: string;
  db: string;
  /** Bridge sockets. */
  runtime: string;
  logs: string;
}

/** Paths inside the state dir (created with mode 0700). */
export function statePaths(stateDir: string): StatePaths {
  const p = {
    root: stateDir,
    db: join(stateDir, "host.db"),
    runtime: join(stateDir, "runtime"),
    logs: join(stateDir, "logs"),
  };
  for (const d of [p.root, p.runtime, p.logs]) mkdirSync(d, { recursive: true, mode: 0o700 });
  return p;
}

export function loadConfig(path: string): HostConfig {
  if (!existsSync(path)) {
    throw new SwitchyardError(
      "not_found",
      `Host config ${path} not found; enroll this host first (switchyard host enroll)`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new SwitchyardError("invalid_request", `Cannot read ${path}: ${(err as Error).message}`);
  }
  const parsed = HostConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SwitchyardError("invalid_request", `Invalid host config ${path}`, {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

/** Write host.json atomically with mode 0600 (directory 0700). */
export function saveConfig(path: string, config: HostConfig): void {
  const cfg = HostConfigSchema.parse(config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function hostPlatform(): "darwin" | "linux" {
  return process.platform === "darwin" ? "darwin" : "linux";
}

export interface EnrollOptions {
  coordinatorUrl: string;
  token: string;
  name: string;
  /** Where to write host.json (default `defaultConfigPath()`). */
  configPath?: string;
  platform?: "darwin" | "linux";
  fetch?: typeof fetch;
}

/** Redeem a host enrollment token (`POST /api/hosts/enroll`) and write host.json. */
export async function enroll(opts: EnrollOptions): Promise<HostConfig & { configPath: string }> {
  const base = opts.coordinatorUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${base}/api/hosts/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: opts.token,
        name: opts.name,
        platform: opts.platform ?? hostPlatform(),
      }),
    });
  } catch (err) {
    throw new SwitchyardError(
      "host_unreachable",
      `Cannot reach coordinator ${base}: ${(err as Error).message}`,
    );
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    const code = (err?.code ?? "internal") as ConstructorParameters<typeof SwitchyardError>[0];
    throw new SwitchyardError(code, err?.message ?? `Enrollment failed (HTTP ${res.status})`);
  }
  const { hostId, credential } = HostEnrollResponse.parse(body);
  const config: HostConfig = { coordinatorUrl: base, hostId, credential, name: opts.name };
  const configPath = opts.configPath ?? defaultConfigPath();
  saveConfig(configPath, config);
  return { ...config, configPath };
}
