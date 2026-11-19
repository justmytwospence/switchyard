import {
  issueLinkProblem,
  issueUnlinkProblem,
  newId,
  type Project,
  type Session,
  SwitchyardError,
  type Task,
  type TrackedIssue,
  type Tracker,
  type TrackerItem,
  TrackerSetStatusResult,
  TrackerSyncResult,
  trackedIssueId,
  type View,
} from "@switchyard/protocol";
import { openBranch } from "./branches.js";
import type { CoordinatorContext } from "./context.js";
import { createWorkspace } from "./sessions/service.js";
import { refreshCheckoutWorkspaces } from "./workspaces.js";

const GITHUB = "https://github.com/";
const SYNC_TIMEOUT_MS = 90_000;

/** The project whose checkout is this GitHub repository. */
export function projectForRepository(projects: Project[], repository: string): Project | undefined {
  const want = `${GITHUB}${repository}`.toLowerCase();
  return projects.find((p) => p.repoIdentity.toLowerCase() === want);
}

/**
 * Whether a project belongs to a tracker's owner (and repository list, when it has one), or is
 * one of its extra repositories.
 */
export function inScope(
  tracker: Pick<Tracker, "owner" | "repositories" | "extraRepositories">,
  project: Project,
): boolean {
  const identity = project.repoIdentity.toLowerCase();
  if ((tracker.extraRepositories ?? []).some((r) => identity === `${GITHUB}${r}`.toLowerCase())) {
    return true;
  }
  if (!identity.startsWith(`${GITHUB}${tracker.owner.toLowerCase()}/`)) return false;
  if (!tracker.repositories) return true;
  return tracker.repositories.some((r) => identity === `${GITHUB}${r}`.toLowerCase());
}

/** One result from several host syncs: items once each (by `itemId`), at most 200. */
export function mergeSyncResults(parts: TrackerSyncResult[]): TrackerSyncResult {
  const seen = new Set<string>();
  const items: TrackerItem[] = [];
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

/** Branch name for "Start work": `<number>-<slug of the title>`. */
export function issueBranch(number: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug ? `${number}-${slug}` : String(number);
}

/**
 * Syncs each tracker's assigned issues into tracked issues, worktrees for their branches and a
 * view of the projects it covers; optionally moves board cards. GitHub stays authoritative for
 * the issues; Switchyard keeps a snapshot of each (`TrackedIssue`).
 */
export class TrackerService {
  private timer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Map<string, Promise<Tracker>>();

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
    for (const t of this.ctx.store.trackers.list(undefined, [], "created_at, rowid")) {
      if (!t.enabled) continue;
      try {
        await this.sync(t.id);
      } catch (err) {
        this.ctx.log.warn({ err, trackerId: t.id }, "tracker sync failed");
      }
    }
  }

  sync(trackerId: string): Promise<Tracker> {
    const running = this.inFlight.get(trackerId);
    if (running) return running;
    const p = this.syncOnce(trackerId).finally(() => this.inFlight.delete(trackerId));
    this.inFlight.set(trackerId, p);
    return p;
  }

  private issuesOf(trackerId: string): TrackedIssue[] {
    return this.ctx.store.issues.list("tracker_id = ?", [trackerId]);
  }

  private save(trackerId: string, patch: Partial<Tracker>): Tracker {
    const { store } = this.ctx;
    return store.tx(() => {
      const cur = store.trackers.require(trackerId);
      const next = { ...cur, ...patch, updatedAt: store.nowIso() };
      store.trackers.upsert(next);
      return next;
    });
  }

  private hostName(hostId: string): string {
    return this.ctx.store.hosts.get(hostId)?.name ?? hostId;
  }

  private hostError(tracker: Tracker, err: unknown): string {
    if (err instanceof SwitchyardError && err.code === "unsupported_capability")
      return `Host ${this.hostName(tracker.hostId)} does not support trackers; upgrade its host agent`;
    return err instanceof Error ? err.message : String(err);
  }

  /** A workspace id that still names a live workspace, else null. */
  private liveWorkspace(id: string | null | undefined): string | null {
    if (!id) return null;
    const ws = this.ctx.store.workspaces.get(id);
    return ws && !ws.archivedAt ? id : null;
  }

  private async syncOnce(trackerId: string): Promise<Tracker> {
    const { store, hostHub } = this.ctx;
    const tracker = store.trackers.require(trackerId);
    if (!hostHub.isConnected(tracker.hostId)) {
      return this.save(trackerId, {
        lastError: `Host ${this.hostName(tracker.hostId)} is offline`,
      });
    }
    const board = tracker.board
      ? { projectNumber: tracker.board.projectNumber, statusField: tracker.board.statusField }
      : null;
    const extra = tracker.extraRepositories ?? [];
    const scopes = [tracker.repositories, ...(extra.length ? [extra] : [])];
    let result: TrackerSyncResult;
    try {
      const parts: TrackerSyncResult[] = [];
      for (const repositories of scopes) {
        const raw = await hostHub.request(
          tracker.hostId,
          { type: "tracker.sync", owner: tracker.owner, repositories, board },
          { timeoutMs: SYNC_TIMEOUT_MS },
        );
        parts.push(TrackerSyncResult.parse(raw));
      }
      result = mergeSyncResults(parts);
    } catch (err) {
      return this.save(trackerId, { lastError: this.hostError(tracker, err) });
    }

    const errors: string[] = [];
    let unmatched = 0;
    const matched: { item: TrackerItem; project: Project; issueId: string }[] = [];
    store.tx(() => {
      const now = store.nowIso();
      const projects = store.projects.list();
      for (const item of result.items) {
        const project = projectForRepository(projects, item.repository);
        if (!project) {
          unmatched++;
          continue;
        }
        const id = trackedIssueId(trackerId, item.itemId);
        const prev = store.issues.get(id);
        const next: TrackedIssue = {
          id,
          trackerId,
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
        for (const i of this.issuesOf(trackerId)) {
          if (!seen.has(i.itemId)) store.deleteIssue(i);
        }
      }
      this.syncView(store.trackers.require(trackerId), projects);
    });

    const current: Tracker = { ...tracker, login: result.login };
    const refreshed = new Set<string>();
    for (const m of matched) {
      try {
        await this.linkWorkspace(current, m.item, m.project, m.issueId, refreshed);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
      if (tracker.writeBack && tracker.board) {
        try {
          await this.writeBack(current, m.item, m.issueId);
        } catch (err) {
          errors.push(this.hostError(tracker, err));
        }
      }
    }

    const lastError =
      errors[0] ??
      (unmatched > 0
        ? `${unmatched} ${unmatched === 1 ? "issue is" : "issues are"} in repositories with no project here`
        : result.truncated
          ? "More than 200 issues; only the first 200 are tracked"
          : null);
    return this.save(trackerId, {
      login: result.login,
      lastSyncedAt: store.nowIso(),
      lastError,
    });
  }

  /** Keep the tracker's view pointed at the projects it covers (inside a transaction). */
  private syncView(tracker: Tracker, projects: Project[]): void {
    const { store } = this.ctx;
    const projectIds = projects.filter((p) => inScope(tracker, p)).map((p) => p.id);
    const views = store.views.list();
    const view =
      views.find((v) => v.trackerId === tracker.id) ??
      views.find((v) => !v.trackerId && v.name.toLowerCase() === tracker.name.toLowerCase());
    const now = store.nowIso();
    if (!view) {
      if (views.some((v) => v.name.toLowerCase() === tracker.name.toLowerCase())) return;
      store.putView({
        id: newId("viw"),
        name: tracker.name,
        mode: "all",
        projectIds,
        hostIds: null,
        sessionIds: [],
        clients: [],
        trackerId: tracker.id,
        createdAt: now,
        updatedAt: now,
      } satisfies View);
      return;
    }
    const same =
      view.trackerId === tracker.id &&
      JSON.stringify(view.projectIds) === JSON.stringify(projectIds);
    if (!same) store.putView({ ...view, trackerId: tracker.id, projectIds, updatedAt: now });
  }

  /**
   * The checkout to make an issue's worktree in: the project's default host, else the tracker's
   * host, else any. The tracker's host is only where `gh` runs.
   */
  private workCheckout(tracker: Tracker, project: Project) {
    const checkouts = this.ctx.store.checkouts.list("project_id = ?", [project.id]);
    return (
      checkouts.find((c) => c.hostId === project.defaultHostId) ??
      checkouts.find((c) => c.hostId === tracker.hostId) ??
      checkouts[0]
    );
  }

  /** Create (once) and link the worktree for an issue's branch. */
  private async linkWorkspace(
    tracker: Tracker,
    item: TrackerItem,
    project: Project,
    issueId: string,
    refreshed: Set<string>,
  ): Promise<void> {
    const { store, hostHub } = this.ctx;
    const branch = item.branches[0] ?? store.issues.get(issueId)?.branch ?? null;
    if (!branch || item.pullRequest?.state === "MERGED") return;
    const find = () =>
      store.workspaces
        .list("project_id = ? AND archived_at IS NULL", [project.id])
        .find(
          (w) => w.branch !== null && (w.branch === branch || item.branches.includes(w.branch)),
        );
    let ws = find();
    const checkout = this.workCheckout(tracker, project);
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
            "tracker: workspace discovery failed",
          );
        }
        ws = find();
      }
    }
    if (!ws && checkout) {
      store.setSetting(key, store.nowIso());
      try {
        await hostHub.request(
          checkout.hostId,
          { type: "tracker.prepareBranch", checkoutPath: checkout.path, branch },
          { timeoutMs: 60_000 },
        );
      } catch (err) {
        this.ctx.log.debug({ err, branch }, "tracker: prepareBranch failed");
      }
      ws = await createWorkspace(this.ctx, project, checkout, branch, null);
    }
    const found = ws!;
    store.tx(() => {
      const issue = store.issues.get(issueId);
      if (!issue || issue.workspaceId === found.id) return;
      store.putIssue({
        ...issue,
        branch: found.branch,
        workspaceId: found.id,
        updatedAt: store.nowIso(),
      });
    });
  }

  /** Move the card once per target column: started once a worktree exists, review once a PR is open. */
  private async writeBack(tracker: Tracker, item: TrackerItem, issueId: string): Promise<void> {
    const { store } = this.ctx;
    const board = tracker.board!;
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
    const result = await this.requestMove(tracker, issue, option.id);
    if (result.status === "moved") {
      store.setSetting(key, store.nowIso());
      this.applyMove(issueId, option);
    } else if (result.reason !== "stale") {
      store.setSetting(key, store.nowIso());
    }
  }

  private async requestMove(
    tracker: Tracker,
    issue: TrackedIssue,
    optionId: string,
  ): Promise<TrackerSetStatusResult> {
    const board = issue.board!;
    const raw = await this.ctx.hostHub.request(
      tracker.hostId,
      {
        type: "tracker.setStatus",
        projectId: board.projectId,
        projectItemId: board.projectItemId,
        fieldId: board.fieldId,
        statusField: tracker.board!.statusField,
        optionId,
        expectedOptionId: board.statusOptionId,
        login: tracker.login ?? "",
        allowShared: tracker.moveShared,
      },
      { timeoutMs: 30_000 },
    );
    return TrackerSetStatusResult.parse(raw);
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

  /**
   * Give an issue a branch: its linked branch, else create one named `<number>-<title>` (as a
   * linked branch on GitHub when the tracker's host has a checkout, else only locally).
   */
  private async startIssue(issueId: string): Promise<TrackedIssue> {
    const { store, hostHub } = this.ctx;
    const issue = store.issues.require(issueId);
    const tracker = store.trackers.require(issue.trackerId);
    if (issue.branch === null && issue.branches.length === 0) {
      const name = issueBranch(issue.number, issue.title);
      const checkout = store.checkouts
        .list("project_id = ?", [issue.projectId])
        .find((c) => c.hostId === tracker.hostId);
      if (checkout) {
        await hostHub.request(
          tracker.hostId,
          {
            type: "tracker.startIssue",
            checkoutPath: checkout.path,
            repository: issue.repository,
            number: issue.number,
            branch: name,
            base: checkout.defaultBranch,
          },
          { timeoutMs: 60_000 },
        );
        await this.sync(tracker.id);
      }
      store.tx(() => {
        const cur = store.issues.require(issueId);
        if (cur.branch === null) {
          store.putIssue({ ...cur, branch: cur.branches[0] ?? name, updatedAt: store.nowIso() });
        }
      });
    }
    return store.issues.require(issueId);
  }

  /**
   * Start or open an issue: give it a branch, then open that branch (its primary session, or a
   * new idle session titled after the issue, making the worktree when needed).
   */
  async openIssue(
    issueId: string,
    opts: { hostId?: string | undefined; viewId?: string | undefined } = {},
  ): Promise<{ session: Session; created: boolean }> {
    const { store } = this.ctx;
    const issue = await this.startIssue(issueId);
    const branch = issue.branch ?? issue.branches[0];
    if (!branch) throw new SwitchyardError("conflict", "This issue has no branch");
    const result = await openBranch(this.ctx, {
      projectId: issue.projectId,
      branch,
      hostId: opts.hostId,
      viewId: opts.viewId,
      prompt: "",
      title: `#${issue.number} ${issue.title}`.slice(0, 120),
    });
    const wsId = result.session.workspaceId;
    store.tx(() => {
      const cur = store.issues.get(issueId);
      if (!cur) return;
      if (cur.branch === branch && (wsId === null || cur.workspaceId === wsId)) return;
      store.putIssue({
        ...cur,
        branch,
        ...(wsId ? { workspaceId: wsId } : {}),
        updatedAt: store.nowIso(),
      });
    });
    return result;
  }

  /** Link a worktree's branch to a not-started issue by hand. GitHub's own link, once it has one, wins at the next sync. */
  linkIssue(issueId: string, workspaceId: string): TrackedIssue {
    const { store } = this.ctx;
    return store.tx(() => {
      const issue = store.issues.require(issueId);
      const ws = store.workspaces.require(workspaceId);
      const problem = issueLinkProblem(issue, ws, store.issues.list());
      if (problem) throw new SwitchyardError("conflict", problem);
      const now = store.nowIso();
      // The worktree exists; never recreate it from the issue if it is removed later.
      store.setSetting(`issueBranchTried:${issueId}:${ws.branch}`, now);
      return store.putIssue({ ...issue, branch: ws.branch, workspaceId: ws.id, updatedAt: now });
    });
  }

  /** Undo a link GitHub does not know about. */
  unlinkIssue(issueId: string): TrackedIssue {
    const { store } = this.ctx;
    return store.tx(() => {
      const issue = store.issues.require(issueId);
      const problem = issueUnlinkProblem(issue);
      if (problem) throw new SwitchyardError("conflict", problem);
      return store.putIssue({
        ...issue,
        branch: null,
        workspaceId: null,
        updatedAt: store.nowIso(),
      });
    });
  }

  /** Set a card's board column by hand. */
  async setStatus(issueId: string, status: string): Promise<TrackedIssue> {
    const { store } = this.ctx;
    const issue = store.issues.require(issueId);
    const board = issue.board;
    if (!board) throw new SwitchyardError("invalid_request", "This issue has no board column");
    const tracker = store.trackers.require(issue.trackerId);
    if (!tracker.writeBack || !tracker.board)
      throw new SwitchyardError("forbidden", "Write-back is off for this tracker");
    const option = board.options.find((o) => o.name.toLowerCase() === status.toLowerCase());
    if (!option) throw new SwitchyardError("invalid_request", "Unknown column");
    const result = await this.requestMove(tracker, issue, option.id);
    if (result.status === "skipped") {
      const message =
        result.reason === "stale"
          ? "The card moved on GitHub; refresh and try again"
          : result.reason === "shared"
            ? "This card is shared and the tracker does not move shared cards"
            : `This card is no longer assigned to ${tracker.login ?? "the tracker's user"}`;
      throw new SwitchyardError("conflict", message);
    }
    return this.applyMove(issueId, option) ?? store.issues.require(issueId);
  }
}
