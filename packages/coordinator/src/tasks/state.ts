import {
  type Run,
  type RunState,
  SwitchyardError,
  type Task,
  type TaskState,
} from "@switchyard/protocol";

/** Allowed manual task transitions (spec section 9 / plan). */
export const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  backlog: ["ready", "canceled"],
  ready: ["backlog", "in_progress", "canceled"],
  in_progress: ["review", "ready", "backlog", "canceled", "done"],
  review: ["in_progress", "done", "ready", "canceled"],
  done: ["ready", "backlog"],
  canceled: ["backlog"],
};

export const STATE_LABELS: Readonly<Record<TaskState, string>> = {
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In progress",
  review: "Review",
  done: "Done",
  canceled: "Canceled",
};

/** Run states that hold the task's execution slot (`queued` is a pending retry). */
export const LIVE_RUN_STATES: readonly RunState[] = [
  "dispatching",
  "uncertain",
  "running",
  "waiting_input",
  "checking",
];
export const TERMINAL_RUN_STATES: readonly RunState[] = [
  "succeeded",
  "failed",
  "interrupted",
  "canceled",
];

export function isLiveRun(run: Run | null | undefined): boolean {
  return !!run && LIVE_RUN_STATES.includes(run.state);
}

export function isTerminalTask(state: TaskState): boolean {
  return state === "done" || state === "canceled";
}

export interface MoveOptions {
  confirm?: boolean;
  onRunning?: "pause" | "stop";
  /** The task's current run, if any. */
  run?: Run | null;
  /** Effective acceptance checks (task policy, else project). */
  checks: string[];
  /** True when the move is the explicit Accept action. */
  accepted?: boolean;
  /** True when the dispatcher starts the task. */
  byDispatcher?: boolean;
}

export interface MovePlan {
  from: TaskState;
  to: TaskState;
  /** What to do with live work first. */
  runningAction: "pause" | "stop" | null;
  /** Review -> In progress starts a new attempt. */
  newAttempt: boolean;
  /** Reasons Done needed confirmation (empty when it did not). */
  unresolved: string[];
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new SwitchyardError("invalid_transition", message, details);
}

/**
 * Why moving `task` to Done needs confirmation: required checks without a passing result, or
 * required human review without an explicit accept.
 */
export function unresolvedForDone(
  task: Task,
  run: Run | null | undefined,
  checks: string[],
  accepted = false,
): string[] {
  const out: string[] = [];
  if (checks.length > 0) {
    const results = run?.checks ?? [];
    const failing = checks.filter((c) => {
      const r = results.find((x) => x.command === c);
      return r?.exitCode !== 0;
    });
    if (failing.length > 0) {
      const missing = failing.some((c) => !results.find((x) => x.command === c));
      out.push(
        missing ? `Checks have not passed: ${failing.join(", ")}` : `Checks failed: ${failing[0]}`,
      );
    }
  }
  if (task.policy.completion.requireHumanReview && !accepted) {
    out.push("Human review is required and the task has not been accepted");
  }
  return out;
}

/**
 * Validate a move and say what it needs. Throws `invalid_transition` with a concrete reason.
 * Pure: the caller applies side effects (pause/stop, new attempt, state write).
 */
export function move(task: Task, to: TaskState, opts: MoveOptions): MovePlan {
  const from = task.state;
  const fromLabel = STATE_LABELS[from];
  const toLabel = STATE_LABELS[to];
  if (from === to) {
    return { from, to, runningAction: null, newAttempt: false, unresolved: [] };
  }
  if (!TRANSITIONS[from].includes(to)) {
    let reason = `A task in ${fromLabel} cannot be moved to ${toLabel}`;
    if (from === "backlog" && (to === "in_progress" || to === "review" || to === "done")) {
      reason = `A Backlog task must be made Ready before it can move to ${toLabel}`;
    } else if (from === "ready" && to === "review") {
      reason = "A task reaches Review only after a run finishes";
    } else if (from === "ready" && to === "done") {
      reason = "A Ready task has not run yet; cancel it instead or run it first";
    } else if (from === "done") {
      reason = `A Done task can only be reopened to Ready or Backlog, not ${toLabel}`;
    } else if (from === "canceled") {
      reason = `A canceled task can only be restored to Backlog, not ${toLabel}`;
    }
    invalid(reason, { from, to });
  }
  if (from === "ready" && to === "in_progress" && !opts.byDispatcher) {
    invalid("Ready tasks start when the dispatcher picks them up; use Run now to start it now", {
      from,
      to,
    });
  }
  let runningAction: MovePlan["runningAction"] = null;
  if (from === "in_progress" && isLiveRun(opts.run)) {
    if (!opts.onRunning) {
      invalid(
        `A running task cannot be moved to ${toLabel} without choosing to pause automation or stop execution`,
        { from, to, choices: ["pause", "stop"] },
      );
    }
    runningAction = opts.onRunning;
  }
  let unresolved: string[] = [];
  if (to === "done") {
    unresolved = unresolvedForDone(task, opts.run, opts.checks, opts.accepted);
    const needsConfirm = from === "in_progress" || unresolved.length > 0;
    if (needsConfirm && !opts.confirm) {
      const why =
        unresolved.length > 0
          ? unresolved.join("; ")
          : "The task is still in progress and has not been reviewed";
      invalid(`Moving to Done needs confirmation: ${why}`, {
        from,
        to,
        needsConfirm: true,
        unresolved,
      });
    }
  }
  return {
    from,
    to,
    runningAction,
    newAttempt: from === "review" && to === "in_progress",
    unresolved,
  };
}

/**
 * DFS over dependencies. Throws `dependency_cycle` naming the cycle's task titles when making
 * `taskId` depend on `deps` would close a cycle; `not_found`-style unknown ids are ignored here.
 */
export function detectCycle(
  taskId: string,
  deps: readonly string[],
  lookup: (id: string) => Pick<Task, "id" | "title" | "dependencies"> | undefined,
  selfTitle?: string,
): void {
  const titleOf = (id: string) =>
    (id === taskId ? selfTitle : undefined) ?? lookup(id)?.title ?? id;
  const depsOf = (id: string): readonly string[] =>
    id === taskId ? deps : (lookup(id)?.dependencies ?? []);
  const visiting = new Set<string>();
  const done = new Set<string>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) return path.slice(path.indexOf(id)).concat(id);
    if (done.has(id)) return null;
    visiting.add(id);
    path.push(id);
    for (const d of depsOf(id)) {
      const c = visit(d);
      if (c) return c;
    }
    path.pop();
    visiting.delete(id);
    done.add(id);
    return null;
  };
  const cycle = visit(taskId);
  if (cycle) {
    const names = cycle.map(titleOf);
    throw new SwitchyardError("dependency_cycle", `Dependency cycle: ${names.join(" → ")}`, {
      cycle,
    });
  }
}

/** `sy/<slug>-<short id>` default branch for a task's worktree. */
export function defaultBranch(task: Pick<Task, "id" | "title">): string {
  const slug =
    task.title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "task";
  const short = task.id.slice(-6).toLowerCase();
  return `sy/${slug}-${short}`;
}
