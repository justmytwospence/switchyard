import type { Run, Task, TaskState } from "@switchyard/protocol";
import type { CoordinatorContext } from "../context.js";

/** Acceptance checks for a task: its own, else the project's. */
export function effectiveChecks(ctx: CoordinatorContext, task: Task): string[] {
  if (task.policy.completion.checks !== null) return task.policy.completion.checks;
  return ctx.store.projects.get(task.projectId)?.checks ?? [];
}

const DONE_AT_PREFIX = "taskDoneAt:";

/** When the task last entered Done (stable across later edits), or null. */
export function taskDoneAt(ctx: CoordinatorContext, taskId: string): string | null {
  return ctx.store.getSetting<string | null>(DONE_AT_PREFIX + taskId, null);
}

/** Routine automation tasks that finish without ever raising attention leave the board. */
function quietRoutine(ctx: CoordinatorContext, task: Task): boolean {
  if (task.origin.kind !== "automation" || !task.origin.routine) return false;
  return ctx.store.attention.count("task_id = ?", [task.id]) === 0;
}

/**
 * Write a task with a new state. Records the Done timestamp (dependency triggers key on it) and
 * hides quiet routine tasks reaching Done. Joins the caller's transaction.
 */
export function putTaskState(
  ctx: CoordinatorContext,
  task: Task,
  state: TaskState,
  patch: Partial<Task> = {},
): Task {
  return ctx.store.tx(() => {
    const now = ctx.store.nowIso();
    const next: Task = { ...task, ...patch, state, updatedAt: now, lastActivityAt: now };
    if (state === "done" && task.state !== "done") {
      ctx.store.setSetting(DONE_AT_PREFIX + task.id, now);
      if (patch.hiddenFromBoard === undefined && quietRoutine(ctx, next)) {
        next.hiddenFromBoard = true;
      }
    }
    if (state !== "done" && patch.hiddenFromBoard === undefined && task.state === "done") {
      next.hiddenFromBoard = false;
    }
    return ctx.store.putTask(next);
  });
}

/** Persist a run with `updatedAt` and the project scope. Joins the caller's transaction. */
export function saveRun(ctx: CoordinatorContext, run: Run, patch: Partial<Run> = {}): Run {
  const task = ctx.store.tasks.get(run.taskId);
  return ctx.store.putRun(
    { ...run, ...patch, updatedAt: ctx.store.nowIso() },
    task?.projectId ?? undefined,
  );
}

/** Raise the `failed` attention item for a task's run. */
export function raiseFailed(ctx: CoordinatorContext, task: Task, summary: string): void {
  ctx.attention.raise({
    reason: "failed",
    taskId: task.id,
    sessionId: task.sessionId,
    projectId: task.projectId,
    summary,
  });
}

export function shortError(err: unknown): { code: string; message: string; details?: unknown } {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const e = err as { code: unknown; message: unknown; details?: unknown };
    return { code: String(e.code), message: String(e.message), details: e.details };
  }
  return { code: "internal", message: err instanceof Error ? err.message : String(err) };
}
