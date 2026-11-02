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
    return registry;
  }

  /** Every adapter seen on this host (all tiers, including project adapters of loaded sessions). */
  info(): AdapterInfo[] {
    const order = ["project", "owner", "plugin", "bundled"];
    return [...this.known.values()].sort(
      (a, b) => order.indexOf(a.tier) - order.indexOf(b.tier) || a.id.localeCompare(b.id),
    );
  }

  private report(d: AdapterDiagnostic): void {
    const key = `${d.adapterId}\u0000${d.level}\u0000${d.message}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.opts.onDiagnostic?.(d);
  }
}
