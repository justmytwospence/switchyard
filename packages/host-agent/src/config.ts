import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { HostEnrollResponse, SwitchyardError } from "@switchyard/protocol";
import { z } from "zod";

export const HostConfigSchema = z.object({
  coordinatorUrl: z.string().min(1),
  hostId: z.string().min(1),
  credential: z.string().min(1),
  name: z.string().min(1),
  /** Run sessions as interactive Pi in a terminal holder (default true; false runs them headless over RPC). */
  terminalSessions: z.boolean().optional(),
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

interface EnrollCommon {
  coordinatorUrl: string;
  name: string;
  /** Where to write host.json (default `defaultConfigPath()`). */
  configPath?: string;
  platform?: "darwin" | "linux";
  fetch?: typeof fetch;
}

/** Exactly one of `token` (a single-use host enrollment token) or `secret` (the shared secret). */
export type EnrollOptions = EnrollCommon &
  ({ token: string; secret?: undefined } | { secret: string; token?: undefined });

/**
 * Enroll this host (`POST /api/hosts/enroll`) with a single-use token or the server's shared
 * host enrollment secret, and write host.json.
 */
export async function enroll(opts: EnrollOptions): Promise<HostConfig & { configPath: string }> {
  const hasToken = typeof opts.token === "string" && opts.token !== "";
  const hasSecret = typeof opts.secret === "string" && opts.secret !== "";
  if (hasToken === hasSecret) {
    throw new SwitchyardError(
      "invalid_request",
      "Enroll with exactly one of a host token or the shared enrollment secret",
    );
  }
  const base = opts.coordinatorUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const platform = opts.platform ?? hostPlatform();
  const body = hasToken
    ? { token: opts.token, name: opts.name, platform }
    : { secret: opts.secret, name: opts.name, platform };
  let res: Response;
  try {
    res = await doFetch(`${base}/api/hosts/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new SwitchyardError(
      "host_unreachable",
      `Cannot reach coordinator ${base}: ${(err as Error).message}`,
    );
  }
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const err = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
    const code = (err?.code ?? "internal") as ConstructorParameters<typeof SwitchyardError>[0];
    throw new SwitchyardError(code, err?.message ?? `Enrollment failed (HTTP ${res.status})`);
  }
  const { hostId, credential } = HostEnrollResponse.parse(parsed);
  const config: HostConfig = { coordinatorUrl: base, hostId, credential, name: opts.name };
  const configPath = opts.configPath ?? defaultConfigPath();
  saveConfig(configPath, config);
  return { ...config, configPath };
}

/** The logging surface `waitForConfig` needs (a pino logger fits). */
export interface WaitLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface WaitForConfigOptions {
  configPath: string;
  env: Env;
  log: WaitLogger;
  signal?: AbortSignal;
  /** Test overrides for the waits (defaults: 5 s, 60 s, 5 s poll, 10 min reminder). */
  timing?: Partial<WaitTiming>;
  fetch?: typeof fetch;
}

export interface WaitTiming {
  unreachableRetryMs: number;
  errorRetryMs: number;
  pollMs: number;
  reminderMs: number;
}

const DEFAULT_TIMING: WaitTiming = {
  unreachableRetryMs: 5_000,
  errorRetryMs: 60_000,
  pollMs: 5_000,
  reminderMs: 10 * 60_000,
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal as AbortSignal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Aborted waiting for host config");
}

/**
 * Resolve the host config without ever giving up: load host.json when it exists; otherwise
 * self-enroll with `SWITCHYARD_HOST_ENROLL_SECRET` and `SWITCHYARD_COORDINATOR_URL` (retrying
 * until it works); otherwise log the enroll command and wait for host.json to appear.
 * Rejects only when `signal` aborts.
 */
export async function waitForConfig(opts: WaitForConfigOptions): Promise<HostConfig> {
  const { configPath, env, log, signal } = opts;
  const t = { ...DEFAULT_TIMING, ...opts.timing };
  if (existsSync(configPath)) return loadConfig(configPath);

  const secret = env.SWITCHYARD_HOST_ENROLL_SECRET?.trim();
  const coordinatorUrl = env.SWITCHYARD_COORDINATOR_URL?.trim();
  if (secret && coordinatorUrl) {
    const name = env.SWITCHYARD_HOST_NAME?.trim() || hostname();
    for (;;) {
      if (signal?.aborted) throw abortError(signal);
      // Someone may have enrolled this host by hand meanwhile.
      if (existsSync(configPath)) return loadConfig(configPath);
      try {
        const enrolled = await enroll({
          coordinatorUrl,
          secret,
          name,
          configPath,
          fetch: opts.fetch,
        });
        log.info({ hostId: enrolled.hostId, configPath }, "host enrolled with the shared secret");
        return loadConfig(configPath);
      } catch (err) {
        if (err instanceof SwitchyardError && err.code === "host_unreachable") {
          log.info({ coordinatorUrl }, "Coordinator not reachable yet; retrying");
          await sleep(t.unreachableRetryMs, signal);
        } else {
          log.warn(
            { coordinatorUrl, err: (err as Error).message },
            "host enrollment failed; retrying in a minute",
          );
          await sleep(t.errorRetryMs, signal);
        }
      }
    }
  }

  const url = coordinatorUrl || "<url>";
  const hint =
    "This host is not enrolled. Create a host token in Settings › Hosts › Add host, then run: " +
    `switchyard host enroll --coordinator ${url} --token <token>`;
  let lastReminder = Number.NEGATIVE_INFINITY;
  let lastError: string | null = null;
  for (;;) {
    if (signal?.aborted) throw abortError(signal);
    if (existsSync(configPath)) {
      try {
        return loadConfig(configPath);
      } catch (err) {
        // A file still being written (or a bad one) is retried rather than fatal.
        const message = (err as Error).message;
        if (message !== lastError)
          log.warn({ configPath, err: message }, "host config not usable yet");
        lastError = message;
      }
    }
    const now = Date.now();
    if (now - lastReminder >= t.reminderMs) {
      log.info({ configPath }, hint);
      lastReminder = now;
    }
    await sleep(t.pollMs, signal);
  }
}

/**
 * Resolve once host.json at `configPath` loads with a different hostId, credential or coordinator
 * than `current` (polled; unreadable or partial files are retried). Rejects only when `signal` aborts.
 */
export async function waitForConfigChange(
  configPath: string,
  current: Pick<HostConfig, "hostId" | "credential" | "coordinatorUrl">,
  opts: { signal?: AbortSignal; pollMs?: number } = {},
): Promise<HostConfig> {
  for (;;) {
    if (opts.signal?.aborted) throw abortError(opts.signal);
    try {
      const next = loadConfig(configPath);
      if (
        next.hostId !== current.hostId ||
        next.credential !== current.credential ||
        next.coordinatorUrl !== current.coordinatorUrl
      ) {
        return next;
      }
    } catch {
      // missing, partial or invalid: try again
    }
    await sleep(opts.pollMs ?? 5000, opts.signal);
  }
}
