import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AdapterInfo } from "@switchyard/protocol";
import { satisfies } from "semver";
import {
  adapterEntries,
  type DiscoveredAdapterCandidate,
  defaultOwnerAdapterDir,
} from "./discovery.js";
import { type AdapterManifest, loadManifest, MANIFEST_FILE } from "./manifest.js";
import { AdapterSession, DEFAULT_HOOK_TIMEOUT_MS, withTimeout } from "./session.js";
import {
  type AdapterCatalogInfo,
  type AdapterDiagnostic,
  type AdapterProvenance,
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
  /** Effective inventory candidates, including records that must not be imported. Preferred. */
  pluginCandidates?: DiscoveredAdapterCandidate[];
  /** Explicit project adapters require confirmed trust. */
  projectTrusted?: boolean | null;
  extensionsDisabled?: boolean;
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
  provenance?: AdapterProvenance;
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
 * Only entry bytes are content-addressed; relative imports resolve normally and dependencies
 * retain Node's normal module cache. The edit/reload guarantee requires a self-contained entry.
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
    const hash = createHash("sha256")
      .update(await readFile(m.serverPath))
      .digest("hex");
    const url = pathToFileURL(m.serverPath);
    url.searchParams.set("sha256", hash);
    mod = (await import(url.href)) as { default?: unknown };
  } catch (err) {
    throw new AdapterLoadError(
      `cannot import ${m.serverPath}: ${(err as Error).message}`,
      m.manifest,
    );
  }
  const exported = mod.default;
  const createServer = async (): Promise<ServerAdapter> => {
    let server: unknown = exported;
    if (typeof exported === "function") {
      try {
        server = await withTimeout(
          () => (exported as ServerAdapterFactory)({ manifest: m.manifest, dir: m.dir }),
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
    return server;
  };
  const server = await createServer();
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
      ...(typeof exported === "function" ? { createServer } : {}),
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
    const candidates: {
      tier: AdapterTier;
      path: string;
      discovered?: DiscoveredAdapterCandidate;
    }[] = [];
    if (opts.extensionsDisabled) return;
    if (opts.projectRoot && opts.projectTrusted === true) {
      for (const d of await this.safeList(resolve(opts.projectRoot, PROJECT_ADAPTER_DIR))) {
        candidates.push({ tier: "project", path: d });
      }
    }
    for (const d of await this.safeList(opts.ownerDir ?? defaultOwnerAdapterDir())) {
      candidates.push({ tier: "owner", path: d });
    }
    for (const c of opts.pluginCandidates ?? []) {
      if (c.provenance.scope === "project" && opts.projectTrusted !== true) continue;
      candidates.push({ tier: "plugin", path: c.path, discovered: c });
    }
    for (const pkgDir of opts.pluginCandidates === undefined
      ? (opts.pluginPackageDirs ?? [])
      : []) {
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
    const seen = new Set<string>();
    for (const c of candidates) {
      try {
        const m = await loadManifest(c.path);
        const canonical = await realpath(m.manifestPath);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        const discovered = c.discovered;
        if (discovered && JSON.stringify(discovered.manifest) !== JSON.stringify(m.manifest)) {
          throw new AdapterLoadError(
            "Manifest changed during discovery; rediscover before loading.",
            m.manifest,
          );
        }
        const legacyPlugin = c.tier === "plugin" && !discovered;
        const blocked = discovered
          ? !discovered.enabled
          : legacyPlugin && !!m.manifest.target.entrypoints;
        const detail =
          discovered?.detail ??
          (legacyPlugin
            ? "Package-level discovery; adapter does not declare target entrypoints."
            : null);
        if (blocked) {
          this.records.push({
            manifest: m.manifest,
            tier: c.tier,
            adapter: null,
            status: "disabled",
            detail: discovered?.detail ?? "Target extension is not enabled in this session.",
            provenance: discovered?.provenance,
          });
          continue;
        }
        const { adapter, warnings } = await loadAdapterFromDir(c.path, c.tier);
        for (const w of warnings) this.diagnostic("warning", adapter.manifest.id, w);
        loaded.push({ ...adapter, provenance: discovered?.provenance, discoveryDetail: detail });
      } catch (err) {
        const manifest =
          err instanceof AdapterLoadError ? err.manifest : (c.discovered?.manifest ?? null);
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
            provenance: c.discovered?.provenance,
          });
        }
      }
    }
    for (const b of opts.bundled ?? []) loaded.push({ ...b, tier: "bundled" });
    const catalogOnly = this.records;
    this.setAdapters(loaded, opts.installedPackages);
    this.records = [...catalogOnly, ...this.records].sort(
      (a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier),
    );
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
    const records: Record_[] = [];
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
          provenance: a.provenance,
        });
        continue;
      }
      winners.set(id, a);
      let detail: string | null = a.discoveryDetail ?? null;
      const installed = a.provenance
        ? { name: a.manifest.target.extension, version: a.provenance.targetVersion }
        : installedPackages?.find((p) => p.name === a.manifest.target.extension);
      if (installed?.version && !satisfies(installed.version, a.manifest.target.versionRange)) {
        detail = [
          detail,
          `installed ${installed.name}@${installed.version} is outside ${a.manifest.target.versionRange} (tested ${a.manifest.target.testedVersions.join(", ") || "none"}); unmatched dialogs fall back to generic`,
        ]
          .filter(Boolean)
          .join(" ");
        this.diagnostic("warning", id, detail);
      }
      records.push({
        manifest: a.manifest,
        tier: a.tier,
        adapter: a,
        status: "active",
        detail,
        provenance: a.provenance,
      });
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
  info(): AdapterCatalogInfo[] {
    return this.records.map((r) => ({
      id: r.manifest.id,
      version: r.manifest.version,
      tier: r.tier,
      target: { ...r.manifest.target },
      capabilities: [...r.manifest.capabilities],
      webRenderer: r.adapter?.webRendererPath != null,
      status: r.status,
      detail: r.detail,
      runtimeStatus: r.status === "error" ? "unavailable" : r.status,
      runtimeDetail: r.detail,
      provenance: r.provenance ?? {
        scope: "explicit",
        source: null,
        packageDir: null,
        manifestPath: r.adapter?.manifestPath ?? null,
        targetVersion: null,
        entrypoints: [],
        evidence: "explicit",
      },
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
