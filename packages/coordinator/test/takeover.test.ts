import { afterEach, describe, expect, it } from "vitest";
import { requireService } from "../src/index.js";
import { hostSession, NO_REPLY, sleep, until } from "./helpers.js";
import {
  cleanupHarness,
  commandsOf,
  createTask,
  dispatcherOf,
  type Harness,
  runOf,
  setupHarness,
  startRun as startBaseRun,
  task,
  untilRun,
} from "./task-helpers.js";

/** Simulate the policy handshake for the negotiated fake host connection. */
async function startRun(...args: Parameters<typeof startBaseRun>) {
  const started = await startBaseRun(...args);
  const { store, ctx } = args[0].t.c;
  const session = store.sessions.require(started.run.sessionId!);
  const nativeSessionId = `native-${session.id}`;
  const runtimeId = `bridge-${session.id}`;
  const controllerEpoch = `controller-${session.id}`;
  store.putSession({
    ...session,
    nativeHandle: { sessionId: nativeSessionId, sessionFile: `/tmp/${nativeSessionId}.jsonl` },
    bridge: {
      version: 1,
      runtimeId,
      nativeSessionId,
      controllerEpoch,
      agentTools: true,
      messageDelivery: true,
      policyState: "active",
      policyPhases: ["request", "tool_call"],
    },
  });
  const root = session.workspaceId
    ? store.workspaces.require(session.workspaceId).path
    : session.cwd;
  requireService(ctx, "policies").bindBoundary(
    {
      authenticatedHostId: session.hostId,
      sessionId: session.id,
      nativeSessionId,
      runtimeId,
      controllerEpoch,
    },
    { cwd: session.cwd, cwdReal: session.cwd, workspaceRoot: root, workspaceRootReal: root },
  );
  return started;
}

/** Publish fresh completed accounting and the settlement together, as a current host does. */
async function settle(h: Harness, sessionId: string, text: string | null) {
  const { store } = h.t.c;
  const session = store.sessions.require(sessionId);
  const watermark = {
    runtimeId: `accounting-${sessionId}`,
    settleSeq: store.runSettleCount(session.runId!) + 1,
  };
  await h.host.event(
    "session.updated",
    hostSession(sessionId, { cwd: session.cwd, runtime: "running" }),
  );
  await h.host.event(
    "session.updated",
    hostSession(sessionId, {
      cwd: session.cwd,
      runtime: "idle",
      lastAssistantText: text,
      stats: { tokens: 0, costUsd: 0, watermark },
      settled: { aborted: false, lastAssistantText: text, watermark },
    }),
  );
}

let h: Harness | undefined;
afterEach(async () => {
  await cleanupHarness(h);
  h = undefined;
});

const policy = {
  continuation: {
    enabled: true,
    objective: "Make login work",
    maxContinuations: 5,
    maxElapsedMinutes: 60,
    maxTokens: null,
    maxCostUsd: null,
  },
};

const automationPrompts = (h: Harness) =>
  commandsOf(h.host, "session.prompt").filter((p) => p.origin === "automation");

describe("takeover during an unconfirmed launch", () => {
  /** The launch reaches the host (which optionally performs it) and the host drops offline. */
  async function uncertainLaunch(h: Harness, performed: boolean) {
    h.override = (cmd) => {
      if (cmd.type !== "dispatch.start") return undefined;
      if (performed) {
        h.state.dispatches.set(cmd.dispatchKey, {
          sessionId: cmd.sessionId,
          workspacePath: `/repos/app/.worktrees/taken`,
        });
      }
      void h.host.close();
      return NO_REPLY;
    };
    const tk = await createTask(h, { state: "ready", policy });
    const run = await untilRun(h, tk.id, "uncertain");
    h.override = undefined;
    return { tk, run };
  }

  const typesAfterFirstStart = (h: Harness) => {
    const types = h.host.commands.map((c) => c.command);
    const at = types.findIndex((c) => c.type === "dispatch.start");
    return types.slice(at + 1);
  };

  it("offline host, launch never arrived: withdrawn, reconciled under human control, interrupted", async () => {
    h = await setupHarness();
    const { tk, run } = await uncertainLaunch(h, false);
    const r = await h.t.admin("POST", `/api/sessions/${run.sessionId}/takeover`);
    expect(r.body.run).toMatchObject({ controlMode: "human", controlRevision: 2 });
    await h.host.open();
    await untilRun(h, tk.id, "interrupted");
    // The launch was not re-delivered; the host first learned human control, then was asked.
    expect(commandsOf(h.host, "dispatch.start")).toHaveLength(1);
    const after = typesAfterFirstStart(h);
    expect(after[0]).toMatchObject({
      type: "session.setControl",
      mode: "human",
      controlRevision: 2,
    });
    expect(after[1]).toMatchObject({ type: "dispatch.reconcile", dispatchKey: run.dispatchKey });
    expect(automationPrompts(h)).toHaveLength(0);
    expect(task(h, tk.id)).toMatchObject({
      state: "in_progress",
      blocked: { reason: "Taken over before launch was confirmed" },
    });
    expect(h.t.c.store.sessions.require(run.sessionId!).runtime).toBe("stopped");
    // Nothing automated follows.
    dispatcherOf(h).tick();
    await sleep(30);
    expect(commandsOf(h.host, "dispatch.start")).toHaveLength(1);
    expect(
      commandsOf(h.host, "session.setControl").filter((c) => c.mode === "automation"),
    ).toHaveLength(0);
  });

  it("offline host, launch performed: adopted under human control, never re-asserting automation", async () => {
    h = await setupHarness();
    const { tk, run } = await uncertainLaunch(h, true);
    await h.t.admin("POST", `/api/sessions/${run.sessionId}/takeover`);
    await h.host.open();
    const adopted = await untilRun(h, tk.id, "running");
    expect(adopted).toMatchObject({ id: run.id, controlMode: "human", controlRevision: 2 });
    expect(h.t.c.store.sessions.require(run.sessionId!).cwd).toBe("/repos/app/.worktrees/taken");
    await until(() => (h!.state.revisions.get(run.sessionId!) ?? 0) >= 2);
    expect(commandsOf(h.host, "dispatch.start")).toHaveLength(1);
    expect(
      commandsOf(h.host, "session.setControl").every(
        (c) => c.mode === "human" && c.controlRevision === 2,
      ),
    ).toBe(true);
    // The session settles: the human's run is never continued automatically.
    await settle(h, run.sessionId!, "partial");
    await sleep(50);
    expect(automationPrompts(h)).toHaveLength(0);
  });

  it("connected host, launch in flight: a takeover keeps the launch revision and adopts it for the person", async () => {
    h = await setupHarness();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    h.override = (cmd) => {
      if (cmd.type !== "dispatch.start") return undefined;
      return gate.then(() => undefined);
    };
    const tk = await createTask(h, { state: "ready", policy });
    await until(() => commandsOf(h!.host, "dispatch.start").length === 1);
    const run = runOf(h, tk.id);
    expect(run.state).toBe("dispatching");
    await h.t.admin("POST", `/api/sessions/${run.sessionId}/takeover`);
    // The host heard about the takeover before the launch finished.
    expect(commandsOf(h.host, "session.setControl")[0]).toMatchObject({
      mode: "human",
      controlRevision: 2,
    });
    h.override = undefined;
    release();
    const adopted = await untilRun(h, tk.id, "running");
    expect(adopted.controlMode).toBe("human");
    const [start] = commandsOf(h.host, "dispatch.start");
    expect(start).toMatchObject({ controlRevision: 1, controlMode: "automation" });
    // A reconcile after the takeover never replays the launch or flips the host to automation.
    await (dispatcherOf(h) as any).reconcileRun(adopted);
    expect(commandsOf(h.host, "dispatch.start")).toHaveLength(1);
    expect(
      commandsOf(h.host, "session.setControl").filter((c) => c.mode === "automation"),
    ).toHaveLength(0);
    expect(automationPrompts(h)).toHaveLength(0);
  });
});

describe("ending paused work", () => {
  it("canceling paused work ends its run and frees the project slot without stopping the session", async () => {
    h = await setupHarness();
    const { task: a, run } = await startRun(h);
    const b = await createTask(h, { state: "ready", title: "B" });
    const elig = await h.t.admin("GET", `/api/tasks/${b.id}/eligibility`);
    expect(elig.body).toMatchObject({ wait: "project_limit" });
    const r = await h.t.admin("POST", `/api/tasks/${a.id}/cancel`, { onRunning: "pause" });
    expect(r.body.state).toBe("canceled");
    expect(runOf(h, a.id)).toMatchObject({
      state: "interrupted",
      controlMode: "human",
      outcome: { summary: "Ended: the task was canceled" },
    });
    expect(runOf(h, a.id).endedAt).not.toBeNull();
    expect(commandsOf(h.host, "session.abort")).toHaveLength(0);
    expect(commandsOf(h.host, "session.stop")).toHaveLength(0);
    await untilRun(h, b.id, "running");
    const cwd = h.t.c.store.sessions.require(run.sessionId!).cwd;
    await h.host.event("session.updated", hostSession(run.sessionId!, { cwd, runtime: "running" }));
    await sleep(30);
    expect(runOf(h, a.id).state).toBe("interrupted");
  });

  it("marking paused work Done ends its run", async () => {
    h = await setupHarness();
    const { task: a } = await startRun(h);
    const r = await h.t.admin("POST", `/api/tasks/${a.id}/move`, {
      to: "done",
      onRunning: "pause",
      confirm: true,
    });
    expect(r.body.state).toBe("done");
    expect(runOf(h, a.id)).toMatchObject({
      state: "interrupted",
      outcome: { summary: "Ended: the task was marked Done" },
    });
  });
});

describe("takeover", () => {
  it("takeover racing a continuation: the host rejects the stale revision, nothing more is sent", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h, { policy });
    let release!: () => void;
    h.state.promptGate = new Promise<void>((r) => {
      release = r;
    });
    await settle(h, run.sessionId!, "partial");
    // The continuation (revision 1) reached the host and is held there.
    await until(() => automationPrompts(h!).length === 1);
    expect(automationPrompts(h)[0]!.controlRevision).toBe(1);

    const r = await h.t.admin("POST", `/api/sessions/${run.sessionId}/takeover`);
    expect(r.body.run).toMatchObject({ controlMode: "human", controlRevision: 2 });
    expect(h.state.revisions.get(run.sessionId!)).toBe(2);
    h.state.promptGate = null;
    release();
    await sleep(50);
    // stale_control ended the continuation silently.
    expect(runOf(h, tk.id)).toMatchObject({ state: "running", controlMode: "human" });
    expect(task(h, tk.id).blocked).toBeNull();
    expect(h.t.c.attention.open({ taskId: tk.id, reason: "failed" })).toHaveLength(0);

    // The human keeps working; settles never trigger automated prompts.
    const human = await h.t.admin("POST", `/api/sessions/${run.sessionId}/prompt`, {
      text: "let me look",
    });
    expect(human.body.automationActive).toBe(false);
    await settle(h, run.sessionId!, "human turn, no marker");
    await settle(h, run.sessionId!, "SWITCHYARD: DONE");
    await sleep(50);
    expect(automationPrompts(h)).toHaveLength(1);
    expect(commandsOf(h.host, "checks.run")).toHaveLength(0);
    expect(task(h, tk.id).state).toBe("in_progress");
    // No successor dispatch while a person has control.
    dispatcherOf(h).tick();
    await sleep(20);
    expect(commandsOf(h.host, "dispatch.start")).toHaveLength(1);
  });

  it("takeover while the host is offline withdraws the unacknowledged continuation; reconnect hears human control first", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h, { policy });
    const sid = run.sessionId!;
    h.override = (cmd) => {
      if (cmd.type !== "session.prompt" || cmd.origin !== "automation") return undefined;
      void h!.host.close();
      return NO_REPLY;
    };
    await settle(h, sid, "partial");
    await until(() => !h!.t.c.hostHub.isConnected(h!.creds.hostId));
    const r = await h.t.admin("POST", `/api/sessions/${sid}/takeover`);
    expect(r.body.run).toMatchObject({ controlMode: "human", controlRevision: 2 });
    h.override = undefined;
    const mark = h.host.commands.length;
    await h.host.open();
    await until(() => (h!.state.revisions.get(sid) ?? 0) >= 2);
    await sleep(50);
    expect(h.host.commands.slice(mark)[0]?.command).toMatchObject({
      type: "session.setControl",
      mode: "human",
      controlRevision: 2,
    });
    // The continuation that never got a receipt is not re-sent.
    expect(automationPrompts(h)).toHaveLength(1);
    expect(runOf(h, tk.id)).toMatchObject({ state: "running", controlMode: "human" });
    expect(h.t.c.store.getSetting(`runContinuation:${run.id}`, null)).toBeNull();
    expect(h.t.c.attention.open({ taskId: tk.id, reason: "failed" })).toHaveLength(0);
  });

  it("a reconnecting host hears current control before re-sent commands", async () => {
    h = await setupHarness();
    const { run } = await startRun(h, { policy });
    const sid = run.sessionId!;
    const cwd = h.t.c.store.sessions.require(sid).cwd;
    await h.host.event("session.updated", hostSession(sid, { cwd, runtime: "idle" }));
    await h.t.admin("POST", `/api/sessions/${sid}/takeover`);
    let dropped = false;
    h.override = (cmd) => {
      if (cmd.type !== "session.prompt" || cmd.origin !== "human" || dropped) return undefined;
      dropped = true;
      void h!.host.close();
      return NO_REPLY;
    };
    const prompt = h.t.admin("POST", `/api/sessions/${sid}/prompt`, { text: "let me look" });
    await until(() => !h!.t.c.hostHub.isConnected(h!.creds.hostId));
    const mark = h.host.commands.length;
    await h.host.open();
    await until(() => h!.host.commands.length >= mark + 2);
    expect(h.host.commands.slice(mark, mark + 2).map((c) => c.command.type)).toEqual([
      "session.setControl",
      "session.prompt",
    ]);
    expect((await prompt).status).toBe(200);
  });

  it("takeover before the settle means no automated prompt at all", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h, { policy });
    await h.t.admin("POST", `/api/sessions/${run.sessionId}/takeover`);
    await settle(h, run.sessionId!, "partial");
    await sleep(50);
    expect(automationPrompts(h)).toHaveLength(0);
    expect(runOf(h, tk.id).state).toBe("running");
  });

  it("return to automation re-evaluates an idle session", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h);
    await h.t.admin("POST", `/api/sessions/${run.sessionId}/takeover`);
    await settle(h, run.sessionId!, "All fixed.\nSWITCHYARD: DONE");
    await sleep(30);
    expect(task(h, tk.id).state).toBe("in_progress");
    const back = await h.t.admin("POST", `/api/sessions/${run.sessionId}/return-to-automation`);
    expect(back.body.run).toMatchObject({ controlMode: "automation", controlRevision: 3 });
    await until(() => task(h!, tk.id).state === "review");
  });

  it("moving running work backward requires pause or stop, and never silently kills it", async () => {
    h = await setupHarness();
    const { task: tk } = await startRun(h);
    const bad = await h.t.admin("POST", `/api/tasks/${tk.id}/move`, { to: "backlog" });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toMatchObject({
      code: "invalid_transition",
      message:
        "A running task cannot be moved to Backlog without choosing to pause automation or stop execution",
    });
    expect(commandsOf(h.host, "session.abort")).toHaveLength(0);

    const paused = await h.t.admin("POST", `/api/tasks/${tk.id}/move`, {
      to: "ready",
      onRunning: "pause",
    });
    expect(paused.body.state).toBe("ready");
    expect(runOf(h, tk.id)).toMatchObject({
      state: "running",
      controlMode: "human",
      controlRevision: 2,
    });
    expect(commandsOf(h.host, "session.setControl").at(-1)).toMatchObject({ mode: "human" });
    expect(dispatcherOf(h).eligibility(task(h, tk.id))).toMatchObject({
      eligible: false,
      wait: "already_dispatched",
    });
    dispatcherOf(h).tick();
    await sleep(20);
    expect(commandsOf(h.host, "dispatch.start")).toHaveLength(1);
    expect(commandsOf(h.host, "session.abort")).toHaveLength(0);
  });

  it("a move re-validates after pausing: a task that changed meanwhile is refused", async () => {
    h = await setupHarness();
    const { task: tk } = await startRun(h);
    h.override = (cmd) => {
      if (cmd.type !== "session.setControl") return undefined;
      h!.t.c.store.putTask({ ...task(h!, tk.id), state: "review" });
      return undefined;
    };
    const r = await h.t.admin("POST", `/api/tasks/${tk.id}/move`, {
      to: "backlog",
      onRunning: "pause",
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: "invalid_transition" });
    expect(task(h, tk.id).state).toBe("review");
  });

  it("stop keeps run data written while the abort was in flight", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h);
    const cwd = h.t.c.store.sessions.require(run.sessionId!).cwd;
    await h.host.event("session.updated", hostSession(run.sessionId!, { cwd, runtime: "running" }));
    h.override = (cmd) => {
      if (cmd.type !== "session.abort") return undefined;
      h!.t.c.store.putRun({ ...runOf(h!, tk.id), continuationsUsed: 1 });
      return null;
    };
    const r = await h.t.admin("POST", `/api/sessions/${run.sessionId}/stop`);
    expect(r.status).toBe(200);
    expect(runOf(h, tk.id)).toMatchObject({ state: "interrupted", continuationsUsed: 1 });
  });

  it("stop does not reopen a run that finished while the abort was in flight", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h);
    const cwd = h.t.c.store.sessions.require(run.sessionId!).cwd;
    await h.host.event("session.updated", hostSession(run.sessionId!, { cwd, runtime: "running" }));
    h.override = (cmd) => {
      if (cmd.type !== "session.abort") return undefined;
      const now = new Date().toISOString();
      h!.t.c.store.putRun({ ...runOf(h!, tk.id), state: "succeeded", endedAt: now });
      return null;
    };
    const r = await h.t.admin("POST", `/api/sessions/${run.sessionId}/stop`);
    expect(r.status).toBe(200);
    expect(runOf(h, tk.id).state).toBe("succeeded");
    expect(task(h, tk.id).blocked).toBeNull();
  });

  it("Stop's own aborted settle never continues the run", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h, { policy });
    const sid = run.sessionId!;
    const cwd = h.t.c.store.sessions.require(sid).cwd;
    await h.host.event("session.updated", hostSession(sid, { cwd, runtime: "running" }));
    h.override = async (cmd) => {
      if (cmd.type !== "session.abort") return undefined;
      await h!.host.event(
        "session.updated",
        hostSession(sid, {
          cwd,
          runtime: "idle",
          runtimeDetail: "aborted",
          lastAssistantText: "partial",
        }),
      );
      return null;
    };
    const r = await h.t.admin("POST", `/api/sessions/${sid}/stop`);
    expect(r.status).toBe(200);
    await sleep(50);
    expect(automationPrompts(h)).toHaveLength(0);
    expect(runOf(h, tk.id).state).toBe("interrupted");
    expect(task(h, tk.id).blocked).toMatchObject({ reason: "Stopped by user" });
  });

  it("stop aborts with a cleared queue and blocks the task", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h);
    const cwd = h.t.c.store.sessions.require(run.sessionId!).cwd;
    await h.host.event("session.updated", hostSession(run.sessionId!, { cwd, runtime: "running" }));
    const r = await h.t.admin("POST", `/api/tasks/${tk.id}/move`, {
      to: "backlog",
      onRunning: "stop",
    });
    expect(r.body.state).toBe("backlog");
    expect(commandsOf(h.host, "session.abort")).toEqual([
      { type: "session.abort", sessionId: run.sessionId, clearQueue: true },
    ]);
    expect(runOf(h, tk.id)).toMatchObject({ state: "interrupted", controlMode: "automation" });
  });
});
