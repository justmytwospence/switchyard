import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AdapterInfo } from "@switchyard/protocol";
import { satisfies } from "semver";
import { adapterEntries, defaultOwnerAdapterDir } from "./discovery.js";
import { type AdapterManifest, loadManifest, MANIFEST_FILE } from "./manifest.js";
import { AdapterSession, DEFAULT_HOOK_TIMEOUT_MS, withTimeout } from "./session.js";
import {
  type AdapterDiagnostic,
  type AdapterSessionHost,
  type AdapterTier,
  type LoadedAdapter,
  type ServerAdapter,
  type ServerAdapterFactory,
  TIER_ORDER,
} from "./types.js";

/** Project-tier adapters live in `<projectRoot>/.switchyard/adapters/<name>/`. */
export const PROJECT_ADAPTER_DIR = join(".switchyard", "adapters");

const FACTORY_TIMEOUT_MS = 10_000;

export interface RegistryLoadOptions {
  projectRoot: string | null;
  /** Default `~/.config/switchyard/adapters`. */
  ownerDir?: string;
  /** Pi package dirs whose package.json declares `switchyard.adapter` (see discoverPiPackages). */
  pluginPackageDirs?: string[];
  bundled?: LoadedAdapter[];
  /** Installed Pi packages, to check each adapter's `target.versionRange`. */
  installedPackages?: { name: string | null; version: string | null }[];
}

export interface AdapterRegistryOptions {
  hookTimeoutMs?: number;
  onDiagnostic?: (d: AdapterDiagnostic) => void;
}

interface Record_ {
  manifest: AdapterManifest;
  tier: AdapterTier;
  adapter: LoadedAdapter | null;
  status: AdapterInfo["status"];
  detail: string | null;
}

export class AdapterLoadError extends Error {
  constructor(
    message: string,
    readonly manifest: AdapterManifest | null,
  ) {
    super(message);
    this.name = "AdapterLoadError";
  }
}

function isServerAdapter(x: unknown): x is ServerAdapter {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * Load one adapter from a directory (or manifest path): validate the manifest, then import the
 * `server` module (ESM default export: a ServerAdapter or a factory returning one).
 */
export async function loadAdapterFromDir(
  pathOrDir: string,
  tier: AdapterTier,
): Promise<{ adapter: LoadedAdapter; warnings: string[] }> {
  const m = await loadManifest(pathOrDir);
  const warnings: string[] = [];
  if (!existsSync(m.serverPath)) {
    throw new AdapterLoadError(`server module ${m.serverPath} does not exist`, m.manifest);
  }
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(m.serverPath).href)) as { default?: unknown };
  } catch (err) {
    throw new AdapterLoadError(
      `cannot import ${m.serverPath}: ${(err as Error).message}`,
      m.manifest,
    );
  }
  let server: unknown = mod.default;
  if (typeof server === "function") {
    try {
      server = await withTimeout(
        () => (server as ServerAdapterFactory)({ manifest: m.manifest, dir: m.dir }),
        FACTORY_TIMEOUT_MS,
      );
    } catch (err) {
      throw new AdapterLoadError(`adapter factory failed: ${(err as Error).message}`, m.manifest);
    }
  }
  if (!isServerAdapter(server)) {
    throw new AdapterLoadError(
      `${m.serverPath} must default-export a ServerAdapter object or factory`,
      m.manifest,
    );
  }
  let webRendererPath = m.webRendererPath;
  if (webRendererPath && !existsSync(webRendererPath)) {
    warnings.push(`web renderer ${webRendererPath} does not exist; portable panels are used`);
    webRendererPath = null;
  }
  return {
    adapter: {
      manifest: m.manifest,
      tier,
      dir: m.dir,
      manifestPath: m.manifestPath,
      webRendererPath,
      server,
    },
    warnings,
  };
}

async function subdirsWithManifest(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  if (existsSync(join(root, MANIFEST_FILE))) return [root];
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() || e.isSymbolicLink())
    .map((e) => join(root, e.name))
    .filter((d) => existsSync(join(d, MANIFEST_FILE)))
    .sort();
}

/**
 * All adapters available to a host, ordered project > owner > plugin > bundled. When two tiers
 * provide the same adapter id, the higher tier wins and the other is listed as disabled.
 * Per-session dispatch lives in AdapterSession (`openSession`).
 */
export class AdapterRegistry {
  private records: Record_[] = [];
  private diags: AdapterDiagnostic[] = [];
  private readonly sessions = new Map<string, AdapterSession>();
  private readonly hookTimeoutMs: number;

  constructor(private readonly opts: AdapterRegistryOptions = {}) {
    this.hookTimeoutMs = opts.hookTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS;
  }

  /** Discover and load adapters from every tier, replacing the current set. */
  async load(opts: RegistryLoadOptions): Promise<void> {
    this.records = [];
    this.diags = [];
    const candidates: { tier: AdapterTier; path: string }[] = [];
    if (opts.projectRoot) {
      for (const d of await this.safeList(resolve(opts.projectRoot, PROJECT_ADAPTER_DIR))) {
        candidates.push({ tier: "project", path: d });
      }
    }
    for (const d of await this.safeList(opts.ownerDir ?? defaultOwnerAdapterDir())) {
      candidates.push({ tier: "owner", path: d });
    }
    for (const pkgDir of opts.pluginPackageDirs ?? []) {
      let entries: string[] = [];
      try {
        entries = adapterEntries(JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8")));
      } catch (err) {
        this.diagnostic(
          "warning",
          null,
          `Cannot read ${pkgDir}/package.json: ${(err as Error).message}`,
        );
      }
      for (const e of entries) candidates.push({ tier: "plugin", path: resolve(pkgDir, e) });
    }

    const loaded: LoadedAdapter[] = [];
    for (const c of candidates) {
      try {
        const { adapter, warnings } = await loadAdapterFromDir(c.path, c.tier);
        for (const w of warnings) this.diagnostic("warning", adapter.manifest.id, w);
        loaded.push(adapter);
      } catch (err) {
        const manifest = err instanceof AdapterLoadError ? err.manifest : null;
        this.diagnostic(
          "error",
          manifest?.id ?? null,
          `Cannot load ${c.tier} adapter at ${c.path}: ${(err as Error).message}`,
        );
        if (manifest) {
          this.records.push({
            manifest,
            tier: c.tier,
            adapter: null,
            status: "error",
            detail: (err as Error).message,
          });
        }
      }
    }
    for (const b of opts.bundled ?? []) loaded.push({ ...b, tier: "bundled" });
    this.setAdapters(loaded, opts.installedPackages);
  }

  /** Install an explicit adapter list (stable-sorted by tier). Used by load() and tests. */
  setAdapters(
    adapters: LoadedAdapter[],
    installedPackages: RegistryLoadOptions["installedPackages"] = [],
  ): void {
    const sorted = [...adapters].sort(
      (a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier),
    );
    const winners = new Map<string, LoadedAdapter>();
    const records = this.records.filter((r) => r.status === "error");
    for (const a of sorted) {
      const id = a.manifest.id;
      const winner = winners.get(id);
      if (winner) {
        records.push({
          manifest: a.manifest,
          tier: a.tier,
          adapter: null,
          status: "disabled",
          detail: `overridden by the ${winner.tier} adapter ${id}${winner.dir ? ` at ${winner.dir}` : ""}`,
        });
        continue;
      }
      winners.set(id, a);
      let detail: string | null = null;
      const installed = installedPackages?.find((p) => p.name === a.manifest.target.extension);
      if (installed?.version && !satisfies(installed.version, a.manifest.target.versionRange)) {
        detail = `installed ${installed.name}@${installed.version} is outside ${a.manifest.target.versionRange} (tested ${a.manifest.target.testedVersions.join(", ") || "none"}); unmatched dialogs fall back to generic`;
        this.diagnostic("warning", id, detail);
      }
      records.push({ manifest: a.manifest, tier: a.tier, adapter: a, status: "active", detail });
    }
    this.records = records.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
  }

  /** Active adapters in precedence order. */
  adapters(): LoadedAdapter[] {
    return this.records.flatMap((r) => (r.status === "active" && r.adapter ? [r.adapter] : []));
  }

  get(adapterId: string): LoadedAdapter | undefined {
    return this.adapters().find((a) => a.manifest.id === adapterId);
  }

  /** Every known adapter (active, overridden or failed) for Settings > Adapters. */
  info(): AdapterInfo[] {
    return this.records.map((r) => ({
      id: r.manifest.id,
      version: r.manifest.version,
      tier: r.tier,
      target: { ...r.manifest.target },
      capabilities: [...r.manifest.capabilities],
      webRenderer: r.adapter?.webRendererPath != null,
      status: r.status,
      detail: r.detail,
    }));
  }

  /** Load-time diagnostics (session diagnostics go through each session's host.emit). */
  diagnostics(): AdapterDiagnostic[] {
    return [...this.diags];
  }

  /** Open the per-session adapter context. Replaces any previous session with the same id. */
  openSession(host: AdapterSessionHost): AdapterSession {
    this.sessions.get(host.sessionId)?.close();
    const s = new AdapterSession(this.adapters(), host, this.hookTimeoutMs);
    this.sessions.set(host.sessionId, s);
    return s;
  }

  session(sessionId: string): AdapterSession | undefined {
    return this.sessions.get(sessionId);
  }

  closeSession(sessionId: string): void {
    this.sessions.get(sessionId)?.close();
    this.sessions.delete(sessionId);
  }

  private async safeList(root: string): Promise<string[]> {
    try {
      return await subdirsWithManifest(root);
    } catch (err) {
      this.diagnostic(
        "warning",
        null,
        `Cannot list adapters in ${root}: ${(err as Error).message}`,
      );
      return [];
    }
  }

  private diagnostic(level: AdapterDiagnostic["level"], adapterId: string | null, message: string) {
    const d: AdapterDiagnostic = { sessionId: null, adapterId, level, message };
    this.diags.push(d);
    try {
      this.opts.onDiagnostic?.(d);
    } catch {
      // ignore sink failures
    }
  }
}
