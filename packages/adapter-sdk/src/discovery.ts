import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AdapterDiagnostic } from "./types.js";

/** Pi's agent directory: `PI_CODING_AGENT_DIR` or `~/.pi/agent`. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const fromEnv = env.PI_CODING_AGENT_DIR?.trim();
  if (fromEnv) return expandHome(fromEnv, home);
  return join(home, ".pi", "agent");
}

/** The owner adapter directory, `~/.config/switchyard/adapters`. */
export function defaultOwnerAdapterDir(home = homedir()): string {
  return join(home, ".config", "switchyard", "adapters");
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

export type PiPackageSource =
  | { kind: "npm"; name: string }
  | { kind: "git"; host: string; path: string }
  | { kind: "local"; path: string };

function isLocalPath(s: string): boolean {
  return s.startsWith(".") || s.startsWith("/") || s.startsWith("~") || /^[A-Za-z]:[\\/]/.test(s);
}

function parseNpmName(spec: string): string {
  const s = spec.trim();
  if (s.startsWith("@")) {
    const at = s.indexOf("@", 1);
    return at === -1 ? s : s.slice(0, at);
  }
  const at = s.indexOf("@");
  return at === -1 ? s : s.slice(0, at);
}

/** Parse a git source the way Pi installs it (`<agentDir>/git/<host>/<path>`). */
export function parseGitSource(source: string): { host: string; path: string } | null {
  let s = source.trim();
  const prefixed = s.startsWith("git:");
  if (prefixed) s = s.slice(4).trim();
  if (!prefixed && !/^(https?|ssh|git):\/\//i.test(s)) return null;
  s = s.replace(/^(https?|ssh|git):\/\//i, "");
  s = s.replace(/^[^@/]+@/, ""); // user@ (git@github.com:user/repo)
  s = s.replace(/^([^/:]+):(?!\d)/, "$1/"); // scp-like host:path
  s = s.split("#")[0] ?? s;
  const [hostPart, ...rest] = s.split("/");
  const host = (hostPart ?? "").replace(/:\d+$/, "");
  const path = rest
    .join("/")
    .replace(/@[^/]*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  if (!host || !path) return null;
  return { host, path };
}

export function parsePiPackageSource(source: string): PiPackageSource {
  const s = source.trim();
  if (s.startsWith("npm:")) return { kind: "npm", name: parseNpmName(s.slice(4)) };
  if (isLocalPath(s)) return { kind: "local", path: s };
  const git = parseGitSource(s);
  if (git) return { kind: "git", ...git };
  return { kind: "local", path: s };
}

/**
 * Where Pi keeps a user-scope package: npm under `<agentDir>/npm/node_modules/<name>` (or the
 * legacy global npm root when given), git under `<agentDir>/git/<host>/<path>`, local paths
 * resolved relative to the agent dir (the directory of the settings file that lists them).
 */
export function piPackageDirCandidates(
  source: string,
  agentDir: string,
  opts: { home?: string; globalNpmRoot?: string } = {},
): string[] {
  const home = opts.home ?? homedir();
  const parsed = parsePiPackageSource(source);
  switch (parsed.kind) {
    case "npm": {
      const out = [join(agentDir, "npm", "node_modules", parsed.name)];
      if (opts.globalNpmRoot) out.push(join(opts.globalNpmRoot, parsed.name));
      return out;
    }
    case "git":
      return [join(agentDir, "git", parsed.host, parsed.path)];
    case "local": {
      const p = expandHome(parsed.path, home);
      return [isAbsolute(p) ? p : resolve(agentDir, p)];
    }
  }
}

export interface PiPackageInfo {
  source: string;
  dir: string;
  name: string | null;
  version: string | null;
  /** `package.json` `switchyard.adapter` entries (paths relative to `dir`), if any. */
  adapters: string[];
}

export interface PiPackageDiscovery {
  agentDir: string;
  packages: PiPackageInfo[];
  /** Package dirs that declare `switchyard.adapter`. Pass to `AdapterRegistry.load`. */
  pluginPackageDirs: string[];
  diagnostics: AdapterDiagnostic[];
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

/** Read `switchyard.adapter` (a path or list of paths) from a package.json object. */
export function adapterEntries(pkg: unknown): string[] {
  const field = (pkg as { switchyard?: { adapter?: unknown } } | null)?.switchyard?.adapter;
  if (typeof field === "string") return [field];
  if (Array.isArray(field)) return field.filter((x): x is string => typeof x === "string");
  return [];
}

/**
 * List the Pi packages from `<agentDir>/settings.json` `packages` and find those that provide a
 * Switchyard adapter. Project-scope packages (`.pi/settings.json`) are not consulted.
 */
export async function discoverPiPackages(
  opts: { agentDir?: string; env?: NodeJS.ProcessEnv; home?: string; globalNpmRoot?: string } = {},
): Promise<PiPackageDiscovery> {
  const home = opts.home ?? homedir();
  const agentDir = opts.agentDir ?? piAgentDir(opts.env, home);
  const out: PiPackageDiscovery = {
    agentDir,
    packages: [],
    pluginPackageDirs: [],
    diagnostics: [],
  };
  const diag = (level: AdapterDiagnostic["level"], message: string) =>
    out.diagnostics.push({ sessionId: null, adapterId: null, level, message });

  const settingsPath = join(agentDir, "settings.json");
  if (!existsSync(settingsPath)) return out;
  let settings: unknown;
  try {
    settings = await readJson(settingsPath);
  } catch (err) {
    diag("warning", `Cannot read Pi settings ${settingsPath}: ${(err as Error).message}`);
    return out;
  }
  const list = (settings as { packages?: unknown })?.packages;
  if (!Array.isArray(list)) return out;

  for (const item of list) {
    const source =
      typeof item === "string"
        ? item
        : item &&
            typeof item === "object" &&
            typeof (item as { source?: unknown }).source === "string"
          ? (item as { source: string }).source
          : null;
    if (!source) {
      diag("warning", `Ignoring Pi package entry ${JSON.stringify(item)}: no source`);
      continue;
    }
    const candidates = piPackageDirCandidates(source, agentDir, {
      home,
      globalNpmRoot: opts.globalNpmRoot,
    });
    const dir = candidates.find((c) => existsSync(c));
    if (!dir) {
      diag(
        "warning",
        `Pi package ${source} could not be resolved (looked in ${candidates.join(", ")}); any adapter it provides is not loaded.`,
      );
      continue;
    }
    let pkg: unknown = null;
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        pkg = await readJson(pkgPath);
      } catch (err) {
        diag("warning", `Cannot read ${pkgPath}: ${(err as Error).message}`);
      }
    }
    const info: PiPackageInfo = {
      source,
      dir,
      name:
        typeof (pkg as { name?: unknown })?.name === "string"
          ? (pkg as { name: string }).name
          : null,
      version:
        typeof (pkg as { version?: unknown })?.version === "string"
          ? (pkg as { version: string }).version
          : null,
      adapters: adapterEntries(pkg),
    };
    out.packages.push(info);
    if (info.adapters.length > 0) out.pluginPackageDirs.push(dir);
  }
  return out;
}
