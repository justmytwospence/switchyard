import { open } from "node:fs/promises";
import {
  type AdapterDiagnostic,
  AdapterRegistry,
  defaultOwnerAdapterDir,
  discoverPiPackages,
  type LoadedAdapter,
  type PiPackageDiscovery,
} from "@switchyard/adapter-sdk";
import type { AdapterInfo } from "@switchyard/protocol";

export interface AdapterCatalogOptions {
  /** Environment used to find Pi's agent dir (`PI_CODING_AGENT_DIR`). */
  env?: NodeJS.ProcessEnv;
  /** Owner adapters (default `~/.config/switchyard/adapters`). */
  ownerDir?: string;
  /** Bundled adapters (default none: adapters ship with the Pi packages that own them). */
  bundled?: LoadedAdapter[];
  hookTimeoutMs?: number;
  /** Load-time diagnostics, each reported once. */
  onDiagnostic?: (d: AdapterDiagnostic) => void;
}

/**
 * Finds adapters for the host: owner, plugin (Pi packages declaring `switchyard.adapter`) and
 * bundled tiers once at startup, plus the project tier (`<workspace>/.switchyard/adapters`) per
 * session cwd. Each session gets a freshly loaded registry so project adapters added later are
 * picked up on the next start.
 */
export class AdapterCatalog {
  private readonly opts: AdapterCatalogOptions;
  private discovery: PiPackageDiscovery | null = null;
  private readonly reported = new Set<string>();
  private readonly known = new Map<string, AdapterInfo>();
  private readonly workspaceRenderers = new Map<string | null, Map<string, string | null>>();

  constructor(opts: AdapterCatalogOptions = {}) {
    this.opts = opts;
  }

  async init(): Promise<void> {
    this.discovery = await discoverPiPackages({ env: this.opts.env });
    for (const d of this.discovery.diagnostics) this.report(d);
    await this.forWorkspace(null);
  }

  /** A registry for one session: project tier from `projectRoot` (null for none). */
  async forWorkspace(projectRoot: string | null): Promise<AdapterRegistry> {
    const registry = new AdapterRegistry({
      hookTimeoutMs: this.opts.hookTimeoutMs,
      onDiagnostic: (d) => this.report(d),
    });
    await registry.load({
      projectRoot,
      ownerDir: this.opts.ownerDir ?? defaultOwnerAdapterDir(),
      pluginPackageDirs: this.discovery?.pluginPackageDirs ?? [],
      installedPackages: this.discovery?.packages ?? [],
      bundled: this.opts.bundled ?? [],
    });
    for (const info of registry.info()) this.known.set(`${info.tier}\u0000${info.id}`, info);
    const snapshot = new Map<string, string | null>();
    for (const adapter of registry.adapters()) {
      const id = adapter.manifest.id;
      let html: string | null = null;
      if (adapter.webRendererPath) {
        try {
          const file = await open(adapter.webRendererPath, "r");
          try {
            // Read no more than the per-file cap plus one byte, even for special files.
            const bytes = Buffer.alloc(256 * 1024 + 1);
            let count = 0;
            while (count < bytes.length) {
              const { bytesRead } = await file.read(bytes, count, bytes.length - count, null);
              if (!bytesRead) break;
              count += bytesRead;
            }
            if (count > 256 * 1024) throw new Error("exceeds 256 KiB");
            html = bytes.toString("utf8", 0, count);
            if (Buffer.byteLength(html, "utf8") > 256 * 1024)
              throw new Error("decoded HTML exceeds 256 KiB");
          } finally {
            await file.close();
          }
        } catch (err) {
          this.report({
            sessionId: null,
            adapterId: id,
            level: "warning",
            message: `Cannot publish web renderer ${adapter.webRendererPath}: ${(err as Error).message}; portable panels are used`,
          });
        }
      }
      snapshot.set(id, html);
    }
    this.workspaceRenderers.set(projectRoot, snapshot);
    return registry;
  }

  /** Host-wide assets: disagreeing or unavailable workspace renderers fail closed. */
  renderers(): Record<string, string> {
    const candidates = new Map<string, string | null>();
    const ambiguous = new Set<string>();
    for (const snapshot of this.workspaceRenderers.values()) {
      for (const [id, html] of snapshot) {
        if (candidates.has(id) && candidates.get(id) !== html) ambiguous.add(id);
        else candidates.set(id, html);
      }
    }
    const out: Record<string, string> = {};
    let total = 0;
    for (const id of [...candidates.keys()].sort()) {
      const html = candidates.get(id);
      if (ambiguous.has(id)) {
        this.report({
          sessionId: null,
          adapterId: id,
          level: "warning",
          message: "Ambiguous web renderer across workspaces; portable panels are used",
        });
        continue;
      }
      if (html === null || html === undefined) continue;
      const size = Buffer.byteLength(html, "utf8");
      if (total + size > 8 * 1024 * 1024) {
        this.report({
          sessionId: null,
          adapterId: id,
          level: "warning",
          message: "Combined web renderers exceed 8 MiB; portable panels are used",
        });
        continue;
      }
      out[id] = html;
      total += size;
    }
    return out;
  }

  /** Every adapter seen on this host (all tiers, including project adapters of loaded sessions). */
  info(): AdapterInfo[] {
    const order = ["project", "owner", "plugin", "bundled"];
    const renderers = this.renderers();
    return [...this.known.values()]
      .map((info) => ({
        ...info,
        webRenderer: info.webRenderer && Object.hasOwn(renderers, info.id),
      }))
      .sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier) || a.id.localeCompare(b.id));
  }

  private report(d: AdapterDiagnostic): void {
    const key = `${d.adapterId}\u0000${d.level}\u0000${d.message}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.opts.onDiagnostic?.(d);
  }
}
