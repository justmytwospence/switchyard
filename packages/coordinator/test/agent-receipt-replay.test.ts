import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentReceiptPeekResult,
  type AgentRequestFrame,
  type Profile,
  type Session,
  SwitchyardError,
} from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageService } from "../src/agents/messages.js";
import { AgentService, type AgentServiceOptions } from "../src/agents/service.js";
import { migrate, openDb } from "../src/db/index.js";
import { EventHub } from "../src/event-hub.js";
import { PolicyService } from "../src/policies/service.js";
import { Store } from "../src/store.js";
import { createTask } from "../src/tasks/service.js";
import { fullCapabilities } from "./task-helpers.js";

const start = Date.parse("2026-01-01T00:00:00.000Z");
const profile: Profile = {
  id: "profile",
  name: "Test",
  provider: null,
  model: null,
  thinking: null,
  projectTrust: "ask",
  extraArgs: [],
};
const boundary = {
  cwd: "/repo",
  cwdReal: "/repo",
  workspaceRoot: "/repo",
  workspaceRootReal: "/repo",
};
const unavailable = {
  ok: false,
  error: {
    code: "conflict",
    message: "The recorded tool result is no longer available; no action was executed.",
  },
};
let directory: string;
let path: string;
let now: number;
let store: Store;
let service: AgentService;
let messages: MessageService;
let options: AgentServiceOptions;
let policies: PolicyService | undefined;

function frame(overrides: Partial<AgentRequestFrame> = {}): AgentRequestFrame {
  return {
    type: "agent.request",
    requestId: randomUUID(),
    sessionId: "caller",
    nativeSessionId: "native",
    runtimeId: "runtime",
    context: { humanInputId: null, causalMessageId: null },
    toolCallId: "call",
    deadlineAt: new Date(now + 30_000).toISOString(),
    method: "task.create",
    args: { objective: "Create exactly one child" },
    ...overrides,
  };
}

function open() {
  const db = openDb(path);
  migrate(db);
  store = new Store(db, new EventHub(), () => new Date(now));
  messages = new MessageService(store, {
    isConnected: () => false,
    accept: async () => {
      throw new Error("Delivery must not be attempted by receipt retrieval");
    },
    status: async () => null,
  });
  for (const method of ["recordContext", "send", "readInbox", "wake"] as const)
    vi.spyOn(messages, method);
  options = {
    store,
    messages,
    scheduleDispatch: vi.fn(),
    negotiatedFeatures: () => new Set(["agentRequests.v1", "policies.v1"]),
    bindPolicyBoundary: vi.fn(),
    authorize: vi.fn(async () => ({ verdict: "ALLOW" })),
    assertAuthorization: vi.fn(),
    policyRequest: vi.fn(),
  };
  service = new AgentService(options);
}

function bind(overrides: Partial<AgentRequestFrame> = {}, controllerEpoch = "controller") {
  return service.handle(
    "host",
    frame({
      method: "session.bind",
      toolCallId: undefined,
      deadlineAt: undefined,
      args: {
        version: 1,
        sessionFile: "/sessions/same-file.jsonl",
        mode: "rpc",
        capabilities: {
          agentTools: true,
          messageDelivery: true,
          editorDraftGuard: true,
          toolPolicy: true,
        },
        policyRequired: true,
        controllerEpoch,
        policyBoundary: boundary,
      },
      ...overrides,
    }),
  );
}

function peek(request: AgentRequestFrame) {
  return service.handle("host", {
    ...request,
    requestId: randomUUID(),
    method: "receipt.peek",
    args: { method: request.method, args: request.args },
  });
}

async function foundHash(request: AgentRequestFrame) {
  const result = await peek(request);
  expect(result).toMatchObject({ ok: true, result: { found: true } });
  if (!result.ok) throw new Error("Expected receipt probe success");
  const found = result.result as AgentReceiptPeekResult;
  if (!found.found) throw new Error("Expected a committed receipt");
  expect(found.requestHash).toMatch(/^[a-f0-9]{64}$/);
  expect(found).toEqual({ found: true, requestHash: found.requestHash });
  return found.requestHash;
}

function replay(request: AgentRequestFrame, requestHash: string) {
  return service.handle("host", {
    ...request,
    requestId: randomUUID(),
    receiptReplay: { requestHash },
  });
}

/** All durable data, not just task counts: probes/replays must not write even bookkeeping. */
function snapshot() {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as { name: string }[];
  return tables.map(({ name }) => [name, store.db.prepare(`SELECT * FROM "${name}"`).all()]);
}

function expectNoCallbacks() {
  expect(options.authorize).not.toHaveBeenCalled();
  expect(options.assertAuthorization).not.toHaveBeenCalled();
  expect(options.policyRequest).not.toHaveBeenCalled();
  expect(options.scheduleDispatch).not.toHaveBeenCalled();
  for (const method of ["recordContext", "send", "readInbox", "wake"] as const)
    expect(messages[method]).not.toHaveBeenCalled();
}

beforeEach(async () => {
  now = start;
  directory = mkdtempSync(join(tmpdir(), "sy-receipt-replay-"));
  path = join(directory, "coordinator.sqlite");
  open();
  store.hosts.upsert(
    {
      id: "host",
      name: "Test",
      platform: "darwin",
      agentVersion: "test",
      piVersion: "1.5.0",
      piCompatible: true,
      capabilities: fullCapabilities(),
      connectivity: "connected",
      lastSeenAt: store.nowIso(),
      revokedAt: null,
      createdAt: store.nowIso(),
    },
    { credential_hash: "test-hash" },
  );
  store.profiles.upsert(profile);
  store.projects.upsert({
    id: "project",
    name: "Project",
    repoIdentity: "https://github.com/test/test",
    defaultProfileId: profile.id,
    defaultHostId: "host",
    maxConcurrentRuns: 1,
    automationEnabled: false,
    setupCommand: null,
    checks: [],
    workspaceSharing: "single_writer",
    worktreeDir: ".worktrees",
    createdAt: store.nowIso(),
    updatedAt: store.nowIso(),
  });
  const caller: Session = {
    id: "caller",
    title: "Caller",
    subtitle: null,
    hostId: "host",
    projectId: "project",
    workspaceId: null,
    cwd: "/repo",
    nativeHandle: null,
    profileSnapshot: profile,
    runtime: "idle",
    runtimeDetail: null,
    connectivity: "connected",
    runId: null,
    taskId: null,
    provenance: "created",
    readOnly: false,
    lastActivityAt: store.nowIso(),
    archivedAt: null,
    queue: { steering: [], followUp: [] },
    stats: null,
    lastAssistantText: null,
    createdAt: store.nowIso(),
  };
  store.putSession(caller);
  store.putSession({ ...caller, id: "target" });
  expect(await bind()).toMatchObject({ ok: true });
  vi.clearAllMocks();
});

afterEach(async () => {
  await policies?.stop();
  policies = undefined;
  await messages.stop();
  store.db.close();
  rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const tools = [
  {
    method: "task.create",
    args: { objective: "Create exactly one child" },
    normalized: {
      notifyOnFinish: true,
      dependencies: [],
      acceptance: [],
      objective: "Create exactly one child",
    },
  },
  {
    method: "message.send",
    args: { sessionId: "target", body: "Hello", mode: "queue" },
    normalized: { mode: "queue", body: "Hello", sessionId: "target" },
  },
  { method: "inbox.read", args: {}, normalized: { limit: 20, after: 0 } },
] as const;

describe("D.9 restricted receipt lookup and replay", () => {
  it.each(tools)(
    "normalizes $method exactly like the original call, with no policy/quota/context/read accounting",
    async ({ method, args, normalized }) => {
      if (method === "inbox.read")
        messages.send("target", { sessionId: "caller", body: "Unread body", mode: "queue" });
      const request = frame({ method, args });
      const first = await service.handle("host", request);
      expect(first.ok).toBe(true);
      // Simulate subsequent delivery/read metadata changes. A replay is the original snapshot.
      store.db.exec("UPDATE agent_messages SET delivery_state = 'appended', read_at = NULL");
      const before = snapshot();
      vi.clearAllMocks();
      options.authorize = vi.fn(async () => ({ verdict: "DENY", reason: "New work denied" }));
      options.assertAuthorization = vi.fn(() => {
        throw new SwitchyardError("stale_control", "Old authorization cannot be reused");
      });
      // Trusted context must not be recorded by either read-only path.
      const normalizedRequest = {
        ...request,
        args: { ...normalized, ignoredByToolSchema: "not part of identity" },
        context: { humanInputId: "new-human", causalMessageId: "not-an-incoming-message" },
      };
      const hash = await foundHash(normalizedRequest);
      expect(await replay(normalizedRequest, hash)).toEqual({
        ...first,
        requestId: expect.any(String),
      });
      expect(snapshot()).toEqual(before);
      expectNoCallbacks();
    },
  );

  it.each([{ objective: "" }, { objective: "Bad acceptance", acceptance: [""] }])(
    "uses the original raw-argument hash for a permanent validation error: %j",
    async (args) => {
      const request = frame({ args });
      const first = await service.handle("host", request);
      expect(first).toMatchObject({ ok: false, error: { code: "invalid_request" } });
      const before = snapshot();
      vi.clearAllMocks();
      const hash = await foundHash(request);
      expect(await replay(request, hash)).toEqual({ ...first, requestId: expect.any(String) });
      expect(await peek({ ...request, args: { ...args, notifyOnFinish: true } })).toMatchObject({
        ok: false,
        error: { code: "conflict" },
      });
      expect(snapshot()).toEqual(before);
      expectNoCallbacks();
    },
  );

  it("returns a stored permanent policy error without asking for fresh authorization", async () => {
    options.authorize = vi.fn(async () => ({ verdict: "DENY", reason: "Original denial" }));
    const request = frame();
    const first = await service.handle("host", request);
    expect(first).toMatchObject({ ok: false, error: { code: "forbidden" } });
    vi.clearAllMocks();
    options.authorize = vi.fn(async () => ({ verdict: "ALLOW" }));
    const before = snapshot();
    const hash = await foundHash(request);
    expect(await replay(request, hash)).toEqual({ ...first, requestId: expect.any(String) });
    expect(snapshot()).toEqual(before);
    expectNoCallbacks();
  });

  it.each(["delete", "stored-hash", "marker-hash", "arguments"])(
    "cannot execute or create a replacement receipt after peek when %s changes",
    async (change) => {
      const request = frame();
      expect((await service.handle("host", request)).ok).toBe(true);
      let hash = await foundHash(request);
      let execution = request;
      if (change === "delete") store.db.exec("DELETE FROM agent_call_receipts");
      if (change === "stored-hash")
        store.db.prepare("UPDATE agent_call_receipts SET request_hash = ?").run("0".repeat(64));
      if (change === "marker-hash") hash = "0".repeat(64);
      if (change === "arguments") execution = { ...request, args: { objective: "Another child" } };
      const before = snapshot();
      vi.clearAllMocks();
      expect(await replay(execution, hash)).toMatchObject(unavailable);
      expect(snapshot()).toEqual(before);
      expect(store.tasks.count()).toBe(1);
      expectNoCallbacks();
    },
  );

  it("a miss is read-only, while unmarked new work still goes through current DENY", async () => {
    const request = frame();
    options.authorize = vi.fn(async () => ({ verdict: "DENY", reason: "Current DENY" }));
    const before = snapshot();
    expect(await peek(request)).toMatchObject({ ok: true, result: { found: false } });
    expect(await replay(request, "0".repeat(64))).toMatchObject(unavailable);
    expect(snapshot()).toEqual(before);
    expectNoCallbacks();
    expect(await service.handle("host", request)).toMatchObject({
      ok: false,
      error: { code: "forbidden", message: "Current DENY" },
    });
    expect(options.authorize).toHaveBeenCalledTimes(1);
    expect(store.tasks.count()).toBe(0);
    expect(store.db.prepare("SELECT * FROM agent_call_receipts").all()).toHaveLength(1);
  });

  it.each(["ASK", "timeout"])(
    "does not mistake %s/pending state for a final receipt",
    async (kind) => {
      options.authorize = vi.fn(async () => {
        if (kind === "timeout") throw new SwitchyardError("timeout", "Coordinator unavailable");
        return {
          verdict: "ASK",
          decisionId: "decision",
          interactionId: "interaction",
          interactionUrl: "https://switchyard.test/code/caller",
        };
      });
      await service.handle("host", frame());
      const before = snapshot();
      vi.clearAllMocks();
      expect(await peek(frame())).toMatchObject({ ok: true, result: { found: false } });
      expect(await replay(frame(), "0".repeat(64))).toMatchObject(unavailable);
      expect(snapshot()).toEqual(before);
      expectNoCallbacks();
    },
  );

  it.each(["session", "native", "tool", "method"])(
    "uses the exact durable key and cannot select another %s (even with the same native filename)",
    async (part) => {
      const request = frame();
      expect((await service.handle("host", request)).ok).toBe(true);
      const hash = await foundHash(request);
      let other = { ...request };
      if (part === "session") {
        // A host cannot project the same file on two sessions simultaneously. Reassign the
        // historical file to another session; its matching path still grants no receipt access.
        const caller = store.sessions.require("caller");
        store.putSession({ ...caller, nativeHandle: null });
        store.putSession({ ...caller, id: "other", nativeHandle: null, bridge: undefined });
        other.sessionId = "other";
        expect(await bind({ sessionId: "other" })).toMatchObject({ ok: true });
      }
      if (part === "native") {
        other.nativeSessionId = "other-native";
        expect(await bind({ nativeSessionId: "other-native" })).toMatchObject({ ok: true });
      }
      if (part === "tool") other.toolCallId = "other-call";
      if (part === "method") other = { ...other, method: "inbox.read", args: {} };
      vi.clearAllMocks();
      const before = snapshot();
      expect(await peek(other)).toMatchObject({ ok: true, result: { found: false } });
      expect(await replay(other, hash)).toMatchObject(unavailable);
      expect(snapshot()).toEqual(before);
      expectNoCallbacks();
    },
  );

  it("conflicts on changed arguments under the same durable key without overwriting it", async () => {
    expect((await service.handle("host", frame())).ok).toBe(true);
    const before = snapshot();
    vi.clearAllMocks();
    expect(await peek(frame({ args: { objective: "Changed" } }))).toMatchObject({
      ok: false,
      error: {
        code: "conflict",
        message: "Agent call identity was reused with different arguments",
      },
    });
    expect(snapshot()).toEqual(before);
    expectNoCallbacks();
  });

  it.each([
    "readOnly",
    "archived",
    "stopped",
    "runtime",
    "native",
    "controller",
    "unbound",
    "revoked",
  ])("requires current access and binding before lookup/replay: %s", async (invalid) => {
    const request = frame();
    expect((await service.handle("host", request)).ok).toBe(true);
    const hash = await foundHash(request);
    const caller = store.sessions.require("caller");
    if (invalid === "readOnly") store.putSession({ ...caller, readOnly: true });
    if (invalid === "archived") store.putSession({ ...caller, archivedAt: store.nowIso() });
    if (invalid === "stopped") store.putSession({ ...caller, runtime: "stopped" });
    if (invalid === "runtime") request.runtimeId = "obsolete";
    if (invalid === "native") request.nativeSessionId = "obsolete";
    if (invalid === "controller")
      store.putSession({
        ...caller,
        bridge: { ...caller.bridge!, controllerEpoch: "replacement" },
      });
    if (invalid === "unbound") service = new AgentService(options);
    if (invalid === "revoked")
      store.hosts.upsert({ ...store.hosts.require("host"), revokedAt: store.nowIso() });
    vi.clearAllMocks();
    const before = snapshot();
    expect(await peek(request)).toMatchObject({ ok: false });
    expect(await replay(request, hash)).toMatchObject({ ok: false });
    expect(snapshot()).toEqual(before);
    expectNoCallbacks();
  });

  it("rejects an obsolete runtime after peek but permits the newly bound controller to retrieve the past result", async () => {
    const request = frame();
    const first = await service.handle("host", request);
    expect(first.ok).toBe(true);
    const hash = await foundHash(request);
    expect(await bind({ runtimeId: "replacement" }, "replacement-controller")).toMatchObject({
      ok: true,
    });
    vi.clearAllMocks();
    const before = snapshot();
    expect(await replay(request, hash)).toMatchObject({
      ok: false,
      error: { code: "stale_control" },
    });
    expect(await replay({ ...request, runtimeId: "replacement" }, hash)).toEqual({
      ...first,
      requestId: expect.any(String),
      runtimeId: "replacement",
    });
    expect(snapshot()).toEqual(before);
    expectNoCallbacks();
  });

  it("does not expose a receipt to another authenticated host", async () => {
    expect((await service.handle("host", frame())).ok).toBe(true);
    const hash = await foundHash(frame());
    store.hosts.upsert(
      { ...store.hosts.require("host"), id: "foreign" },
      { credential_hash: "foreign-hash" },
    );
    const before = snapshot();
    vi.clearAllMocks();
    for (const request of [
      frame({ method: "receipt.peek", args: { method: "task.create", args: frame().args } }),
      frame({ receiptReplay: { requestHash: hash } }),
    ])
      expect(await service.handle("foreign", request)).toMatchObject({
        ok: false,
        error: { code: "forbidden" },
      });
    expect(snapshot()).toEqual(before);
    expectNoCallbacks();
  });

  it("requires a tool identity on peek and a deadline on replay without weakening the D.5 budget", async () => {
    expect(await peek(frame({ toolCallId: undefined }))).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(await replay(frame({ deadlineAt: undefined }), "0".repeat(64))).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    const request = frame();
    expect((await service.handle("host", request)).ok).toBe(true);
    const hash = await foundHash(request);
    now += 60_000;
    const before = snapshot();
    vi.clearAllMocks();
    // Like ordinary idempotent replay, a committed result is safe even past its original deadline.
    expect(await replay(request, hash)).toMatchObject({ ok: true });
    expect(snapshot()).toEqual(before);
    expectNoCallbacks();
    expect(await service.handle("host", { ...request, toolCallId: "fresh" })).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    expect(snapshot()).toEqual(before);
    expectNoCallbacks();
  });

  it.each([
    "session.bind",
    "receipt.peek",
    "policy.status",
    "policy.cancel",
    "policy.evaluate",
  ] as const)("rejects receiptReplay on %s instead of treating it as authority", async (method) => {
    const before = snapshot();
    expect(
      await service.handle(
        "host",
        frame({ method, receiptReplay: { requestHash: "0".repeat(64) } }),
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(snapshot()).toEqual(before);
    expectNoCallbacks();
  });

  it("preserves the 128 KiB original-frame bound for both paths", async () => {
    const before = snapshot();
    const request = frame({ args: { objective: "x".repeat(128 * 1024) } });
    expect(await peek(request)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await replay(request, "0".repeat(64))).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(snapshot()).toEqual(before);
    expectNoCallbacks();
  });
});

it("lost acknowledgement: a new coordinator/controller/runtime retrieves the same native session's committed result after root completion", async () => {
  const root = createTask({ store }, { projectId: "project", title: "Root" }, { kind: "manual" });
  store.putSession({ ...store.sessions.require("caller"), taskId: root.id });

  function installPolicies() {
    policies = new PolicyService({
      store,
      publicUrl: "https://switchyard.test",
      reconcileInputAttention: vi.fn(),
      hostPolicyConnection: () => ({
        connected: true,
        features: new Set(["agentRequests.v1", "policies.v1"]),
      }),
      evaluator: {
        validateRule: async () => ({ valid: true, returnType: "dyn" }),
        evaluateRules: async (rules) =>
          rules.map((rule) => ({
            ruleId: rule.id,
            ruleRevision: rule.revision,
            result:
              rule.name === "Count new requests"
                ? { verdict: "ALLOW" as const, state_updates: { calls: 1 } }
                : null,
            error: null,
          })),
      },
    });
    policies.start();
    options.bindPolicyBoundary = (owner, proof) => policies!.bindBoundary(owner, proof);
    const owner = (request: AgentRequestFrame) => ({
      authenticatedHostId: "host",
      sessionId: request.sessionId,
      nativeSessionId: request.nativeSessionId,
      runtimeId: request.runtimeId,
    });
    options.authorize = vi.fn((_context, request) =>
      policies!.authorize({ kind: "agent_request", owner: owner(request), frame: request }),
    );
    options.assertAuthorization = vi.fn((_context, request) =>
      policies!.assertAuthorized({ kind: "agent_request", owner: owner(request), frame: request }),
    );
  }
  installPolicies();
  await policies!.createRule({
    scope: "server",
    scopeId: null,
    priority: -100,
    phases: ["request"],
    enabled: true,
    name: "Count new requests",
    expression: '{"verdict":"ALLOW","state_updates":{"calls":1}}',
  });
  expect(await bind()).toMatchObject({ ok: true });
  const activate = () => {
    const caller = store.sessions.require("caller");
    store.putSession({
      ...caller,
      bridge: { ...caller.bridge!, policyState: "active", policyPhases: ["tool_call", "request"] },
    });
  };
  activate();
  const request = frame();
  // The real AgentService commits, but its return value never reaches the simulated sender.
  await service.handle("host", request);
  const receipt = store.db.prepare("SELECT * FROM agent_call_receipts").get() as {
    result_json: string;
    request_hash: string;
  };
  expect(receipt, "the mutation and its final receipt must really have committed").toBeDefined();
  expect(JSON.parse(receipt.result_json)).toMatchObject({
    ok: true,
    result: { task: { state: "ready" } },
  });
  const counters = store.db.prepare("SELECT * FROM policy_counters").all();
  expect(counters).toMatchObject([{ counters_json: '{"calls":1}', version: 1 }]);
  const child = store.tasks.list().find((task) => task.id !== root.id)!;
  expect(child.parentTaskId).toBe(root.id);
  await policies!.stop();
  policies = undefined;
  await messages.stop();
  store.db.close();

  // Close/reopen SQLite, discard all in-memory bindings and policy service state.
  now += 60_000;
  open();
  installPolicies();
  const resumed = frame({ runtimeId: "replacement-runtime" });
  expect(await bind({ runtimeId: resumed.runtimeId }, "replacement-controller")).toMatchObject({
    ok: true,
  });
  activate();
  store.putTask({ ...store.tasks.require(root.id), state: "done" });
  const before = snapshot();
  vi.clearAllMocks();
  const hash = await foundHash(resumed);
  expect(hash).toBe(receipt.request_hash);
  expect(await replay(resumed, hash)).toEqual({
    type: "agent.result",
    requestId: expect.any(String),
    runtimeId: resumed.runtimeId,
    ...JSON.parse(receipt.result_json),
  });
  expect(snapshot()).toEqual(before);
  expectNoCallbacks();
  expect(
    store.tasks
      .list()
      .map((task) => task.id)
      .sort(),
  ).toEqual([root.id, child.id].sort());
  expect(store.db.prepare("SELECT * FROM agent_call_receipts").all()).toHaveLength(1);
  expect(store.db.prepare("SELECT * FROM task_subscriptions").all()).toHaveLength(1);
  expect(store.db.prepare("SELECT * FROM policy_counters").all()).toEqual(counters);
  // A fresh logical call is not replay permission and still meets the current root fence.
  const denied = await service.handle("host", { ...resumed, toolCallId: "fresh-call" });
  expect(denied).toMatchObject({
    ok: false,
    error: {
      code: "forbidden",
      message: "The root task has ended; reopen it before starting more agent work.",
    },
  });
  expect(options.authorize).toHaveBeenCalledTimes(1);
  expect(store.tasks.count()).toBe(2);
});
