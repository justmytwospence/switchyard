import { afterEach, describe, expect, it, vi } from "vitest";
import { PolicyService } from "../src/policies/service.js";
import {
  CANCELED_CONTINUATION_PREFIX,
  CONTINUATION_PAUSED_NOTICE,
  CONTINUATION_UNCERTAIN_NOTICE,
  type PendingContinuation,
} from "../src/tasks/continuations.js";
import { RunsService } from "../src/tasks/runs.js";
import { hostSession, sleep, until } from "./helpers.js";
import {
  cleanupHarness,
  commandsOf,
  fullCapabilities,
  type Harness,
  runOf,
  settle,
  setupHarness as setupBaseHarness,
  startRun as startBaseRun,
  task,
  untilRun,
} from "./task-helpers.js";

let h: Harness | undefined;
let ownedPolicies: PolicyService | undefined;
let recoveredRuns: RunsService | undefined;
async function setupHarness(...args: Parameters<typeof setupBaseHarness>) {
  const harness = await setupBaseHarness(...args);
  if (!harness.t.c.ctx.services.has("policies")) {
    ownedPolicies = new PolicyService(harness.t.c.ctx);
    ownedPolicies.start();
    harness.t.c.ctx.services.set("policies", ownedPolicies);
  }
  return harness;
}
async function startRun(...args: Parameters<typeof startBaseRun>) {
  const started = await startBaseRun(...args);
  const store = args[0].t.c.store;
  const session = store.sessions.require(started.run.sessionId!);
  const nativeSessionId = `native-${session.id}`;
  store.putSession({
    ...session,
    nativeHandle: {
      sessionId: nativeSessionId,
      sessionFile: `/tmp/${nativeSessionId}.jsonl`,
    },
    bridge: {
      version: 1,
      runtimeId: "bridge-runtime",
      controllerEpoch: "controller-epoch",
      nativeSessionId,
      agentTools: true,
      messageDelivery: true,
      policyState: "active",
      policyPhases: ["request", "tool_call"],
    },
  });
  const root = session.workspaceId
    ? store.workspaces.require(session.workspaceId).path
    : session.cwd;
  policies().bindBoundary(
    {
      authenticatedHostId: session.hostId,
      sessionId: session.id,
      nativeSessionId,
      runtimeId: "bridge-runtime",
    },
    {
      cwd: session.cwd,
      cwdReal: session.cwd,
      workspaceRoot: root,
      workspaceRootReal: root,
    },
  );
  return started;
}
function policies() {
  return h!.t.c.ctx.services.get("policies") as PolicyService;
}
function pending(runId: string) {
  return h!.t.c.store.getSetting<PendingContinuation | null>(`runContinuation:${runId}`, null);
}
async function completed(runId: string, tokens: number | null, costUsd: number | null = null) {
  const store = h!.t.c.store;
  const sessionId = store.runs.require(runId).sessionId!;
  const watermark = {
    runtimeId: "accounting-epoch",
    settleSeq: store.runSettleCount(runId) + 1,
  };
  await h!.host.event("session.updated", { id: sessionId, runtime: "running" });
  await h!.host.event("session.updated", {
    id: sessionId,
    runtime: "idle",
    stats: { tokens, costUsd, watermark },
    lastAssistantText: "partial",
    settled: { aborted: false, lastAssistantText: "partial", watermark },
  });
}
async function answer(runId: string, confirmed = true) {
  const decision = pending(runId)!;
  const interaction = h!.t.c.store.interactions
    .list()
    .find((i) => i.state === "pending" && i.permission?.decisionId === decision.decisionId)!;
  return policies().answer(decision.decisionId!, interaction.revision, confirmed, "test-device");
}
afterEach(async () => {
  recoveredRuns?.stop();
  recoveredRuns = undefined;
  vi.restoreAllMocks();
  await ownedPolicies?.stop();
  ownedPolicies = undefined;
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
    expect(checks).toMatchObject({
      sessionId: run.sessionId,
      commands: ["npm test"],
    });
    expect(runOf(h, tk.id)).toMatchObject({
      state: "succeeded",
      outcome: { kind: "review" },
      checks: [{ command: "npm test", exitCode: 0 }],
    });
    const att = h.t.c.attention.open({
      taskId: tk.id,
      reason: "ready_for_review",
    });
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
    expect(h.t.c.store.st.get("SELECT outcome FROM task_completions ORDER BY rowid").all()).toEqual(
      [{ outcome: "review" }, { outcome: "done" }],
    );
    await until(() => h!.t.c.attention.open({ taskId: tk.id }).length === 0);

    const history = await h.t.admin("GET", `/api/attention?resolvedOnly=true&taskId=${tk.id}`);
    expect(history.status).toBe(200);
    expect(history.body).toHaveLength(1);
    expect(history.body[0]).toMatchObject({
      id: att[0]!.id,
      reason: "ready_for_review",
    });
    expect(history.body[0].resolvedAt).not.toBeNull();
    const open = await h.t.admin("GET", `/api/attention?taskId=${tk.id}`);
    expect(open.body).toEqual([]);
  });

  it("new attempt from Review prompts the same session with the feedback", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h);
    await settle(h, run.sessionId!, "SWITCHYARD: DONE");
    await until(() => task(h!, tk.id).state === "review");
    await h.t.admin("POST", `/api/tasks/${tk.id}/request-changes`, {
      feedback: ["Use bcrypt"],
    });
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
    expect(runOf(h, tk.id)).toMatchObject({
      state: "failed",
      outcome: { kind: "failed" },
    });
    expect(h.t.c.store.st.get("SELECT outcome FROM task_completions").all()).toEqual([
      { outcome: "failed" },
    ]);
    expect(h.t.c.attention.open({ taskId: tk.id, reason: "failed" })).toHaveLength(1);
    // Moving to Done needs confirmation.
    const done = await h.t.admin("POST", `/api/tasks/${tk.id}/move`, {
      to: "done",
    });
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
    const captured = h.t.c.store.st.get("SELECT snapshot_json FROM task_completions").get() as {
      snapshot_json: string;
    };
    expect(JSON.parse(captured.snapshot_json)).toMatchObject({
      outcome: "failed",
      runId: run.id,
      childSessionId: run.sessionId,
      failure: { kind: "blocked", summary: "missing API key" },
    });
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
    expect(runOf(h, tk.id).outcome).toEqual({
      kind: "no_change",
      summary: "No change",
    });
    expect(h.t.c.store.attention.count("task_id = ?", [tk.id])).toBe(0);
    const hist = await h.t.admin("GET", `/api/automations/${a.body.id}/history`);
    expect(hist.body[0]).toMatchObject({
      state: "fired",
      taskId: tk.id,
      outcome: "No change",
    });
    const board = await h.t.admin("GET", `/api/tasks?projectId=${h.project.id}`);
    expect(board.body.map((t: { id: string }) => t.id)).not.toContain(tk.id);
  });

  it("an aborted turn under automation is evaluated and continued like any settle", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h, { policy: continuation() });
    await settle(h, run.sessionId!, "partial", { runtimeDetail: "aborted" });
    await until(() => commandsOf(h!.host, "session.prompt").length === 1);
    expect(commandsOf(h.host, "session.prompt")[0]!.text).toContain("Continuation 1 of 2");
    expect(runOf(h, tk.id)).toMatchObject({
      continuationsUsed: 1,
      state: "running",
    });
  });

  it("continues within the limit, then blocks when continuations run out", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h, { policy: continuation() });
    await settle(h, run.sessionId!, "Partway there.");
    await until(() => commandsOf(h!.host, "session.prompt").length === 1);
    let prompts = commandsOf(h.host, "session.prompt");
    expect(prompts[0]).toMatchObject({
      origin: "automation",
      mode: "prompt",
      controlRevision: 1,
    });
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

  it("blocks expensive/unclassified continuations at the hard token budget", async () => {
    h = await setupHarness({ capabilities: fullCapabilities() });
    const { task: tk, run } = await startRun(h, {
      policy: continuation({ maxTokens: 1000, maxContinuations: 10 }),
    });
    expect(run.usage.accounting).toBe("available");
    await completed(run.id, 5000, 0.5);
    await until(() => task(h!, tk.id).blocked !== null);
    expect(task(h, tk.id).blocked!.reason).toContain("budget");
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(0);
    expect(runOf(h, tk.id).continuationsUsed).toBe(0);
    expect(runOf(h, tk.id).usage).toEqual({
      tokens: 5000,
      costUsd: 0.5,
      accounting: "available",
      note: null,
    });
  });

  it("discloses unavailable accounting and blocks configured budgets without it", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h, {
      policy: continuation({ maxTokens: 10 }),
    });
    await settle(h, run.sessionId!, "not done");
    await until(() => task(h!, tk.id).blocked !== null);
    expect(task(h, tk.id).blocked!.reason).toBe(
      "Budget accounting is unavailable; resume manually or remove the limit.",
    );
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(0);
    expect(h.t.c.store.runs.require(run.id).usage).toMatchObject({
      accounting: "unavailable",
      note: "Token/cost accounting not reported by this Pi provider",
    });
  });

  it("ASK persists without consuming a continuation, then refreshes authorization after approval", async () => {
    h = await setupHarness();
    const { run } = await startRun(h, {
      policy: continuation({ maxTokens: 1000 }),
    });
    const authorize = vi.spyOn(policies(), "authorize");
    await completed(run.id, 800);
    await until(() => !!pending(run.id)?.decisionId);
    expect(h.t.c.store.runs.require(run.id).continuationsUsed).toBe(0);
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(0);
    const proof = pending(run.id)!;
    expect(proof.input).toEqual({
      kind: "continuation",
      runId: run.id,
      expectedControlRevision: 1,
      nextContinuationNumber: 1,
      expectedSettleCount: 1,
      expectedWatermark: { runtimeId: "accounting-epoch", settleSeq: 1 },
    });
    expect(proof.input.expectedWatermark!.runtimeId).not.toBe("bridge-runtime");
    await answer(run.id);
    await until(() => commandsOf(h!.host, "session.prompt").length === 1);
    expect(authorize.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(authorize.mock.calls.at(-1)![0]).toEqual(proof.input);
    expect(h.t.c.store.runs.require(run.id).continuationsUsed).toBe(1);
    expect(h.host.commands.filter((c) => c.command.type === "session.prompt")[0]!.commandId).toBe(
      `cont_${run.id}_1`,
    );
  });

  it("a denied ASK blocks with the policy reason and never consumes a continuation", async () => {
    h = await setupHarness();
    const { run, task: tk } = await startRun(h, {
      policy: continuation({ maxTokens: 1000 }),
    });
    await completed(run.id, 800);
    await until(() => !!pending(run.id)?.decisionId);
    await answer(run.id, false);
    await until(() => task(h!, tk.id).blocked !== null);
    expect(task(h, tk.id).blocked!.reason).toBe("The policy action was denied.");
    expect(runOf(h, tk.id).continuationsUsed).toBe(0);
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(0);
  });

  it("explicitly cheap models can continue beyond a hard budget only after soft approval", async () => {
    h = await setupHarness();
    const { run } = await startRun(h, {
      policy: continuation({ maxTokens: 1000 }),
    });
    const session = h.t.c.store.sessions.require(run.sessionId!);
    h.t.c.store.putSession({
      ...session,
      model: {
        provider: "test",
        id: "cheap",
        name: "Cheap",
        contextWindow: 100000,
        reasoning: false,
        thinkingLevels: [],
      },
    });
    policies().updateSettings({
      expectedRevision: policies().settings().revision,
      modelClassifications: [{ provider: "test", modelId: "cheap", classification: "cheap" }],
    });
    await completed(run.id, 1500);
    await until(() => !!pending(run.id)?.decisionId);
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(0);
    await answer(run.id);
    await until(() => commandsOf(h!.host, "session.prompt").length === 1);
  });

  it("evaluates token and USD soft approvals under one whole authorization", async () => {
    h = await setupHarness();
    const { run } = await startRun(h, {
      policy: continuation({ maxTokens: 1000, maxCostUsd: 10 }),
    });
    await completed(run.id, 800, 8);
    await until(() => !!pending(run.id)?.decisionId);
    const decisionId = pending(run.id)!.decisionId;
    await answer(run.id);
    await until(
      () =>
        h!.t.c.store.interactions
          .list()
          .filter((i) => i.permission?.decisionId === decisionId && i.state === "pending")
          .length === 1,
    );
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(0);
    expect(h.t.c.store.runs.require(run.id).continuationsUsed).toBe(0);
    await answer(run.id);
    await until(() => commandsOf(h!.host, "session.prompt").length === 1);
  });

  it("recovers a durable ASK after RunsService restarts, continuing only once", async () => {
    h = await setupHarness();
    const { run } = await startRun(h, {
      policy: continuation({ maxTokens: 1000 }),
    });
    await completed(run.id, 800);
    await until(() => !!pending(run.id)?.decisionId);
    const original = pending(run.id)!;
    (h.t.c.ctx.services.get("runs") as RunsService).stop();
    recoveredRuns = new RunsService(h.t.c.ctx);
    h.t.c.ctx.services.set("runs", recoveredRuns);
    recoveredRuns.start();
    await sleep(30);
    expect(pending(run.id)!.decisionId).toBe(original.decisionId);
    expect(h.t.c.store.runs.require(run.id).continuationsUsed).toBe(0);
    await answer(run.id);
    await until(() => commandsOf(h!.host, "session.prompt").length === 1);
    recoveredRuns.recover();
    await sleep(30);
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(1);
    expect(h.t.c.store.runs.require(run.id).continuationsUsed).toBe(1);
  });

  it("recovery discards an obsolete ASK and evaluates a newer durable settle in the same sweep", async () => {
    h = await setupHarness();
    const { run, task: tk } = await startRun(h, {
      policy: continuation({ maxTokens: 1000 }),
    });
    await completed(run.id, 800);
    await until(() => !!pending(run.id)?.decisionId);
    (h.t.c.ctx.services.get("runs") as RunsService).stop();
    const store = h.t.c.store;
    const session = store.sessions.require(run.sessionId!);
    store.tx(() => {
      store.noteRunSettle(run.id);
      store.putSession({
        ...session,
        lastAssistantText: "SWITCHYARD: DONE",
        stats: {
          tokens: 850,
          costUsd: null,
          watermark: { runtimeId: "accounting-epoch", settleSeq: 2 },
        },
      });
    });
    recoveredRuns = new RunsService(h.t.c.ctx);
    h.t.c.ctx.services.set("runs", recoveredRuns);
    recoveredRuns.start();
    await until(() => pending(run.id) === null);
    // An obsolete, unspent ASK must not take control away from the newer settle.
    expect(store.runs.require(run.id)).toMatchObject({
      controlMode: "automation",
      continuationsUsed: 0,
    });
    await until(() => task(h!, tk.id).state === "review");
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(0);
    expect(store.runs.require(run.id).continuationsUsed).toBe(0);
  });

  it.each([
    "settlement",
    "epoch",
    "sequence",
    "native",
    "runtime",
    "takeover",
    "manual",
    "model",
    "limits",
    "rule",
  ])("never executes an ASK approved against stale %s context", async (change) => {
    h = await setupHarness();
    const { run } = await startRun(h, {
      policy: continuation({ maxTokens: 1000 }),
    });
    await completed(run.id, 800);
    await until(() => !!pending(run.id)?.decisionId);
    const store = h.t.c.store;
    const session = store.sessions.require(run.sessionId!);
    if (change === "settlement") store.noteRunSettle(run.id);
    else if (change === "epoch" || change === "sequence")
      store.putSession({
        ...session,
        stats: {
          ...session.stats!,
          watermark: {
            runtimeId: change === "epoch" ? "new-epoch" : "accounting-epoch",
            settleSeq: change === "sequence" ? 2 : 1,
          },
        },
      });
    else if (change === "native")
      store.putSession({
        ...session,
        nativeHandle: {
          sessionId: "new-native",
          sessionFile: "/new.jsonl",
        },
      });
    else if (change === "runtime")
      store.putSession({
        ...session,
        bridge: {
          ...session.bridge!,
          runtimeId: "new-bridge",
        },
      });
    else if (change === "takeover")
      store.putRun({
        ...store.runs.require(run.id),
        controlMode: "human",
        controlRevision: 2,
      });
    else if (change === "manual") store.putSession({ ...session, runtime: "running" });
    else if (change === "model")
      store.putSession({
        ...session,
        model: {
          provider: "test",
          id: "other",
          name: "Other",
          contextWindow: 100000,
          reasoning: false,
          thinkingLevels: [],
        },
      });
    else if (change === "limits")
      store.putRun({
        ...store.runs.require(run.id),
        limits: {
          ...run.limits,
          enabled: true,
          objective: "changed",
          maxContinuations: 2,
          maxElapsedMinutes: 60,
          maxTokens: 2000,
          maxCostUsd: null,
        },
      });
    else
      await policies().updateRule("continuation-soft-budget", {
        expectedRevision: policies().getRule("continuation-soft-budget")!.revision,
        name: "Changed rule",
      });
    await answer(run.id).catch(() => undefined);
    (h.t.c.ctx.services.get("runs") as RunsService).recover();
    await sleep(50);
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(0);
    expect(store.runs.require(run.id).continuationsUsed).toBe(0);
  });

  it("rechecks time limits after approval rather than spending a continuation", async () => {
    h = await setupHarness();
    const { run, task: tk } = await startRun(h, {
      policy: continuation({ maxTokens: 1000, maxElapsedMinutes: 1 }),
    });
    await completed(run.id, 800);
    await until(() => !!pending(run.id)?.decisionId);
    h.t.clock.advance(61_000);
    await answer(run.id);
    await until(() => task(h!, tk.id).blocked !== null);
    expect(task(h, tk.id).blocked!.reason).toContain("elapsed-time limit");
    expect(runOf(h, tk.id).continuationsUsed).toBe(0);
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(0);
  });

  it("an ASK grant never bypasses a later server DENY", async () => {
    h = await setupHarness();
    await policies().createRule({
      scope: "server",
      scopeId: null,
      priority: 1000,
      enabled: true,
      phases: ["request"],
      name: "No continuations",
      expression: '{"verdict":"DENY","reason":"Later policy denied"}',
    });
    const { run, task: tk } = await startRun(h, {
      policy: continuation({ maxTokens: 1000 }),
    });
    await completed(run.id, 800);
    await until(() => !!pending(run.id)?.decisionId);
    await answer(run.id);
    await until(() => task(h!, tk.id).blocked !== null);
    expect(task(h, tk.id).blocked!.reason).toBe("Later policy denied");
    expect(runOf(h, tk.id).continuationsUsed).toBe(0);
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(0);
  });

  it("rechecks execution fences after an asynchronous authorization, before counting", async () => {
    h = await setupHarness();
    const { run } = await startRun(h, { policy: continuation() });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(policies(), "authorize").mockImplementationOnce(async () => {
      await gate;
      return { verdict: "ALLOW" };
    });
    await settle(h, run.sessionId!, "partial");
    await until(() => pending(run.id)?.phase === "authorization");
    const store = h.t.c.store;
    store.putRun({
      ...store.runs.require(run.id),
      controlMode: "human",
      controlRevision: 2,
    });
    release();
    await until(() => pending(run.id) === null);
    expect(store.runs.require(run.id).continuationsUsed).toBe(0);
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(0);
  });

  it("recovers the durable authorization input if stopped before authorize returns", async () => {
    h = await setupHarness();
    const { run } = await startRun(h, { policy: continuation() });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(policies(), "authorize").mockImplementationOnce(async () => {
      await gate;
      return { verdict: "ALLOW" };
    });
    await settle(h, run.sessionId!, "partial");
    await until(() => pending(run.id)?.phase === "authorization");
    const proof = pending(run.id)!.input;
    expect(h.t.c.store.runs.require(run.id).continuationsUsed).toBe(0);
    (h.t.c.ctx.services.get("runs") as RunsService).stop();
    recoveredRuns = new RunsService(h.t.c.ctx);
    h.t.c.ctx.services.set("runs", recoveredRuns);
    recoveredRuns.start();
    await until(() => commandsOf(h!.host, "session.prompt").length === 1);
    release();
    await sleep(30);
    expect(proof.nextContinuationNumber).toBe(1);
    expect(h.t.c.store.runs.require(run.id).continuationsUsed).toBe(1);
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(1);
  });

  it("does not treat unwatermarked display totals as completed budget accounting", async () => {
    h = await setupHarness();
    const { run, task: tk } = await startRun(h, {
      policy: continuation({ maxTokens: 1000 }),
    });
    await settle(h, run.sessionId!, "partial", {
      stats: { tokens: 100, costUsd: 0.1 },
    });
    await until(() => task(h!, tk.id).blocked !== null);
    expect(task(h, tk.id).blocked!.reason).toBe(
      "Budget accounting is unavailable; resume manually or remove the limit.",
    );
    expect(runOf(h, tk.id).continuationsUsed).toBe(0);
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(0);
  });

  it("fails closed when the policy service is unavailable", async () => {
    h = await setupHarness();
    const { run, task: tk } = await startRun(h, { policy: continuation() });
    const service = policies();
    h.t.c.ctx.services.delete("policies");
    await settle(h, run.sessionId!, "partial");
    await until(() => task(h!, tk.id).blocked !== null);
    h.t.c.ctx.services.set("policies", service);
    expect(task(h, tk.id).blocked!.reason).toContain("Policy authorization is unavailable");
    expect(runOf(h, tk.id).continuationsUsed).toBe(0);
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(0);
  });

  it("delivery recovery cannot send a previously approved command under a new control revision", async () => {
    h = await setupHarness();
    const { run } = await startRun(h, { policy: continuation() });
    h.override = (cmd) =>
      cmd.type === "session.prompt"
        ? { __error: { code: "timeout", message: "No receipt" } }
        : undefined;
    await settle(h, run.sessionId!, "partial");
    await until(() => pending(run.id)?.phase === "delivery");
    await until(() => commandsOf(h!.host, "session.prompt").length === 1);
    await sleep(30);
    const store = h.t.c.store;
    store.putRun({
      ...store.runs.require(run.id),
      controlMode: "automation",
      controlRevision: 3,
    });
    (h.t.c.ctx.services.get("runs") as RunsService).recover();
    await until(() => pending(run.id) === null);
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(1);
    expect(store.runs.require(run.id).continuationsUsed).toBe(1);
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

  it("a stale_control receipt pauses a reserved continuation for review", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h, { policy: continuation() });
    h.state.revisions.set(run.sessionId!, 5);
    await settle(h, run.sessionId!, "partial");
    await until(() => runOf(h!, tk.id).controlMode === "human");
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(1);
    expect(task(h, tk.id).blocked).toEqual({
      reason: `${CONTINUATION_PAUSED_NOTICE} ${CONTINUATION_UNCERTAIN_NOTICE}`,
    });
    expect(runOf(h, tk.id)).toMatchObject({
      state: "interrupted",
      controlMode: "human",
      controlRevision: 2,
      continuationsUsed: 1,
    });
    expect(pending(run.id)).toBeNull();
    expect(
      h.t.c.store.getSetting(`${CANCELED_CONTINUATION_PREFIX}${run.id}:1`, null),
    ).toMatchObject({
      commandId: `cont_${run.id}_1`,
      mayHaveSent: true,
      reason: expect.any(String),
    });
    expect(h.t.c.attention.open({ taskId: tk.id, reason: "failed" })).toHaveLength(1);
  });

  it("a continuation error after the run was stopped leaves it interrupted", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h, { policy: continuation() });
    h.override = (cmd) => {
      if (cmd.type !== "session.prompt" || cmd.origin !== "automation") return undefined;
      h!.t.c.store.putRun({ ...runOf(h!, tk.id), state: "interrupted" });
      return {
        __error: { code: "invalid_request", message: "Pi is not running" },
      };
    };
    await settle(h, run.sessionId!, "partial");
    await until(() => commandsOf(h!.host, "session.prompt").length === 1);
    await sleep(50);
    expect(runOf(h, tk.id).state).toBe("interrupted");
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
    // Leave durable work behind without the active-policy recovery listener evaluating it.
    (h.t.c.ctx.services.get("runs") as RunsService).stop();
    await h.host.close();
    store.tx(() => {
      const s = store.sessions.require(run.sessionId!);
      store.putSession({
        ...s,
        runtime: "idle",
        lastAssistantText: "Done.\nSWITCHYARD: DONE",
      });
      store.noteRunSettle(run.id);
    });
    recoveredRuns = new RunsService(h.t.c.ctx);
    h.t.c.ctx.services.set("runs", recoveredRuns);
    recoveredRuns.start();
    expect(task(h, tk.id).state).toBe("in_progress");
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
    // Persist the crash state with no live recovery listener or pending HostHub request.
    (h.t.c.ctx.services.get("runs") as RunsService).stop();
    await h.host.close();
    const session = store.sessions.require(run.sessionId!);
    store.tx(() => {
      store.putSession({
        ...session,
        bridge: { ...session.bridge!, policyState: "lost", policyPhases: [] },
      });
      store.putRun({ ...store.runs.require(run.id), state: "checking" });
    });
    recoveredRuns = new RunsService(h.t.c.ctx);
    h.t.c.ctx.services.set("runs", recoveredRuns);
    recoveredRuns.start();
    expect(commandsOf(h.host, "checks.run")).toHaveLength(0);
    await h.host.open();
    await until(() => task(h!, tk.id).state === "review");
    const sent = h.host.commands.filter((c) => c.command.type === "checks.run");
    expect(sent.map((c) => c.commandId)).toEqual([`chk_${run.id}_1_0_1`]);
  });

  it("recovery: an unacknowledged continuation is re-sent with the same command id and text", async () => {
    h = await setupHarness();
    const { run } = await startRun(h, { policy: continuation() });
    const store = h.t.c.store;
    // Authorized and reserved, but the receipt is lost. Recovery resends the same command.
    const settled = vi.spyOn(h.t.c.ctx.services.get("runs") as RunsService, "onSessionSettled");
    h.override = (cmd) =>
      cmd.type === "session.prompt"
        ? { __error: { code: "timeout", message: "Lost receipt" } }
        : undefined;
    await settle(h, run.sessionId!, "partial");
    await until(() => pending(run.id)?.phase === "delivery");
    await until(() => commandsOf(h!.host, "session.prompt").length === 1);
    await settled.mock.results.at(-1)!.value;
    const reservation = pending(run.id)!;
    const authorize = vi.spyOn(policies(), "authorize");
    h.override = undefined;
    await h.host.close();
    const offlineSession = store.sessions.require(run.sessionId!);
    store.putSession({
      ...offlineSession,
      bridge: { ...offlineSession.bridge!, policyState: "lost", policyPhases: [] },
    });
    await h.host.open();
    expect(commandsOf(h.host, "session.prompt")).toHaveLength(1);
    expect(pending(run.id)).toEqual(reservation);
    // A welcome is not proof that the same local policy binding is enforcing again.
    const session = store.sessions.require(run.sessionId!);
    await h.host.event("session.updated", {
      id: session.id,
      bridge: { ...session.bridge!, policyState: "active", policyPhases: ["request", "tool_call"] },
    });
    await until(() => commandsOf(h!.host, "session.prompt").length === 2);
    const sent = h.host.commands.filter((c) => c.command.type === "session.prompt");
    expect(sent.map((c) => c.commandId)).toEqual([`cont_${run.id}_1`, `cont_${run.id}_1`]);
    expect(sent[1]!.command).toEqual(sent[0]!.command);
    await until(() => store.getSetting(`runContinuation:${run.id}`, null) === null);
    expect(runOf(h, run.taskId).continuationsUsed).toBe(1);
    expect(authorize).not.toHaveBeenCalled();
    // Normal continuations use deterministic ids too.
    await settle(h, run.sessionId!, "Partway there.");
    await until(() => commandsOf(h!.host, "session.prompt").length === 3);
    expect(h.host.commands.filter((c) => c.command.type === "session.prompt")[2]!.commandId).toBe(
      `cont_${run.id}_2`,
    );
  });

  it("captures a final session runtime failure through the mirror path", async () => {
    h = await setupHarness();
    const { task: tk, run } = await startRun(h);
    const cwd = h.t.c.store.sessions.require(run.sessionId!).cwd;
    await h.host.event(
      "session.updated",
      hostSession(run.sessionId!, {
        cwd,
        runtime: "failed",
        runtimeDetail: "crashed",
      }),
    );
    expect(runOf(h, tk.id)).toMatchObject({
      state: "failed",
      outcome: { kind: "failed" },
    });
    const row = h.t.c.store.st.get("SELECT snapshot_json FROM task_completions").get() as {
      snapshot_json: string;
    };
    expect(JSON.parse(row.snapshot_json)).toMatchObject({
      outcome: "failed",
      runId: run.id,
      childSessionId: run.sessionId,
      failure: { kind: "failed", summary: "Session failed: crashed" },
    });
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
    expect(h.t.c.store.st.get("SELECT * FROM task_completions").all()).toHaveLength(0);
    expect(task(h, tk.id).blocked).toEqual({
      reason: "Session interrupted: resume to continue",
    });
    // A blocked task moves back without a pause/stop choice; dispatch resumes the same session.
    const back = await h.t.admin("POST", `/api/tasks/${tk.id}/move`, {
      to: "ready",
    });
    expect(back.body.state).toBe("ready");
    const second = await untilRun(h, tk.id, "running");
    expect(second.sessionId).toBe(run.sessionId);
    expect(second.attempt).toBe(2);
    const last = commandsOf(h.host, "dispatch.start").at(-1)!;
    expect(last.nativeHandle).not.toBeNull();
    expect(last.workspace).toEqual({ path: cwd });
  });
});
