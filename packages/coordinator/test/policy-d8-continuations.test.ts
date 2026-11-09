import type { Run } from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireService } from "../src/services.js";
import { returnToAutomation, takeover } from "../src/sessions/control.js";
import {
  CANCELED_AUTHORIZATION_PREFIX,
  CANCELED_CONTINUATION_PREFIX,
  CONTINUATION_PREFIX,
  CONTINUATION_UNCERTAIN_NOTICE,
  type PendingContinuation,
  SETTLEMENT_PREFIX,
} from "../src/tasks/continuations.js";
import { RunsService } from "../src/tasks/runs.js";
import { until } from "./helpers.js";
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
const runs = () => recovered ?? requireService(h!.t.c.ctx, "runs");
const pending = (runId: string) =>
  h!.t.c.store.getSetting<PendingContinuation | null>(CONTINUATION_PREFIX + runId, null);
const fenceKey = (p: PendingContinuation) =>
  `${CANCELED_AUTHORIZATION_PREFIX}${p.input.runId}:${p.n}:${p.input.expectedControlRevision}:${p.input.expectedSettleCount}`;

async function setup(ask = true, checks: string[] = []) {
  h = await setupHarness({
    coordinator: { projectScanIntervalMs: 0, cacheAlertTickMs: 0 },
    checks,
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
  const source = {
    runtimeId: "bridge-runtime",
    nativeSessionId: session.nativeHandle!.sessionId,
    controllerEpoch: "controller-1",
  };
  store.putSession({
    ...session,
    bridge: {
      version: 1,
      ...source,
      agentTools: true,
      messageDelivery: true,
      policyState: "active",
      policyPhases: ["tool_call", "request"],
    },
  });
  policies().bindBoundary(
    { authenticatedHostId: session.hostId, sessionId: session.id, ...source },
    {
      cwd: session.cwd,
      cwdReal: session.cwd,
      workspaceRoot: session.cwd,
      workspaceRootReal: session.cwd,
    },
  );
  if (ask)
    await policies().createRule({
      scope: "server",
      scopeId: null,
      priority: -1,
      enabled: true,
      phases: ["request"],
      name: "Continue approval",
      expression: '{"verdict":"ASK","reason":"Approve continuation"}',
    });
  h.host.commands.length = 0;
  return { store, root, run, sessionId: session.id };
}

/** Persist exactly the crash-time projection without letting the old RunsService consume it. */
function persistSettle(run: Run, text: string) {
  const store = h!.t.c.store;
  const count = store.noteRunSettle(run.id);
  const watermark = { runtimeId: "usage-epoch", settleSeq: count };
  const session = store.sessions.require(run.sessionId!);
  store.sessions.upsert({
    ...session,
    runtime: "idle",
    lastAssistantText: text,
    stats: { tokens: count * 10, costUsd: count / 100, watermark },
  });
  return {
    session: store.sessions.require(session.id),
    aborted: false,
    lastAssistantText: text,
    watermark,
  };
}

async function firstAsk(run: Run) {
  await runs().onSessionSettled(persistSettle(run, "Still working"));
  const authorization = pending(run.id)!;
  expect(authorization).toMatchObject({ phase: "authorization", decisionId: expect.any(String) });
  expect(authorization.input.expectedSettleCount).toBe(1);
  return authorization;
}

function restart() {
  runs().stop();
  recovered = new RunsService(h!.t.c.ctx);
  recovered.start();
}

function expectUnspent(run: Run, authorization: PendingContinuation) {
  const store = h!.t.c.store;
  expect(store.runs.require(run.id)).toMatchObject({
    controlMode: "automation",
    controlRevision: run.controlRevision,
    continuationsUsed: 0,
  });
  expect(store.getSetting(fenceKey(authorization), null)).toEqual({
    reason: expect.any(String),
    at: store.nowIso(),
  });
  expect(store.getSetting(`${CANCELED_CONTINUATION_PREFIX}${run.id}:1`, null)).toBeNull();
  expect(commandsOf(h!.host, "session.prompt")).toHaveLength(0);
  expect(commandsOf(h!.host, "session.setControl")).toHaveLength(0);
  expect(store.tasks.require(run.taskId).blocked?.reason ?? "").not.toContain(
    CONTINUATION_UNCERTAIN_NOTICE,
  );
}

function decision(decisionId: string) {
  return h!.t.c.store.db
    .prepare("SELECT canceled, verdict FROM policy_evaluations WHERE decision_id=?")
    .get(decisionId);
}

function discard(service: RunsService, runId: string, expected: PendingContinuation) {
  return (
    service as unknown as {
      discardContinuationAuthorization(
        id: string,
        p: PendingContinuation,
        reason: string,
      ): "discarded" | "replaced" | false;
    }
  ).discardContinuationAuthorization(runId, expected, "Superseded authorization");
}

afterEach(async () => {
  recovered?.stop();
  recovered = undefined;
  vi.restoreAllMocks();
  await cleanupHarness(h);
  h = undefined;
});

describe("D.8 obsolete unspent authorization recovery", () => {
  it.each(["SWITCHYARD: DONE", "SWITCHYARD: NO_CHANGE"])(
    "recovers the newest %s through normal checks/Review without takeover or delivery warnings",
    async (marker) => {
      const { store, run } = await setup(true, ["test acceptance"]);
      const old = await firstAsk(run);
      runs().stop();
      const latest = persistSettle(run, marker);
      // A stale waiting_input projection is normalized by evaluation, not by discard.
      store.putRun({ ...store.runs.require(run.id), state: "waiting_input" });
      const cancelAuthorization = policies().cancelContinuationAuthorization.bind(policies());
      const cancel = vi
        .spyOn(policies(), "cancelContinuationAuthorization")
        .mockImplementation((input, reason) => {
          expect(store.inTransaction).toBe(true);
          expect(pending(run.id)).toEqual(old);
          expect(store.runs.require(run.id).state).toBe("waiting_input");
          expect(store.getSetting(fenceKey(old), null)).not.toBeNull();
          expect(store.getSetting(`runEvaluated:${run.id}`, 0)).toBe(1);
          expect(store.getSetting(SETTLEMENT_PREFIX + run.id, null)).toEqual({
            count: 1,
            watermark: old.input.expectedWatermark,
          });
          cancelAuthorization(input, reason);
        });
      restart();
      await until(() => store.runs.require(run.id).state === "succeeded");
      expect(store.tasks.require(run.taskId).state).toBe("review");
      expect(pending(run.id)).toBeNull();
      expectUnspent(run, old);
      expect(cancel).toHaveBeenCalledExactlyOnceWith(old.input, expect.any(String));
      expect(decision(old.decisionId!)).toMatchObject({ canceled: 1 });
      expect(store.interactions.list("state='pending'")).toHaveLength(0);
      expect(h!.t.c.attention.open({ reason: "needs_input" })).toHaveLength(0);
      expect(commandsOf(h!.host, "checks.run")).toHaveLength(1);
      expect(store.getSetting(SETTLEMENT_PREFIX + run.id, null)).toEqual({
        count: 2,
        watermark: latest.watermark,
      });
      runs().recover();
      expect(commandsOf(h!.host, "checks.run")).toHaveLength(1);
    },
  );

  it("gives a newer unfinished settle its own ASK and ignores a late old approval/update", async () => {
    const { store, run } = await setup();
    const old = await firstAsk(run);
    const interaction = store.interactions.list("state='pending'")[0]!;
    runs().stop();
    persistSettle(run, "New unfinished work");
    restart();
    await until(() => pending(run.id)?.input.expectedSettleCount === 2);
    await until(() => !!pending(run.id)?.decisionId);
    const next = pending(run.id)!;
    expect(next.decisionId).not.toBe(old.decisionId);
    expect(next.n).toBe(old.n);
    expect(decision(old.decisionId!)).toMatchObject({ canceled: 1 });
    expect(decision(next.decisionId!)).toMatchObject({ canceled: 0, verdict: "ASK" });
    await expect(
      policies().answer(old.decisionId!, interaction.revision, true, "late-device"),
    ).rejects.toThrow();
    h!.t.c.ctx.hub.emit("event", {
      seq: 999,
      id: "late-interaction-event",
      at: store.nowIso(),
      type: "interaction.updated",
      data: store.interactions.require(interaction.id),
    });
    await until(() => pending(run.id)?.decisionId === next.decisionId);
    expectUnspent(run, old);
    expect(store.getSetting(fenceKey(next), null)).toBeNull();
    expect(store.db.prepare("SELECT * FROM policy_grants").all()).toHaveLength(0);
  });

  it("discards an old ASK on the live settlement cleanup path, then evaluates the newest settle", async () => {
    const { store, run } = await setup();
    const old = await firstAsk(run);
    const latest = persistSettle(run, "SWITCHYARD: DONE");
    await runs().onSessionSettled(latest);
    await until(() => store.runs.require(run.id).state === "succeeded");
    expect(store.tasks.require(run.taskId).state).toBe("review");
    expectUnspent(run, old);
    expect(decision(old.decisionId!)).toMatchObject({ canceled: 1 });
  });

  it.each([false, true])(
    "uses latest persisted text/watermark after an in-flight old authorize returns (failed=%s)",
    async (failed) => {
      const { store, run } = await setup();
      const authorize = policies().authorize.bind(policies());
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let old: PendingContinuation | null = null;
      vi.spyOn(policies(), "authorize").mockImplementationOnce(async (input) => {
        old = pending(run.id);
        await gate;
        if (failed) throw new Error("Obsolete worker failed");
        return authorize(input);
      });
      const evaluating = runs().onSessionSettled(persistSettle(run, "Old unfinished text"));
      await until(() => !!old);
      const latest = persistSettle(run, "SWITCHYARD: DONE");
      await runs().onSessionSettled(latest); // deferred while the old worker holds busy
      release();
      await evaluating;
      await until(() => store.runs.require(run.id).state === "succeeded");
      expect(store.tasks.require(run.taskId).state).toBe("review");
      expectUnspent(run, old!);
      expect(pending(run.id)).toBeNull();
      expect(store.getSetting(SETTLEMENT_PREFIX + run.id, null)).toEqual({
        count: 2,
        watermark: latest.watermark,
      });
    },
  );

  it.each(["human takeover", "terminal run", "terminal root"])(
    "preserves %s while an obsolete authorization is awaiting its worker",
    async (change) => {
      const { store, root, run } = await setup();
      const authorize = policies().authorize.bind(policies());
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let waiting = false;
      vi.spyOn(policies(), "authorize").mockImplementationOnce(async (input) => {
        const result = await authorize(input);
        waiting = true;
        await gate;
        return result;
      });
      const evaluating = runs().onSessionSettled(persistSettle(run, "Unfinished work"));
      await until(() => waiting);
      const old = pending(run.id)!;
      persistSettle(run, "SWITCHYARD: DONE");
      if (change === "human takeover")
        store.putRun({ ...store.runs.require(run.id), controlMode: "human", controlRevision: 2 });
      if (change === "terminal run")
        store.putRun({ ...store.runs.require(run.id), state: "canceled" });
      if (change === "terminal root") store.putTask({ ...root, state: "done" });
      const before = store.runs.require(run.id);
      release();
      await evaluating;
      expect(store.runs.require(run.id)).toEqual(before);
      expect(store.tasks.require(run.taskId).state).toBe("in_progress");
      expect(pending(run.id)).toBeNull();
      expect(store.getSetting(fenceKey(old), null)).not.toBeNull();
      expect(commandsOf(h!.host, "session.prompt")).toHaveLength(0);
      expect(commandsOf(h!.host, "session.setControl")).toHaveLength(0);
    },
  );

  it("fences a delayed old worker before it can recreate ASK after compare-and-delete", async () => {
    const { store, run } = await setup();
    const authorize = policies().authorize.bind(policies());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(policies(), "authorize").mockImplementationOnce(async (input) => {
      await gate;
      return authorize(input);
    });
    const evaluating = runs().onSessionSettled(persistSettle(run, "Old work"));
    const old = pending(run.id)!;
    expect(discard(runs(), run.id, old)).toBe("discarded");
    expect(store.getSetting(`runEvaluated:${run.id}`, 0)).toBe(1);
    release();
    await evaluating;
    expect(pending(run.id)).toBeNull();
    expect(store.interactions.list("state='pending'")).toHaveLength(0);
    expectUnspent(run, old);
  });

  it("does not evaluate an already evaluated newer settle twice", async () => {
    const { store, run } = await setup();
    const old = await firstAsk(run);
    runs().stop();
    persistSettle(run, "Already handled");
    store.setSetting(`runEvaluated:${run.id}`, 2);
    const authorize = vi.spyOn(policies(), "authorize");
    restart();
    await until(() => pending(run.id) === null);
    runs().recover();
    expect(authorize).not.toHaveBeenCalled();
    expectUnspent(run, old);
    expect(store.runs.require(run.id).state).toBe("running");
  });

  it("cancels an obsolete same-settle wait without reauthorizing or busy-looping", async () => {
    const { store, root, run } = await setup();
    const old = await firstAsk(run);
    runs().stop();
    // Restoring the fields cannot restore the monotonic root epoch.
    store.putTask({ ...root, state: "done" });
    store.putTask(root);
    const authorize = vi.spyOn(policies(), "authorize");
    restart();
    await until(() => pending(run.id) === null);
    for (let i = 0; i < 3; i++) runs().recover();
    expect(authorize).not.toHaveBeenCalled();
    expect(store.getSetting(`runEvaluated:${run.id}`, 0)).toBe(1);
    expectUnspent(run, old);
  });

  it("allows an explicit return to automation to authorize the same settle under a new control identity", async () => {
    const { store, run, sessionId } = await setup();
    const old = await firstAsk(run);
    await takeover(h!.t.c.ctx, sessionId);
    expect(store.runs.require(run.id).continuationsUsed).toBe(0);
    await returnToAutomation(h!.t.c.ctx, sessionId);
    await until(() => pending(run.id)?.input.expectedControlRevision === 3);
    await until(() => !!pending(run.id)?.decisionId);
    const next = pending(run.id)!;
    expect(next.input.expectedSettleCount).toBe(1);
    expect(next.decisionId).not.toBe(old.decisionId);
    expect(store.getSetting(fenceKey(old), null)).not.toBeNull();
    expect(store.getSetting(fenceKey(next), null)).toBeNull();
    expect(store.runs.require(run.id)).toMatchObject({
      controlMode: "automation",
      controlRevision: 3,
      continuationsUsed: 0,
    });
    expect(commandsOf(h!.host, "session.prompt")).toHaveLength(0);
  });

  it.each([1, 2])(
    "discards recognized v%s unspent authorization without upgrading authority",
    async (version) => {
      const { store, run } = await setup();
      const old = await firstAsk(run);
      runs().stop();
      store.setSetting(CONTINUATION_PREFIX + run.id, { ...old, version });
      persistSettle(run, "SWITCHYARD: DONE");
      const authorize = vi.spyOn(policies(), "authorize");
      restart();
      await until(() => store.runs.require(run.id).state === "succeeded");
      expect(authorize).not.toHaveBeenCalled();
      expectUnspent(run, old);
    },
  );

  it.each(["new authorization", "delivery"])(
    "compare-and-delete preserves a replacement %s",
    async (replacement) => {
      const { store, run } = await setup();
      const old = await firstAsk(run);
      runs().stop();
      const next: PendingContinuation =
        replacement === "delivery"
          ? { ...old, phase: "delivery" }
          : { ...old, input: { ...old.input, expectedSettleCount: 2 }, context: "new context" };
      store.setSetting(CONTINUATION_PREFIX + run.id, next);
      const cancel = vi.spyOn(policies(), "cancelContinuationAuthorization");
      expect(discard(runs(), run.id, old)).toBe("replaced");
      expect(pending(run.id)).toEqual(next);
      expect(cancel).not.toHaveBeenCalled();
      expect(store.getSetting(fenceKey(old), null)).toBeNull();
      expect(store.getSetting(`${CANCELED_CONTINUATION_PREFIX}${run.id}:1`, null)).toBeNull();
    },
  );

  it.each([
    ["authorization", false],
    ["delivery", false],
    ["authorization", true],
  ] as const)(
    "recovers a replacement's actual %s phase after the old worker returns (failed=%s)",
    async (phase, failed) => {
      const { store, run } = await setup();
      const authorize = policies().authorize.bind(policies());
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let waiting = false;
      vi.spyOn(policies(), "authorize").mockImplementationOnce(async (input) => {
        const result = await authorize(input);
        waiting = true;
        await gate;
        if (failed) throw new Error("Obsolete worker failed");
        return result;
      });
      const evaluating = runs().onSessionSettled(persistSettle(run, "Old work"));
      await until(() => waiting);
      const old = pending(run.id)!;
      const next: PendingContinuation = { ...old, phase, context: "Replacement proof" };
      store.setSetting(CONTINUATION_PREFIX + run.id, next);
      // Observe the recovery dispatch rather than execute this synthetic replacement proof.
      const resume = vi
        .spyOn(
          runs() as unknown as {
            resumeContinuation(id: string, p: PendingContinuation): Promise<void>;
          },
          "resumeContinuation",
        )
        .mockResolvedValue();
      release();
      await evaluating;
      await until(() => resume.mock.calls.length === 1);
      expect(resume).toHaveBeenCalledExactlyOnceWith(run.id, next);
      expect(pending(run.id)).toEqual(next);
      expect(store.getSetting(fenceKey(old), null)).toBeNull();
      expect(store.runs.require(run.id)).toMatchObject({
        controlMode: "automation",
        continuationsUsed: 0,
      });
      expect(commandsOf(h!.host, "session.setControl")).toHaveLength(0);
    },
  );

  it.each(["human", "terminal run", "terminal root", "replaced attempt"])(
    "does not reverse %s during newest-settle recovery",
    async (change) => {
      const { store, root, run } = await setup();
      await firstAsk(run);
      runs().stop();
      persistSettle(run, "SWITCHYARD: DONE");
      if (change === "human")
        store.putRun({ ...store.runs.require(run.id), controlMode: "human", controlRevision: 2 });
      if (change === "terminal run")
        store.putRun({ ...store.runs.require(run.id), state: "canceled" });
      if (change === "terminal root") store.putTask({ ...root, state: "done" });
      if (change === "replaced attempt")
        store.putTask({ ...store.tasks.require(run.taskId), currentRunId: null });
      const before = store.runs.require(run.id);
      restart();
      runs().recover();
      expect(store.runs.require(run.id)).toEqual(before);
      expect(store.tasks.require(run.taskId).state).toBe("in_progress");
      expect(commandsOf(h!.host, "session.prompt")).toHaveLength(0);
      expect(commandsOf(h!.host, "session.setControl")).toHaveLength(0);
    },
  );

  it.each(["delivery", "may_have_sent", "inconsistent count", "unknown format"])(
    "retains conservative pause handling for %s",
    async (kind) => {
      const { store, run } = await setup();
      const old = await firstAsk(run);
      runs().stop();
      const p = { ...old };
      if (kind === "delivery") p.phase = "delivery";
      if (kind === "may_have_sent") p.deliveryAttempt = "may_have_sent";
      store.setSetting(
        CONTINUATION_PREFIX + run.id,
        kind === "unknown format" ? { ...p, version: 99 } : p,
      );
      if (kind === "delivery" || kind === "inconsistent count")
        store.putRun({ ...store.runs.require(run.id), continuationsUsed: 1 });
      persistSettle(run, "SWITCHYARD: DONE");
      restart();
      await until(() => store.runs.require(run.id).controlMode === "human");
      expect(pending(run.id)).toBeNull();
      expect(store.getSetting(fenceKey(old), null)).toBeNull();
      expect(store.getSetting(`${CANCELED_CONTINUATION_PREFIX}${run.id}:1`, null)).not.toBeNull();
      expect(store.runs.require(run.id).continuationsUsed).toBe(
        kind === "delivery" || kind === "inconsistent count" ? 1 : 0,
      );
      expect(commandsOf(h!.host, "session.prompt")).toHaveLength(0);
    },
  );

  it.each(["running", "compacting"])(
    "waits for an eligible idle session after discard (%s)",
    async (state) => {
      const { store, run, sessionId } = await setup();
      const old = await firstAsk(run);
      runs().stop();
      persistSettle(run, "SWITCHYARD: DONE");
      const session = store.sessions.require(sessionId);
      store.sessions.upsert({
        ...session,
        runtime: state === "running" ? "running" : "idle",
        compacting: state === "compacting",
      });
      restart();
      await until(() => pending(run.id) === null);
      expectUnspent(run, old);
      expect(store.runs.require(run.id).state).toBe("running");
      expect(store.getSetting(`runEvaluated:${run.id}`, 0)).toBe(1);
      store.sessions.upsert({
        ...store.sessions.require(sessionId),
        runtime: "idle",
        compacting: false,
      });
      runs().recover();
      await until(() => store.runs.require(run.id).state === "succeeded");
      expect(store.tasks.require(run.taskId).state).toBe("review");
    },
  );

  it("keeps a same-settle unspent authorization during temporary disconnection", async () => {
    const { store, run, sessionId } = await setup();
    const old = await firstAsk(run);
    await h!.host.close();
    const session = store.sessions.require(sessionId);
    store.putSession({
      ...session,
      bridge: { ...session.bridge!, policyState: "lost", policyPhases: [] },
    });
    const authorize = vi.spyOn(policies(), "authorize");
    runs().recover();
    expect(pending(run.id)).toEqual(old);
    expect(authorize).not.toHaveBeenCalled();
    expect(store.getSetting(fenceKey(old), null)).toBeNull();
    expect(store.runs.require(run.id)).toMatchObject({
      controlMode: "automation",
      continuationsUsed: 0,
    });
  });
});
