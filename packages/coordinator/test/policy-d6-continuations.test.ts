import { SwitchyardError } from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireService } from "../src/services.js";
import { pauseRunForPolicy, returnToAutomation, takeover } from "../src/sessions/control.js";
import {
  CANCELED_CONTINUATION_PREFIX,
  CONTINUATION_PAUSED_NOTICE,
  CONTINUATION_PREFIX,
  CONTINUATION_UNCERTAIN_NOTICE,
  continuationContext,
  type PendingContinuation,
} from "../src/tasks/continuations.js";
import { continuationCommandId, RunsService } from "../src/tasks/runs.js";
import { NO_REPLY, until } from "./helpers.js";
import {
  cleanupHarness,
  commandsOf,
  createTask,
  type Harness,
  setupHarness,
  startRun,
} from "./task-helpers.js";

let h: Harness | undefined;
let recovered: RunsService | undefined;
const policies = () => requireService(h!.t.c.ctx, "policies");
const runs = () => requireService(h!.t.c.ctx, "runs");
const pending = (runId: string) =>
  h!.t.c.store.getSetting<PendingContinuation | null>(CONTINUATION_PREFIX + runId, null);
const canceled = (runId: string, n = 1) =>
  h!.t.c.store.getSetting(`${CANCELED_CONTINUATION_PREFIX}${runId}:${n}`, null);
const prompts = () => h!.host.commands.filter(({ command }) => command.type === "session.prompt");

async function setup() {
  h = await setupHarness({
    coordinator: { projectScanIntervalMs: 0, cacheAlertTickMs: 0 },
  });
  const root = await createTask(h, { title: "Root" });
  const { run } = await startRun(h, {
    parentTaskId: root.id,
    policy: {
      continuation: {
        enabled: true,
        objective: "Finish safely",
        maxContinuations: 3,
        maxElapsedMinutes: 60,
        maxTokens: null,
        maxCostUsd: null,
      },
    },
  });
  const store = h.t.c.store;
  const session = store.sessions.require(run.sessionId!);
  const nativeSessionId = session.nativeHandle!.sessionId;
  store.putSession({
    ...session,
    bridge: {
      version: 1,
      runtimeId: "bridge-runtime",
      controllerEpoch: "controller-epoch",
      nativeSessionId,
      agentTools: true,
      messageDelivery: true,
      policyState: "active",
      policyPhases: ["tool_call", "request"],
    },
  });
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
      workspaceRoot: session.cwd,
      workspaceRootReal: session.cwd,
    },
  );
  return { store, root, run, sessionId: session.id, nativeSessionId };
}

async function settle(sessionId: string) {
  const settled = vi.spyOn(runs(), "onSessionSettled");
  const previous = settled.mock.results.length;
  await h!.host.event("session.updated", { id: sessionId, runtime: "running" });
  await h!.host.event("session.updated", {
    id: sessionId,
    runtime: "idle",
    lastAssistantText: "Still working",
    settled: { aborted: false, lastAssistantText: "Still working" },
  });
  await until(() => settled.mock.results.length > previous);
  await settled.mock.results[previous]!.value;
}

function loseReceipt() {
  h!.override = (command) =>
    command.type === "session.prompt"
      ? { __error: { code: "timeout", message: "Lost receipt" } }
      : undefined;
}
function cancelAllow() {
  h!.t.c.store.db.exec("UPDATE policy_evaluations SET canceled=1 WHERE verdict='ALLOW'");
}

async function expectPaused(runId: string, mayHaveSent: boolean) {
  const store = h!.t.c.store;
  await until(() => store.runs.require(runId).controlMode === "human");
  const run = store.runs.require(runId);
  expect(run).toMatchObject({
    state: "interrupted",
    controlRevision: 2,
    continuationsUsed: 1,
  });
  expect(run.endedAt).toBeNull();
  expect(pending(runId)).toBeNull();
  expect(canceled(runId)).toMatchObject({
    commandId: continuationCommandId(runId, 1),
    reason: expect.any(String),
    mayHaveSent,
    at: store.nowIso(),
  });
  const notice = mayHaveSent
    ? `${CONTINUATION_PAUSED_NOTICE} ${CONTINUATION_UNCERTAIN_NOTICE}`
    : CONTINUATION_PAUSED_NOTICE;
  expect(store.tasks.require(run.taskId).blocked).toEqual({ reason: notice });
  expect(h!.t.c.attention.open({ taskId: run.taskId, reason: "failed" })).toHaveLength(1);
  await until(() =>
    commandsOf(h!.host, "session.setControl").some((command) => command.mode === "human"),
  );
  expect(commandsOf(h!.host, "session.abort")).toHaveLength(0);
  expect(commandsOf(h!.host, "session.stop")).toHaveLength(0);
}

afterEach(async () => {
  recovered?.stop();
  recovered = undefined;
  vi.restoreAllMocks();
  await cleanupHarness(h);
  h = undefined;
});

describe("D.6 durable continuation send authority", () => {
  it("includes the persisted root epoch even when all visible root fields are restored", async () => {
    const { store, root, run } = await setup();
    const before = continuationContext(store, policies(), run);
    const fence = policies().rootFence(run.taskId)!;
    store.putTask({ ...root, state: "done" });
    store.putTask(root);
    expect(store.tasks.require(root.id)).toEqual(root);
    expect(policies().rootFence(run.taskId)!.epoch).toBeGreaterThan(fence.epoch);
    expect(continuationContext(store, policies(), run)).not.toBe(before);
  });

  it("checks the physical reservation transaction and commits may_have_sent before external write", async () => {
    const { store, run, sessionId } = await setup();
    const assert = policies().checkReservedContinuation.bind(policies());
    const fence = vi
      .spyOn(policies(), "checkReservedContinuation")
      .mockImplementation((input, context) => {
        expect(store.inTransaction).toBe(true);
        expect(store.runs.require(run.id).continuationsUsed).toBe(1);
        expect(pending(run.id)).toMatchObject({
          version: 3,
          phase: "delivery",
          deliveryAttempt: "not_sent",
        });
        return assert(input, context);
      });
    h!.override = (command) => {
      if (command.type === "session.prompt") {
        expect(store.inTransaction).toBe(false);
        expect(pending(run.id)?.deliveryAttempt).toBe("may_have_sent");
      }
      return undefined;
    };
    await settle(sessionId);
    expect(fence.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(prompts().map(({ commandId }) => commandId)).toEqual([continuationCommandId(run.id, 1)]);
    expect(pending(run.id)).toBeNull();
  });

  it("rejects an ALLOW canceled between reservation and the initial socket write", async () => {
    const { run, sessionId } = await setup();
    const hub = h!.t.c.ctx.hostHub;
    const send = hub.send.bind(hub);
    vi.spyOn(hub, "send").mockImplementation((hostId, command, options) => {
      if (command.type === "session.prompt") {
        expect(pending(run.id)?.phase).toBe("delivery");
        expect(h!.t.c.store.inTransaction).toBe(false);
        cancelAllow();
      }
      return send(hostId, command, options);
    });
    await settle(sessionId);
    expect(prompts()).toHaveLength(0);
    await expectPaused(run.id, false);
  });

  it("turns even a forbidden proof failure into a safe pause, not final run failure", async () => {
    const { store, run, sessionId } = await setup();
    vi.spyOn(policies(), "checkReservedContinuation").mockImplementationOnce(() => {
      throw new SwitchyardError("forbidden", "Root task ended");
    });
    await settle(sessionId);
    expect(prompts()).toHaveLength(0);
    await expectPaused(run.id, false);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM task_completions").get()).toMatchObject({
      n: 0,
    });
  });

  it("retains a valid automatic reconnect resend guard and its original command", async () => {
    const { store, run, sessionId } = await setup();
    const fence = vi.spyOn(policies(), "checkReservedContinuation");
    h!.override = (command) => (command.type === "session.prompt" ? NO_REPLY : undefined);
    const work = settle(sessionId);
    await until(() => prompts().length === 1);
    await h!.host.close();
    h!.override = undefined;
    await h!.host.open();
    await work;
    expect(fence.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1]).toEqual(prompts()[0]);
    expect(store.runs.require(run.id).continuationsUsed).toBe(1);
    expect(pending(run.id)).toBeNull();
  });

  it("does not replay merely to retrieve a receipt once Pi may already be running", async () => {
    const { store, run, sessionId } = await setup();
    loseReceipt();
    await settle(sessionId);
    store.putSession({
      ...store.sessions.require(sessionId),
      runtime: "running",
    });
    h!.override = undefined;
    runs().recover();
    await expectPaused(run.id, true);
    expect(store.sessions.require(sessionId).runtime).toBe("running");
    expect(prompts()).toHaveLength(1);
  });

  it("revalidates a canceled ALLOW with otherwise identical context on recovery", async () => {
    const { store, run, sessionId } = await setup();
    loseReceipt();
    await settle(sessionId);
    const reservation = pending(run.id)!;
    cancelAllow();
    expect(continuationContext(store, policies(), store.runs.require(run.id))).toBe(
      reservation.context,
    );
    h!.override = undefined;
    runs().recover();
    await expectPaused(run.id, true);
    expect(prompts()).toHaveLength(1);
  });

  it("valid retry preserves id, text, revision and exactly one spent count", async () => {
    const { store, run, sessionId } = await setup();
    const fence = vi.spyOn(policies(), "checkReservedContinuation");
    loseReceipt();
    await settle(sessionId);
    expect(pending(run.id)).toMatchObject({
      version: 3,
      deliveryAttempt: "may_have_sent",
    });
    h!.override = undefined;
    runs().recover();
    await until(() => pending(run.id) === null);
    expect(fence.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1]).toEqual(prompts()[0]);
    expect(store.runs.require(run.id).continuationsUsed).toBe(1);
    expect(canceled(run.id)).toBeNull();
  });

  it("does not replay a root done/reopen reservation after service restart", async () => {
    const { store, root, run, sessionId } = await setup();
    loseReceipt();
    await settle(sessionId);
    runs().stop();
    store.putTask({ ...root, state: "done" });
    store.putTask(root);
    h!.override = undefined;
    recovered = new RunsService(h!.t.c.ctx);
    recovered.start();
    await expectPaused(run.id, true);
    expect(prompts()).toHaveLength(1);
    // Root reopening and live runtime projection cannot undo the explicit policy pause.
    recovered.mirror({
      ...store.sessions.require(sessionId),
      runtime: "running",
    });
    recovered.recover();
    expect(store.runs.require(run.id)).toMatchObject({
      state: "interrupted",
      controlMode: "human",
    });
    expect(prompts()).toHaveLength(1);
  });

  it("guards HostHub automatic reconnect replay and never resends an ambiguous revoked prompt", async () => {
    const { store, root, run, sessionId } = await setup();
    h!.override = (command) => (command.type === "session.prompt" ? NO_REPLY : undefined);
    const work = settle(sessionId);
    await until(() => prompts().length === 1);
    await h!.host.close();
    store.putTask({ ...root, state: "done" });
    store.putTask(root);
    h!.override = undefined;
    await h!.host.open();
    await work;
    await expectPaused(run.id, true);
    expect(prompts()).toHaveLength(1);
  });

  it("keeps a reserved fileless actor valid through same-ID handle discovery and path changes", async () => {
    const { store, run, sessionId, nativeSessionId } = await setup();
    const session = store.sessions.require(sessionId);
    store.putSession({ ...session, nativeHandle: null });
    loseReceipt();
    await settle(sessionId);
    const reservation = pending(run.id)!;
    const current = store.sessions.require(sessionId);
    store.putSession({
      ...current,
      nativeHandle: {
        sessionId: nativeSessionId,
        sessionFile: "/discovered.jsonl",
      },
    });
    expect(continuationContext(store, policies(), store.runs.require(run.id))).toBe(
      reservation.context,
    );
    store.putSession({
      ...store.sessions.require(sessionId),
      nativeHandle: { sessionId: nativeSessionId, sessionFile: "/moved.jsonl" },
    });
    expect(continuationContext(store, policies(), store.runs.require(run.id))).toBe(
      reservation.context,
    );
    h!.override = undefined;
    runs().recover();
    await until(() => pending(run.id) === null);
    expect(prompts()).toHaveLength(2);
    expect(store.runs.require(run.id).continuationsUsed).toBe(1);
    expect(canceled(run.id)).toBeNull();
  });

  it("rejects a conflicting native handle without laundering it into the stable fingerprint", async () => {
    const { store, run, sessionId } = await setup();
    loseReceipt();
    await settle(sessionId);
    const reservation = pending(run.id)!;
    store.sessions.upsert({
      ...store.sessions.require(sessionId),
      nativeHandle: { sessionId: "other-native", sessionFile: "/other.jsonl" },
    });
    expect(continuationContext(store, policies(), store.runs.require(run.id))).toBe(
      reservation.context,
    );
    h!.override = undefined;
    runs().recover();
    await expectPaused(run.id, true);
    expect(prompts()).toHaveLength(1);
  });

  it.each([1, 2])(
    "never retrofits a v%s legacy reservation and retains its counted number",
    async (version) => {
      const { store, run, sessionId } = await setup();
      loseReceipt();
      await settle(sessionId);
      const { deliveryAttempt: _attempt, ...legacy } = pending(run.id)!;
      store.setSetting(CONTINUATION_PREFIX + run.id, { ...legacy, version });
      const authorize = vi.spyOn(policies(), "authorize");
      h!.override = undefined;
      runs().recover();
      await expectPaused(run.id, true);
      expect(authorize).not.toHaveBeenCalled();
      expect(prompts()).toHaveLength(1);
    },
  );

  it("requires explicit return and uses the next number after invalidated delivery", async () => {
    const { store, run, sessionId } = await setup();
    loseReceipt();
    await settle(sessionId);
    cancelAllow();
    h!.override = undefined;
    runs().recover();
    await expectPaused(run.id, true);
    await returnToAutomation(h!.t.c.ctx, sessionId);
    await until(() => prompts().length === 2);
    expect(prompts().map(({ commandId }) => commandId)).toEqual([
      continuationCommandId(run.id, 1),
      continuationCommandId(run.id, 2),
    ]);
    expect(store.runs.require(run.id)).toMatchObject({
      controlMode: "automation",
      controlRevision: 3,
      continuationsUsed: 2,
    });
    expect(canceled(run.id)).not.toBeNull();
  });

  it("pauses an ambiguous reservation instead of discarding it on a newer settle", async () => {
    const { run, sessionId } = await setup();
    loseReceipt();
    await settle(sessionId);
    h!.override = undefined;
    await settle(sessionId);
    await expectPaused(run.id, true);
    expect(prompts()).toHaveLength(1);
  });

  it("propagates policy pause after the outer transaction and never regresses a newer takeover", async () => {
    const { store, run, sessionId } = await setup();
    const withdraw = vi.spyOn(h!.t.c.ctx.hostHub, "withdrawMatching").mockImplementation(() => {
      expect(store.inTransaction).toBe(false);
      return 0;
    });
    let pause!: Promise<unknown>;
    store.tx(() => {
      pause = pauseRunForPolicy(h!.t.c.ctx, run.id, "Policy changed");
      expect(store.runs.require(run.id)).toMatchObject({
        state: "interrupted",
        controlMode: "human",
        controlRevision: 2,
      });
      expect(withdraw).not.toHaveBeenCalled();
    });
    await pause;
    expect(withdraw).toHaveBeenCalledOnce();
    expect(commandsOf(h!.host, "session.abort")).toHaveLength(0);
    await takeover(h!.t.c.ctx, sessionId);
    const human = store.runs.require(run.id);
    await pauseRunForPolicy(h!.t.c.ctx, run.id, "Late policy failure");
    expect(store.runs.require(run.id)).toEqual(human);
  });

  it("does not alter a terminal or replaced run when an old policy failure arrives", async () => {
    const { store, run } = await setup();
    const finished = store.putRun({
      ...store.runs.require(run.id),
      state: "succeeded",
      endedAt: store.nowIso(),
    });
    await pauseRunForPolicy(h!.t.c.ctx, run.id, "Late failure");
    expect(store.runs.require(run.id)).toEqual(finished);
    store.putRun({ ...finished, state: "running", endedAt: null });
    store.putTask({ ...store.tasks.require(run.taskId), currentRunId: null });
    const replaced = store.runs.require(run.id);
    await pauseRunForPolicy(h!.t.c.ctx, run.id, "Late failure");
    expect(store.runs.require(run.id)).toEqual(replaced);
    expect(commandsOf(h!.host, "session.setControl")).toHaveLength(0);
  });

  it("never retries or refunds when the final proof rejects at the first send", async () => {
    const { store, run, sessionId } = await setup();
    vi.spyOn(policies(), "checkReservedContinuation").mockImplementationOnce(() => {
      throw new SwitchyardError("stale_control", "Proof revoked");
    });
    await settle(sessionId);
    await expectPaused(run.id, false);
    runs().recover();
    expect(store.runs.require(run.id).continuationsUsed).toBe(1);
    expect(prompts()).toHaveLength(0);
  });
});
