import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { ADMIN_DEVICE_ID, type Coordinator, createCoordinator } from "@switchyard/coordinator";
import {
  enroll,
  type HostAgentHandle,
  type HostConfig,
  loadConfig,
  runHostAgent,
} from "@switchyard/host-agent";
import { DEFAULT_PORT } from "@switchyard/protocol";
import { ApiClient } from "@switchyard/terminal";
import { CliError, writeEndpoint } from "../config.js";
import type { Ctx } from "../context.js";
import { defaultDataDir, type Env, resolveWebDist, standaloneHostPaths } from "../paths.js";
import { printInit } from "./auth.js";
import { authOptionsFromEnv, localUrlFor, parseOrigins, waitForSignal } from "./coordinator.js";

export interface UpFlags {
  port?: string;
  host?: string;
  dataDir?: string;
  publicUrl?: string;
  trustedOrigins?: string;
  webDist?: string;
  name?: string;
  dev?: boolean;
  /** Open the first sign-in link in a browser (default: when stdout is a TTY). */
  open?: boolean;
}

/** Vite's dev server origins, trusted with `--dev`. */
export const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

export function upOptions(flags: UpFlags, env: Env) {
  const port = flags.port === undefined ? DEFAULT_PORT : Number(flags.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new CliError(`Invalid port "${flags.port}"`);
  }
  const listenHost = flags.host ?? "0.0.0.0";
  const dataDir = flags.dataDir ?? defaultDataDir(env);
  const explicitPublic = (flags.publicUrl ?? env.SWITCHYARD_PUBLIC_URL)?.trim();
  // Port 0 (tests): the coordinator derives the URL and origins once it is listening.
  // `localhost` rather than 127.0.0.1: passkeys need a host name.
  const publicUrl =
    explicitPublic || port !== 0
      ? (explicitPublic || `http://localhost:${port}`).replace(/\/+$/, "")
      : undefined;
  let trusted = parseOrigins(flags.trustedOrigins ?? env.SWITCHYARD_TRUSTED_ORIGINS);
  if (!trusted && publicUrl) {
    trusted = [new URL(publicUrl).origin];
    // The default URL is also reached over loopback.
    if (!explicitPublic) trusted.push(`http://127.0.0.1:${port}`);
  }
  if (flags.dev && trusted) trusted = [...new Set([...trusted, ...DEV_ORIGINS])];
  return {
    dataDir,
    listen: { host: listenHost, port },
    publicUrl,
    trustedOrigins: trusted,
    webDist: resolveWebDist(flags.webDist, env),
    // Same server env as `coordinator start`: shared host secret, trusted proxies and OIDC.
    ...authOptionsFromEnv(env),
  };
}

/**
 * Enroll the standalone local host on first start (a host enrollment created with the admin
 * token, redeemed like any remote host), or reuse its config. The host always connects to the
 * coordinator over loopback with the normal host protocol.
 */
export async function ensureLocalHost(
  coordinator: Coordinator,
  localUrl: string,
  configPath: string,
  name: string,
  fetchImpl?: typeof fetch,
): Promise<{ config: HostConfig; enrolled: boolean }> {
  if (existsSync(configPath)) {
    const cfg = loadConfig(configPath);
    const known = coordinator.store.hosts.get(cfg.hostId);
    if (known && !known.revokedAt) {
      return { config: { ...cfg, coordinatorUrl: localUrl }, enrolled: false };
    }
  }
  const api = new ApiClient({
    coordinatorUrl: localUrl,
    credential: coordinator.adminToken,
    fetch: fetchImpl,
  });
  const e = await api.post<{ token: string }>("/api/hosts/enrollments", {});
  const cfg = await enroll({
    coordinatorUrl: localUrl,
    token: e.token,
    name,
    configPath,
    fetch: fetchImpl,
  });
  const { configPath: _p, ...config } = cfg;
  return { config, enrolled: true };
}

export interface StandaloneHandle {
  coordinator: Coordinator;
  host: HostAgentHandle;
  localUrl: string;
  /** The first sign-in link when this start set the server up, else null. */
  firstLink: string | null;
  stop(): Promise<void>;
}

/** Open a URL in the default browser (macOS `open`, Linux `xdg-open`); errors are ignored. */
export function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawnFn: typeof spawn = spawn,
): void {
  const cmd = platform === "darwin" ? "open" : platform === "linux" ? "xdg-open" : null;
  if (!cmd) return;
  try {
    const child = spawnFn(cmd, [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no browser: the link is printed anyway
  }
}

export interface StandaloneDeps {
  /** Browser opener (default `openBrowser`). */
  open?: (url: string) => void;
}

/**
 * First start: set the server up in-process (local server access proves ownership), print the
 * single-use sign-in link with a QR code and open it in the browser when asked to.
 */
async function initializeLocally(
  ctx: Ctx,
  coordinator: Coordinator,
  open: boolean,
  opener: (url: string) => void,
): Promise<string | null> {
  if (coordinator.owner.isInitialized()) return null;
  coordinator.owner.markInitialized();
  const e = coordinator.auth.createEnrollment("device", ADMIN_DEVICE_ID);
  // The link carries a token: it goes to this terminal (stdout), never to the log.
  await printInit(ctx, { alreadyInitialized: false, enrollment: e });
  if (open) opener(e.url);
  return e.url;
}

/** Start the coordinator and the local host agent in this process. */
export async function startStandalone(
  ctx: Ctx,
  flags: UpFlags,
  deps: StandaloneDeps = {},
): Promise<StandaloneHandle> {
  if (flags.dev && !ctx.env.SWITCHYARD_LOG_LEVEL) process.env.SWITCHYARD_LOG_LEVEL = "debug";
  const opts = upOptions(flags, ctx.env);
  // `up` sets the server up itself below, so no "run switchyard init" hint.
  const coordinator = createCoordinator({ ...opts, setupHint: false });
  await coordinator.start();
  let firstLink: string | null;
  try {
    firstLink = await initializeLocally(
      ctx,
      coordinator,
      flags.open ?? process.stdout.isTTY === true,
      deps.open ?? ((url) => openBrowser(url)),
    );
  } catch (err) {
    await coordinator.stop();
    throw err;
  }
  const localUrl = localUrlFor(opts.listen, coordinator.port);
  writeEndpoint(opts.dataDir, { localUrl, publicUrl: coordinator.config.publicUrl });
  let host: HostAgentHandle;
  try {
    const paths = standaloneHostPaths(opts.dataDir);
    const { config, enrolled } = await ensureLocalHost(
      coordinator,
      localUrl,
      paths.configPath,
      flags.name ?? hostname().replace(/\.local$/, ""),
    );
    if (enrolled) ctx.err(`Enrolled the local host "${config.name}" (${config.hostId})`);
    host = await runHostAgent({ config, stateDir: paths.stateDir, handleSignals: false });
  } catch (err) {
    await coordinator.stop();
    throw err;
  }
  return {
    coordinator,
    host,
    localUrl,
    firstLink,
    async stop() {
      await host.stop();
      await coordinator.stop();
    },
  };
}

export async function up(ctx: Ctx, flags: UpFlags): Promise<void> {
  const s = await startStandalone(ctx, flags);
  const c = s.coordinator;
  ctx.err(
    [
      `Switchyard is up: ${c.config.publicUrl} (listening on port ${c.port})`,
      `Data: ${c.config.dataDir}`,
      c.config.webDist ? null : "Web app bundle not found: API only (run `pnpm build`)",
      "Another device: switchyard pair    Terminal: switchyard attach",
      "Schedules run only while this process is running.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const sig = await waitForSignal();
  ctx.err(`${sig}: stopping (Pi sessions on this host are stopped and can be resumed later)`);
  await s.stop();
}
