import { createHash } from "node:crypto";
import {
  type AgentRequestFrame,
  AgentToolPolicyWait,
  canonicalPolicyJson,
  type Task,
} from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireService } from "../src/services.js";
import {
  enrollHost,
  FakeHost,
  hostSession,
  startCoordinator,
  type TestCoordinator,
} from "./helpers.js";

let t: TestCoordinator;
let host: FakeHost;
let root: Task;
let child: Task;
let sequence = 0;
const policies = () => requireService(t.c.ctx, "policies");
const agents = () => requireService(t.c.ctx, "agents");
const owner = () => ({
  authenticatedHostId: host.hostId,
  sessionId: "caller",
  nativeSessionId: "native",
  runtimeId: "bridge-runtime",
});
const boundary = {
  cwd: "/repo",
  cwdReal: "/repo",
  workspaceRoot: "/repo",
  workspaceRootReal: "/repo",
};
function frame(over: Partial<AgentRequestFrame> = {}): AgentRequestFrame {
  return {
    type: "agent.request",
    requestId: `request-${++sequence}`,
    sessionId: "caller",
    nativeSessionId: "native",
    runtimeId: "bridge-runtime",
    context: { humanInputId: null, causalMessageId: null },
    method: "task.create",
    toolCallId: "create-child",
    deadlineAt: new Date(t.clock.now + 30_000).toISOString(),
    args: { objective: "Do the requested work" },
    ...over,
  };
}
const receipts = () => t.c.store.db.prepare("SELECT * FROM agent_call_receipts").all();
const pending = () => t.c.store.interactions.list("state = 'pending'");
async function addTarget() {
  await host.event("session.updated", hostSession("target", { cwd: "/repo" }));
  t.c.store.putSession({ ...t.c.store.sessions.require("target"), projectId: "project" });
}
async function ask(name = "request approval", priority = -1) {
  return policies().createRule({
    scope: "server",
    scopeId: null,
    priority,
    enabled: true,
    phases: ["request"],
    name,
    expression: `{"verdict":"ASK","reason":"${name}"}`,
  });
}
async function answer(interactionId: string) {
  const interaction = t.c.store.interactions.require(interactionId);
  return t.admin("POST", `/api/interactions/${interactionId}/answer`, {
    revision: interaction.revision,
    response: { kind: "confirm", confirmed: true },
  });
}
async function statusOf(decisionId: string) {
  // Exercise the real 25-second protocol without delaying the test suite's wall clock.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const status = policies().status(owner(), { decisionId, waitMs: 25_000 });
    await vi.advanceTimersByTimeAsync(25_000);
    return await status;
  } finally {
    vi.useRealTimers();
  }
}
async function waitForPolicy(request: AgentRequestFrame) {
  const result = await agents().handle(host.hostId, request);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return AgentToolPolicyWait.parse(result.result);
}
function expectNoMutation() {
  expect(t.c.store.tasks.count()).toBe(2);
  expect(receipts()).toHaveLength(0);
  expect(t.c.store.db.prepare("SELECT * FROM task_subscriptions").all()).toHaveLength(0);
  expect(t.c.store.db.prepare("SELECT * FROM agent_messages").all()).toHaveLength(0);
}

beforeEach(async () => {
  t = await startCoordinator({
    schedulerTickMs: 0,
    dispatcher: { tickMs: 0 },
    cacheAlertTickMs: 0,
    projectScanIntervalMs: 0,
  });
  const credentials = await enrollHost(t);
  host = new FakeHost(
    t.c.localUrl.replace("http", "ws"),
    credentials.hostId,
    credentials.credential,
  );
  await host.open({ features: ["agentRequests.v1", "policies.v1"] });
  const now = t.c.store.nowIso();
  t.c.store.projects.upsert({
    id: "project",
    name: "Project",
    repoIdentity: "https://github.com/test/project",
    defaultProfileId: null,
    defaultHostId: host.hostId,
    maxConcurrentRuns: 1,
    automationEnabled: false,
    setupCommand: null,
    checks: [],
    workspaceSharing: "single_writer",
    worktreeDir: ".worktrees",
    createdAt: now,
    updatedAt: now,
  });
  const createdRoot = await t.admin("POST", "/api/tasks", { projectId: "project", title: "Root" });
  expect(createdRoot.status).toBe(201);
  root = createdRoot.body;
  const createdChild = await t.admin("POST", "/api/tasks", {
    projectId: "project",
    title: "Child",
    parentTaskId: root.id,
  });
  expect(createdChild.status).toBe(201);
  child = createdChild.body;
  await host.event("session.updated", hostSession("caller", { cwd: "/repo", nativeHandle: null }));
  t.c.store.putSession({
    ...t.c.store.sessions.require("caller"),
    projectId: "project",
    taskId: child.id,
  });
  expect(
    await agents().handle(
      host.hostId,
      frame({
        method: "session.bind",
        toolCallId: undefined,
        deadlineAt: undefined,
        args: {
          version: 1,
          sessionFile: null,
          mode: "rpc",
          policyRequired: true,
          controllerEpoch: "d56b0e03-6291-4bd1-b334-d924e559687f",
          capabilities: {
            agentTools: true,
            messageDelivery: true,
            editorDraftGuard: true,
            toolPolicy: true,
          },
          policyBoundary: boundary,
        },
      }),
    ),
  ).toMatchObject({ ok: true, result: { features: ["agentRequests.v1", "policies.v1"] } });
  const session = t.c.store.sessions.require("caller");
  t.c.store.putSession({
    ...session,
    bridge: { ...session.bridge!, policyState: "active", policyPhases: ["tool_call", "request"] },
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await host?.close();
  await t?.cleanup();
});

describe("D.5 builtin request authorization", () => {
  it("returns ASK promptly, keeps healthy waits beyond 30 seconds mutation-free, and requires explicit replay", async () => {
    await ask();
    const status = vi.spyOn(policies(), "status");
    const request = frame();
    const wait = await waitForPolicy(request);
    expect(status).not.toHaveBeenCalled(); // The adapter must not suspend the tool RPC.
    expect(await waitForPolicy(frame())).toEqual(wait);
    expect(pending()).toHaveLength(1);
    expectNoMutation();
    for (let i = 0; i < 2; i++) {
      t.clock.advance(35_000);
      expect(await statusOf(wait.decisionId)).toEqual({
        state: "pending",
      });
      expectNoMutation();
    }
    expect((await answer(wait.interactionId)).status).toBe(200);
    expect(await statusOf(wait.decisionId)).toEqual({
      state: "allowed",
    });
    expectNoMutation(); // Answer/status only change policy state, never resume a mutation.
    const originalFence = policies().assertAuthorized.bind(policies());
    const fence = vi.spyOn(policies(), "assertAuthorized");
    fence.mockImplementation((input) => {
      expect(t.c.store.inTransaction).toBe(true);
      expect(t.c.store.tasks.count()).toBe(2);
      return originalFence(input);
    });
    const resumed = await agents().handle(host.hostId, frame());
    expect(resumed).toMatchObject({
      ok: true,
      result: { task: { state: "ready", parentTaskId: child.id } },
    });
    expect(fence).toHaveBeenCalledOnce();
    expect(t.c.store.tasks.count()).toBe(3);
    expect(receipts()).toHaveLength(1);

    // A lost committed reply stays readable after the root ends and the old deadline expires.
    t.c.store.putTask({ ...root, state: "done" });
    const authorize = vi.spyOn(policies(), "authorize");
    const replay = await agents().handle(host.hostId, {
      ...request,
      requestId: "lost-reply-retry",
    });
    expect(replay).toMatchObject({ ok: true, result: resumed.ok ? resumed.result : undefined });
    expect(authorize).not.toHaveBeenCalled();
    expect(fence).toHaveBeenCalledOnce();
    expect(t.c.store.tasks.count()).toBe(3);
    expect(receipts()).toHaveLength(1);
  });

  it("does not execute between sequential ASK rules or after their answers until the retry", async () => {
    await ask("first", -2);
    await ask("second", -1);
    const wait = await waitForPolicy(frame());
    expect((await answer(wait.interactionId)).status).toBe(200);
    expectNoMutation();
    expect(await statusOf(wait.decisionId)).toEqual({
      state: "pending",
    });
    const second = pending()[0]!;
    expect(second.id).not.toBe(wait.interactionId);
    expect(second.permission?.decisionId).toBe(wait.decisionId);
    const nextWait = await waitForPolicy(frame());
    expect(nextWait).toMatchObject({ decisionId: wait.decisionId, interactionId: second.id });
    expectNoMutation();
    expect((await answer(second.id)).status).toBe(200);
    expect(await statusOf(wait.decisionId)).toEqual({
      state: "allowed",
    });
    expectNoMutation();
    expect(await agents().handle(host.hostId, frame())).toMatchObject({
      ok: true,
      result: { task: { state: "ready" } },
    });
    expect(t.c.store.tasks.count()).toBe(3);
  });

  it.each(["cancel", "lease expiry"])(
    "never creates an orphan after %s and a late answer",
    async (mode) => {
      await ask();
      const wait = await waitForPolicy(frame());
      if (mode === "cancel") await policies().cancel(owner(), { decisionId: wait.decisionId });
      else t.clock.advance(61_000);
      expect((await answer(wait.interactionId)).status).toBe(409);
      expect(await statusOf(wait.decisionId)).toMatchObject({ state: "canceled" });
      expectNoMutation();
    },
  );

  it("fences root completion and reopening after asynchronous ALLOW inside the action transaction", async () => {
    const authorize = policies().authorize.bind(policies());
    vi.spyOn(policies(), "authorize").mockImplementationOnce(async (input) => {
      const result = await authorize(input);
      expect(result.verdict).toBe("ALLOW");
      t.c.store.putTask({ ...root, state: "done" });
      t.c.store.putTask(root);
      return result;
    });
    const fence = vi.spyOn(policies(), "assertAuthorized");
    expect(await agents().handle(host.hostId, frame())).toMatchObject({
      ok: false,
      error: { code: "stale_control" },
    });
    expect(fence).toHaveBeenCalledOnce();
    expectNoMutation();
    expect(await agents().handle(host.hostId, frame({ toolCallId: "fresh-action" }))).toMatchObject(
      { ok: true, result: { task: { state: "ready" } } },
    );
  });

  it("does not mutate or store a receipt if the worker outlives this request's fixed deadline", async () => {
    const authorize = policies().authorize.bind(policies());
    vi.spyOn(policies(), "authorize").mockImplementationOnce(async (input) => {
      const result = await authorize(input);
      t.clock.advance(30_001);
      return result;
    });
    expect(await agents().handle(host.hostId, frame())).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    expectNoMutation();
    expect(await agents().handle(host.hostId, frame())).toMatchObject({
      ok: true,
      result: { task: { state: "ready" } },
    });
    expect(receipts()).toHaveLength(1);
  });

  it("does not send or consume message quota until the original method is explicitly retried", async () => {
    await addTarget();
    await ask();
    const request = () =>
      frame({
        method: "message.send",
        args: { sessionId: "target", body: "Message body", mode: "steer" },
      });
    const wait = await waitForPolicy(request());
    expect(await waitForPolicy(request())).toEqual(wait);
    expectNoMutation();
    expect((await answer(wait.interactionId)).status).toBe(200);
    expect(await statusOf(wait.decisionId)).toEqual({ state: "allowed" });
    expectNoMutation();
    const sent = await agents().handle(host.hostId, request());
    expect(sent).toMatchObject({ ok: true, result: { message: { kind: "message" } } });
    expect(t.c.store.db.prepare("SELECT * FROM agent_messages").all()).toHaveLength(1);
    const replay = await agents().handle(host.hostId, request());
    expect(replay).toMatchObject({ ok: true, result: sent.ok ? sent.result : undefined });
    expect(t.c.store.db.prepare("SELECT * FROM agent_messages").all()).toHaveLength(1);
    expect(receipts()).toHaveLength(1);
  });

  it("does not mark inbox bodies read during ASK or approval, and replays the committed read", async () => {
    await addTarget();
    const messages = requireService(t.c.ctx, "messages");
    const message = messages.send("target", {
      sessionId: "caller",
      body: "Unread body",
      mode: "queue",
    });
    const readAt = () =>
      t.c.store.db.prepare("SELECT read_at FROM agent_messages WHERE id=?").get(message.id);
    await ask();
    const request = () => frame({ method: "inbox.read", args: {} });
    const wait = await waitForPolicy(request());
    expect(await waitForPolicy(request())).toEqual(wait);
    expect(readAt()).toMatchObject({ read_at: null });
    expect(receipts()).toHaveLength(0);
    expect((await answer(wait.interactionId)).status).toBe(200);
    expect(await statusOf(wait.decisionId)).toEqual({ state: "allowed" });
    expect(readAt()).toMatchObject({ read_at: null });
    expect(receipts()).toHaveLength(0);
    const read = await agents().handle(host.hostId, request());
    expect(read).toMatchObject({
      ok: true,
      result: { messages: [{ id: message.id, readAt: expect.any(String) }] },
    });
    const committedReadAt = readAt();
    t.clock.advance(1_000);
    expect(await agents().handle(host.hostId, request())).toMatchObject({
      ok: true,
      result: read.ok ? read.result : undefined,
    });
    expect(readAt()).toEqual(committedReadAt);
    expect(receipts()).toHaveLength(1);
  });

  it("records a permanent forbidden receipt on DENY without executing", async () => {
    await policies().createRule({
      scope: "server",
      scopeId: null,
      priority: -1,
      enabled: true,
      phases: ["request"],
      name: "Deny request",
      expression: '{"verdict":"DENY","reason":"Not permitted"}',
    });
    const denied = await agents().handle(host.hostId, frame());
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "forbidden", message: "Not permitted" },
    });
    expect(t.c.store.tasks.count()).toBe(2);
    expect(receipts()).toHaveLength(1);
    const authorize = vi.spyOn(policies(), "authorize");
    expect(await agents().handle(host.hostId, frame())).toMatchObject({
      ok: false,
      error: { code: "forbidden", message: "Not permitted" },
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(receipts()).toHaveLength(1);
  });

  it("classifies a sample with fileless bridge identity without executing a tool", async () => {
    host.handler = (command) => {
      if (command.type !== "session.classifyPolicySample") return null;
      return {
        sessionId: command.sessionId,
        nativeSessionId: command.nativeSessionId,
        runtimeId: command.runtimeId,
        sampleId: command.sampleId,
        toolHash: createHash("sha256").update(canonicalPolicyJson(command.tool)).digest("hex"),
        boundary,
        defaultBranch: "main",
        safety: {
          destructiveDelete: false,
          forcePush: false,
          defaultBranchPush: false,
          uncertain: false,
          reasons: [],
        },
      };
    };
    const response = await t.admin("POST", "/api/policies/test", {
      sessionId: "caller",
      phase: "tool_call",
      tool: { name: "bash", args: { command: "echo sample" } },
      request: null,
    });
    expect(response.status).toBe(200);
    expect(response.body.verdict).toBe("ALLOW");
    expect(t.c.store.sessions.require("caller").nativeHandle).toBeNull();
    expect(host.commands.map(({ command }) => command.type)).toEqual([
      "session.classifyPolicySample",
    ]);
    expectNoMutation();
  });
});
