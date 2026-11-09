import { type Session, SwitchyardError } from "@switchyard/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireService } from "../src/services.js";
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
const canceled = (runId: string) =>
  h!.t.c.store.getSetting(`${CANCELED_CONTINUATION_PREFIX}${runId}:1`, null);
const prompts = () => h!.host.commands.filter(({ command }) => command.type === "session.prompt");

async function setup(commandTimeoutMs = 200) {
  h = await setupHarness({
    coordinator: { projectScanIntervalMs: 0, cacheAlertTickMs: 0, commandTimeoutMs },
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
  const source = { runtimeId: "bridge-runtime", nativeSessionId, controllerEpoch: "controller-1" };
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
  return { store, root, run, sessionId: session.id, source };
}

function bridge(sessionId: string, patch: Partial<NonNullable<Session["bridge"]>>) {
  const store = h!.t.c.store;
  const session = store.sessions.require(sessionId);
  store.putSession({ ...session, bridge: { ...session.bridge!, ...patch } });
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

async function publishActive(sessionId: string) {
  const session = h!.t.c.store.sessions.require(sessionId);
  await h!.host.event("session.updated", {
    id: sessionId,
    bridge: { ...session.bridge!, policyState: "active", policyPhases: ["tool_call", "request"] },
  });
}

function loseReceipt() {
  h!.override = (command) =>
    command.type === "session.prompt"
      ? { __error: { code: "timeout", message: "Lost receipt" } }
      : undefined;
}

function allowRows() {
  return h!.t.c.store.db
    .prepare("SELECT decision_id, verdict, canceled, revisions_json FROM policy_evaluations")
    .all();
}

async function expectPaused(runId: string, mayHaveSent: boolean) {
  const store = h!.t.c.store;
  await until(() => store.runs.require(runId).controlMode === "human");
  const run = store.runs.require(runId);
  expect(run).toMatchObject({ state: "interrupted", controlRevision: 2, continuationsUsed: 1 });
  expect(run.endedAt).toBeNull();
  expect(pending(runId)).toBeNull();
  expect(canceled(runId)).toMatchObject({
    commandId: continuationCommandId(runId, 1),
    reason: expect.any(String),
    mayHaveSent,
    at: store.nowIso(),
  });
  const reason = mayHaveSent
    ? `${CONTINUATION_PAUSED_NOTICE} ${CONTINUATION_UNCERTAIN_NOTICE}`
    : CONTINUATION_PAUSED_NOTICE;
  expect(store.tasks.require(run.taskId).blocked).toEqual({ reason });
  expect(commandsOf(h!.host, "session.abort")).toHaveLength(0);
  expect(commandsOf(h!.host, "session.stop")).toHaveLength(0);
}

function holdInitialWrite(runId: string, sessionId: string) {
  const hub = h!.t.c.ctx.hostHub;
  const send = hub.send.bind(hub);
  let held = false;
  vi.spyOn(hub, "send").mockImplementation((hostId, command, options) => {
    if (command.type === "session.prompt" && !held) {
      held = true;
      expect(pending(runId)).toMatchObject({ version: 3, phase: "delivery" });
      bridge(sessionId, { policyState: "lost", policyPhases: [] });
    }
    return send(hostId, command, options);
  });
}

afterEach(async () => {
  recovered?.stop();
  recovered = undefined;
  vi.restoreAllMocks();
  await cleanupHarness(h);
  h = undefined;
});

describe("D.7 captured source and stable continuation fingerprints", () => {
  it("ignores availability and file metadata but retains controller/root/accounting fences", async () => {
    const { store, root, run, sessionId } = await setup();
    const current = () => store.runs.require(run.id);
    const before = continuationContext(store, policies(), current());
    bridge(sessionId, { policyState: "lost", policyPhases: [], agentTools: false });
    const session = store.sessions.require(sessionId);
    store.putSession({
      ...session,
      connectivity: "reconnecting",
      lastActivityAt: "2026-11-09T00:00:00.000Z",
      nativeHandle: { sessionId: session.bridge!.nativeSessionId, sessionFile: "/new/path" },
    });
    expect(continuationContext(store, policies(), current())).toBe(before);
    bridge(sessionId, { policyState: "active", policyPhases: ["request"] });
    expect(continuationContext(store, policies(), current())).toBe(before);
    bridge(sessionId, { controllerEpoch: "controller-2" });
    expect(continuationContext(store, policies(), current())).not.toBe(before);
    bridge(sessionId, { controllerEpoch: "controller-1" });
    store.putTask({ ...root, state: "done" });
    store.putTask(root);
    expect(continuationContext(store, policies(), current())).not.toBe(before);
  });

  it("captures v3 source once and marks ambiguity only at the guarded external write", async () => {
    const { store, run, sessionId, source } = await setup();
    const authorize = policies().authorize.bind(policies());
    vi.spyOn(policies(), "authorize").mockImplementation((input) => {
      expect(pending(run.id)).toMatchObject({
        version: 3,
        source,
        phase: "authorization",
        deliveryAttempt: "not_sent",
      });
      return authorize(input);
    });
    const check = policies().checkReservedContinuation.bind(policies());
    const fence = vi
      .spyOn(policies(), "checkReservedContinuation")
      .mockImplementation((...args) => {
        expect(store.inTransaction).toBe(true);
        expect(pending(run.id)).toMatchObject({
          version: 3,
          source,
          phase: "delivery",
          deliveryAttempt: "not_sent",
        });
        expect(store.runs.require(run.id).continuationsUsed).toBe(1);
        return check(...args);
      });
    h!.override = (command) => {
      if (command.type === "session.prompt") {
        expect(store.inTransaction).toBe(false);
        expect(pending(run.id)).toMatchObject({ source, deliveryAttempt: "may_have_sent" });
      }
      return undefined;
    };
    await settle(sessionId);
    expect(fence).toHaveBeenCalledTimes(2); // offline-proof preflight and actual write fence
    expect(prompts().map(({ commandId }) => commandId)).toEqual([continuationCommandId(run.id, 1)]);
    expect(pending(run.id)).toBeNull();
  });
});

describe("D.7 deferred continuation delivery and recovery", () => {
  it("defers at the write boundary without pause/count/attempt changes, then pumps on active proof", async () => {
    const { store, run, sessionId, source } = await setup(2000);
    const requests = vi.spyOn(h!.t.c.ctx.hostHub, "request");
    holdInitialWrite(run.id, sessionId);
    const work = settle(sessionId);
    await until(
      () =>
        pending(run.id)?.phase === "delivery" &&
        store.sessions.require(sessionId).bridge?.policyState === "lost",
    );
    const reservation = pending(run.id)!;
    const allowed = allowRows();
    const authorize = vi.spyOn(policies(), "authorize");
    expect(reservation).toMatchObject({ version: 3, source, deliveryAttempt: "not_sent" });
    expect(prompts()).toHaveLength(0);
    expect(store.runs.require(run.id)).toMatchObject({
      continuationsUsed: 1,
      controlMode: "automation",
      state: "running",
    });
    expect(canceled(run.id)).toBeNull();
    bridge(sessionId, { policyState: "initializing", policyPhases: [] });
    h!.t.c.ctx.hostHub.retryDeferred(run.hostId!);
    expect(prompts()).toHaveLength(0);
    expect(pending(run.id)).toEqual(reservation);
    expect(allowRows()).toEqual(allowed);
    await publishActive(sessionId);
    await work;
    await until(() => pending(run.id) === null);
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]).toMatchObject({
      commandId: continuationCommandId(run.id, 1),
      command: {
        text: reservation.text,
        controlRevision: reservation.input.expectedControlRevision,
      },
    });
    expect(store.runs.require(run.id).continuationsUsed).toBe(1);
    expect(authorize).not.toHaveBeenCalled();
    expect(allowRows()).toEqual(allowed);
    expect(
      requests.mock.calls.filter(([, command]) => command.type === "session.prompt"),
    ).toHaveLength(1);
  });

  it("expires an in-memory deferred request without losing the durable reservation or permitting a late write", async () => {
    const { store, run, sessionId } = await setup();
    holdInitialWrite(run.id, sessionId);
    await settle(sessionId); // HostHub's original timer expires while the guard defers.
    const reservation = pending(run.id)!;
    expect(reservation.deliveryAttempt).toBe("not_sent");
    expect(prompts()).toHaveLength(0);
    const check = vi.spyOn(policies(), "checkReservedContinuation");
    h!.t.c.ctx.hostHub.retryDeferred(run.hostId!);
    expect(check).not.toHaveBeenCalled(); // The timed-out frame no longer exists.
    const authorize = vi.spyOn(policies(), "authorize");
    bridge(sessionId, { policyState: "active", policyPhases: ["tool_call", "request"] });
    await until(() => pending(run.id) === null);
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]).toMatchObject({
      commandId: continuationCommandId(run.id, 1),
      command: { text: reservation.text },
    });
    expect(store.runs.require(run.id).continuationsUsed).toBe(1);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("preserves ALLOW and original command through disconnect/lost/same-binding active recovery", async () => {
    const { store, run, sessionId } = await setup();
    loseReceipt();
    await settle(sessionId);
    const original = prompts()[0];
    const reservation = pending(run.id)!;
    const allowed = allowRows();
    const authorize = vi.spyOn(policies(), "authorize");
    await h!.host.close();
    bridge(sessionId, { policyState: "lost", policyPhases: [] });
    runs().recover();
    expect(pending(run.id)).toEqual(reservation);
    h!.override = undefined;
    await h!.host.open();
    expect(prompts()).toHaveLength(1);
    expect(pending(run.id)).toEqual(reservation);
    bridge(sessionId, { policyState: "active", policyPhases: ["tool_call", "request"] });
    await until(() => pending(run.id) === null);
    expect(prompts()).toEqual([original, original]);
    expect(store.runs.require(run.id).continuationsUsed).toBe(1);
    expect(allowRows()).toEqual(allowed);
    expect(authorize).not.toHaveBeenCalled();
    expect(canceled(run.id)).toBeNull();
  });

  it("reruns the tri-state guard on HostHub auto-resend and waits for committed active readiness", async () => {
    const { run, sessionId } = await setup(2000);
    h!.override = (command) => (command.type === "session.prompt" ? NO_REPLY : undefined);
    const work = settle(sessionId);
    await until(() => prompts().length === 1);
    const original = prompts()[0];
    await h!.host.close();
    bridge(sessionId, { policyState: "lost", policyPhases: [] });
    h!.override = undefined;
    await h!.host.open();
    expect(prompts()).toEqual([original]);
    expect(pending(run.id)?.deliveryAttempt).toBe("may_have_sent");
    await publishActive(sessionId);
    await work;
    expect(prompts()).toEqual([original, original]);
    expect(pending(run.id)).toBeNull();
  });
});

describe("D.7 permanent invalidation never hides behind unavailable transport", () => {
  it.each(["agentRequests.v1", "policies.v1"])(
    "pauses when the current welcome is missing %s despite cached potential",
    async (missing) => {
      const { store, run, sessionId } = await setup();
      loseReceipt();
      await settle(sessionId);
      await h!.host.close();
      bridge(sessionId, { policyState: "lost", policyPhases: [] });
      h!.override = undefined;
      await h!.host.open({
        features: ["agentRequests.v1", "policies.v1"].filter((feature) => feature !== missing),
      });
      await expectPaused(run.id, true);
      expect(store.hosts.require(run.hostId!).capabilities?.policies).toBe(true);
      expect(prompts()).toHaveLength(1);
      expect(canceled(run.id)).toMatchObject({
        reason: expect.stringMatching(/upgrad|support|polic|feature/i),
      });
    },
  );

  it.each(["controller-2", undefined])(
    "pauses a changed/missing controller epoch %s even when its bridge is lost",
    async (controllerEpoch) => {
      const { run, sessionId } = await setup();
      loseReceipt();
      await settle(sessionId);
      await h!.host.close();
      bridge(sessionId, { controllerEpoch, policyState: "lost", policyPhases: [] });
      runs().recover();
      await expectPaused(run.id, true);
      expect(prompts()).toHaveLength(1);
    },
  );

  it.each(["root", "canceled ALLOW"])(
    "pauses %s changes offline instead of indefinitely deferring",
    async (change) => {
      const { store, root, run, sessionId } = await setup();
      loseReceipt();
      await settle(sessionId);
      await h!.host.close();
      bridge(sessionId, { policyState: "lost", policyPhases: [] });
      if (change === "root") {
        store.putTask({ ...root, state: "done" });
        store.putTask(root);
      } else store.db.exec("UPDATE policy_evaluations SET canceled=1 WHERE verdict='ALLOW'");
      runs().recover();
      await expectPaused(run.id, true);
      expect(prompts()).toHaveLength(1);
    },
  );

  it("pauses a permanent failure at the first write without falsely claiming a send happened", async () => {
    const { run, sessionId } = await setup();
    const hub = h!.t.c.ctx.hostHub;
    const send = hub.send.bind(hub);
    vi.spyOn(hub, "send").mockImplementation((hostId, command, options) => {
      if (command.type === "session.prompt") {
        vi.spyOn(policies(), "checkReservedContinuation").mockImplementationOnce(() => {
          throw new SwitchyardError(
            "unsupported_capability",
            "Upgrade the host policy implementation",
          );
        });
      }
      return send(hostId, command, options);
    });
    await settle(sessionId);
    await expectPaused(run.id, false);
    expect(canceled(run.id)).toMatchObject({ reason: "Upgrade the host policy implementation" });
    expect(prompts()).toHaveLength(0);
  });

  it.each([1, 2])(
    "never upgrades an unprovable v%s reservation with today's source",
    async (version) => {
      const { store, run, sessionId } = await setup();
      loseReceipt();
      await settle(sessionId);
      const { source: _source, deliveryAttempt: _attempt, ...record } = pending(run.id)!;
      store.setSetting(CONTINUATION_PREFIX + run.id, {
        ...record,
        version,
        ...(version === 2 ? { deliveryAttempt: "not_sent" } : {}),
      });
      h!.override = undefined;
      runs().recover();
      await expectPaused(run.id, version === 1);
      expect(prompts()).toHaveLength(1);
    },
  );

  it("retains original ambiguity and root fencing across RunsService restart", async () => {
    const { store, root, run, sessionId } = await setup();
    loseReceipt();
    await settle(sessionId);
    runs().stop();
    await h!.host.close();
    store.putTask({ ...root, state: "done" });
    store.putTask(root);
    recovered = new RunsService(h!.t.c.ctx);
    recovered.start();
    await expectPaused(run.id, true);
    expect(prompts()).toHaveLength(1);
  });
});
