import { type Run, type Session, SwitchyardError } from "@switchyard/protocol";
import type { CoordinatorContext } from "../context.js";
import { getService } from "../services.js";
import { isRunAutomationCommand } from "../tasks/runs.js";
import { TERMINAL_RUN_STATES } from "../tasks/state.js";

/** Session control: take over, return to automation and stop. */

function requireRun(ctx: CoordinatorContext, session: Session): Run {
  const run = ctx.store.runForSession(session);
  if (!run) {
    throw new SwitchyardError(
      "invalid_request",
      "This session is not controlled by an automation run",
    );
  }
  return run;
}

async function setControl(
  ctx: CoordinatorContext,
  sessionId: string,
  mode: "automation" | "human",
): Promise<{ session: Session; run: Run }> {
  const { session, run } = ctx.store.tx(() => {
    const session = ctx.store.sessions.require(sessionId);
    const run = requireRun(ctx, session);
    const now = ctx.store.nowIso();
    const updated = ctx.store.putRun(
      { ...run, controlMode: mode, controlRevision: run.controlRevision + 1, updatedAt: now },
      session.projectId ?? undefined,
    );
    return { session, run: updated };
  });
  if (mode === "human") {
    getService(ctx, "dispatcher")?.onTakeover(run.id);
    // A host that is away must not run this run's automated follow-ups when it is back.
    ctx.hostHub.withdrawMatching(
      session.hostId,
      (id) => isRunAutomationCommand(run.id, id),
      "Withdrawn: a person took over",
    );
  }
  if (ctx.hostHub.isConnected(session.hostId)) {
    try {
      await ctx.hostHub.request(session.hostId, {
        type: "session.setControl",
        sessionId: session.id,
        controlRevision: run.controlRevision,
        mode,
      });
    } catch (err) {
      // The revision is already recorded; the host learns it on the next automated command
      // (which it rejects as stale_control). Report but do not undo the takeover.
      ctx.log.warn({ err, sessionId }, "session.setControl failed");
    }
  }
  return { session, run };
}

/**
 * Human takes control: `controlRevision++`, `controlMode = human`. Continuations, infra retries
 * and successor dispatch all check `controlMode` before acting, and the host rejects automated
 * commands carrying an older revision (`stale_control`).
 */
export function takeover(ctx: CoordinatorContext, sessionId: string) {
  return setControl(ctx, sessionId, "human");
}

/**
 * Take over a run that may not have a live session yet (queued retry, launch in flight): bumps
 * the revision and sets human control; tells the host when a session exists.
 */
export async function takeoverRun(ctx: CoordinatorContext, runId: string): Promise<Run> {
  const run = ctx.store.runs.require(runId);
  if (run.sessionId && ctx.store.sessions.get(run.sessionId)?.runId === run.id) {
    return (await takeover(ctx, run.sessionId)).run;
  }
  const updated = ctx.store.tx(() => {
    const cur = ctx.store.runs.require(runId);
    const task = ctx.store.tasks.get(cur.taskId);
    return ctx.store.putRun(
      {
        ...cur,
        controlMode: "human",
        controlRevision: cur.controlRevision + 1,
        updatedAt: ctx.store.nowIso(),
      },
      task?.projectId,
    );
  });
  getService(ctx, "dispatcher")?.onTakeover(updated.id);
  return updated;
}

/**
 * Return control to automation: `controlRevision++`, `controlMode = automation`. When the
 * session is idle the run is re-evaluated right away (markers, continuation, checks).
 */
export async function returnToAutomation(ctx: CoordinatorContext, sessionId: string) {
  const result = await setControl(ctx, sessionId, "automation");
  const session = ctx.store.sessions.require(sessionId);
  if (session.runtime === "idle") {
    const runs = getService(ctx, "runs");
    void runs
      ?.onSessionSettled({
        session,
        aborted: false,
        lastAssistantText: session.lastAssistantText,
      })
      .catch((err) => ctx.log.error({ err, sessionId }, "re-evaluation failed"));
  }
  getService(ctx, "dispatcher")?.schedule();
  return result;
}

/**
 * Stop aborts current execution (`session.abort {clearQueue: true}`). For a session under a run,
 * the run becomes `interrupted` and the task `blocked {reason: "Stopped by user"}`; automation
 * policy is unchanged.
 */
export async function stopSession(ctx: CoordinatorContext, sessionId: string): Promise<Session> {
  const session = ctx.store.sessions.require(sessionId);
  const pre = ctx.store.runForSession(session);
  if (pre && (pre.state === "dispatching" || pre.state === "uncertain")) {
    throw new SwitchyardError(
      "conflict",
      "The launch is not confirmed yet; wait for the host or pause automation instead",
    );
  }
  const release = pre ? getService(ctx, "runs")?.beginStop(pre.id) : undefined;
  try {
    await ctx.hostHub.request(session.hostId, {
      type: "session.abort",
      sessionId,
      clearQueue: true,
    });
    // Re-read inside the transaction: the abort was awaited, and only the run that was current
    // when Stop was pressed is interrupted (never a newer attempt, never a finished run).
    ctx.store.tx(() => {
      const cur = ctx.store.sessions.require(sessionId);
      const run = pre ? ctx.store.runs.get(pre.id) : ctx.store.runForSession(cur);
      if (!run || TERMINAL_RUN_STATES.includes(run.state)) return;
      const now = ctx.store.nowIso();
      ctx.store.putRun(
        { ...run, state: "interrupted", updatedAt: now },
        cur.projectId ?? undefined,
      );
      const task = ctx.store.tasks.get(run.taskId);
      if (task && task.currentRunId === run.id) {
        ctx.store.putTask({
          ...task,
          blocked: { reason: "Stopped by user" },
          updatedAt: now,
          lastActivityAt: now,
        });
      }
    });
  } finally {
    release?.();
  }
  return ctx.store.sessions.require(sessionId);
}
