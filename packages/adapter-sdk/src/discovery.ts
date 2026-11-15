import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type AdapterManifest, loadManifest } from "./manifest.js";
import type { AdapterDiagnostic, AdapterProvenance } from "./types.js";

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
  scope: "user" | "project";
  /** Canonical provider root, which may differ from the target component root. */
  providerRoot: string;
  enabledExtensionPaths: string[];
  targets: {
    manifestPath: string;
    packageRoot: string | null;
    name: string;
    version: string | null;
  }[];
}

/** Deliberately structural: adapter-sdk must not depend on pi-runtime. */
export interface PiDiscoveryInventory {
  status: "available" | "unavailable";
  extensions: {
    path: string;
    enabled: boolean;
    source: string;
    scope: "user" | "project";
    packageRoot: string | null;
  }[];
  diagnostics: string[];
}

export interface DiscoveredAdapterCandidate {
  path: string;
  manifest: AdapterManifest;
  enabled: boolean;
  detail: string | null;
  provenance: AdapterProvenance;
}

export interface PiPackageDiscoveryOptions {
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  globalNpmRoot?: string;
  inventory?: PiDiscoveryInventory;
  reportedExtensionPaths?: string[];
  projectTrusted?: boolean | null;
  extensionsDisabled?: boolean;
}

export interface PiPackageDiscovery {
  agentDir: string;
  packages: PiPackageInfo[];
  /** Compatibility metadata only. Pass `candidates` to the registry to preserve filtering. */
  pluginPackageDirs: string[];
  /** Preferred registry input: includes disabled records and component-specific versions. */
  candidates: DiscoveredAdapterCandidate[];
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
 * Inspect Pi's already-resolved effective inventory without reimplementing its filters/deltas.
 * Missing/unavailable inventory uses an explicitly coarse, user-only legacy fallback.
 * This reads manifests/package metadata, never adapter server modules.
 */
export async function discoverPiPackages(
  opts: PiPackageDiscoveryOptions = {},
): Promise<PiPackageDiscovery> {
  const home = opts.home ?? homedir();
  const agentDir = opts.agentDir ?? piAgentDir(opts.env, home);
  const out: PiPackageDiscovery = {
    agentDir,
    packages: [],
    pluginPackageDirs: [],
    candidates: [],
    diagnostics: [],
  };
  const diag = (level: AdapterDiagnostic["level"], message: string) =>
    out.diagnostics.push({ sessionId: null, adapterId: null, level, message });

  if (opts.extensionsDisabled) return out;
  for (const message of opts.inventory?.diagnostics ?? []) diag("warning", message);
  if (
    opts.inventory?.status === "available" &&
    opts.projectTrusted !== null &&
    opts.projectTrusted !== undefined
  ) {
    const groups = new Map<
      string,
      { source: string; scope: "user" | "project"; enabled: string[] }
    >();
    for (const ext of opts.inventory.extensions) {
      if (!ext.packageRoot || (ext.scope === "project" && opts.projectTrusted !== true)) continue;
      const root = await canonicalPath(ext.packageRoot);
      const path = await canonicalPath(ext.path);
      // Do not follow extension/package symlinks out of the resolver-authorized provider.
      if (!inside(root, path)) continue;
      const group = groups.get(root) ?? { source: ext.source, scope: ext.scope, enabled: [] };
      // Keep Pi's resolved enabled paths verbatim; do not merge filters or guess deltas.
      // Project provenance wins for a shared provider without dropping user-enabled resources.
      if (ext.scope === "project") {
        group.source = ext.source;
        group.scope = ext.scope;
      }
      if (ext.enabled) group.enabled.push(path);
      groups.set(root, group);
    }
    const reported = new Set(
      await Promise.all((opts.reportedExtensionPaths ?? []).map(canonicalPath)),
    );
    for (const [root, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      await inspectPackage(root, group.source, group.scope, group.enabled, reported, false, out);
    }
    return out;
  }
  diag(
    "warning",
    "Legacy user-scope package discovery: effective Pi resources/trust are unavailable; project adapters are not authorized and resource filters cannot be verified.",
  );

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
    const root = await canonicalPath(dir);
    if (out.packages.some((p) => p.providerRoot === root)) continue;
    const enabled =
      typeof item !== "object" ||
      item === null ||
      (item as { autoload?: unknown }).autoload !== false;
    await inspectPackage(root, source, "user", [], new Set(), true, out, enabled);
  }
  return out;
}

async function canonicalPath(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path));
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === "" ||
    (!isAbsolute(rel) &&
      rel !== ".." &&
      !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
  );
}

const LEGACY_DETAIL = "Package-level discovery; adapter does not declare target entrypoints.";
const DISABLED_DETAIL = "Target extension is not enabled in this session.";

async function inspectPackage(
  root: string,
  source: string,
  scope: "user" | "project",
  enabledPaths: string[],
  reported: Set<string>,
  legacy: boolean,
  out: PiPackageDiscovery,
  legacyEnabled = true,
): Promise<void> {
  const diagnostic = (message: string) =>
    out.diagnostics.push({ sessionId: null, adapterId: null, level: "warning" as const, message });
  let pkg: { name?: unknown; version?: unknown };
  try {
    pkg = (await readJson(join(root, "package.json"))) as typeof pkg;
    if (!pkg || typeof pkg !== "object") throw new Error("expected package object");
  } catch (err) {
    diagnostic(`Cannot read ${root}/package.json: ${(err as Error).message}`);
    return;
  }
  const info: PiPackageInfo = {
    source,
    scope,
    dir: root,
    providerRoot: root,
    name: typeof pkg.name === "string" ? pkg.name : null,
    version: typeof pkg.version === "string" ? pkg.version : null,
    adapters: adapterEntries(pkg),
    enabledExtensionPaths: [...new Set(enabledPaths)].sort(),
    targets: [],
  };
  out.packages.push(info);
  for (const entry of info.adapters) {
    try {
      const path = await canonicalPath(resolve(root, entry));
      if (!inside(root, path)) throw new Error("adapter path escapes provider root");
      const m = await loadManifest(path);
      const manifestPath = await canonicalPath(m.manifestPath);
      if (
        !inside(root, manifestPath) ||
        !inside(root, await canonicalPath(m.serverPath)) ||
        (m.webRendererPath && !inside(root, await canonicalPath(m.webRendererPath)))
      ) {
        throw new Error("adapter files escape provider root");
      }
      if (out.candidates.some((c) => c.path === manifestPath)) continue;
      // Walk from the adapter toward the authorized provider, never into its parents.
      let target: { root: string; version: string | null } | null = null;
      for (let dir = await canonicalPath(m.dir); inside(root, dir); dir = dirname(dir)) {
        try {
          const component = (await readJson(join(dir, "package.json"))) as {
            name?: unknown;
            version?: unknown;
          };
          if (component?.name === m.manifest.target.extension) {
            target = {
              root: dir,
              version: typeof component.version === "string" ? component.version : null,
            };
            break;
          }
        } catch {
          /* Not every ancestor is a package. */
        }
        if (dir === root) break;
      }
      info.targets.push({
        manifestPath,
        packageRoot: target?.root ?? null,
        name: m.manifest.target.extension,
        version: target?.version ?? null,
      });
      const bound = m.manifest.target.entrypoints !== undefined;
      const entrypoints =
        target && bound
          ? await Promise.all(
              m.manifest.target.entrypoints!.map((p) =>
                canonicalPath(resolve(target.root, p.replaceAll("\\", "/"))),
              ),
            )
          : [];
      if (target && entrypoints.some((p) => !inside(target.root, p)))
        throw new Error("target entrypoint escapes component root");
      // A legacy fallback cannot prove entrypoint-bound adapters are loaded.
      const enabled = bound
        ? !legacy && entrypoints.some((p) => enabledPaths.includes(p) && reported.has(p))
        : legacy
          ? legacyEnabled
          : enabledPaths.length > 0;
      out.candidates.push({
        path: manifestPath,
        manifest: m.manifest,
        enabled,
        detail: !enabled ? DISABLED_DETAIL : bound ? null : LEGACY_DETAIL,
        provenance: {
          scope,
          source,
          packageDir: root,
          manifestPath,
          targetVersion: target?.version ?? null,
          entrypoints: [...new Set(entrypoints)].sort(),
          evidence: bound ? "runtime-reported" : "package-level",
        },
      });
    } catch (err) {
      diagnostic(`Cannot inspect adapter ${entry} in ${root}: ${(err as Error).message}`);
    }
  }
  if (info.adapters.length > 0) out.pluginPackageDirs.push(root);
}
