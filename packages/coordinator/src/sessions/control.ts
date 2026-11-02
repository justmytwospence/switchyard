import { type Run, type Session, SwitchyardError } from "@switchyard/protocol";
import type { CoordinatorContext } from "../context.js";

/**
 * Session control routes. The tasks/runs worker extends these (continuation checks,
 * `onSessionSettled` on return-to-automation) by subscribing to `control.changed` or editing
 * this module.
 */

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
  ctx.hub.emit("control.changed", { run, session, mode });
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

/** Human takes control: `controlRevision++`, `controlMode = human`. */
export function takeover(ctx: CoordinatorContext, sessionId: string) {
  return setControl(ctx, sessionId, "human");
}

/** Return control to automation: `controlRevision++`, `controlMode = automation`. */
export function returnToAutomation(ctx: CoordinatorContext, sessionId: string) {
  return setControl(ctx, sessionId, "automation");
}

/**
 * Stop aborts current execution (`session.abort {clearQueue: true}`). For a session under a run,
 * the run becomes `interrupted` and the task `blocked {reason: "Stopped by user"}`; automation
 * policy is unchanged.
 */
export async function stopSession(ctx: CoordinatorContext, sessionId: string): Promise<Session> {
  const session = ctx.store.sessions.require(sessionId);
  await ctx.hostHub.request(session.hostId, {
    type: "session.abort",
    sessionId,
    clearQueue: true,
  });
  const run = ctx.store.runForSession(session);
  if (run && !["succeeded", "failed", "canceled", "interrupted"].includes(run.state)) {
    ctx.store.tx(() => {
      const now = ctx.store.nowIso();
      ctx.store.putRun(
        { ...run, state: "interrupted", updatedAt: now },
        session.projectId ?? undefined,
      );
      const task = ctx.store.tasks.get(run.taskId);
      if (task) {
        ctx.store.putTask({
          ...task,
          blocked: { reason: "Stopped by user" },
          updatedAt: now,
          lastActivityAt: now,
        });
      }
    });
  }
  return ctx.store.sessions.require(sessionId);
}
