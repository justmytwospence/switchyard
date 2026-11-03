import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Env = Record<string, string | undefined>;

/**
 * Coordinator data dir: `SWITCHYARD_DATA_DIR`, else `~/Library/Application Support/switchyard/
 * coordinator` on macOS and `${XDG_DATA_HOME:-~/.local/share}/switchyard` elsewhere.
 */
export function defaultDataDir(
  env: Env = process.env,
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
): string {
  const fromEnv = env.SWITCHYARD_DATA_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "switchyard", "coordinator");
  }
  const xdg = env.XDG_DATA_HOME?.trim();
  return join(xdg || join(home, ".local", "share"), "switchyard");
}

/** `~/.config/switchyard` (or `$XDG_CONFIG_HOME/switchyard`). */
export function configDir(env: Env = process.env, home = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return join(xdg || join(home, ".config"), "switchyard");
}

/** Terminal/CLI credentials: `~/.config/switchyard/client.json`. */
export function clientConfigPath(env: Env = process.env, home = homedir()): string {
  const fromEnv = env.SWITCHYARD_CLIENT_CONFIG?.trim();
  if (fromEnv) return resolve(fromEnv);
  return join(configDir(env, home), "client.json");
}

/** Standalone (`switchyard up`) keeps its local host's config and state inside the data dir. */
export function standaloneHostPaths(dataDir: string): { stateDir: string; configPath: string } {
  const stateDir = join(dataDir, "host");
  return { stateDir, configPath: join(stateDir, "host.json") };
}

/** Root of the installed `@switchyard/cli` package (the directory holding its package.json). */
export function cliPackageRoot(): string {
  // dist/paths.js -> package root
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * The entry file to run this CLI (used in service files). Built from the workspace, this module
 * is `dist/paths.js` and the entry is `dist/main.js`; in the published npm bundle every module is
 * one file, `dist/switchyard.mjs`, which is itself the entry.
 */
export function entryFor(selfPath: string, root: string): string {
  return basename(selfPath) === "paths.js" ? join(root, "dist", "main.js") : selfPath;
}

export function cliEntry(): string {
  return entryFor(fileURLToPath(import.meta.url), cliPackageRoot());
}

/**
 * The web app bundle: `SWITCHYARD_WEB_DIST`, else the built `packages/web/dist` next to the
 * installed CLI package when present, else null (API only).
 */
export function resolveWebDist(
  explicit: string | undefined,
  env: Env = process.env,
  root = cliPackageRoot(),
): string | null {
  const fromOpt = explicit?.trim() || env.SWITCHYARD_WEB_DIST?.trim();
  if (fromOpt) return resolve(fromOpt);
  for (const candidate of [join(root, "..", "web", "dist"), join(root, "web-dist")]) {
    if (existsSync(join(candidate, "index.html"))) return resolve(candidate);
  }
  return null;
}

/** Templates for `host install-service` (repo `deploy/`), when available. */
export function deployDir(root = cliPackageRoot()): string {
  return resolve(root, "..", "..", "deploy");
}
