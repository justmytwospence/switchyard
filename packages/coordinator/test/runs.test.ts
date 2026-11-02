import { afterEach, describe, expect, it } from "vitest";
import { hostSession, sleep, until } from "./helpers.js";
import {
  cleanupHarness,
  commandsOf,
  fullCapabilities,
  type Harness,
  runOf,
  settle,
  setupHarness,
  startRun,
  task,
  untilRun,
} from "./task-helpers.js";

let h: Harness | undefined;
afterEach(async () => {
  await cleanupHarness(h);
  h = undefined;
});

const continuation = (over: Record<string, unknown> = {}) => ({
  continuation: {
    enabled: true,
    objective: "Make login work",
    maxContinuations: 2,
    maxElapsedMinutes: 60,
    maxTokens: null,
    maxCostUsd: null,
    ...over,
  },
});

describe("runs", () => {
  it("DONE runs the checks and moves the task to Review; accept marks it Done", async () => {
    h = await setupHarness({ checks: ["npm test"] });
    const { task: tk, run } = await startRun(h);
    await settle(h, run.sessionId!, "Fixed it.\nSWITCHYARD: DONE");
    await until(() => task(h!, tk.id).state === "review");
    const [checks] = commandsOf(h.host, "checks.run");
    expect(checks).toMatchObject({ sessionId: run.sessionId, commands: ["npm test"] });
    expect(runOf(h, tk.id)).toMatchObject({
      state: "succeeded",
      outcome: { kind: "review" },
      checks: [{ command: "npm test", exitCode: 0 }],
    });
    const att = h.t.c.attention.open({ taskId: tk.id, reason: "ready_for_review" });
    expect(att).toHaveLength(1);
    expect(att[0]!.deepLink).toBe(`/tasks/${tk.id}`);

    const ack = await h.t.admin("POST", `/api/attention/${att[0]!.id}/acknowledge`);
    expect(ack.body.resolvedAt).toBeNull();

    const changes = await h.t.admin("POST", `/api/tasks/${tk.id}/request-changes`, {
      feedback: ["Add a regression test"],
    });
    expect(changes.body).toMatchObject({
      state: "review",
      review: { changesRequested: true, feedback: ["Add a regression test"] },
    });
    const accepted = await h.t.admin("POST", `/api/tasks/${tk.id}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.state).toBe("done");
    await until(() => h!.t.c.attention.open({ taskId: tk.id }).length === 0);
  });

  it("new attempt from Review prompts the same session with the feedback", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h);
    await settle(h, run.sessionId!, "SWITCHYARD: DONE");
    await until(() => task(h!, tk.id).state === "review");
    await h.t.admin("POST", `/api/tasks/${tk.id}/request-changes`, { feedback: ["Use bcrypt"] });
    const r = await h.t.admin("POST", `/api/tasks/${tk.id}/new-attempt`);
    expect(r.status).toBe(200);
    expect(r.body.run).toMatchObject({ attempt: 2, sessionId: run.sessionId });
    const second = await untilRun(h, tk.id, "running");
    expect(second.controlRevision).toBe(2);
    const prompts = commandsOf(h.host, "session.prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.text).toContain("## Review feedback (attempt 2)");
    expect(prompts[0]!.text).toContain("- Use bcrypt");
    expect(commandsOf(h.host, "session.setControl").at(-1)).toMatchObject({
      controlRevision: 2,
      mode: "automation",
    });
    expect(task(h, tk.id)).toMatchObject({
      state: "in_progress",
      review: { changesRequested: false },
    });
    expect(h.t.c.attention.open({ taskId: tk.id, reason: "ready_for_review" })).toHaveLength(0);
  });

  it("refuses a new attempt on a session that cannot resume unless fresh", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h);
    await settle(h, run.sessionId!, "SWITCHYARD: DONE");
    await until(() => task(h!, tk.id).state === "review");
    const s = h.t.c.store.sessions.require(run.sessionId!);
    h.t.c.store.putSession({ ...s, runtime: "stopped", nativeHandle: null });
    const r = await h.t.admin("POST", `/api/tasks/${tk.id}/new-attempt`);
    expect(r.body.error).toMatchObject({
      code: "native_session_missing",
      details: { alternative: `/api/tasks/${tk.id}/new-attempt?fresh=true` },
    });
    const fresh = await h.t.admin("POST", `/api/tasks/${tk.id}/new-attempt?fresh=true`);
    expect(fresh.status).toBe(200);
    expect(fresh.body.run.sessionId).not.toBe(run.sessionId);
    await untilRun(h, tk.id, "running");
    const starts = commandsOf(h.host, "dispatch.start");
    expect(starts.at(-1)!.workspace).toEqual({ path: s.cwd });
  });

  it("failing checks without continuation block the task", async () => {
    h = await setupHarness({ checks: ["npm test", "npm run lint"] });
    h.state.checkExit["npm run lint"] = 1;
    const { task: tk, run } = await startRun(h);
    await settle(h, run.sessionId!, "SWITCHYARD: DONE");
    await until(() => task(h!, tk.id).blocked !== null);
    expect(task(h, tk.id)).toMatchObject({
      state: "in_progress",
      blocked: { reason: "Checks failed: npm run lint" },
    });
    expect(runOf(h, tk.id)).toMatchObject({ state: "failed", outcome: { kind: "failed" } });
    expect(h.t.c.attention.open({ taskId: tk.id, reason: "failed" })).toHaveLength(1);
    // Moving to Done needs confirmation.
    const done = await h.t.admin("POST", `/api/tasks/${tk.id}/move`, { to: "done" });
    expect(done.body.error.code).toBe("invalid_transition");
    expect(done.body.error.message).toContain("Checks failed: npm run lint");
  });

  it("BLOCKED blocks the task with the agent's reason", async () => {
    h = await setupHarness({ checks: ["npm test"] });
    const { task: tk, run } = await startRun(h);
    await settle(h, run.sessionId!, "I need credentials.\nSWITCHYARD: BLOCKED missing API key");
    await until(() => task(h!, tk.id).blocked !== null);
    expect(task(h, tk.id).blocked).toEqual({ reason: "missing API key" });
    expect(runOf(h, tk.id)).toMatchObject({
      state: "failed",
      outcome: { kind: "blocked", summary: "missing API key" },
    });
    expect(commandsOf(h.host, "checks.run")).toHaveLength(0);
    const [att] = h.t.c.attention.open({ taskId: tk.id, reason: "failed" });
    expect(att!.summary).toBe("missing API key");
  });

  it("NO_CHANGE in watch mode finishes quietly and hides the routine task", async () => {
    h = await setupHarness();
    const a = await h.t.admin("POST", "/api/automations", {
      name: "Watch deps",
      projectId: h.project.id,
      trigger: { kind: "cron", expr: "0 9 * * *", timezone: "UTC" },
      template: {
        title: "Check deps",
        objective: "Look for updates",
        acceptanceCriteria: [],
        priority: 2,
      },
      mode: "watch",
    });
    expect(a.status).toBe(201);
    // A cron automation fired by the scheduler creates a routine task.
    const at = new Date(h.t.clock.now);
    at.setUTCHours(9, 0, 0, 0);
    if (at.getTime() <= h.t.clock.now) at.setUTCDate(at.getUTCDate() + 1);
    h.t.clock.now = at.getTime() + 10_000;
    const { requireService } = await import("../src/index.js");
    requireService(h.t.c.ctx, "scheduler").tick();
    await until(() => h!.t.c.store.tasks.list("automation_id = ?", [a.body.id]).length === 1);
    const tk = h.t.c.store.tasks.list("automation_id = ?", [a.body.id])[0]!;
    expect(tk.origin).toMatchObject({ kind: "automation", routine: true });
    const run = await untilRun(h, tk.id, "running");
    expect(commandsOf(h.host, "dispatch.start")[0]!.prompt).toContain("SWITCHYARD: NO_CHANGE");
    await settle(h, run.sessionId!, "Nothing new.\nSWITCHYARD: NO_CHANGE");
    await until(() => task(h!, tk.id).state === "done");
    expect(task(h, tk.id).hiddenFromBoard).toBe(true);
    expect(runOf(h, tk.id).outcome).toEqual({ kind: "no_change", summary: "No change" });
    expect(h.t.c.store.attention.count("task_id = ?", [tk.id])).toBe(0);
    const hist = await h.t.admin("GET", `/api/automations/${a.body.id}/history`);
    expect(hist.body[0]).toMatchObject({ state: "fired", taskId: tk.id, outcome: "No change" });
    const board = await h.t.admin("GET", `/api/tasks?projectId=${h.project.id}`);
    expect(board.body.map((t: { id: string }) => t.id)).not.toContain(tk.id);
  });

  it("continues within the limit, then blocks when continuations run out", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h, { policy: continuation() });
    await settle(h, run.sessionId!, "Partway there.");
    await until(() => commandsOf(h!.host, "session.prompt").length === 1);
    let prompts = commandsOf(h.host, "session.prompt");
    expect(prompts[0]).toMatchObject({ origin: "automation", mode: "prompt", controlRevision: 1 });
    expect(prompts[0]!.text).toBe(
      "Continue working toward the objective: Make login work. Continuation 1 of 2. End with `SWITCHYARD: DONE` when finished or `SWITCHYARD: BLOCKED <reason>`.",
    );
    await settle(h, run.sessionId!, "More progress.");
    await until(() => commandsOf(h!.host, "session.prompt").length === 2);
    prompts = commandsOf(h.host, "session.prompt");
    expect(prompts[1]!.text).toContain("Continuation 2 of 2");
    await settle(h, run.sessionId!, "Still going.");
    await until(() => task(h!, tk.id).blocked !== null);
    expect(task(h, tk.id).blocked!.reason).toBe(
      "Continuation limit reached (the maximum of 2 continuations) without the agent reporting done",
    );
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(2);
    expect(runOf(h, tk.id).continuationsUsed).toBe(2);
  });

  it("enforces the elapsed-time limit", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h, {
      policy: continuation({ maxElapsedMinutes: 1, maxContinuations: 10 }),
    });
    h.t.clock.advance(2 * 60_000);
    await settle(h, run.sessionId!, "not done");
    await until(() => task(h!, tk.id).blocked !== null);
    expect(task(h, tk.id).blocked!.reason).toContain("elapsed-time limit of 1 minute");
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(0);
  });

  it("enforces token caps when accounting is available", async () => {
    h = await setupHarness({ capabilities: fullCapabilities() });
    const { task: tk, run } = await startRun(h, {
      policy: continuation({ maxTokens: 1000, maxContinuations: 10 }),
    });
    expect(run.usage.accounting).toBe("available");
    await settle(h, run.sessionId!, "not done", { stats: { tokens: 5000, costUsd: 0.5 } });
    await until(() => task(h!, tk.id).blocked !== null);
    expect(task(h, tk.id).blocked!.reason).toContain("token limit of 1000");
    expect(runOf(h, tk.id).usage).toEqual({
      tokens: 5000,
      costUsd: 0.5,
      accounting: "available",
      note: null,
    });
  });

  it("discloses unavailable accounting and ignores token caps without it", async () => {
    h = await setupHarness();
    const { run } = await startRun(h, { policy: continuation({ maxTokens: 10 }) });
    await settle(h, run.sessionId!, "not done");
    await until(() => commandsOf(h!.host, "session.prompt").length === 1);
    expect(h.t.c.store.runs.require(run.id).usage).toMatchObject({
      accounting: "unavailable",
      note: "Token/cost accounting not reported by this Pi provider",
    });
  });

  it("failing checks with continuation left continue with the failure tails", async () => {
    h = await setupHarness({ checks: ["npm test"] });
    h.state.checkExit["npm test"] = 2;
    const { task: tk, run } = await startRun(h, { policy: continuation() });
    await settle(h, run.sessionId!, "SWITCHYARD: DONE");
    await until(() => commandsOf(h!.host, "session.prompt").length === 1);
    const [p] = commandsOf(h.host, "session.prompt");
    expect(p!.text).toContain("The acceptance checks failed");
    expect(p!.text).toContain("`npm test` exited 2");
    expect(runOf(h, tk.id).state).toBe("running");
    h.state.checkExit["npm test"] = 0;
    await settle(h, run.sessionId!, "SWITCHYARD: DONE");
    await until(() => task(h!, tk.id).state === "review");
  });

  it("a stale_control receipt ends the continuation silently", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h, { policy: continuation() });
    h.state.revisions.set(run.sessionId!, 5);
    await settle(h, run.sessionId!, "partial");
    await until(() => commandsOf(h!.host, "session.prompt").length === 1);
    await sleep(50);
    expect(task(h, tk.id).blocked).toBeNull();
    expect(runOf(h, tk.id).state).toBe("running");
    expect(h.t.c.attention.open({ taskId: tk.id, reason: "failed" })).toHaveLength(0);
  });

  it("a settle arriving while the previous one is evaluated is evaluated afterwards, not dropped", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h, { policy: continuation() });
    let release!: () => void;
    h.state.promptGate = new Promise<void>((r) => {
      release = r;
    });
    await settle(h, run.sessionId!, "Partway there.");
    await until(() => commandsOf(h!.host, "session.prompt").length === 1);
    // The continuation is still awaiting its receipt when the next settle (DONE) arrives.
    await settle(h, run.sessionId!, "All done.\nSWITCHYARD: DONE");
    h.state.promptGate = null;
    release();
    await until(() => task(h!, tk.id).state === "review");
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(1);
  });

  it("recovery: an idle session whose settle was never evaluated is evaluated on host connect", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h);
    const store = h.t.c.store;
    // The settle was projected, then the coordinator stopped before evaluating it.
    store.tx(() => {
      const s = store.sessions.require(run.sessionId!);
      store.putSession({ ...s, runtime: "idle", lastAssistantText: "Done.\nSWITCHYARD: DONE" });
      store.noteRunSettle(run.id);
    });
    await sleep(30);
    expect(task(h, tk.id).state).toBe("in_progress");
    await h.host.close();
    await h.host.open();
    await until(() => task(h!, tk.id).state === "review");
    // Evaluated once: another reconnect changes nothing.
    const events = store.eventsAfter(0, 100_000).length;
    await h.host.close();
    await h.host.open();
    await sleep(50);
    expect(runOf(h, tk.id).state).toBe("succeeded");
    expect(
      store
        .eventsAfter(0, 100_000)
        .slice(events)
        .filter((e) => e.type === "task.updated"),
    ).toHaveLength(0);
  });

  it("recovery: a run left in checking re-sends checks.run with a deterministic command id", async () => {
    h = await setupHarness({ checks: ["npm test"] });
    const { task: tk, run } = await startRun(h);
    const store = h.t.c.store;
    // The coordinator stopped after persisting `checking`, before the receipt came back.
    store.tx(() => store.putRun({ ...store.runs.require(run.id), state: "checking" }));
    await h.host.close();
    await h.host.open();
    await until(() => task(h!, tk.id).state === "review");
    const sent = h.host.commands.filter((c) => c.command.type === "checks.run");
    expect(sent.map((c) => c.commandId)).toEqual([`chk_${run.id}_1_0_1`]);
  });

  it("recovery: an unacknowledged continuation is re-sent with the same command id and text", async () => {
    h = await setupHarness();
    const { run } = await startRun(h, { policy: continuation() });
    const store = h.t.c.store;
    // Persisted (count and text) but the coordinator stopped before the host acknowledged.
    store.tx(() => {
      store.putRun({ ...store.runs.require(run.id), continuationsUsed: 1 });
      store.setSetting(`runContinuation:${run.id}`, { n: 1, text: "Continue: persisted text" });
    });
    await h.host.close();
    await h.host.open();
    await until(() => commandsOf(h!.host, "session.prompt").length === 1);
    const [sent] = h.host.commands.filter((c) => c.command.type === "session.prompt");
    expect(sent!.commandId).toBe(`cont_${run.id}_1`);
    expect(sent!.command).toMatchObject({ text: "Continue: persisted text", origin: "automation" });
    await until(() => store.getSetting(`runContinuation:${run.id}`, null) === null);
    expect(runOf(h, run.taskId).continuationsUsed).toBe(1);
    // Normal continuations use deterministic ids too.
    await settle(h, run.sessionId!, "Partway there.");
    await until(() => commandsOf(h!.host, "session.prompt").length === 2);
    expect(h.host.commands.filter((c) => c.command.type === "session.prompt")[1]!.commandId).toBe(
      `cont_${run.id}_2`,
    );
  });

  it("mirrors waiting_input and interrupted session runtime into the run", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h);
    const cwd = h.t.c.store.sessions.require(run.sessionId!).cwd;
    await h.host.event(
      "session.updated",
      hostSession(run.sessionId!, { cwd, runtime: "waiting_input" }),
    );
    expect(runOf(h, tk.id).state).toBe("waiting_input");
    await h.host.event("session.updated", hostSession(run.sessionId!, { cwd, runtime: "running" }));
    expect(runOf(h, tk.id).state).toBe("running");
    await h.host.event(
      "session.updated",
      hostSession(run.sessionId!, { cwd, runtime: "interrupted" }),
    );
    expect(runOf(h, tk.id).state).toBe("interrupted");
    expect(task(h, tk.id).blocked).toEqual({ reason: "Session interrupted: resume to continue" });
    // A blocked task moves back without a pause/stop choice; dispatch resumes the same session.
    const back = await h.t.admin("POST", `/api/tasks/${tk.id}/move`, { to: "ready" });
    expect(back.body.state).toBe("ready");
    const second = await untilRun(h, tk.id, "running");
    expect(second.sessionId).toBe(run.sessionId);
    expect(second.attempt).toBe(2);
    const last = commandsOf(h.host, "dispatch.start").at(-1)!;
    expect(last.nativeHandle).not.toBeNull();
    expect(last.workspace).toEqual({ path: cwd });
  });
});
