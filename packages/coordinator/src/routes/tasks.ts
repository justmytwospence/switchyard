import {
  CreateTaskRequest,
  MoveTaskRequest,
  RequestChangesRequest,
  SwitchyardError,
  type Task,
  type TaskState,
  UpdateTaskRequest,
} from "@switchyard/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CoordinatorContext } from "../context.js";
import { parse } from "../http.js";
import { requireService } from "../services.js";
import { stopSession, takeoverRun } from "../sessions/control.js";
import { LIVE_RUNTIMES } from "../sessions/service.js";
import { effectiveChecks, putTaskState, saveRun } from "../tasks/common.js";
import { createTask, mergePolicy, validateDependencies, validateParent } from "../tasks/service.js";
import { isLiveRun, isTerminalTask, move, STATE_LABELS } from "../tasks/state.js";

const ListQuery = z.object({
  projectId: z.string().optional(),
  state: z.string().optional(),
  includeHidden: z.enum(["true", "false"]).optional(),
});
const AcceptRequest = z.object({ confirm: z.boolean().optional() });
const ReopenRequest = z.object({ to: z.enum(["ready", "backlog"]).default("ready") });
const CancelRequest = z.object({ onRunning: z.enum(["pause", "stop"]).optional() });
const NewAttemptQuery = z.object({ fresh: z.enum(["true", "false"]).optional() });
const PauseRequest = z.object({ paused: z.boolean() });

/**
 * Apply a move: validate (`invalid_transition` with a concrete reason), pause or stop live work
 * as chosen, then validate again and write the new state. Never kills running work silently.
 */
export async function applyMove(
  ctx: CoordinatorContext,
  taskId: string,
  to: TaskState,
  opts: { confirm?: boolean; onRunning?: "pause" | "stop"; position?: number; accepted?: boolean },
): Promise<Task> {
  const { store } = ctx;
  const task = store.tasks.require(taskId);
  const run = task.currentRunId ? store.runs.get(task.currentRunId) : undefined;
  const plan = move(task, to, {
    confirm: opts.confirm,
    onRunning: opts.onRunning,
    run,
    checks: effectiveChecks(ctx, task),
    accepted: opts.accepted,
  });
  if (plan.from === plan.to) {
    if (opts.position === undefined || opts.position === task.position) return task;
    return store.tx(() =>
      store.putTask({
        ...store.tasks.require(taskId),
        position: opts.position!,
        updatedAt: store.nowIso(),
      }),
    );
  }
  if (plan.newAttempt) {
    requireService(ctx, "dispatcher").newAttempt(taskId);
    return store.tasks.require(taskId);
  }
  if (plan.runningAction && run && isLiveRun(run)) {
    if (plan.runningAction === "pause") {
      await takeoverRun(ctx, run.id);
    } else {
      const session = run.sessionId ? store.sessions.get(run.sessionId) : undefined;
      if (!session || !LIVE_RUNTIMES.includes(session.runtime)) {
        throw new SwitchyardError(
          "conflict",
          "The launch is not confirmed yet; wait for the host or pause automation instead",
        );
      }
      await stopSession(ctx, session.id);
    }
  }
  const updated = store.tx(() => {
    const cur = store.tasks.require(taskId);
    const curRun = cur.currentRunId ? store.runs.get(cur.currentRunId) : undefined;
    // Pausing or stopping was awaited: the task may have moved meanwhile, so validate again.
    if (cur.state !== plan.from) {
      throw new SwitchyardError(
        "invalid_transition",
        `The task moved to ${STATE_LABELS[cur.state]} while this move was applied; try again`,
        { from: plan.from, current: cur.state, to },
      );
    }
    move(cur, to, {
      confirm: opts.confirm,
      onRunning: opts.onRunning,
      run: curRun,
      checks: effectiveChecks(ctx, cur),
      accepted: opts.accepted,
    });
    const patch: Partial<Task> = {};
    if (opts.position !== undefined) patch.position = opts.position;
    if (to === "ready" || to === "backlog" || to === "canceled") patch.blocked = null;
    if (to === "done") patch.review = { ...cur.review, changesRequested: false };
    if (curRun?.state === "queued" && to !== "ready") {
      saveRun(ctx, curRun, { state: "canceled", endedAt: store.nowIso(), nextAttemptAt: null });
    }
    // A task that ends ends its live run too, or the run would hold a concurrency slot forever.
    // Nothing is stopped on the host: paused work stays under the person's control.
    if (isTerminalTask(to) && curRun && isLiveRun(curRun)) {
      saveRun(ctx, curRun, {
        state: "interrupted",
        endedAt: store.nowIso(),
        outcome: {
          kind: "canceled",
          summary:
            to === "canceled" ? "Ended: the task was canceled" : "Ended: the task was marked Done",
        },
      });
      const s = curRun.sessionId ? store.sessions.get(curRun.sessionId) : undefined;
      if (s?.runtime === "starting") {
        store.putSession({
          ...s,
          runtime: "stopped",
          runtimeDetail: "The task ended before its launch was confirmed",
        });
      }
    }
    if (to === "canceled") {
      ctx.attention.resolve({ taskId, reason: "failed" });
    }
    return putTaskState(ctx, cur, to, patch);
  });
  requireService(ctx, "dispatcher").schedule();
  return updated;
}

export function registerTaskRoutes(app: FastifyInstance, ctx: CoordinatorContext): void {
  const { store } = ctx;
  const idOf = (req: { params: unknown }) => (req.params as { id: string }).id;
  const dispatcher = () => requireService(ctx, "dispatcher");

  app.get("/api/tasks", async (req) => {
    const q = parse(ListQuery, req.query, "query");
    const where: string[] = [];
    const params: string[] = [];
    if (q.projectId) {
      where.push("project_id = ?");
      params.push(q.projectId);
    }
    if (q.state) {
      const states = q.state.split(",").filter(Boolean);
      where.push(`state IN (${states.map(() => "?").join(",")})`);
      params.push(...states);
    }
    const list = store.tasks.list(where.join(" AND ") || undefined, params, "created_at");
    return q.includeHidden === "true" ? list : list.filter((t) => !t.hiddenFromBoard);
  });

  app.post("/api/tasks", async (req, reply) => {
    const body = parse(CreateTaskRequest, req.body);
    const task = createTask(ctx, body, { kind: "manual" });
    dispatcher().schedule();
    return reply.code(201).send(task);
  });

  app.get("/api/tasks/:id", async (req) => store.tasks.require(idOf(req)));

  app.patch("/api/tasks/:id", async (req) => {
    const body = parse(UpdateTaskRequest, req.body);
    const task = store.tx(() => {
      const cur = store.tasks.require(idOf(req));
      const title = body.title ?? cur.title;
      if (body.dependencies) {
        validateDependencies(
          ctx,
          cur.id,
          cur.projectId,
          title,
          body.dependencies,
          cur.dependencies,
        );
      }
      if (body.parentTaskId !== undefined) {
        validateParent(ctx, cur.id, cur.projectId, body.parentTaskId);
      }
      const next: Task = {
        ...cur,
        title,
        objective: body.objective ?? cur.objective,
        acceptanceCriteria: body.acceptanceCriteria ?? cur.acceptanceCriteria,
        dependencies: body.dependencies ?? cur.dependencies,
        ...(body.parentTaskId !== undefined ? { parentTaskId: body.parentTaskId } : {}),
        priority: body.priority ?? cur.priority,
        position: body.position ?? cur.position,
        notBefore: body.notBefore !== undefined ? body.notBefore : cur.notBefore,
        policy: body.policy ? mergePolicy(cur.policy, body.policy) : cur.policy,
        updatedAt: store.nowIso(),
      };
      return store.putTask(next);
    });
    dispatcher().schedule();
    return task;
  });

  app.delete("/api/tasks/:id", async (req) => {
    store.tx(() => {
      const task = store.tasks.require(idOf(req));
      if (task.state !== "backlog" && task.state !== "canceled") {
        throw new SwitchyardError(
          "invalid_transition",
          "Only Backlog or Canceled tasks can be deleted; cancel it first",
        );
      }
      store.deleteTask(task);
    });
    return { ok: true };
  });

  app.post("/api/tasks/:id/move", async (req) => {
    const body = parse(MoveTaskRequest, req.body);
    return applyMove(ctx, idOf(req), body.to, body);
  });

  app.post("/api/tasks/:id/run-now", async (req) => {
    const run = dispatcher().runNow(idOf(req));
    return { task: store.tasks.require(idOf(req)), run };
  });

  /** Accepting marks the task Done. It does not merge or push. */
  app.post("/api/tasks/:id/accept", async (req) => {
    const body = parse(AcceptRequest, req.body);
    const task = store.tasks.require(idOf(req));
    if (task.state !== "review") {
      throw new SwitchyardError("invalid_transition", "Only tasks in Review can be accepted");
    }
    return applyMove(ctx, task.id, "done", { confirm: body.confirm, accepted: true });
  });

  app.post("/api/tasks/:id/request-changes", async (req) => {
    const body = parse(RequestChangesRequest, req.body);
    return store.tx(() => {
      const task = store.tasks.require(idOf(req));
      if (task.state !== "review") {
        throw new SwitchyardError(
          "invalid_transition",
          "Changes can only be requested while the task is in Review",
        );
      }
      return store.putTask({
        ...task,
        review: { feedback: [...task.review.feedback, ...body.feedback], changesRequested: true },
        updatedAt: store.nowIso(),
        lastActivityAt: store.nowIso(),
      });
    });
  });

  app.post("/api/tasks/:id/new-attempt", async (req) => {
    const q = parse(NewAttemptQuery, req.query, "query");
    const run = dispatcher().newAttempt(idOf(req), { fresh: q.fresh === "true" });
    return { task: store.tasks.require(idOf(req)), run };
  });

  app.post("/api/tasks/:id/reopen", async (req) => {
    const body = parse(ReopenRequest, req.body);
    const task = store.tasks.require(idOf(req));
    if (task.state !== "done") {
      throw new SwitchyardError("invalid_transition", "Only Done tasks can be reopened");
    }
    return applyMove(ctx, task.id, body.to, {});
  });

  app.post("/api/tasks/:id/cancel", async (req) => {
    const body = parse(CancelRequest, req.body);
    return applyMove(ctx, idOf(req), "canceled", { onRunning: body.onRunning });
  });

  app.get("/api/tasks/:id/eligibility", async (req) =>
    dispatcher().eligibility(store.tasks.require(idOf(req))),
  );

  app.get("/api/tasks/:id/runs", async (req) => {
    const task = store.tasks.require(idOf(req));
    return store.runs.list("task_id = ?", [task.id], "created_at");
  });

  app.get("/api/now", async () => dispatcher().now());

  /** Pause or resume future dispatch; active runs keep running. */
  app.post("/api/dispatch/pause", async (req) => {
    const body = parse(PauseRequest, req.body);
    store.setDispatchPaused(body.paused);
    if (!body.paused) dispatcher().schedule();
    return { dispatchPaused: store.dispatchPaused };
  });
}
