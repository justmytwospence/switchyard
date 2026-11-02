import { afterEach, describe, expect, it } from "vitest";
import { hostSession, sleep, until } from "./helpers.js";
import {
  cleanupHarness,
  commandsOf,
  dispatcherOf,
  type Harness,
  runOf,
  settle,
  setupHarness,
  startRun,
  task,
} from "./task-helpers.js";

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
