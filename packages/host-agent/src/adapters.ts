import { open } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import {
  type AdapterDiagnostic,
  AdapterRegistry,
  defaultOwnerAdapterDir,
  discoverPiPackages,
  type LoadedAdapter,
} from "@switchyard/adapter-sdk";
import type { PiResourceInventory } from "@switchyard/pi-runtime";
import type { AdapterInfo, SessionAdapterInfo } from "@switchyard/protocol";

export type { SessionAdapterInfo } from "@switchyard/protocol";

export interface AdapterCatalogOptions {
  /** Environment used to find Pi's agent dir (`PI_CODING_AGENT_DIR`). */
  env?: NodeJS.ProcessEnv;
  /** Owner adapters (default `~/.config/switchyard/adapters`). */
  ownerDir?: string;
  /** Bundled adapters (default none: adapters ship with the Pi packages that own them). */
  bundled?: LoadedAdapter[];
  hookTimeoutMs?: number;
  /** Published load-time diagnostics. Candidate diagnostics are held until commit. */
  onDiagnostic?: (d: AdapterDiagnostic) => void;
}

export interface SessionAdapterInput {
  sessionId: string;
  cwd: string;
  resources: PiResourceInventory;
  reportedExtensionPaths: string[];
  projectTrusted: boolean | null;
  extensionsDisabled: boolean;
}

export interface PreparedSessionAdapters {
  registry: AdapterRegistry;
  /** Publish this candidate after the caller has installed its restored adapter context. */
  commit(): void;
  /** Discard an uncommitted candidate. After commit, ownership belongs to the caller. */
  dispose(): void;
}

interface Snapshot {
  registry: AdapterRegistry;
  info: SessionAdapterInfo[];
  renderers: Map<string, string | null>;
  diagnostics: AdapterDiagnostic[];
  rendererDiagnostics: AdapterDiagnostic[];
}
interface Preparation {
  registry: AdapterRegistry;
  disposed: boolean;
}

const MAX_ADAPTERS = 256;
const MAX_DIAGNOSTICS = 100;
const FILE_CAP = 256 * 1024;
const TOTAL_CAP = 8 * 1024 * 1024;
const ORDER = ["project", "owner", "plugin", "bundled"];

/** Strip terminal escapes/control characters and bound inspection text, never plugin state. */
function clean(value: string, limit = 4000): string {
  return stripVTControlCharacters(value)
    .replace(/\p{Cc}/gu, " ")
    .slice(0, limit);
}
function cleanInfo(info: SessionAdapterInfo): SessionAdapterInfo {
  const path = (value: string | null) => (value === null ? null : clean(value, 4096));
  return {
    ...info,
    id: clean(info.id),
    version: clean(info.version),
    target: {
      extension: clean(info.target.extension),
      versionRange: clean(info.target.versionRange),
      testedVersions: info.target.testedVersions.map((v) => clean(v)),
    },
    capabilities: info.capabilities.map((v) => clean(v)),
    detail: info.detail === null ? null : clean(info.detail),
    runtimeDetail: info.runtimeDetail === null ? null : clean(info.runtimeDetail),
    provenance: {
      ...info.provenance,
      source: path(info.provenance.source),
      packageDir: path(info.provenance.packageDir),
      manifestPath: path(info.provenance.manifestPath),
      targetVersion: path(info.provenance.targetVersion),
      entrypoints: info.provenance.entrypoints.slice(0, 128).map((p) => clean(p, 4096)),
    },
  };
}

/**
 * Effective discovery is session-scoped. Preparing a registry never changes the published
 * catalog: the supervisor owns the restore/swap boundary and explicitly commits afterwards.
 */
export class AdapterCatalog {
  private readonly sessions = new Map<string, Snapshot>();
  private readonly preparations = new Map<string, Set<Preparation>>();
  private initial: Snapshot | null = null;
  private publishedRenderers: Record<string, string> = {};

  constructor(private readonly opts: AdapterCatalogOptions = {}) {}

  /** Owner/bundled inspection only. No Pi package or project code is imported at startup. */
  async init(): Promise<void> {
    const registry = this.registry();
    await registry.load({
      projectRoot: null,
      ownerDir: this.opts.ownerDir ?? defaultOwnerAdapterDir(),
      pluginCandidates: [],
      bundled: this.opts.bundled ?? [],
    });
    this.initial = await this.snapshot(registry, null, []);
    this.refreshRenderers();
    this.publishDiagnostics(null, this.initial);
  }

  async prepareSession(input: SessionAdapterInput): Promise<PreparedSessionAdapters> {
    const registry = this.registry();
    const preparation: Preparation = { registry, disposed: false };
    const pending = this.preparations.get(input.sessionId) ?? new Set<Preparation>();
    pending.add(preparation);
    this.preparations.set(input.sessionId, pending);
    const forget = () => {
      pending.delete(preparation);
      if (!pending.size && this.preparations.get(input.sessionId) === pending)
        this.preparations.delete(input.sessionId);
    };
    try {
      const discovery = await discoverPiPackages({
        env: this.opts.env,
        inventory: input.resources,
        reportedExtensionPaths: input.reportedExtensionPaths,
        projectTrusted: input.projectTrusted,
        extensionsDisabled: input.extensionsDisabled,
      });
      // Unavailable inventory must never authorize explicit project adapters either.
      await registry.load({
        projectRoot: input.cwd,
        projectTrusted: input.projectTrusted === true && input.resources.status === "available",
        extensionsDisabled: input.extensionsDisabled,
        ownerDir: this.opts.ownerDir ?? defaultOwnerAdapterDir(),
        pluginCandidates: discovery.candidates,
        installedPackages: discovery.packages,
        bundled: this.opts.bundled ?? [],
      });
      const snapshot = await this.snapshot(registry, input.sessionId, discovery.diagnostics);
      let committed = false;
      return {
        registry,
        commit: () => {
          if (committed) return;
          if (preparation.disposed) throw new Error("Adapter candidate has been disposed");
          committed = true;
          forget();
          this.sessions.set(input.sessionId, snapshot);
          this.refreshRenderers();
          this.publishDiagnostics(input.sessionId, snapshot);
        },
        dispose: () => {
          if (committed || preparation.disposed) return;
          preparation.disposed = true;
          forget();
          registry.closeSession(input.sessionId);
        },
      };
    } catch (err) {
      forget();
      registry.closeSession(input.sessionId);
      throw err;
    }
  }

  /** Convenience for tests/callers without a restore transaction. Production uses prepareSession. */
  async forSession(input: SessionAdapterInput): Promise<AdapterRegistry> {
    const prepared = await this.prepareSession(input);
    try {
      prepared.commit();
      return prepared.registry;
    } catch (err) {
      prepared.dispose();
      throw err;
    }
  }

  /**
   * Legacy test API. A cwd alone is not proof of trust: expose owner/bundled adapters only.
   * Call forSession with explicit live trust/resource evidence to authorize project/plugins.
   */
  async forWorkspace(projectRoot: string | null): Promise<AdapterRegistry> {
    return this.forSession({
      sessionId: `legacy-workspace:${projectRoot ?? ""}`,
      cwd: projectRoot ?? ".",
      resources: { status: "available", extensions: [], diagnostics: [] },
      reportedExtensionPaths: [],
      projectTrusted: false,
      extensionsDisabled: false,
    });
  }

  sessionInfo(sessionId: string): SessionAdapterInfo[] {
    const snapshot = this.sessions.get(sessionId);
    return snapshot
      ? snapshot.info.slice(0, MAX_ADAPTERS).map((info) => this.visibleInfo(info))
      : [];
  }

  sessionDiagnostics(sessionId: string): AdapterDiagnostic[] {
    const snapshot = this.sessions.get(sessionId);
    if (!snapshot) return [];
    const diagnostics = [...snapshot.diagnostics, ...snapshot.rendererDiagnostics];
    if (diagnostics.length > MAX_DIAGNOSTICS) {
      return [
        ...diagnostics.slice(0, MAX_DIAGNOSTICS - 1).map((d) => ({ ...d })),
        this.diagnostic(
          sessionId,
          null,
          "Adapter inspection diagnostics truncated to 100 records.",
        ),
      ];
    }
    return diagnostics.map((d) => ({ ...d }));
  }

  releaseSession(sessionId: string): void {
    for (const preparation of this.preparations.get(sessionId) ?? []) {
      preparation.disposed = true;
      preparation.registry.closeSession(sessionId);
    }
    this.preparations.delete(sessionId);
    this.sessions.get(sessionId)?.registry.closeSession(sessionId);
    this.sessions.delete(sessionId);
    this.refreshRenderers();
  }

  /** Host-wide assets: disagreements or unavailable session renderers fail portable. */
  renderers(): Record<string, string> {
    return { ...this.publishedRenderers };
  }

  /** Current committed adapters, not a history of adapters ever seen on this host. */
  info(): AdapterInfo[] {
    const known = new Map<string, AdapterInfo>();
    for (const snapshot of this.snapshots().values()) {
      for (const info of snapshot.info) {
        const {
          runtimeStatus: _status,
          runtimeDetail: _detail,
          provenance: _provenance,
          ...base
        } = this.visibleInfo(info);
        known.set(`${info.tier}\u0000${info.id}`, base);
      }
    }
    return [...known.values()].sort(
      (a, b) => ORDER.indexOf(a.tier) - ORDER.indexOf(b.tier) || a.id.localeCompare(b.id),
    );
  }

  private registry(): AdapterRegistry {
    // No external diagnostic sink here: failed/discarded candidates must remain unpublished.
    return new AdapterRegistry({ hookTimeoutMs: this.opts.hookTimeoutMs });
  }

  private async snapshot(
    registry: AdapterRegistry,
    sessionId: string | null,
    discoveryDiagnostics: AdapterDiagnostic[],
  ): Promise<Snapshot> {
    const snapshot: Snapshot = {
      registry,
      info: registry.info().map(cleanInfo),
      renderers: new Map(),
      diagnostics: [...discoveryDiagnostics, ...registry.diagnostics()].map((d) => ({
        sessionId,
        adapterId: d.adapterId === null ? null : clean(d.adapterId),
        level: d.level,
        message: clean(d.message),
      })),
      rendererDiagnostics: [],
    };
    if (snapshot.info.length > MAX_ADAPTERS)
      snapshot.diagnostics.push(
        this.diagnostic(sessionId, null, "Adapter inspection truncated to 256 records."),
      );
    if (registry.info().some((info) => info.provenance.entrypoints.length > 128))
      snapshot.diagnostics.push(
        this.diagnostic(sessionId, null, "Adapter inspection entrypoints truncated to 128 paths."),
      );
    for (const adapter of registry.adapters()) {
      const id = adapter.manifest.id;
      let html: string | null = null;
      if (adapter.webRendererPath) {
        try {
          const file = await open(adapter.webRendererPath, "r");
          try {
            // Cap reads even for special files and check decoded UTF-8 size as well.
            const bytes = Buffer.alloc(FILE_CAP + 1);
            let count = 0;
            while (count < bytes.length) {
              const { bytesRead } = await file.read(bytes, count, bytes.length - count, null);
              if (!bytesRead) break;
              count += bytesRead;
            }
            if (count > FILE_CAP) throw new Error("exceeds 256 KiB");
            html = bytes.toString("utf8", 0, count);
            if (Buffer.byteLength(html, "utf8") > FILE_CAP)
              throw new Error("decoded HTML exceeds 256 KiB");
          } finally {
            await file.close();
          }
        } catch (err) {
          html = null;
          snapshot.diagnostics.push(
            this.diagnostic(
              sessionId,
              id,
              `Cannot publish web renderer ${adapter.webRendererPath}: ${(err as Error).message}; portable panels are used`,
            ),
          );
        }
      }
      snapshot.renderers.set(id, html);
    }
    return snapshot;
  }

  private snapshots(): Map<string | null, Snapshot> {
    // The startup inspection is not another live session and must not pin stale owner assets.
    return this.sessions.size
      ? new Map(this.sessions)
      : new Map(this.initial ? [[null, this.initial]] : []);
  }

  private refreshRenderers(): void {
    const snapshots = this.snapshots();
    const candidates = new Map<string, string | null>();
    const ambiguous = new Set<string>();
    for (const snapshot of snapshots.values()) {
      snapshot.rendererDiagnostics = [];
      for (const [id, html] of snapshot.renderers) {
        if (candidates.has(id) && candidates.get(id) !== html) ambiguous.add(id);
        else candidates.set(id, html);
      }
    }
    const out: Record<string, string> = {};
    let total = 0;
    for (const id of [...candidates.keys()].sort()) {
      const html = candidates.get(id);
      let message: string | null = null;
      if (ambiguous.has(id))
        message = "Ambiguous web renderer across sessions; portable panels are used";
      else if (html !== null && html !== undefined) {
        const size = Buffer.byteLength(html, "utf8");
        if (total + size > TOTAL_CAP)
          message = "Combined web renderers exceed 8 MiB; portable panels are used";
        else {
          Object.defineProperty(out, id, {
            value: html,
            enumerable: true,
            configurable: true,
            writable: true,
          });
          total += size;
        }
      }
      if (message) {
        for (const [sessionId, snapshot] of snapshots) {
          if (snapshot.renderers.has(id))
            snapshot.rendererDiagnostics.push(this.diagnostic(sessionId, id, message));
        }
      }
    }
    this.publishedRenderers = out;
  }

  private visibleInfo(info: SessionAdapterInfo): SessionAdapterInfo {
    return {
      ...cleanInfo(info),
      webRenderer: info.webRenderer && Object.hasOwn(this.publishedRenderers, info.id),
    };
  }

  private diagnostic(
    sessionId: string | null,
    adapterId: string | null,
    message: string,
  ): AdapterDiagnostic {
    return {
      sessionId,
      adapterId: adapterId === null ? null : clean(adapterId),
      level: "warning",
      message: clean(message),
    };
  }

  private publishDiagnostics(sessionId: string | null, snapshot: Snapshot): void {
    const diagnostics =
      sessionId === null
        ? [...snapshot.diagnostics, ...snapshot.rendererDiagnostics].slice(0, MAX_DIAGNOSTICS)
        : this.sessionDiagnostics(sessionId);
    for (const d of diagnostics) {
      try {
        this.opts.onDiagnostic?.({ ...d });
      } catch {
        // Diagnostic sinks cannot roll back a committed registry.
      }
    }
  }
}
