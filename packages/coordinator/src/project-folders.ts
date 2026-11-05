import {
  type Checkout,
  DEFAULT_WORKTREE_DIR,
  newId,
  type Project,
  ProjectFolderScan,
  type ProjectScan,
  type ProjectScanResult,
  SwitchyardError,
} from "@switchyard/protocol";
import type { CoordinatorContext } from "./context.js";
import { requireConnected } from "./sessions/service.js";
import { refreshCheckoutWorkspaces } from "./workspaces.js";

/**
 * Project folders: every git repository directly inside a host's folders becomes a project, or
 * another checkout of the project with the same repository identity. Scans run when the folders
 * change, when the host connects, on an interval and on demand. Nothing is removed.
 */

export const PROJECT_SCAN_INTERVAL_MS = 10 * 60_000;
export const PROJECT_SCAN_MIN_AGE_ON_CONNECT_MS = 60_000;
export const PROJECT_SCAN_TIMEOUT_MS = 120_000;

/** Trim, drop trailing slashes (keeping `/` and `~`), drop empties, dedupe in order. */
export function normalizeProjectFolders(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    let f = raw.trim();
    while (f.length > 1 && f.endsWith("/")) f = f.slice(0, -1);
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

/** `base`, else `base (host)`, else `base (host) 2`, ... (case-insensitive). */
export function uniqueProjectName(existing: string[], base: string, hostName: string): string {
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  const withHost = `${base} (${hostName})`;
  if (!taken.has(withHost.toLowerCase())) return withHost;
  for (let i = 2; ; i++) {
    const candidate = `${withHost} ${i}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** A new project with the defaults `POST /api/projects` uses. */
export function newProject(input: {
  name: string;
  repoIdentity: string;
  hostId: string;
  now: string;
  defaultProfileId?: string | null;
  setupCommand?: string | null;
  checks?: string[];
  maxConcurrentRuns?: number;
  worktreeDir?: string;
}): Project {
  return {
    id: newId("prj"),
    name: input.name,
    repoIdentity: input.repoIdentity,
    defaultProfileId: input.defaultProfileId ?? null,
    defaultHostId: input.hostId,
    maxConcurrentRuns: input.maxConcurrentRuns ?? 1,
    automationEnabled: true,
    setupCommand: input.setupCommand ?? null,
    checks: input.checks ?? [],
    workspaceSharing: "single_writer",
    worktreeDir: input.worktreeDir ?? DEFAULT_WORKTREE_DIR,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function setScan(ctx: CoordinatorContext, hostId: string, scan: ProjectScan): void {
  ctx.store.tx(() => {
    const h = ctx.store.hosts.require(hostId);
    ctx.store.putHost({ ...h, projectScan: scan });
  });
}

function isTooOld(err: unknown): boolean {
  return (
    err instanceof SwitchyardError &&
    err.code === "invalid_request" &&
    err.message.startsWith("Invalid command")
  );
}

/** Scan every project folder of a connected host and add what is new. */
export async function scanHostProjectFolders(
  ctx: CoordinatorContext,
  hostId: string,
): Promise<ProjectScanResult> {
  const host = ctx.store.hosts.require(hostId);
  const folders = host.projectFolders ?? [];
  if (folders.length === 0) {
    throw new SwitchyardError(
      "invalid_request",
      `${host.name} has no project folders. Add one first.`,
    );
  }
  requireConnected(ctx, hostId);
  const scan: ProjectScan = {
    state: "running",
    startedAt: ctx.store.nowIso(),
    finishedAt: null,
    repositories: 0,
    projectsCreated: 0,
    checkoutsAdded: 0,
    errors: [],
  };
  const added: ProjectScanResult["added"] = [];
  setScan(ctx, hostId, scan);
  try {
    const newCheckouts: Checkout[] = [];
    for (const folder of folders) {
      let result: ProjectFolderScan;
      try {
        const raw = await ctx.hostHub.request(
          hostId,
          { type: "projects.scan", folder },
          { timeoutMs: PROJECT_SCAN_TIMEOUT_MS },
        );
        result = ProjectFolderScan.parse(raw);
      } catch (err) {
        if (isTooOld(err)) {
          throw new SwitchyardError(
            "unsupported_capability",
            `${host.name} runs Switchyard ${host.agentVersion}, which cannot scan project folders. Update its host agent.`,
          );
        }
        if (err instanceof SwitchyardError && err.code === "host_unreachable") throw err;
        scan.errors.push(`${folder}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      scan.repositories += result.repositories.length;
      for (const repo of result.repositories) {
        const r = ctx.store.tx(() => {
          const known = ctx.store.checkouts.list("host_id = ? AND path = ?", [
            hostId,
            repo.root,
          ])[0];
          if (known) return null;
          const now = ctx.store.nowIso();
          let project = ctx.store.projects.list("repo_identity = ?", [repo.repoIdentity])[0];
          let created = false;
          if (!project) {
            const names = ctx.store.projects.list().map((p) => p.name);
            project = ctx.store.putProject(
              newProject({
                name: uniqueProjectName(names, repo.name, host.name),
                repoIdentity: repo.repoIdentity,
                hostId,
                now,
              }),
            );
            created = true;
          }
          const checkout = ctx.store.putCheckout({
            id: newId("chk"),
            projectId: project.id,
            hostId,
            path: repo.root,
            commonDir: repo.commonDir,
            defaultBranch: repo.defaultBranch,
            createdAt: now,
          });
          return { project, checkout, created };
        });
        if (!r) continue;
        scan.checkoutsAdded++;
        if (r.created) scan.projectsCreated++;
        newCheckouts.push(r.checkout);
        added.push({
          projectId: r.project.id,
          name: r.project.name,
          path: repo.root,
          newProject: r.created,
        });
      }
    }
    for (const checkout of newCheckouts) {
      try {
        await refreshCheckoutWorkspaces(ctx, checkout);
      } catch (err) {
        ctx.log.warn({ err, checkoutId: checkout.id }, "workspace discovery failed");
      }
    }
    const done: ProjectScan = { ...scan, state: "done", finishedAt: ctx.store.nowIso() };
    setScan(ctx, hostId, done);
    return { ...done, added };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setScan(ctx, hostId, {
      ...scan,
      state: "failed",
      finishedAt: ctx.store.nowIso(),
      errors: [...scan.errors, message],
    });
    throw err;
  }
}

/** Runs scans: one at a time per host, on connect, on an interval and on request. */
export class ProjectFolderService {
  private readonly inflight = new Map<string, Promise<ProjectScanResult>>();
  private timer: NodeJS.Timeout | null = null;
  private readonly onConnected = ({ hostId }: { hostId: string }) => {
    const host = this.ctx.store.hosts.get(hostId);
    if (!host || host.revokedAt || !(host.projectFolders ?? []).length) return;
    const last = host.projectScan?.startedAt ? Date.parse(host.projectScan.startedAt) : null;
    const now = Date.parse(this.ctx.store.nowIso());
    if (last !== null && now - last < PROJECT_SCAN_MIN_AGE_ON_CONNECT_MS) return;
    this.background(hostId);
  };

  constructor(
    private readonly ctx: CoordinatorContext,
    private readonly opts: { intervalMs: number },
  ) {}

  /** Scan a host now; joins a scan already running for it. */
  scan(hostId: string): Promise<ProjectScanResult> {
    const running = this.inflight.get(hostId);
    if (running) return running;
    const p = scanHostProjectFolders(this.ctx, hostId).finally(() => this.inflight.delete(hostId));
    this.inflight.set(hostId, p);
    return p;
  }

  /** Scan without waiting; failures are logged (and recorded on the host). */
  background(hostId: string): void {
    this.scan(hostId).catch((err) =>
      this.ctx.log.warn({ err, hostId }, "project folder scan failed"),
    );
  }

  start(): void {
    this.ctx.hub.on("host.connected", this.onConnected);
    if (this.opts.intervalMs > 0) {
      this.timer = setInterval(() => this.tick(), this.opts.intervalMs);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ctx.hub.off("host.connected", this.onConnected);
  }

  private tick(): void {
    for (const h of this.ctx.store.hosts.list()) {
      if (h.revokedAt || !(h.projectFolders ?? []).length) continue;
      if (!this.ctx.hostHub.isConnected(h.id)) continue;
      this.background(h.id);
    }
  }
}
