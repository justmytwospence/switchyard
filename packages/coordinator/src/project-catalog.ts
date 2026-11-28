import { randomBytes } from "node:crypto";
import {
  type CatalogAccountType,
  type CatalogConnectionStatus,
  CatalogRepository,
  DEFAULT_WORKTREE_DIR,
  isListedProject,
  newId,
  type Project,
  SwitchyardError,
} from "@switchyard/protocol";
import type { CoordinatorContext } from "./context.js";
import type { Store } from "./store.js";

export interface RegistrationAccount {
  connectionId: string;
  account: string;
  accountType: CatalogAccountType;
}

export interface RepositoryProvider {
  authority: string;
  beginRegistration(
    input: RegistrationAccount & { returnUrl: string; state: string },
  ): Promise<{ url: string; fields: Record<string, string> }>;
  completeRegistration(
    input: RegistrationAccount & { code: string },
  ): Promise<{ installUrl: string }>;
  listRepositories(
    connectionId: string,
  ): Promise<
    | { state: "ready"; repositories: CatalogRepository[]; manageUrl: string }
    | { state: "pending" | "suspended" | "removed"; manageUrl?: string }
  >;
  resolveRemote(connectionId: string, repoIdentity: string): Promise<string | null>;
  issueCloneGrant(
    connectionId: string,
    repository: CatalogRepository,
  ): Promise<{ token: string; expiresAt: string }>;
  releaseGrant(token: string): Promise<void>;
  disconnect(connectionId: string): Promise<void>;
}

type Connection = CatalogConnectionStatus & { authority: string };
type HistoryConflict = {
  connectionId: string;
  externalId: string;
  fullName: string;
  projectIds: string[];
};
const json = <T>(row: { json: unknown }): T => JSON.parse(String(row.json)) as T;
const sameRemote = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const displayName = (r: CatalogRepository) => `${r.owner}/${r.name}`;

/** Local membership gate shared by HTTP and agent-side task creation. No network access. */
export function requireListedRepository(store: Store, project: Project): Project {
  if (!isListedProject(project)) {
    throw new SwitchyardError(
      "conflict",
      "This repository is not in the connected Git provider catalog",
    );
  }
  const { authority, externalId } = project.catalog!;
  const rows = store.db
    .prepare(`SELECT json_extract(c.json, '$.state') AS state
    FROM catalog_connections c JOIN catalog_memberships m ON m.connection_id=c.id
    WHERE m.authority=? AND m.external_id=?`)
    .all(authority ?? "", externalId ?? "");
  if (rows.length && rows.every((r) => r.state === "suspended")) {
    throw new SwitchyardError("conflict", "The Git provider installation is suspended");
  }
  return project;
}

export class ProjectCatalog {
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly registrations = new Map<
    string,
    RegistrationAccount & { device: string; expires: number }
  >();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly ctx: CoordinatorContext,
    readonly provider?: RepositoryProvider,
  ) {}

  private get store() {
    return this.ctx.store;
  }
  private get db() {
    return this.store.db;
  }

  start() {
    if (!this.provider) return;
    const tick = () => {
      for (const connection of this.connections()) {
        if (connection.state !== "disconnected") void this.refresh(connection.id).catch(() => {});
      }
    };
    this.timer = setInterval(tick, 5 * 60_000);
    this.timer.unref();
    tick();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.registrations.clear();
  }

  private requireProvider() {
    if (!this.provider)
      throw new SwitchyardError("unsupported_capability", "Repository provider is unavailable");
    return this.provider;
  }

  private connection(id: string): Connection {
    const row = this.db.prepare("SELECT json FROM catalog_connections WHERE id = ?").get(id);
    if (!row) throw new SwitchyardError("not_found", "Provider connection not found");
    return json<Connection>(row as { json: unknown });
  }

  private connections(): Connection[] {
    return this.db
      .prepare("SELECT json FROM catalog_connections ORDER BY account, id")
      .all()
      .map((row) => json<Connection>(row as { json: unknown }));
  }

  private putConnection(c: Connection) {
    this.db
      .prepare(`INSERT INTO catalog_connections(id,authority,account,json) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET json = excluded.json`)
      .run(c.id, c.authority, c.account, JSON.stringify(c));
  }

  status() {
    return {
      available: !!this.provider,
      connections: this.connections()
        .filter((c) => c.state !== "disconnected")
        .map(({ authority: _, ...c }) => c),
      conflicts: this.db
        .prepare("SELECT json FROM catalog_conflicts ORDER BY connection_id, external_id")
        .all()
        .map((r) => json<HistoryConflict>(r as { json: unknown })),
    };
  }

  async begin(device: string, account: string, accountType: CatalogAccountType) {
    const provider = this.requireProvider();
    const now = this.store.now().getTime();
    for (const [id, r] of this.registrations) if (r.expires <= now) this.registrations.delete(id);
    if (this.registrations.size >= 64)
      throw new SwitchyardError("rate_limited", "Too many pending Git provider connections");
    const state = randomBytes(32).toString("base64url");
    const input = { connectionId: `cat_${randomBytes(16).toString("hex")}`, account, accountType };
    this.registrations.set(state, { ...input, device, expires: now + 600_000 });
    try {
      return await provider.beginRegistration({
        ...input,
        state,
        returnUrl: new URL("/settings/projects/connect/return", this.ctx.config.publicUrl).href,
      });
    } catch {
      this.registrations.delete(state);
      throw new SwitchyardError("conflict", "Could not start a Git provider connection");
    }
  }

  async complete(device: string, state: string, code: string) {
    const pending = this.registrations.get(state);
    if (!pending || pending.device !== device || pending.expires <= this.store.now().getTime()) {
      throw new SwitchyardError("forbidden", "Git provider connection expired; start again");
    }
    this.registrations.delete(state);
    const { connectionId, account, accountType } = pending;
    const provider = this.requireProvider();
    let installUrl: string;
    try {
      ({ installUrl } = await provider.completeRegistration({
        connectionId,
        account,
        accountType,
        code,
      }));
    } catch {
      throw new SwitchyardError(
        "conflict",
        "Could not verify the Git provider registration; start again",
      );
    }
    if (this.stopped) return;
    this.putConnection({
      id: connectionId,
      authority: provider.authority,
      account,
      accountType,
      state: "pending",
      lastSyncedAt: null,
      lastError: null,
      installUrl,
      manageUrl: null,
    });
  }

  refresh(id: string): Promise<void> {
    const current = this.inflight.get(id);
    if (current) return current;
    const work = this.doRefresh(id).finally(() => this.inflight.delete(id));
    this.inflight.set(id, work);
    return work;
  }

  private async doRefresh(id: string) {
    const c = this.connection(id);
    if (c.state === "disconnected")
      throw new SwitchyardError("conflict", "Git provider is disconnected");
    try {
      const provider = this.requireProvider();
      if (c.authority !== provider.authority) throw new Error("Provider unavailable");
      const result = await provider.listRepositories(id);
      if (this.stopped || this.connection(id).state === "disconnected") return;
      if (result.state === "ready") {
        const repos = CatalogRepository.array().max(100_000).parse(result.repositories);
        const ids = new Set<string>();
        const names = new Set<string>();
        for (const r of repos) {
          const web = new URL(r.webUrl);
          const clone = new URL(r.cloneUrl);
          const name = displayName(r).toLowerCase();
          if (
            r.authority !== c.authority ||
            web.host !== c.authority ||
            clone.host !== c.authority ||
            web.username ||
            web.password ||
            web.search ||
            web.hash ||
            clone.username ||
            clone.password ||
            clone.search ||
            clone.hash ||
            ids.has(r.externalId) ||
            names.has(name)
          )
            throw new Error("Invalid repository inventory");
          ids.add(r.externalId);
          names.add(name);
        }
        this.reconcileComplete(c, repos, result.manageUrl);
      } else if (result.state === "removed") {
        this.reconcileComplete(c, [], result.manageUrl ?? c.manageUrl, "removed");
      } else {
        this.putConnection({
          ...c,
          state: result.state === "pending" && c.lastSyncedAt ? "stale" : result.state,
          manageUrl: result.manageUrl ?? c.manageUrl,
          lastError:
            result.state === "suspended"
              ? "Installation suspended on Git provider"
              : c.lastSyncedAt
                ? "Could not verify the Git provider installation"
                : null,
        });
      }
    } catch (error) {
      if (this.stopped || this.connection(id).state === "disconnected") return;
      const reconnect =
        error instanceof Error && "code" in error && error.code === "provider_reconnect_required";
      this.putConnection({
        ...c,
        state: c.state === "suspended" ? "suspended" : "stale",
        lastError: reconnect
          ? "Reconnect provider. Last known repositories are unchanged."
          : "Could not refresh the Git provider. Last known repositories are unchanged.",
      });
    }
  }

  private reconcileComplete(
    c: Connection,
    repos: CatalogRepository[],
    manageUrl: string | null,
    state: "ready" | "removed" = "ready",
  ) {
    this.store.tx(() => {
      this.putConnection({
        ...c,
        state,
        manageUrl,
        lastError: null,
        lastSyncedAt: this.store.nowIso(),
      });
      const before = this.db
        .prepare("SELECT external_id FROM catalog_memberships WHERE connection_id = ?")
        .all(c.id)
        .map((r) => String(r.external_id));
      this.db
        .prepare("UPDATE catalog_memberships SET missing = missing + 1 WHERE connection_id = ?")
        .run(c.id);
      const put =
        this.db.prepare(`INSERT INTO catalog_memberships(connection_id,authority,external_id,json,missing) VALUES (?,?,?,?,0)
        ON CONFLICT(connection_id,authority,external_id) DO UPDATE SET json=excluded.json,missing=0`);
      for (const r of repos) put.run(c.id, c.authority, r.externalId, JSON.stringify(r));
      this.db
        .prepare("DELETE FROM catalog_memberships WHERE connection_id = ? AND missing >= 2")
        .run(c.id);
      this.db.prepare("DELETE FROM catalog_conflicts WHERE connection_id = ?").run(c.id);
      for (const r of repos) this.bind(c.id, r);
      for (const externalId of before) this.delistIfAbsent(c.authority, externalId);
    });
  }

  private byBinding(authority: string, externalId: string) {
    const row = this.db
      .prepare("SELECT project_id FROM catalog_bindings WHERE authority = ? AND external_id = ?")
      .get(authority, externalId);
    return row ? this.store.projects.require(String(row.project_id)) : undefined;
  }

  private bind(connectionId: string, r: CatalogRepository, chosen?: string) {
    let project = this.byBinding(r.authority, r.externalId);
    if (!project) {
      const candidates = this.store.projects
        .list("lower(repo_identity) = lower(?)", [r.webUrl])
        .filter((p) => !p.catalog || p.catalog.state === "legacy");
      if (chosen) {
        project = candidates.find((p) => p.id === chosen);
        if (!project)
          throw new SwitchyardError("conflict", "That Project does not match this repository");
      } else if (candidates.length > 1) {
        const conflict = {
          connectionId,
          externalId: r.externalId,
          fullName: displayName(r),
          projectIds: candidates.map((p) => p.id).sort(),
        };
        this.db
          .prepare("INSERT OR REPLACE INTO catalog_conflicts VALUES (?,?,?)")
          .run(connectionId, r.externalId, JSON.stringify(conflict));
        return;
      } else project = candidates[0];
      const now = this.store.nowIso();
      project ??= {
        id: newId("prj"),
        name: displayName(r),
        repoIdentity: r.webUrl,
        defaultProfileId: null,
        defaultHostId: null,
        maxConcurrentRuns: 1,
        automationEnabled: true,
        setupCommand: null,
        checks: [],
        workspaceSharing: "single_writer",
        worktreeDir: DEFAULT_WORKTREE_DIR,
        ensureSessions: false,
        removeLanded: false,
        createdAt: now,
        updatedAt: now,
      };
    }
    const name = project.name === project.catalog?.fullName ? displayName(r) : project.name;
    const next: Project = {
      ...project,
      name,
      repoIdentity: r.webUrl,
      catalog: {
        state: "listed",
        authority: r.authority,
        externalId: r.externalId,
        fullName: displayName(r),
      },
    };
    if (JSON.stringify(next) !== JSON.stringify(project))
      this.store.putProject({ ...next, updatedAt: this.store.nowIso() });
    this.db
      .prepare("INSERT OR IGNORE INTO catalog_bindings VALUES (?,?,?)")
      .run(r.authority, r.externalId, project.id);
    this.db
      .prepare(
        "DELETE FROM catalog_conflicts WHERE external_id=? AND connection_id IN (SELECT id FROM catalog_connections WHERE authority=?)",
      )
      .run(r.externalId, r.authority);
  }

  private delistIfAbsent(authority: string, id: string) {
    if (
      this.db
        .prepare("SELECT 1 FROM catalog_memberships WHERE authority=? AND external_id=? LIMIT 1")
        .get(authority, id)
    )
      return;
    const p = this.byBinding(authority, id);
    if (p?.catalog?.state === "listed")
      this.store.putProject({
        ...p,
        catalog: { ...p.catalog, state: "delisted" },
        updatedAt: this.store.nowIso(),
      });
  }

  resolveHistory(id: string, externalId: string, projectId: string) {
    this.store.tx(() => {
      const conflict = this.db
        .prepare("SELECT 1 FROM catalog_conflicts WHERE connection_id=? AND external_id=?")
        .get(id, externalId);
      const row = this.db
        .prepare(
          "SELECT json FROM catalog_memberships WHERE connection_id=? AND external_id=? AND missing=0",
        )
        .get(id, externalId);
      if (!conflict || !row)
        throw new SwitchyardError("conflict", "Refresh before choosing existing history");
      this.bind(id, json<CatalogRepository>(row as { json: unknown }), projectId);
    });
  }

  async disconnect(id: string) {
    const c = this.connection(id);
    this.store.tx(() => {
      this.putConnection({ ...c, state: "disconnected", installUrl: null, manageUrl: null });
      const ids = this.db
        .prepare("SELECT external_id FROM catalog_memberships WHERE connection_id=?")
        .all(id);
      this.db.prepare("DELETE FROM catalog_memberships WHERE connection_id=?").run(id);
      this.db.prepare("DELETE FROM catalog_conflicts WHERE connection_id=?").run(id);
      for (const row of ids) this.delistIfAbsent(c.authority, String(row.external_id));
    });
    await this.provider?.disconnect(id).catch(() => {});
  }

  requireListedProject(id: string) {
    return requireListedRepository(this.store, this.store.projects.require(id));
  }

  repository(project: Project, requireCurrent = false) {
    const rows = this.db
      .prepare(`SELECT m.connection_id, m.json, m.missing, c.json AS connection FROM catalog_memberships m
      JOIN catalog_connections c ON c.id=m.connection_id WHERE m.authority=? AND m.external_id=?
      ORDER BY lower(json_extract(m.json,'$.webUrl')) <> lower(?), m.missing,
        json_extract(c.json,'$.state') <> 'ready', m.connection_id`)
      .all(
        project.catalog?.authority ?? "",
        project.catalog?.externalId ?? "",
        project.repoIdentity,
      );
    const row = rows.find((r) => {
      const { state } = json<Connection>({ json: r.connection });
      return (
        state !== "suspended" &&
        state !== "disconnected" &&
        (!requireCurrent || (r.missing === 0 && state !== "removed"))
      );
    });
    if (!row)
      throw new SwitchyardError(
        "conflict",
        "Repository access cannot be verified; refresh the Git provider",
      );
    return {
      connectionId: String(row.connection_id),
      repo: json<CatalogRepository>(row as { json: unknown }),
    };
  }

  async matchesRemote(project: Project, remote: string) {
    const { connectionId, repo } = this.repository(project);
    if (sameRemote(repo.webUrl, remote) && sameRemote(project.repoIdentity, remote)) return true;
    return (
      (await this.provider?.resolveRemote(connectionId, remote).catch(() => null)) ===
      repo.externalId
    );
  }

  async grant(project: Project) {
    const { connectionId, repo } = this.repository(project, true);
    if (!repo.defaultBranch)
      throw new SwitchyardError("conflict", "No default branch to start work on");
    try {
      return await this.requireProvider().issueCloneGrant(connectionId, repo);
    } catch {
      throw new SwitchyardError(
        "conflict",
        "Could not authorize this checkout; refresh the Git provider",
      );
    }
  }
}
