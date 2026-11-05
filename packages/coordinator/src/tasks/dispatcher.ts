import {
  type Checkout,
  DispatchStartResult,
  type Eligibility,
  type HostCommand,
  type HostCommandOf,
  MARKERS,
  type NowResponse,
  newId,
  type Profile,
  type Project,
  ReconcileResult,
  type Run,
  type Session,
  SwitchyardError,
  type Task,
} from "@switchyard/protocol";
import type { CoordinatorContext } from "../context.js";
import { LIVE_RUNTIMES, resolveProfile } from "../sessions/service.js";
import { predictedWorktreePath, recordCreatedWorkspace, worktreeDirOf } from "../workspaces.js";
import { putTaskState, raiseFailed, saveRun, shortError } from "./common.js";
import { defaultBranch, isLiveRun, LIVE_RUN_STATES } from "./state.js";

export interface DispatcherOptions {
  /** Periodic tick (default 2 s); 0 disables the timer (tests call `tick()`). */
  tickMs: number;
  /** Infra retry backoff (default 30 s). */
  retryBackoffMs: number;
  /** Infra retries per run before the task is blocked (default 2). */
  maxInfraRetries: number;
  /** Re-ask a connected host about an uncertain launch at most this often (default 30 s). */
  reconcileEveryMs: number;
  /**
   * Receipt timeout for `dispatch.start` (default 10 min): the host waits for worktree setup
   * before starting Pi. A disconnect still makes the launch `uncertain` right away.
   */
  startTimeoutMs: number;
}

export const DEFAULT_DISPATCHER_OPTIONS: DispatcherOptions = {
  tickMs: 2000,
  retryBackoffMs: 30_000,
  maxInfraRetries: 2,
  reconcileEveryMs: 30_000,
  startTimeoutMs: 10 * 60_000,
};

type Wait = Extract<Eligibility, { eligible: false }>["wait"];

/** Where and how a task would run. */
export interface LaunchPlan {
  hostId: string;
  hostName: string;
  project: Project;
  profile: Profile;
  /** Session to reuse (continue mode, re-runs, new attempts). */
  session: Session | null;
  /** Reused session is live and idle: start the run with `session.prompt`. */
  viaPrompt: boolean;
  workspace:
    | { kind: "path"; path: string; workspaceId: string | null }
    | { kind: "create"; checkout: Checkout; branch: string; base: string };
}

type Evaluation = { eligibility: Eligibility; plan?: LaunchPlan };

/** Errors that a retry cannot fix. */
const DETERMINISTIC_ERRORS = new Set([
  "branch_invalid",
  "path_collision",
  "repo_mismatch",
  "not_a_git_repo",
  "pi_incompatible",
  "native_session_missing",
  "invalid_request",
  "forbidden",
  "workspace_active_sessions",
]);

const VIA_PREFIX = "runVia:";
/** The revision a launch was created with; takeovers and returns only ever raise the run's. */
const LAUNCH_REV_PREFIX = "runLaunchRev:";

export const TAKEN_OVER_BEFORE_LAUNCH = "Taken over before launch was confirmed";
export const HOST_RESTARTED_DURING_LAUNCH = "Host restarted during launch; verify and resume";

/** The host restarted after Pi may have been spawned: never replay the prompt. */
function startedUnknown(details: unknown): boolean {
  return (details as { started?: unknown } | null | undefined)?.started === "unknown";
}

/** A duplicate `dispatch.start` while the host is still launching the first one. */
function stillLaunching(error: { code: string; details?: unknown }): boolean {
  const state = (error.details as { state?: string } | undefined)?.state;
  return error.code === "conflict" && (state === "accepted" || state === "workspace_ready");
}

/** The prompt that starts a run. */
export function buildRunPrompt(
  task: Pick<Task, "title" | "objective" | "acceptanceCriteria">,
  attempt: number,
  feedback: string[] = [],
  opts: { watch?: boolean } = {},
): string {
  const parts = [`# Task: ${task.title}`];
  if (task.objective.trim()) parts.push(task.objective.trim());
  if (task.acceptanceCriteria.length > 0) {
    parts.push(
      `## Acceptance criteria\n${task.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`,
    );
  }
  if (attempt > 1 && feedback.length > 0) {
    parts.push(
      `## Review feedback (attempt ${attempt})\nA reviewer asked for these changes to the previous attempt:\n${feedback.map((f) => `- ${f}`).join("\n")}`,
    );
  }
  let tail = `When you have finished, end your final message with a line \`${MARKERS.done}\`. If you cannot proceed, end with \`${MARKERS.blocked} <reason>\`.`;
  if (opts.watch) {
    tail += ` If nothing relevant changed and there is nothing to do, end with \`${MARKERS.noChange}\` instead.`;
  }
  parts.push(tail);
  return parts.join("\n\n");
}

function wait(w: Wait, message: string): Evaluation {
  return { eligibility: { eligible: false, wait: w, message } };
}

/**
 * Picks Ready tasks and launches them on hosts. Every launch is persisted (Run dispatching +
 * Session starting + task in progress) before the host is contacted; lost receipts make the run
 * `uncertain` until the host reconnects and `dispatch.reconcile` settles it. Never fails over.
 */
export class Dispatcher {
  private timer: NodeJS.Timeout | null = null;
  private scheduled = false;
  private ticking = false;
  private stopped = false;
  /** Runs with a send in flight. */
  private inflight = new Set<string>();
  private lastReconcile = new Map<string, number>();
  private unsubscribe: (() => void)[] = [];

  constructor(
    private readonly ctx: CoordinatorContext,
    readonly opts: DispatcherOptions = DEFAULT_DISPATCHER_OPTIONS,
  ) {}

  start(): void {
    const { store, hub } = this.ctx;
    // Launches interrupted by a coordinator restart: nothing is in flight any more.
    store.tx(() => {
      for (const r of store.runs.list("state = 'dispatching'")) {
        saveRun(this.ctx, r, { state: "uncertain" });
      }
    });
    const on = <K extends Parameters<typeof hub.on>[0]>(name: K, fn: (...a: never[]) => void) => {
      hub.on(name, fn as never);
      this.unsubscribe.push(() => hub.off(name, fn as never));
    };
    on("task.changed", () => this.schedule());
    on("run.changed", (run: Run) => {
      if (!LIVE_RUN_STATES.includes(run.state)) this.schedule();
    });
    on("host.connected", ({ hostId }: { hostId: string }) => {
      void this.reconcileHost(hostId).finally(() => this.schedule());
    });
    on("host.disconnected", ({ hostId }: { hostId: string }) => this.onHostLost(hostId));
    on("event", (e: { type: string }) => {
      if (e.type === "settings.updated" || e.type === "project.updated") this.schedule();
      else if (e.type === "session.updated") this.schedule();
    });
    if (this.opts.tickMs > 0) {
      this.timer = setInterval(() => this.tick(), this.opts.tickMs);
      this.timer.unref();
    }
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
  }

  /** Coalesced tick on the next turn of the event loop. */
  schedule(): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (!this.stopped) this.tick();
    });
  }

  /** Evaluate Ready tasks in (priority, position, createdAt) order and launch the eligible. */
  tick(): void {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      for (const task of this.readyTasks()) {
        const ev = this.evaluate(task);
        if (ev.eligibility.eligible && ev.plan) {
          try {
            this.launch(task.id, ev.plan, {});
          } catch (err) {
            this.ctx.log.warn({ err, taskId: task.id }, "dispatch failed");
          }
        }
      }
      this.reconcileStale();
    } finally {
      this.ticking = false;
    }
  }

  private readyTasks(): Task[] {
    return this.ctx.store.tasks
      .list("state = 'ready'")
      .sort(
        (a, b) =>
          a.priority - b.priority ||
          a.position - b.position ||
          a.createdAt.localeCompare(b.createdAt),
      );
  }

  // ---- eligibility -----------------------------------------------------------------------

  eligibility(task: Task, opts: { manual?: boolean } = {}): Eligibility {
    return this.evaluate(task, opts).eligibility;
  }

  /** Eligibility plus the launch plan when eligible. */
  evaluate(task: Task, opts: { manual?: boolean } = {}): Evaluation {
    const { store } = this.ctx;
    if (task.state !== "ready") {
      return wait("not_ready", `The task is ${task.state.replace("_", " ")}, not Ready`);
    }
    const current = task.currentRunId ? store.runs.get(task.currentRunId) : undefined;
    if (
      current &&
      current.controlMode === "human" &&
      (isLiveRun(current) || current.state === "queued")
    ) {
      return wait(
        "already_dispatched",
        "Paused: a person has taken over this run; return it to automation to continue",
      );
    }
    if (current && isLiveRun(current)) {
      if (current.state === "uncertain") {
        const name = current.hostId ? (store.hosts.get(current.hostId)?.name ?? "host") : "host";
        return wait("already_dispatched", `Waiting for host ${name} to confirm launch`);
      }
      return wait("already_dispatched", "A run for this task is already active");
    }
    const now = store.now().getTime();
    if (!opts.manual && current?.state === "queued" && current.nextAttemptAt) {
      const at = Date.parse(current.nextAttemptAt);
      if (at > now) {
        return wait(
          "retry_backoff",
          `Retrying launch in ${Math.ceil((at - now) / 1000)} s (retry ${current.infraRetries} of ${this.opts.maxInfraRetries})`,
        );
      }
    }
    const project = store.projects.get(task.projectId);
    if (!project) return wait("invalid_configuration", "The task's project no longer exists");
    if (!opts.manual) {
      if (store.dispatchPaused) return wait("dispatch_paused", "Dispatch is paused");
      if (!project.automationEnabled) {
        return wait(
          "project_automation_disabled",
          `Automation is disabled for project ${project.name}`,
        );
      }
      if (task.notBefore && Date.parse(task.notBefore) > now) {
        return wait("scheduled_time", `Scheduled for ${task.notBefore}`);
      }
    }
    const deps = task.dependencies.map((id) => store.tasks.get(id)).filter((d): d is Task => !!d);
    // A canceled dependency will never be done: waiting on it would wait forever.
    const canceled = deps.find((d) => d.state === "canceled");
    if (canceled) {
      return wait("invalid_configuration", `Dependency ${canceled.title} was canceled`);
    }
    const unmet = deps.filter((d) => d.state !== "done");
    if (unmet.length > 0) {
      return wait("dependency", `Waiting for ${unmet.map((d) => d.title).join(", ")}`);
    }
    const target = this.resolveTarget(task, project);
    if ("error" in target) return wait(target.wait, target.error);
    const host = store.hosts.get(target.hostId);
    if (!host || host.revokedAt) {
      return wait("invalid_configuration", "The task's host is unknown or was revoked");
    }
    if (!this.ctx.hostHub.isConnected(host.id)) {
      return wait("host_offline", `Host ${host.name} is offline`);
    }
    if (!host.piCompatible) {
      return wait(
        "invalid_configuration",
        `Pi ${host.piVersion ?? "(not found)"} on ${host.name} is outside the tested range`,
      );
    }
    let profile: Profile;
    try {
      profile = resolveProfile(this.ctx, task.policy.profileId, project);
    } catch {
      return wait("invalid_configuration", "No Pi profile could be resolved for this task");
    }
    const active = this.activeRunCount(project.id);
    if (active >= project.maxConcurrentRuns) {
      return wait(
        "project_limit",
        `Project ${project.name} is at its limit of ${project.maxConcurrentRuns} concurrent run${project.maxConcurrentRuns === 1 ? "" : "s"}`,
      );
    }
    if (target.workspace.kind === "path" && project.workspaceSharing === "single_writer") {
      const busy = this.liveSessionsAt(host.id, target.workspace).filter(
        (s) => s.id !== target.session?.id,
      );
      if (busy.length > 0) {
        return wait("workspace_occupied", `Workspace is in use by session ${busy[0]!.title}`);
      }
    }
    if (target.session && LIVE_RUNTIMES.includes(target.session.runtime)) {
      if (target.session.runtime !== "idle") {
        return wait(
          "workspace_occupied",
          `Session ${target.session.title} is ${target.session.runtime.replace("_", " ")}`,
        );
      }
    }
    return {
      eligibility: { eligible: true, hostId: host.id, hostName: host.name },
      plan: {
        hostId: host.id,
        hostName: host.name,
        project,
        profile,
        session: target.session,
        viaPrompt: !!target.session && target.session.runtime === "idle",
        workspace: target.workspace,
      },
    };
  }

  private activeRunCount(projectId: string): number {
    const states = LIVE_RUN_STATES.map(() => "?").join(",");
    const row = this.ctx.store.st
      .get(
        `SELECT COUNT(*) AS n FROM runs r JOIN tasks t ON t.id = r.task_id WHERE t.project_id = ? AND r.state IN (${states})`,
      )
      .get(projectId, ...LIVE_RUN_STATES) as { n: number };
    return row.n;
  }

  private liveSessionsAt(
    hostId: string,
    ws: { path: string; workspaceId: string | null },
  ): Session[] {
    return this.ctx.store.sessions
      .list("host_id = ? AND archived_at IS NULL", [hostId])
      .filter(
        (s) =>
          LIVE_RUNTIMES.includes(s.runtime) &&
          !s.readOnly &&
          ((ws.workspaceId && s.workspaceId === ws.workspaceId) || s.cwd === ws.path),
      );
  }

  /** Host, session reuse and workspace for a task. */
  private resolveTarget(
    task: Task,
    project: Project,
  ):
    | { hostId: string; session: Session | null; workspace: LaunchPlan["workspace"] }
    | { error: string; wait: Wait } {
    const { store } = this.ctx;
    const session = task.sessionId ? store.sessions.get(task.sessionId) : undefined;
    if (session && !session.archivedAt && !session.readOnly) {
      const ws = session.workspaceId ? store.workspaces.get(session.workspaceId) : undefined;
      if (ws && !ws.archivedAt) {
        return {
          hostId: session.hostId,
          session,
          workspace: { kind: "path", path: ws.path, workspaceId: ws.id },
        };
      }
      if (session.nativeHandle && session.cwd) {
        return {
          hostId: session.hostId,
          session,
          workspace: { kind: "path", path: session.cwd, workspaceId: session.workspaceId },
        };
      }
      if (task.policy.workspace.mode === "new_worktree") {
        // Never started (pre-start failure): start the same session id in a new worktree.
        const r = this.newWorktree(task, project, session.hostId);
        if ("error" in r) return r;
        return { hostId: session.hostId, session, workspace: r };
      }
    }
    if (task.policy.workspace.mode === "existing") {
      const ws = store.workspaces.get(task.policy.workspace.workspaceId);
      if (!ws || ws.archivedAt) {
        return { wait: "invalid_configuration", error: "The task's workspace no longer exists" };
      }
      if (task.policy.hostId && task.policy.hostId !== ws.hostId) {
        return {
          wait: "invalid_configuration",
          error: "The task's host does not have its workspace",
        };
      }
      return {
        hostId: ws.hostId,
        session: null,
        workspace: { kind: "path", path: ws.path, workspaceId: ws.id },
      };
    }
    const hostId =
      task.policy.hostId ??
      project.defaultHostId ??
      store.checkouts.list("project_id = ?", [project.id])[0]?.hostId ??
      null;
    if (!hostId) {
      return { wait: "invalid_configuration", error: "No host is configured for this project" };
    }
    const r = this.newWorktree(task, project, hostId);
    if ("error" in r) return r;
    return { hostId, session: null, workspace: r };
  }

  private newWorktree(
    task: Task,
    project: Project,
    hostId: string,
  ): Extract<LaunchPlan["workspace"], { kind: "create" }> | { error: string; wait: Wait } {
    const checkout = this.ctx.store.checkouts.list("project_id = ? AND host_id = ?", [
      project.id,
      hostId,
    ])[0];
    if (!checkout) {
      const name = this.ctx.store.hosts.get(hostId)?.name ?? hostId;
      return {
        wait: "invalid_configuration",
        error: `Project ${project.name} has no checkout on host ${name}`,
      };
    }
    const policy = task.policy.workspace.mode === "new_worktree" ? task.policy.workspace : null;
    return {
      kind: "create",
      checkout,
      branch: policy?.branch ?? defaultBranch(task),
      base: policy?.base ?? checkout.defaultBranch,
    };
  }

  // ---- launching -------------------------------------------------------------------------

  /** `POST /api/tasks/:id/run-now`: dispatch now or explain the wait. */
  runNow(taskId: string): Run {
    const task = this.ctx.store.tasks.require(taskId);
    if (task.state !== "ready") {
      throw new SwitchyardError(
        "invalid_transition",
        task.state === "backlog"
          ? "Make the task Ready before running it"
          : `A task in ${task.state.replace("_", " ")} cannot be run now`,
      );
    }
    const ev = this.evaluate(task, { manual: true });
    if (!ev.eligibility.eligible || !ev.plan) {
      const e = ev.eligibility as Extract<Eligibility, { eligible: false }>;
      throw new SwitchyardError("conflict", e.message, { wait: e.wait });
    }
    return this.launch(task.id, ev.plan, {});
  }

  /**
   * Start a new attempt from Review on the same session (or a fresh one with `fresh`). The
   * reviewer's feedback goes into the prompt.
   */
  newAttempt(taskId: string, opts: { fresh?: boolean } = {}): Run {
    const { store } = this.ctx;
    const task = store.tasks.require(taskId);
    const current = task.currentRunId ? store.runs.get(task.currentRunId) : undefined;
    const blockedInProgress = task.state === "in_progress" && !isLiveRun(current);
    if (task.state !== "review" && !blockedInProgress) {
      throw new SwitchyardError(
        "invalid_transition",
        "A new attempt starts from Review (or a blocked task)",
      );
    }
    if (current?.controlMode === "human" && isLiveRun(current)) {
      throw new SwitchyardError(
        "conflict",
        "A person has taken over this run; return it to automation first",
      );
    }
    let probe: Task = { ...task, state: "ready" };
    const session = task.sessionId ? store.sessions.get(task.sessionId) : undefined;
    if (opts.fresh) {
      const wsId = session?.workspaceId ?? null;
      probe = {
        ...probe,
        sessionId: null,
        policy: wsId
          ? { ...probe.policy, workspace: { mode: "existing", workspaceId: wsId } }
          : probe.policy,
      };
    } else if (session && !LIVE_RUNTIMES.includes(session.runtime) && !session.nativeHandle) {
      throw new SwitchyardError(
        "native_session_missing",
        "The previous session cannot be resumed; start a fresh session instead",
        { alternative: `/api/tasks/${task.id}/new-attempt?fresh=true` },
      );
    }
    const ev = this.evaluate(probe, { manual: true });
    if (!ev.eligibility.eligible || !ev.plan) {
      const e = ev.eligibility as Extract<Eligibility, { eligible: false }>;
      throw new SwitchyardError(
        e.wait === "host_offline" ? "host_unreachable" : "conflict",
        e.message,
        { wait: e.wait },
      );
    }
    return this.launch(task.id, ev.plan, {
      newAttempt: true,
      taskPatch: opts.fresh ? { sessionId: null, policy: probe.policy } : {},
    });
  }

  /**
   * Persist the launch (Run dispatching, Session starting, task in progress) in one
   * transaction, then contact the host.
   */
  private launch(
    taskId: string,
    plan: LaunchPlan,
    opts: { newAttempt?: boolean; taskPatch?: Partial<Task> },
  ): Run {
    const { store } = this.ctx;
    const run = store.tx(() => {
      const task = { ...store.tasks.require(taskId), ...(opts.taskPatch ?? {}) };
      const now = store.nowIso();
      const prev = task.currentRunId ? store.runs.get(task.currentRunId) : undefined;
      const queued = prev?.state === "queued" ? prev : undefined;
      const prevRuns = store.runs.list("task_id = ?", [task.id]);
      const maxAttempt = prevRuns.reduce((m, r) => Math.max(m, r.attempt), 0);
      const sessionRuns = plan.session ? store.runs.list("session_id = ?", [plan.session.id]) : [];
      const maxRevision = sessionRuns.reduce((m, r) => Math.max(m, r.controlRevision), 0);
      const host = store.hosts.require(plan.hostId);
      const accounting =
        host.capabilities?.tokenAccounting || host.capabilities?.costAccounting
          ? "available"
          : "unavailable";
      const id = queued?.id ?? newId("run");
      const run: Run = {
        id,
        taskId: task.id,
        sessionId: null,
        hostId: plan.hostId,
        dispatchKey: id,
        attempt: queued ? queued.attempt : maxAttempt + 1,
        state: "dispatching",
        controlMode: "automation",
        controlRevision: Math.max(1, maxRevision + (plan.session ? 1 : 0)),
        continuationsUsed: 0,
        infraRetries: queued?.infraRetries ?? 0,
        nextAttemptAt: null,
        startedAt: null,
        endedAt: null,
        outcome: null,
        limits: task.policy.continuation,
        usage: {
          tokens: null,
          costUsd: null,
          accounting,
          note:
            accounting === "unavailable"
              ? "Token/cost accounting not reported by this Pi provider"
              : null,
        },
        checks: [],
        createdAt: queued?.createdAt ?? now,
        updatedAt: now,
      };
      let session: Session;
      if (plan.session) {
        const cur = store.sessions.require(plan.session.id);
        session = {
          ...cur,
          runId: id,
          taskId: task.id,
          lastActivityAt: now,
          ...(plan.viaPrompt
            ? {}
            : { runtime: "starting" as const, runtimeDetail: null, profileSnapshot: plan.profile }),
        };
      } else {
        const ws = plan.workspace;
        session = {
          id: newId("ses"),
          title: task.title,
          subtitle: null,
          hostId: plan.hostId,
          workspaceId: ws.kind === "path" ? ws.workspaceId : null,
          projectId: task.projectId,
          cwd:
            ws.kind === "path"
              ? ws.path
              : predictedWorktreePath(ws.checkout, store.projects.get(task.projectId), ws.branch),
          nativeHandle: null,
          profileSnapshot: plan.profile,
          runtime: "starting",
          runtimeDetail: null,
          connectivity: host.connectivity,
          runId: id,
          taskId: task.id,
          provenance: "created",
          readOnly: false,
          lastActivityAt: now,
          archivedAt: null,
          queue: { steering: [], followUp: [] },
          stats: null,
          lastAssistantText: null,
          createdAt: now,
        };
      }
      run.sessionId = session.id;
      store.putSession(session);
      saveRun(this.ctx, run);
      if (plan.viaPrompt) store.setSetting(VIA_PREFIX + id, "prompt");
      store.setSetting(LAUNCH_REV_PREFIX + id, run.controlRevision);
      putTaskState(this.ctx, task, "in_progress", {
        currentRunId: id,
        sessionId: session.id,
        blocked: null,
        review: opts.newAttempt ? { ...task.review, changesRequested: false } : task.review,
      });
      this.ctx.attention.resolve({ taskId: task.id, reason: "failed" });
      return store.runs.require(id);
    });
    void this.send(run.id);
    return run;
  }

  private viaPrompt(runId: string): boolean {
    return this.ctx.store.getSetting<string | null>(VIA_PREFIX + runId, null) === "prompt";
  }

  /** The revision the launch was created with (never a later takeover's). */
  launchRevision(run: Run): number {
    return (
      this.ctx.store.getSetting<number | null>(LAUNCH_REV_PREFIX + run.id, null) ??
      run.controlRevision
    );
  }

  private isWatch(task: Task): boolean {
    if (task.origin.kind !== "automation") return false;
    return this.ctx.store.automations.get(task.origin.automationId)?.mode === "watch";
  }

  /** The exact command for a run (rebuilt identically on resend). */
  buildCommand(run: Run): HostCommand {
    const { store } = this.ctx;
    const task = store.tasks.require(run.taskId);
    const session = store.sessions.require(run.sessionId!);
    const prompt = buildRunPrompt(task, run.attempt, task.review.feedback, {
      watch: this.isWatch(task),
    });
    if (this.viaPrompt(run.id)) {
      return {
        type: "session.prompt",
        sessionId: session.id,
        text: prompt,
        images: [],
        mode: "prompt",
        origin: "automation",
        // Only sent under automation, so the current revision is an automation one.
        controlRevision: run.controlRevision,
      };
    }
    let workspace: HostCommandOf<"dispatch.start">["workspace"];
    const ws = session.workspaceId ? store.workspaces.get(session.workspaceId) : undefined;
    if (ws) workspace = { path: ws.path };
    else if (session.nativeHandle) workspace = { path: session.cwd };
    else {
      const project = store.projects.require(task.projectId);
      const target = this.newWorktree(task, project, session.hostId);
      if ("error" in target) throw new SwitchyardError("invalid_request", target.error);
      workspace = {
        createFrom: {
          checkoutPath: target.checkout.path,
          branch: target.branch,
          base: target.base,
          setupCommand: project.setupCommand,
          worktreeDir: worktreeDirOf(project),
        },
      };
    }
    return {
      type: "dispatch.start",
      dispatchKey: run.dispatchKey,
      runId: run.id,
      taskId: task.id,
      sessionId: session.id,
      projectId: task.projectId,
      title: task.title,
      workspace,
      nativeHandle: session.nativeHandle,
      profile: session.profileSnapshot,
      prompt,
      // The launch's own revision: a resend after a takeover must never carry the newer one.
      controlRevision: this.launchRevision(run),
      controlMode: run.controlMode,
    };
  }

  private isHuman(runId: string): boolean {
    return this.ctx.store.runs.get(runId)?.controlMode === "human";
  }

  /**
   * Send (or resend) a run's launch command and apply the outcome. Only under automation: a
   * run a person took over is settled by `reconcileHuman`, never launched.
   */
  private async send(runId: string): Promise<void> {
    if (this.inflight.has(runId)) return;
    const { store, hostHub } = this.ctx;
    const run = store.runs.get(runId);
    if (!run?.hostId || !(run.state === "dispatching" || run.state === "uncertain")) return;
    if (run.controlMode !== "automation") return;
    let cmd: HostCommand;
    try {
      cmd = this.buildCommand(run);
    } catch (err) {
      this.applyFailure(runId, shortError(err), false);
      return;
    }
    this.inflight.add(runId);
    try {
      if (cmd.type === "session.prompt") {
        await hostHub.request(
          run.hostId,
          {
            type: "session.setControl",
            sessionId: cmd.sessionId,
            controlRevision: run.controlRevision,
            mode: "automation",
          },
          { commandId: `ctl_${run.dispatchKey}_${run.controlRevision}` },
        );
        if (this.stopped) return;
        if (this.isHuman(runId)) {
          await this.reconcileHuman(runId);
          return;
        }
      }
      const receipt = await hostHub.send(run.hostId, cmd, {
        commandId: `cmd_${run.dispatchKey}`,
        timeoutMs: cmd.type === "dispatch.start" ? this.opts.startTimeoutMs : undefined,
      });
      if (this.stopped) return;
      if (this.isHuman(runId)) {
        if (receipt.ok) this.adoptForHuman(runId, receipt.result);
        else if (stillLaunching(receipt.error)) this.markUncertain(runId);
        else if (startedUnknown(receipt.error.details))
          this.applyFailure(runId, receipt.error, false);
        else this.interruptForHuman(runId);
        return;
      }
      if (receipt.ok) this.applyStarted(runId, receipt.result);
      else if (stillLaunching(receipt.error)) this.markUncertain(runId);
      else this.applyFailure(runId, receipt.error, true);
    } catch (err) {
      if (this.stopped) return;
      const e = shortError(err);
      if (e.code === "timeout" || e.code === "host_unreachable") this.markUncertain(runId);
      else if (this.isHuman(runId)) this.markUncertain(runId);
      else this.applyFailure(runId, e, true);
    } finally {
      this.inflight.delete(runId);
    }
  }

  /**
   * A person took over a run whose launch is not confirmed. Launch commands still queued for a
   * disconnected host are withdrawn so a reconnect cannot deliver them; a connected host already
   * learned the takeover through `session.setControl` (it holds it for a session it has not
   * created yet and withholds the launch prompt).
   */
  onTakeover(runId: string): void {
    const run = this.ctx.store.runs.get(runId);
    if (!run?.hostId || !(run.state === "dispatching" || run.state === "uncertain")) return;
    const reason = "Launch withdrawn: a person took over";
    this.ctx.hostHub.withdraw(`cmd_${run.dispatchKey}`, reason);
    for (let rev = 1; rev <= run.controlRevision; rev++) {
      this.ctx.hostHub.withdraw(`ctl_${run.dispatchKey}_${rev}`, reason);
    }
  }

  /** Tell the host the run is under human control (current revision). */
  private async assertHumanControl(run: Run): Promise<boolean> {
    if (!run.hostId || !run.sessionId) return false;
    try {
      // Same id as the reconnect announcement (`HostHub.onHello`): joins it while it is pending,
      // and the host dedupes it otherwise.
      await this.ctx.hostHub.request(
        run.hostId,
        {
          type: "session.setControl",
          sessionId: run.sessionId,
          controlRevision: run.controlRevision,
          mode: "human",
        },
        { commandId: `ctl_${run.dispatchKey}_${run.controlRevision}` },
      );
      return true;
    } catch (err) {
      this.ctx.log.warn({ err, runId: run.id }, "session.setControl (human) failed");
      return false;
    }
  }

  /**
   * Settle an unconfirmed launch a person took over, without automating anything: the host
   * learns human control first; a started session is adopted under human control; a launch that
   * never started is interrupted for the person to decide.
   */
  private async reconcileHuman(runId: string): Promise<void> {
    const run = this.ctx.store.runs.get(runId);
    if (!run?.hostId || !(run.state === "dispatching" || run.state === "uncertain")) return;
    if (!(await this.assertHumanControl(run))) return;
    if (this.stopped) return;
    if (this.viaPrompt(run.id)) {
      // The session already existed and is live; whether the prompt arrived is for the person.
      this.adoptForHuman(run.id, {});
      return;
    }
    let result: ReconcileResult;
    try {
      result = ReconcileResult.parse(
        await this.ctx.hostHub.request(run.hostId, {
          type: "dispatch.reconcile",
          dispatchKey: run.dispatchKey,
        }),
      );
    } catch (err) {
      this.ctx.log.warn({ err, runId: run.id }, "dispatch.reconcile failed");
      return;
    }
    if (this.stopped) return;
    if (!result.known) {
      this.interruptForHuman(run.id);
      return;
    }
    if (result.state === "started") {
      this.adoptForHuman(
        run.id,
        {
          sessionId: result.sessionId ?? run.sessionId,
          workspacePath: result.workspacePath,
          nativeHandle: result.nativeHandle,
        },
        result.runtime,
      );
      return;
    }
    if (result.state === "failed") {
      if (startedUnknown(result.errorDetails)) {
        this.applyFailure(
          run.id,
          {
            code: "internal",
            message: result.error ?? "Host restarted during launch",
            details: result.errorDetails,
          },
          false,
        );
      } else {
        this.interruptForHuman(run.id);
      }
    }
    // accepted / workspace_ready: the host knows about the takeover and will not send the
    // prompt; ask again on the next reconcile.
  }

  /** A launch that started is adopted under human control; the host is told so. */
  private adoptForHuman(runId: string, raw: unknown, runtime?: Session["runtime"] | null): void {
    this.applyStarted(runId, raw, runtime);
    const run = this.ctx.store.runs.get(runId);
    if (run?.controlMode === "human" && run.hostId && this.ctx.hostHub.isConnected(run.hostId)) {
      void this.assertHumanControl(run);
    }
  }

  /** A launch a person took over never started: interrupt it and leave it to them. */
  private interruptForHuman(runId: string): void {
    const { store } = this.ctx;
    store.tx(() => {
      const run = store.runs.get(runId);
      if (!run || !(run.state === "dispatching" || run.state === "uncertain")) return;
      saveRun(this.ctx, run, { state: "interrupted" });
      const session = run.sessionId ? store.sessions.get(run.sessionId) : undefined;
      if (session?.runtime === "starting") {
        store.putSession({
          ...session,
          runtime: "stopped",
          runtimeDetail: TAKEN_OVER_BEFORE_LAUNCH,
        });
      }
      const task = store.tasks.get(run.taskId);
      if (task && task.currentRunId === run.id) {
        putTaskState(this.ctx, task, task.state, { blocked: { reason: TAKEN_OVER_BEFORE_LAUNCH } });
      }
    });
  }

  /**
   * The host restarted after Pi may have been spawned and prompted. Never replay: adopt what the
   * host knows (native handle, worktree), interrupt the run and block the task for a person.
   */
  private applyStartUnknown(runId: string, details: unknown): void {
    const { store } = this.ctx;
    const d = (details ?? {}) as { nativeHandle?: unknown; workspacePath?: unknown };
    store.tx(() => {
      const run = store.runs.get(runId);
      if (!run || !(run.state === "dispatching" || run.state === "uncertain")) return;
      const session = run.sessionId ? store.sessions.get(run.sessionId) : undefined;
      if (session) {
        const parsed = DispatchStartResult.partial().safeParse({
          nativeHandle: d.nativeHandle ?? undefined,
          workspacePath: typeof d.workspacePath === "string" ? d.workspacePath : undefined,
        });
        const result = parsed.success ? parsed.data : {};
        let next: Session = { ...session };
        if (result.nativeHandle && !next.nativeHandle) next.nativeHandle = result.nativeHandle;
        if (result.workspacePath && !session.workspaceId && !this.viaPrompt(run.id)) {
          next = {
            ...next,
            cwd: result.workspacePath,
            workspaceId: this.recordWorkspace(run, session, result.workspacePath),
          };
        }
        if (next.runtime === "starting") {
          next = { ...next, runtime: "interrupted", runtimeDetail: HOST_RESTARTED_DURING_LAUNCH };
        }
        if (JSON.stringify(next) !== JSON.stringify(session)) store.putSession(next);
      }
      saveRun(this.ctx, run, { state: "interrupted" });
      const task = store.tasks.get(run.taskId);
      if (!task || task.currentRunId !== run.id) return;
      const blocked = putTaskState(this.ctx, task, task.state, {
        blocked: { reason: HOST_RESTARTED_DURING_LAUNCH },
      });
      raiseFailed(this.ctx, blocked, HOST_RESTARTED_DURING_LAUNCH);
    });
  }

  private markUncertain(runId: string): void {
    this.ctx.store.tx(() => {
      const run = this.ctx.store.runs.get(runId);
      if (run?.state === "dispatching") saveRun(this.ctx, run, { state: "uncertain" });
    });
  }

  private onHostLost(hostId: string): void {
    this.ctx.store.tx(() => {
      for (const r of this.ctx.store.runs.list("host_id = ? AND state = 'dispatching'", [hostId])) {
        saveRun(this.ctx, r, { state: "uncertain" });
      }
    });
  }

  /** Receipt ok (or reconcile `started`): the run is running. */
  private applyStarted(runId: string, raw: unknown, runtime?: Session["runtime"] | null): void {
    const { store } = this.ctx;
    store.tx(() => {
      const run = store.runs.get(runId);
      if (!run) return;
      const now = store.nowIso();
      const parsed = DispatchStartResult.partial().safeParse(raw ?? {});
      const result = parsed.success ? parsed.data : {};
      let session = run.sessionId ? store.sessions.get(run.sessionId) : undefined;
      if (session && !this.viaPrompt(run.id)) {
        let next: Session = { ...session };
        if (result.nativeHandle && !next.nativeHandle) next.nativeHandle = result.nativeHandle;
        const path = result.workspacePath;
        if (path && !session.workspaceId) {
          next = { ...next, cwd: path, workspaceId: this.recordWorkspace(run, session, path) };
        }
        if (runtime && next.runtime === "starting") next.runtime = runtime;
        if (JSON.stringify(next) !== JSON.stringify(session)) session = store.putSession(next);
      }
      // A run that already settled (fast session) keeps its later state.
      if (!(run.state === "dispatching" || run.state === "uncertain")) return;
      const state = session?.runtime === "waiting_input" ? "waiting_input" : "running";
      saveRun(this.ctx, run, { state, startedAt: run.startedAt ?? now });
    });
  }

  /** Record the worktree the host created for a run; returns its workspace id. */
  private recordWorkspace(run: Run, session: Session, path: string): string | null {
    const { store } = this.ctx;
    const existing = store.workspaceByPath(session.hostId, path);
    if (existing) return existing.id;
    const task = store.tasks.require(run.taskId);
    const project = store.projects.require(task.projectId);
    const checkout = store.checkouts.list("project_id = ? AND host_id = ?", [
      project.id,
      session.hostId,
    ])[0];
    if (!checkout) return null;
    const target = this.newWorktree(task, project, session.hostId);
    if ("error" in target) return null;
    return recordCreatedWorkspace(this.ctx, project, checkout, {
      path,
      branch: target.branch,
      baseBranch: target.base,
    }).id;
  }

  /**
   * A launch failed. Pre-start failures are retried (max `maxInfraRetries`, with backoff) while
   * the run is under automation; otherwise the task is blocked with `failed` attention.
   */
  private applyFailure(
    runId: string,
    error: { code: string; message: string; details?: unknown },
    mayRetry: boolean,
  ): void {
    if (startedUnknown(error.details)) {
      this.applyStartUnknown(runId, error.details);
      return;
    }
    const { store } = this.ctx;
    store.tx(() => {
      const run = store.runs.get(runId);
      if (!run || !(run.state === "dispatching" || run.state === "uncertain")) return;
      const task = store.tasks.get(run.taskId);
      const now = store.nowIso();
      const details = (error.details ?? {}) as {
        state?: string;
        stage?: string;
        started?: boolean;
      };
      const started =
        details.started === true || details.state === "started" || details.stage === "started";
      const failed = saveRun(this.ctx, run, {
        state: "failed",
        endedAt: now,
        outcome: { kind: "failed", summary: `Launch failed: ${error.message}` },
      });
      const session = run.sessionId ? store.sessions.get(run.sessionId) : undefined;
      if (session && session.runtime === "starting") {
        store.putSession({ ...session, runtime: "failed", runtimeDetail: error.message });
      }
      if (!task || task.currentRunId !== run.id) return;
      const retry =
        mayRetry &&
        !started &&
        !DETERMINISTIC_ERRORS.has(error.code) &&
        failed.controlMode === "automation" &&
        failed.infraRetries < this.opts.maxInfraRetries;
      if (retry) {
        const id = newId("run");
        const queued: Run = {
          ...failed,
          id,
          dispatchKey: id,
          state: "queued",
          infraRetries: failed.infraRetries + 1,
          nextAttemptAt: new Date(store.now().getTime() + this.opts.retryBackoffMs).toISOString(),
          startedAt: null,
          endedAt: null,
          outcome: null,
          checks: [],
          createdAt: now,
          updatedAt: now,
        };
        saveRun(this.ctx, queued);
        if (session) store.putSession({ ...store.sessions.require(session.id), runId: id });
        putTaskState(this.ctx, task, "ready", { currentRunId: id, blocked: null });
        return;
      }
      const reason = `Launch failed: ${error.message}`;
      const blocked = putTaskState(this.ctx, task, task.state, { blocked: { reason } });
      raiseFailed(this.ctx, blocked, reason);
    });
  }

  // ---- reconcile -------------------------------------------------------------------------

  /** On host (re)connect: settle every uncertain launch on that host. Never fails over. */
  async reconcileHost(hostId: string): Promise<void> {
    const runs = this.ctx.store.runs.list("host_id = ? AND state IN ('uncertain', 'dispatching')", [
      hostId,
    ]);
    for (const run of runs) {
      if (this.inflight.has(run.id)) continue;
      await this.reconcileRun(run);
    }
  }

  private async reconcileRun(stale: Run): Promise<void> {
    const run = this.ctx.store.runs.get(stale.id);
    if (!run?.hostId) return;
    this.lastReconcile.set(run.id, Date.now());
    if (run.controlMode !== "automation") {
      await this.reconcileHuman(run.id);
      return;
    }
    if (this.viaPrompt(run.id)) {
      // Host receipts dedupe by commandId: resending the same command is idempotent.
      await this.send(run.id);
      return;
    }
    let result: ReconcileResult;
    try {
      result = ReconcileResult.parse(
        await this.ctx.hostHub.request(run.hostId, {
          type: "dispatch.reconcile",
          dispatchKey: run.dispatchKey,
        }),
      );
    } catch (err) {
      this.ctx.log.warn({ err, runId: run.id }, "dispatch.reconcile failed");
      return;
    }
    if (this.stopped) return;
    if (!result.known) {
      // The host never saw it: resend with the same dispatchKey.
      this.markUncertain(run.id);
      await this.send(run.id);
      return;
    }
    if (result.state === "started") {
      this.applyStarted(
        run.id,
        {
          sessionId: result.sessionId ?? run.sessionId,
          workspacePath: result.workspacePath,
          nativeHandle: result.nativeHandle,
        },
        result.runtime,
      );
      return;
    }
    if (result.state === "failed") {
      this.applyFailure(
        run.id,
        {
          code: "internal",
          message: result.error ?? "Launch failed on host",
          details: result.errorDetails ?? undefined,
        },
        true,
      );
      return;
    }
    // accepted / workspace_ready: still launching on the host; resending returns its outcome.
    await this.send(run.id);
  }

  /** Periodically re-ask connected hosts about uncertain launches. */
  private reconcileStale(): void {
    const now = Date.now();
    for (const run of this.ctx.store.runs.list("state = 'uncertain'")) {
      if (!run.hostId || this.inflight.has(run.id)) continue;
      if (!this.ctx.hostHub.isConnected(run.hostId)) continue;
      const last = this.lastReconcile.get(run.id) ?? 0;
      if (now - last < this.opts.reconcileEveryMs) continue;
      void this.reconcileRun(run);
    }
  }

  // ---- Now -------------------------------------------------------------------------------

  now(): NowResponse {
    const { store } = this.ctx;
    const states = LIVE_RUN_STATES.map(() => "?").join(",");
    const running = store.runs
      .list(`state IN (${states})`, [...LIVE_RUN_STATES], "created_at")
      .map((r) => ({ taskId: r.taskId, runId: r.id, sessionId: r.sessionId }));
    const queued = this.readyTasks().map((t) => ({
      taskId: t.id,
      eligibility: this.eligibility(t),
    }));
    return { running, queued, dispatchPaused: store.dispatchPaused };
  }
}
