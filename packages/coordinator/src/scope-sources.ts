import {
  type GitHubScope,
  type GitHubSource,
  IssueDescriptionResult,
  IssueSetStatusResult,
  IssueSyncResult,
  issueLinkProblem,
  issueUnlinkProblem,
  type OpenIssueRequest,
  type Project,
  type Scope,
  SwitchyardError,
  type SyncedIssue,
  sourceBacklog,
  sourceFollow,
  sourceMakesWorktrees,
  type Task,
  type TrackedIssue,
  trackedIssueId,
} from "@switchyard/protocol";
import type { CoordinatorContext } from "./context.js";
import {
  issueWorkBranch,
  pendingIssueSession,
  projectMatchesIssue,
  remoteIssueBranches,
  trackedIssueLinks,
} from "./issue-work.js";
import { requireService } from "./services.js";
import { createWorkspace } from "./sessions/service.js";
import { refreshCheckoutWorkspaces } from "./workspaces.js";

const GITHUB = "https://github.com/";
const SYNC_TIMEOUT_MS = 90_000;

export { issueBranch } from "./issue-work.js";

function sourceConfig({
  lastError: _error,
  lastSyncedAt: _at,
  login: _login,
  ...config
}: GitHubSource) {
  return JSON.stringify(config);
}

/** The project whose checkout is this GitHub repository. */
export function projectForRepository(projects: Project[], repository: string): Project | undefined {
  const want = `${GITHUB}${repository}`.toLowerCase();
  return projects.find((p) => p.repoIdentity.toLowerCase() === want);
}

/**
 * Whether a project belongs to a source's owner (and repository list, when it has one), or is
 * one of its extra repositories.
 */
export function inScope(
  source: Pick<GitHubSource, "owner" | "repositories" | "extraRepositories">,
  project: Project,
): boolean {
  const identity = project.repoIdentity;
  return (
    identity.toLowerCase().startsWith(GITHUB) &&
    repositoryInScope(source, identity.slice(GITHUB.length))
  );
}

/** The projects a source covers, in the order given. */
export function projectIdsFor(
  source: Pick<GitHubSource, "owner" | "repositories" | "extraRepositories">,
  projects: Project[],
): string[] {
  return projects.filter((p) => inScope(source, p)).map((p) => p.id);
}

/** Whether a GitHub repository (`owner/name`) is one the source covers. */
export function repositoryInScope(
  source: Pick<GitHubSource, "owner" | "repositories" | "extraRepositories">,
  repository: string,
): boolean {
  const repo = repository.toLowerCase();
  if ((source.extraRepositories ?? []).some((r) => repo === r.toLowerCase())) return true;
  if (!repo.startsWith(`${source.owner.toLowerCase()}/`)) return false;
  if (!source.repositories) return true;
  return source.repositories.some((r) => repo === r.toLowerCase());
}

/** One result from several host syncs: items once each (by `itemId`), at most 200. */
export function mergeSyncResults(parts: IssueSyncResult[]): IssueSyncResult {
  const seen = new Set<string>();
  const items: SyncedIssue[] = [];
  for (const p of parts) {
    for (const i of p.items) {
      if (seen.has(i.itemId)) continue;
      seen.add(i.itemId);
      items.push(i);
    }
  }
  return {
    login: parts[0]?.login ?? "",
    items: items.slice(0, 200),
    truncated: parts.some((p) => p.truncated) || items.length > 200,
  };
}

/**
 * Syncs each GitHub scope's issues into tracked issues and worktrees for their branches, and
 * keeps the scope's projects in step with the repositories its source covers; optionally moves
 * board cards. GitHub stays authoritative for the issues; Switchyard keeps a snapshot of each
 * (`TrackedIssue`).
 */
export class ScopeSourceService {
  private timer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Map<string, Promise<Scope>>();

  constructor(
    private readonly ctx: CoordinatorContext,
    private readonly opts: { tickMs: number },
  ) {}

  start(): void {
    this.retireTrackerTasks();
    if (this.opts.tickMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Trackers used to create a Backlog task per issue. Once, delete those nobody touched and
   * detach the tracker from the rest (through the store, so clients get the events).
   */
  private retireTrackerTasks(): void {
    const { store } = this.ctx;
    if (store.getSetting("trackerTasksRetired", false)) return;
    store.tx(() => {
      const now = store.nowIso();
      for (const t of store.tasks.list()) {
        const legacy = t as Task & { tracker?: unknown };
        if (!legacy.tracker) continue;
        if (t.state === "backlog" && t.sessionId === null && t.currentRunId === null) {
          store.deleteTask(t);
        } else {
          const { tracker: _tracker, ...rest } = legacy;
          store.putTask({ ...rest, updatedAt: now });
        }
      }
      store.setSetting("trackerTasksRetired", true);
    });
  }

  async tick(): Promise<void> {
    for (const t of this.ctx.store.scopes.list(undefined, [], "created_at, rowid")) {
      if (!t.source?.enabled) continue;
      try {
        await this.sync(t.id);
      } catch (err) {
        this.ctx.log.warn({ err, scopeId: t.id }, "scope sync failed");
      }
    }
  }

  sync(scopeId: string): Promise<Scope> {
    const running = this.inFlight.get(scopeId);
    if (running) return running;
    const p = this.syncOnce(scopeId).finally(() => this.inFlight.delete(scopeId));
    this.inFlight.set(scopeId, p);
    return p;
  }

  async describeIssue(issueId: string): Promise<IssueDescriptionResult> {
    const { store, hostHub } = this.ctx;
    const issue = store.issues.require(issueId);
    const source = this.sourced(issue.scopeId).source;
    if (!hostHub.isConnected(source.hostId))
      throw new SwitchyardError("host_unreachable", "Source host is offline");
    const raw = await hostHub.request(
      source.hostId,
      { type: "tracker.describeIssue", repository: issue.repository, number: issue.number },
      { timeoutMs: 15_000 },
    );
    const current = store.issues.get(issueId);
    const currentSource = store.scopes.get(issue.scopeId)?.source;
    if (
      !current ||
      current.scopeId !== issue.scopeId ||
      current.itemId !== issue.itemId ||
      current.repository !== issue.repository ||
      current.number !== issue.number ||
      currentSource?.hostId !== source.hostId
    ) {
      throw new SwitchyardError("conflict", "Issue or source changed while reading description");
    }
    return IssueDescriptionResult.parse(raw);
  }

  /** A scope with a source, else a conflict. */
  private sourced(scopeId: string): GitHubScope {
    const scope = this.ctx.store.scopes.require(scopeId);
    if (!scope.source) throw new SwitchyardError("conflict", "This scope has no source to sync");
    return scope as GitHubScope;
  }

  private issuesOf(scopeId: string): TrackedIssue[] {
    return this.ctx.store.issues.list("scope_id = ?", [scopeId]);
  }

  /**
   * Record a sync's outcome on the scope's source. A change of `lastSyncedAt` alone is written
   * without an event (it happens every tick); anything else is published. A scope whose source
   * was removed meanwhile is left alone.
   */
  private save(scopeId: string, patch: Partial<GitHubSource>): Scope {
    const { store } = this.ctx;
    return store.tx(() => {
      const cur = store.scopes.require(scopeId);
      if (!cur.source) return cur;
      const source = { ...cur.source, ...patch };
      const next: Scope = { ...cur, source };
      const quiet =
        JSON.stringify({ ...cur.source, lastSyncedAt: null }) ===
        JSON.stringify({ ...source, lastSyncedAt: null });
      if (quiet) store.scopes.upsert(next);
      else store.putScope(next);
      return next;
    });
  }

  private hostName(hostId: string): string {
    return this.ctx.store.hosts.get(hostId)?.name ?? hostId;
  }

  private hostError(source: GitHubSource, err: unknown): string {
    if (err instanceof SwitchyardError && err.code === "unsupported_capability") {
      if (sourceFollow(source) === "board" || sourceBacklog(source).length > 0)
        return `Host ${this.hostName(source.hostId)} does not support following a board or backlog columns; upgrade its host agent`;
      return `Host ${this.hostName(source.hostId)} does not support GitHub issue sync; upgrade its host agent`;
    }
    return err instanceof Error ? err.message : String(err);
  }

  /** Read the source's actual membership, without projecting snapshots, worktrees or board moves. */
  private async readInventory(source: GitHubSource): Promise<IssueSyncResult> {
    const board = source.board
      ? {
          projectNumber: source.board.projectNumber,
          statusField: source.board.statusField,
          ...(source.board.priorityField ? { priorityField: source.board.priorityField } : {}),
        }
      : null;
    const extra = source.extraRepositories ?? [];
    const follow = sourceFollow(source);
    const backlog = sourceBacklog(source);
    const scopes =
      follow === "board" ? [null] : [source.repositories, ...(extra.length ? [extra] : [])];
    const parts: IssueSyncResult[] = [];
    for (const repositories of scopes) {
      const raw = await this.ctx.hostHub.request(
        source.hostId,
        {
          type: "tracker.sync",
          owner: source.owner,
          repositories,
          board,
          ...(follow === "board" ? { follow } : {}),
          ...(backlog.length ? { backlog } : {}),
        },
        { timeoutMs: SYNC_TIMEOUT_MS },
      );
      parts.push(IssueSyncResult.parse(raw));
    }
    const result = mergeSyncResults(parts);
    return follow === "board"
      ? { ...result, items: result.items.filter((i) => repositoryInScope(source, i.repository)) }
      : result;
  }

  /** A workspace id that still names a live workspace, else null. */
  private liveWorkspace(id: string | null | undefined): string | null {
    if (!id) return null;
    const ws = this.ctx.store.workspaces.get(id);
    return ws && !ws.archivedAt ? id : null;
  }

  private async syncOnce(scopeId: string): Promise<Scope> {
    const { store, hostHub } = this.ctx;
    const source = this.sourced(scopeId).source;
    if (!hostHub.isConnected(source.hostId)) {
      return this.save(scopeId, {
        lastError: `Host ${this.hostName(source.hostId)} is offline`,
      });
    }
    let result: IssueSyncResult;
    try {
      result = await this.readInventory(source);
    } catch (err) {
      return this.save(scopeId, { lastError: this.hostError(source, err) });
    }

    const errors: string[] = [];
    const unmatched = new Set<string>();
    let unmatchedCount = 0;
    const matched: { item: SyncedIssue; project: Project; issueId: string }[] = [];
    store.tx(() => {
      // The scope, or its source, may have been removed while the host answered.
      this.sourced(scopeId);
      const now = store.nowIso();
      const projects = store.projects.list();
      for (const item of result.items) {
        const project = projectForRepository(projects, item.repository);
        if (!project) {
          unmatched.add(item.repository);
          unmatchedCount++;
          continue;
        }
        const id = trackedIssueId(scopeId, item.itemId);
        const prev = store.issues.get(id);
        const next: TrackedIssue = {
          id,
          scopeId,
          // As the store writes it, so an unchanged issue compares equal.
          trackerId: scopeId,
          itemId: item.itemId,
          projectId: project.id,
          repository: item.repository,
          number: item.number,
          title: item.title.slice(0, 300),
          url: item.url,
          assignees: item.assignees,
          branches: item.branches,
          branch: prev?.branch ?? null,
          workspaceId: this.liveWorkspace(prev?.workspaceId),
          pullRequest: item.pullRequest,
          board: item.board,
          parent: item.parent ?? null,
          subIssues: item.subIssues ?? null,
          updatedAt: now,
        };
        if (
          !prev ||
          JSON.stringify({ ...prev, updatedAt: "" }) !== JSON.stringify({ ...next, updatedAt: "" })
        ) {
          store.putIssue(next);
        }
        matched.push({ item, project, issueId: id });
      }
      if (!result.truncated) {
        const seen = new Set(result.items.map((i) => i.itemId));
        for (const i of this.issuesOf(scopeId)) {
          if (!seen.has(i.itemId)) store.deleteIssue(i);
        }
      }
      this.syncProjects(scopeId, projects);
    });

    const current: GitHubSource = { ...source, login: result.login };
    const refreshed = new Set<string>();
    for (const m of matched) {
      try {
        await requireService(this.ctx, "issueWork").serialize(
          m.project.id,
          m.item.itemId,
          async () => {
            const scope = store.scopes.get(scopeId);
            if (!scope?.source || sourceConfig(scope.source) !== sourceConfig(source)) return;
            await this.linkWorkspace(current, m.item, m.project, m.issueId, refreshed);
          },
        );
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
      if (source.writeBack && source.board) {
        try {
          await this.writeBack(current, m.item, m.issueId);
        } catch (err) {
          errors.push(this.hostError(source, err));
        }
      }
    }

    const unmatchedList = [...unmatched].sort();
    const unmatchedNames =
      unmatchedList.slice(0, 3).join(", ") +
      (unmatchedList.length > 3 ? ` and ${unmatchedList.length - 3} more` : "");
    const lastError =
      errors[0] ??
      (unmatched.size > 0
        ? `${unmatchedCount} ${unmatchedCount === 1 ? "issue is" : "issues are"} in repositories with no project here: ${unmatchedNames}`
        : result.truncated
          ? "More than 200 issues; only the first 200 are tracked"
          : null);
    return this.save(scopeId, {
      login: result.login,
      lastSyncedAt: store.nowIso(),
      lastError,
    });
  }

  /** Keep the scope's projects in step with the repositories its source covers (inside a transaction). */
  private syncProjects(scopeId: string, projects: Project[]): void {
    const { store } = this.ctx;
    const scope = store.scopes.get(scopeId);
    if (!scope?.source) return;
    const projectIds = projectIdsFor(scope.source, projects);
    if (JSON.stringify(scope.projectIds) === JSON.stringify(projectIds)) return;
    store.putScope({ ...scope, projectIds, updatedAt: store.nowIso() });
  }

  /**
   * The checkout to make an issue's worktree in: the project's default host, else the source's
   * host, else any. The source's host is only where `gh` runs.
   */
  private workCheckout(source: GitHubSource, project: Project) {
    const checkouts = this.ctx.store.checkouts.list("project_id = ?", [project.id]);
    return (
      checkouts.find((c) => c.hostId === project.defaultHostId) ??
      checkouts.find((c) => c.hostId === source.hostId) ??
      checkouts[0]
    );
  }

  /** Create (once) and link the worktree for an issue's branch. */
  private async linkWorkspace(
    source: GitHubSource,
    item: SyncedIssue,
    project: Project,
    issueId: string,
    refreshed: Set<string>,
  ): Promise<void> {
    const { store, hostHub } = this.ctx;
    const issue = store.issues.get(issueId);
    if (!issue || !projectMatchesIssue(store, issue)) return;
    const { branch, work, remote } = issueWorkBranch(store, project.id, item);
    if (!branch || item.pullRequest?.state === "MERGED") return;
    const update = (workspaceId: string | null) => {
      const row = store.issues.get(issueId);
      if (row && (row.branch !== branch || row.workspaceId !== workspaceId)) {
        store.putIssue({ ...row, branch, workspaceId, updatedAt: store.nowIso() });
      }
    };
    const find = () => {
      const matches = store.workspaces
        .list("project_id = ? AND archived_at IS NULL", [project.id])
        .filter((w) => w.branch === branch);
      return (
        matches.find((w) => w.id === work?.workspaceId) ??
        matches.find((w) => w.id === issue.workspaceId) ??
        matches[0]
      );
    };
    let ws = find();
    if (
      pendingIssueSession(store, work, branch) ||
      (ws && work?.branch === branch && work.remote && !work.workspaceId)
    ) {
      update(null);
      return;
    }
    if (!ws && (work?.branch === branch || issue.branch !== null)) update(null);
    const checkout = this.workCheckout(source, project);
    if (!ws && !checkout) return;
    const key = `issueBranchTried:${issueId}:${branch}`;
    if (!ws && checkout) {
      if (store.getSetting<string | null>(key, null) !== null) return;
      if (!refreshed.has(checkout.id)) {
        refreshed.add(checkout.id);
        try {
          await refreshCheckoutWorkspaces(this.ctx, checkout);
        } catch (err) {
          this.ctx.log.debug(
            { err, checkoutId: checkout.id },
            "scope sync: workspace discovery failed",
          );
        }
        ws = find();
      }
    }
    // A source that only watches never makes a worktree. A durable manual link on
    // an absent worktree also doesn't let another board recreate it automatically.
    if (!ws && (!sourceMakesWorktrees(source) || (!remote && work?.workspaceId))) return;
    if (!ws && checkout) {
      store.setSetting(key, store.nowIso());
      if (remote) {
        const preparation = await hostHub.request<{ ok?: boolean }>(
          checkout.hostId,
          {
            type: "tracker.prepareBranch",
            checkoutPath: checkout.path,
            branch,
            ...(hostHub.supportsStrictIssueBranches(checkout.hostId) ? { strict: true } : {}),
          },
          { timeoutMs: 60_000 },
        );
        if (preparation?.ok !== true) {
          throw new SwitchyardError(
            "conflict",
            "The host did not confirm preparation of the linked remote branch",
          );
        }
      }
      ws = await createWorkspace(this.ctx, project, checkout, branch, null);
    }
    update(ws!.id);
  }

  /** Move the card once per target column: started once a worktree exists, review once a PR is open. */
  private async writeBack(source: GitHubSource, item: SyncedIssue, issueId: string): Promise<void> {
    const { store } = this.ctx;
    const board = source.board!;
    const issue = store.issues.get(issueId);
    if (!issue?.board) return;
    const target =
      item.pullRequest?.state === "OPEN" && board.onReview
        ? board.onReview
        : issue.workspaceId && board.onStart
          ? board.onStart
          : null;
    if (!target) return;
    const key = `issueMoved:${issueId}:${target}`;
    if (store.getSetting<string | null>(key, null) !== null) return;
    if (issue.board.status?.toLowerCase() === target.toLowerCase()) {
      store.setSetting(key, store.nowIso());
      return;
    }
    const option = issue.board.options.find((o) => o.name.toLowerCase() === target.toLowerCase());
    if (!option) throw new Error(`Board has no "${target}" column`);
    const result = await this.requestMove(source, issue, option.id);
    if (result.status === "moved") {
      store.setSetting(key, store.nowIso());
      this.applyMove(issueId, option);
    } else if (result.reason !== "stale") {
      store.setSetting(key, store.nowIso());
    }
  }

  private async requestMove(
    source: GitHubSource,
    issue: TrackedIssue,
    optionId: string,
  ): Promise<IssueSetStatusResult> {
    const board = issue.board!;
    const raw = await this.ctx.hostHub.request(
      source.hostId,
      {
        type: "tracker.setStatus",
        projectId: board.projectId,
        projectItemId: board.projectItemId,
        fieldId: board.fieldId,
        statusField: source.board!.statusField,
        optionId,
        expectedOptionId: board.statusOptionId,
        login: source.login ?? "",
        allowShared: source.moveShared,
        allowUnassigned: sourceFollow(source) === "board",
      },
      { timeoutMs: 30_000 },
    );
    return IssueSetStatusResult.parse(raw);
  }

  private applyMove(
    issueId: string,
    option: { id: string; name: string },
  ): TrackedIssue | undefined {
    const { store } = this.ctx;
    return store.tx(() => {
      const i = store.issues.get(issueId);
      if (!i?.board) return i;
      return store.putIssue({
        ...i,
        board: { ...i.board, status: option.name, statusOptionId: option.id },
        updatedAt: store.nowIso(),
      });
    });
  }

  /** Start from a tracked membership, or navigate to its already-known work. */
  openIssue(issueId: string, opts: OpenIssueRequest = {}) {
    const { store } = this.ctx;
    const initial = store.issues.require(issueId);
    return requireService(this.ctx, "issueWork").openIssueWork(
      initial.projectId,
      initial.itemId,
      opts,
      "tracked",
      () => {
        const issue = store.issues.require(issueId);
        const source = this.sourced(issue.scopeId).source;
        const refresh = () => new SwitchyardError("conflict", "Refresh the source before starting");
        const assertCurrent = () => {
          const current = store.issues.require(issueId);
          const live = this.sourced(current.scopeId).source;
          if (
            current.projectId !== initial.projectId ||
            current.itemId !== initial.itemId ||
            current.scopeId !== issue.scopeId ||
            current.number !== issue.number ||
            current.repository !== issue.repository ||
            !projectMatchesIssue(store, current) ||
            sourceConfig(source) !== sourceConfig(live)
          ) {
            throw refresh();
          }
        };
        const assertCanStart = () => {
          const live = this.sourced(issue.scopeId).source;
          if (!live.enabled || live.lastError !== null || !live.lastSyncedAt) throw refresh();
          if (store.issues.require(issueId).pullRequest?.state === "MERGED") {
            throw new SwitchyardError("conflict", "This issue is merged");
          }
        };
        return {
          issue,
          mutationHostId: source.hostId,
          assertCurrent,
          assertCanStart,
          reconcileExisting: source.enabled && source.lastError === null && !!source.lastSyncedAt,
          refreshForStart: async () => {
            // An issue lookup alone can't prove membership of a particular board or assignment.
            // A read-only source refresh also recovers a branch after an uncertain start receipt.
            let result: IssueSyncResult;
            try {
              result = await this.readInventory(source);
            } catch (err) {
              this.ctx.log.debug({ err, issueId }, "issue open: source refresh failed");
              throw refresh();
            }
            assertCurrent();
            const fresh = result.items.find(
              (i) =>
                i.itemId === issue.itemId &&
                i.number === issue.number &&
                i.repository.toLowerCase() === issue.repository.toLowerCase(),
            );
            if (result.truncated || !fresh) throw refresh();
            return {
              issue: fresh,
              mutationHostId: source.hostId,
              assertCurrent,
              assertCanStart: () => {
                assertCanStart();
                if (fresh.pullRequest?.state === "MERGED") {
                  throw new SwitchyardError("conflict", "This issue is merged");
                }
              },
            };
          },
        };
      },
    );
  }

  /** Link a worktree by hand. Scope snapshots are a projection, not separate links. */
  linkIssue(issueId: string, workspaceId: string): Promise<TrackedIssue> {
    const { store } = this.ctx;
    const work = requireService(this.ctx, "issueWork");
    const initial = store.issues.require(issueId);
    return work.serialize(initial.projectId, initial.itemId, () =>
      store.tx(() => {
        const issue = store.issues.require(issueId);
        if (
          issue.projectId !== initial.projectId ||
          issue.itemId !== initial.itemId ||
          !projectMatchesIssue(store, issue)
        ) {
          throw new SwitchyardError("conflict", "The issue changed; refresh and try again");
        }
        const ws = store.workspaces.require(workspaceId);
        const problem = issueLinkProblem(issue, ws, store.issues.list());
        if (problem) throw new SwitchyardError("conflict", problem);
        const { branch, ambiguous } = issueWorkBranch(store, issue.projectId, issue);
        const siblings = trackedIssueLinks(store, issue.projectId, issue.itemId);
        if (
          branch ||
          ambiguous ||
          siblings.some((i) => remoteIssueBranches(i).length || i.pullRequest?.state === "MERGED")
        ) {
          throw new SwitchyardError("conflict", "This issue already has a branch or pull request");
        }
        const other = store.listIssueWork(issue.projectId).find((w) => w.branch === ws.branch);
        if (other)
          throw new SwitchyardError(
            "conflict",
            `This branch is already linked to #${other.number}`,
          );
        store.putIssueWork({
          projectId: issue.projectId,
          nodeId: issue.itemId,
          number: issue.number,
          title: issue.title,
          url: issue.url,
          branch: ws.branch!,
          remote: false,
          workspaceId: ws.id,
          pendingSessionId: null,
        });
        // The worktree exists; never recreate it from this board if it is removed later.
        store.setSetting(`issueBranchTried:${issueId}:${ws.branch}`, store.nowIso());
        work.projectLink(issue.projectId, issue.itemId, ws.branch, ws.id);
        return store.issues.require(issueId);
      }),
    );
  }

  /** Undo a local link on every membership, so no legacy fallback can resurrect it. */
  unlinkIssue(issueId: string): Promise<TrackedIssue> {
    const { store } = this.ctx;
    const work = requireService(this.ctx, "issueWork");
    const initial = store.issues.require(issueId);
    return work.serialize(initial.projectId, initial.itemId, () =>
      store.tx(() => {
        const issue = store.issues.require(issueId);
        if (
          issue.projectId !== initial.projectId ||
          issue.itemId !== initial.itemId ||
          !projectMatchesIssue(store, issue)
        ) {
          throw new SwitchyardError("conflict", "The issue changed; refresh and try again");
        }
        const link = issueWorkBranch(store, issue.projectId, issue);
        const problem = issueUnlinkProblem({ ...issue, branch: link.branch });
        if (problem) throw new SwitchyardError("conflict", problem);
        if (
          link.ambiguous ||
          link.remote ||
          trackedIssueLinks(store, issue.projectId, issue.itemId).some(
            (i) => i.branches.length || i.pullRequest,
          )
        ) {
          throw new SwitchyardError(
            "conflict",
            "Resolve the GitHub or conflicting branch links before unlinking",
          );
        }
        if (pendingIssueSession(store, link.work, link.branch)) {
          throw new SwitchyardError("conflict", "This worktree is still being created");
        }
        store.deleteIssueWork(issue.projectId, issue.itemId);
        work.projectLink(issue.projectId, issue.itemId, null, null);
        return store.issues.require(issueId);
      }),
    );
  }

  /** Set a card's board column by hand. */
  async setStatus(issueId: string, status: string): Promise<TrackedIssue> {
    const { store } = this.ctx;
    const issue = store.issues.require(issueId);
    const board = issue.board;
    if (!board) throw new SwitchyardError("invalid_request", "This issue has no board column");
    const source = this.sourced(issue.scopeId).source;
    if (!source.writeBack || !source.board)
      throw new SwitchyardError("forbidden", "Write-back is off for this scope");
    const option = board.options.find((o) => o.name.toLowerCase() === status.toLowerCase());
    if (!option) throw new SwitchyardError("invalid_request", "Unknown column");
    const result = await this.requestMove(source, issue, option.id);
    if (result.status === "skipped") {
      const message =
        result.reason === "stale"
          ? "The card moved on GitHub; refresh and try again"
          : result.reason === "shared"
            ? "This card is shared and this scope does not move shared cards"
            : sourceFollow(source) === "board"
              ? "This card is assigned to someone else"
              : `This card is no longer assigned to ${source.login ?? "the scope's GitHub user"}`;
      throw new SwitchyardError("conflict", message);
    }
    return this.applyMove(issueId, option) ?? store.issues.require(issueId);
  }
}
