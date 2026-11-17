import {
  newId,
  type Project,
  SwitchyardError,
  type Task,
  type TaskTracker,
  type Tracker,
  type TrackerItem,
  TrackerSetStatusResult,
  TrackerSyncResult,
  type View,
} from "@switchyard/protocol";
import type { CoordinatorContext } from "./context.js";
import { createWorkspace } from "./sessions/service.js";
import { createTask } from "./tasks/service.js";
import { refreshCheckoutWorkspaces } from "./workspaces.js";

const GITHUB = "https://github.com/";
const SYNC_TIMEOUT_MS = 90_000;

/** The project whose checkout is this GitHub repository. */
export function projectForRepository(projects: Project[], repository: string): Project | undefined {
  const want = `${GITHUB}${repository}`.toLowerCase();
  return projects.find((p) => p.repoIdentity.toLowerCase() === want);
}

/** Whether a project belongs to a tracker's owner (and repository list, when it has one). */
export function inScope(
  tracker: Pick<Tracker, "owner" | "repositories">,
  project: Project,
): boolean {
  const identity = project.repoIdentity.toLowerCase();
  if (!identity.startsWith(`${GITHUB}${tracker.owner.toLowerCase()}/`)) return false;
  if (!tracker.repositories) return true;
  return tracker.repositories.some((r) => identity === `${GITHUB}${r}`.toLowerCase());
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
 * Syncs each tracker's assigned issues into Backlog tasks, worktrees for their branches and a view
 * of the projects it covers; optionally moves board cards. GitHub stays authoritative for the
 * issues; Switchyard keeps a snapshot on each task (`Task.tracker`).
 */
export class TrackerService {
  private timer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Map<string, Promise<Tracker>>();

  constructor(
    private readonly ctx: CoordinatorContext,
    private readonly opts: { tickMs: number },
  ) {}

  start(): void {
    if (this.opts.tickMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
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

  private tasksOf(trackerId: string): Task[] {
    return this.ctx.store.tasks.list().filter((t) => t.tracker?.trackerId === trackerId);
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

  private async syncOnce(trackerId: string): Promise<Tracker> {
    const { store, hostHub } = this.ctx;
    const tracker = store.trackers.require(trackerId);
    if (!hostHub.isConnected(tracker.hostId)) {
      return this.save(trackerId, {
        lastError: `Host ${this.hostName(tracker.hostId)} is offline`,
      });
    }
    let result: TrackerSyncResult;
    try {
      const raw = await hostHub.request(
        tracker.hostId,
        {
          type: "tracker.sync",
          owner: tracker.owner,
          repositories: tracker.repositories,
          board: tracker.board
            ? { projectNumber: tracker.board.projectNumber, statusField: tracker.board.statusField }
            : null,
        },
        { timeoutMs: SYNC_TIMEOUT_MS },
      );
      result = TrackerSyncResult.parse(raw);
    } catch (err) {
      return this.save(trackerId, { lastError: this.hostError(tracker, err) });
    }

    const errors: string[] = [];
    let unmatched = 0;
    const matched: { item: TrackerItem; project: Project; taskId: string }[] = [];
    store.tx(() => {
      const now = store.nowIso();
      const projects = store.projects.list();
      const mine = this.tasksOf(trackerId);
      for (const item of result.items) {
        const project = projectForRepository(projects, item.repository);
        if (!project) {
          unmatched++;
          continue;
        }
        let task =
          mine.find((t) => t.tracker!.itemId === item.itemId) ??
          store.tasks
            .list("project_id = ?", [project.id])
            .find((t) => !t.tracker && t.githubIssue?.url === item.url);
        if (!task) {
          task = createTask(
            this.ctx,
            { projectId: project.id, githubIssueUrl: item.url, title: item.title.slice(0, 300) },
            { kind: "manual" },
          );
        }
        const prev = task.tracker;
        const next: TaskTracker = {
          trackerId,
          itemId: item.itemId,
          repository: item.repository,
          number: item.number,
          assignees: item.assignees,
          branch: prev?.branch ?? null,
          workspaceId: prev?.workspaceId ?? null,
          pullRequest: item.pullRequest,
          board: item.board,
        };
        const title = task.state === "backlog" ? item.title.slice(0, 300) : task.title;
        if (JSON.stringify(prev) !== JSON.stringify(next) || title !== task.title) {
          task = store.putTask({ ...task, tracker: next, title, updatedAt: now });
        }
        matched.push({ item, project, taskId: task.id });
      }
      if (!result.truncated) {
        const seen = new Set(result.items.map((i) => i.itemId));
        for (const t of this.tasksOf(trackerId)) {
          if (seen.has(t.tracker!.itemId)) continue;
          if (t.state === "backlog" && t.sessionId === null && t.currentRunId === null) {
            store.deleteTask(t);
          }
        }
      }
      this.syncView(store.trackers.require(trackerId), projects);
    });

    const current: Tracker = { ...tracker, login: result.login };
    const refreshed = new Set<string>();
    for (const m of matched) {
      try {
        await this.linkWorkspace(current, m.item, m.project, m.taskId, refreshed);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
      if (tracker.writeBack && tracker.board) {
        try {
          await this.writeBack(current, m.item, m.taskId);
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

  /** Create (once) and link the worktree for an issue's branch. */
  private async linkWorkspace(
    tracker: Tracker,
    item: TrackerItem,
    project: Project,
    taskId: string,
    refreshed: Set<string>,
  ): Promise<void> {
    const { store, hostHub } = this.ctx;
    const branch = item.branches[0];
    if (!branch || item.pullRequest?.state === "MERGED") return;
    const checkout = store.checkouts
      .list("project_id = ?", [project.id])
      .find((c) => c.hostId === tracker.hostId);
    if (!checkout) return;
    const find = () =>
      store.workspaces
        .list("checkout_id = ? AND archived_at IS NULL", [checkout.id])
        .find((w) => w.branch !== null && item.branches.includes(w.branch));
    let ws = find();
    const key = `trackerBranchTried:${taskId}:${branch}`;
    if (!ws) {
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
    if (!ws) {
      store.setSetting(key, store.nowIso());
      await hostHub.request(
        tracker.hostId,
        { type: "tracker.prepareBranch", checkoutPath: checkout.path, branch },
        { timeoutMs: 60_000 },
      );
      ws = await createWorkspace(this.ctx, project, checkout, branch, null);
    }
    const found = ws;
    store.tx(() => {
      const task = store.tasks.get(taskId);
      if (!task?.tracker || task.tracker.workspaceId === found.id) return;
      store.putTask({
        ...task,
        tracker: { ...task.tracker, branch: found.branch, workspaceId: found.id },
        updatedAt: store.nowIso(),
      });
    });
  }

  /** Move the card once per target column: started once a worktree exists, review once a PR is open. */
  private async writeBack(tracker: Tracker, item: TrackerItem, taskId: string): Promise<void> {
    const { store } = this.ctx;
    const board = tracker.board!;
    const task = store.tasks.get(taskId);
    const link = task?.tracker;
    if (!task || !link?.board) return;
    const target =
      item.pullRequest?.state === "OPEN" && board.onReview
        ? board.onReview
        : link.workspaceId && board.onStart
          ? board.onStart
          : null;
    if (!target) return;
    const key = `trackerMoved:${taskId}:${target}`;
    if (store.getSetting<string | null>(key, null) !== null) return;
    if (link.board.status?.toLowerCase() === target.toLowerCase()) {
      store.setSetting(key, store.nowIso());
      return;
    }
    const option = link.board.options.find((o) => o.name.toLowerCase() === target.toLowerCase());
    if (!option) throw new Error(`Board has no "${target}" column`);
    const result = await this.requestMove(tracker, task, option.id);
    if (result.status === "moved") {
      store.setSetting(key, store.nowIso());
      this.applyMove(taskId, option);
    } else if (result.reason !== "stale") {
      store.setSetting(key, store.nowIso());
    }
  }

  private async requestMove(
    tracker: Tracker,
    task: Task,
    optionId: string,
  ): Promise<TrackerSetStatusResult> {
    const board = task.tracker!.board!;
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

  private applyMove(taskId: string, option: { id: string; name: string }): Task | undefined {
    const { store } = this.ctx;
    return store.tx(() => {
      const t = store.tasks.get(taskId);
      if (!t?.tracker?.board) return t;
      return store.putTask({
        ...t,
        tracker: {
          ...t.tracker,
          board: { ...t.tracker.board, status: option.name, statusOptionId: option.id },
        },
        updatedAt: store.nowIso(),
      });
    });
  }

  /** "Start work": create the issue's linked branch on GitHub, then sync to make its worktree. */
  async startIssue(taskId: string): Promise<Task> {
    const { store, hostHub } = this.ctx;
    const task = store.tasks.require(taskId);
    if (!task.tracker)
      throw new SwitchyardError("invalid_request", "This task is not from a tracker");
    if (task.tracker.branch !== null)
      throw new SwitchyardError("conflict", "This issue already has a branch");
    const tracker = store.trackers.require(task.tracker.trackerId);
    const checkout = store.checkouts
      .list("project_id = ?", [task.projectId])
      .find((c) => c.hostId === tracker.hostId);
    if (!checkout)
      throw new SwitchyardError(
        "invalid_request",
        `No checkout of this project on ${this.hostName(tracker.hostId)}`,
      );
    const title = store.tasks.require(taskId).title;
    await hostHub.request(
      tracker.hostId,
      {
        type: "tracker.startIssue",
        checkoutPath: checkout.path,
        repository: task.tracker.repository,
        number: task.tracker.number,
        branch: issueBranch(task.tracker.number, title),
        base: checkout.defaultBranch,
      },
      { timeoutMs: 60_000 },
    );
    await this.sync(tracker.id);
    return store.tasks.require(taskId);
  }

  /** Set a card's board column by hand. */
  async setStatus(taskId: string, status: string): Promise<Task> {
    const { store } = this.ctx;
    const task = store.tasks.require(taskId);
    const board = task.tracker?.board;
    if (!task.tracker || !board)
      throw new SwitchyardError("invalid_request", "This task has no board column");
    const tracker = store.trackers.require(task.tracker.trackerId);
    if (!tracker.writeBack || !tracker.board)
      throw new SwitchyardError("forbidden", "Write-back is off for this tracker");
    const option = board.options.find((o) => o.name.toLowerCase() === status.toLowerCase());
    if (!option) throw new SwitchyardError("invalid_request", "Unknown column");
    const result = await this.requestMove(tracker, task, option.id);
    if (result.status === "skipped") {
      const message =
        result.reason === "stale"
          ? "The card moved on GitHub; refresh and try again"
          : result.reason === "shared"
            ? "This card is shared and the tracker does not move shared cards"
            : `This card is no longer assigned to ${tracker.login ?? "the tracker's user"}`;
      throw new SwitchyardError("conflict", message);
    }
    return this.applyMove(taskId, option) ?? store.tasks.require(taskId);
  }
}
