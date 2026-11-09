import { afterEach, describe, expect, it, vi } from "vitest";
import { requireService } from "../src/services.js";
import { CONTINUATION_PREFIX, type PendingContinuation } from "../src/tasks/continuations.js";
import { continuationCommandId } from "../src/tasks/runs.js";
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
const policies = () => requireService(h!.t.c.ctx, "policies");
const runs = () => requireService(h!.t.c.ctx, "runs");
const pending = (runId: string) =>
  h!.t.c.store.getSetting<PendingContinuation | null>(CONTINUATION_PREFIX + runId, null);
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
        objective: "Finish the work",
        maxContinuations: 2,
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
  return { store, root, run };
}
async function settle(sessionId: string) {
  const settled = vi.spyOn(runs(), "onSessionSettled");
  await h!.host.event("session.updated", { id: sessionId, runtime: "running" });
  await h!.host.event("session.updated", {
    id: sessionId,
    runtime: "idle",
    lastAssistantText: "Still working",
    settled: { aborted: false, lastAssistantText: "Still working" },
  });
  await until(() => settled.mock.results.length > 0);
  await settled.mock.results[0]!.value;
}
function expectUnspent(runId: string) {
  expect(h!.t.c.store.runs.require(runId).continuationsUsed).toBe(0);
  expect(commandsOf(h!.host, "session.prompt")).toHaveLength(0);
  expect(pending(runId)).toBeNull();
}

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupHarness(h);
  h = undefined;
});

describe("D.5 continuation final authorization transaction", () => {
  it("checks synchronous authority inside the reservation transaction before spending the step", async () => {
    const { store, run } = await setup();
    const assertAuthorized = policies().assertAuthorized.bind(policies());
    const fence = vi.spyOn(policies(), "assertAuthorized").mockImplementation((input) => {
      expect(store.inTransaction).toBe(true);
      expect(store.runs.require(run.id).continuationsUsed).toBe(0);
      expect(pending(run.id)?.phase).toBe("authorization");
      assertAuthorized(input);
    });
    await settle(run.sessionId!);
    expect(fence).toHaveBeenCalledOnce();
    expect(fence).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "continuation",
        runId: run.id,
        nextContinuationNumber: 1,
      }),
    );
    expect(store.runs.require(run.id).continuationsUsed).toBe(1);
    expect(commandsOf(h!.host, "session.prompt")).toHaveLength(1);
    expect(
      h!.host.commands.find(({ command }) => command.type === "session.prompt")?.commandId,
    ).toBe(continuationCommandId(run.id, 1));
    expect(pending(run.id)).toBeNull();
  });

  it("rejects a root done/reopen between asynchronous ALLOW and reservation without spending or delivering", async () => {
    const { store, root, run } = await setup();
    const authorize = policies().authorize.bind(policies());
    vi.spyOn(policies(), "authorize").mockImplementationOnce(async (input) => {
      const result = await authorize(input);
      expect(result.verdict).toBe("ALLOW");
      // Restore the visible state exactly: only the monotonic root epoch proves staleness.
      store.putTask({ ...root, state: "done" });
      store.putTask(root);
      return result;
    });
    const fence = vi.spyOn(policies(), "assertAuthorized");
    await settle(run.sessionId!);
    // The epoch-bearing context rejects this before the final authorization fence.
    expect(fence).not.toHaveBeenCalled();
    expectUnspent(run.id);
  });

  it("does not treat an unpersisted evaluator ALLOW as authority", async () => {
    const { run } = await setup();
    vi.spyOn(policies(), "authorize").mockResolvedValueOnce({
      verdict: "ALLOW",
    });
    const fence = vi.spyOn(policies(), "assertAuthorized");
    await settle(run.sessionId!);
    expect(fence).toHaveBeenCalledOnce();
    expectUnspent(run.id);
  });

  it("keeps durable continuation ASK unspent and applies the final fence after approval", async () => {
    const { store, run } = await setup();
    await policies().createRule({
      scope: "server",
      scopeId: null,
      priority: -1,
      enabled: true,
      phases: ["request"],
      name: "Continue approval",
      expression: '{"verdict":"ASK","reason":"Approve continuation"}',
    });
    const fence = vi.spyOn(policies(), "assertAuthorized");
    await settle(run.sessionId!);
    const authorization = pending(run.id)!;
    expect(authorization).toMatchObject({
      phase: "authorization",
      n: 1,
      decisionId: expect.any(String),
    });
    expect(store.runs.require(run.id).continuationsUsed).toBe(0);
    expect(fence).not.toHaveBeenCalled();
    expect(commandsOf(h!.host, "session.prompt")).toHaveLength(0);
    const row = store.db
      .prepare("SELECT wait_lease_until FROM policy_evaluations WHERE decision_id=?")
      .get(authorization.decisionId!);
    expect(row).toMatchObject({ wait_lease_until: null });
    // Internal continuations are durable, not dependent on a fictitious tool status poller.
    h!.t.clock.advance(70_000);
    const interaction = store.interactions.list("state = 'pending'")[0]!;
    const answered = await h!.t.admin("POST", `/api/interactions/${interaction.id}/answer`, {
      revision: interaction.revision,
      response: { kind: "confirm", confirmed: true },
    });
    expect(answered.status).toBe(200);
    await until(() => commandsOf(h!.host, "session.prompt").length === 1);
    expect(fence).toHaveBeenCalledOnce();
    expect(store.runs.require(run.id).continuationsUsed).toBe(1);
  });
});
