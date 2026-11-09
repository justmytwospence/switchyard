import {
  type AgentRequestFrame,
  AgentToolPolicyWait,
  type PolicyEvaluation,
  type Profile,
  type Session,
  SwitchyardError,
} from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentService, type AgentServiceOptions } from "../src/agents/service.js";
import { migrate, openDb } from "../src/db/index.js";
import { EventHub } from "../src/event-hub.js";
import { Store } from "../src/store.js";
import { createTask } from "../src/tasks/service.js";
import { fullCapabilities } from "./task-helpers.js";

const start = Date.parse("2026-01-01T00:00:00.000Z");
const profile: Profile = {
  id: "prf_test",
  name: "Test",
  provider: null,
  model: null,
  thinking: null,
  projectTrust: "ask",
  extraArgs: [],
};
const ask: PolicyEvaluation = {
  verdict: "ASK",
  decisionId: "pol_test",
  interactionId: "int_test",
  interactionUrl: "https://switchyard.example/code/ses_caller",
};
let now: number;
let store: Store;
let service: AgentService;
let options: AgentServiceOptions;

function frame(over: Partial<AgentRequestFrame> = {}): AgentRequestFrame {
  return {
    type: "agent.request",
    requestId: "req_test",
    sessionId: "ses_caller",
    nativeSessionId: "native-caller",
    runtimeId: "runtime-1",
    context: { humanInputId: null, causalMessageId: null },
    toolCallId: "call-1",
    deadlineAt: new Date(now + 30_000).toISOString(),
    method: "task.create",
    args: { objective: "Create a child" },
    ...over,
  };
}

function receipts() {
  return store.db.prepare("SELECT * FROM agent_call_receipts").all();
}

async function bind(over: Partial<AgentRequestFrame> = {}) {
  return service.handle(
    "hst_test",
    frame({
      method: "session.bind",
      toolCallId: undefined,
      deadlineAt: undefined,
      args: {
        version: 1,
        sessionFile: null,
        mode: "rpc",
        capabilities: {
          agentTools: true,
          messageDelivery: true,
          editorDraftGuard: true,
          toolPolicy: true,
        },
        policyRequired: true,
        controllerEpoch: "d56b0e03-6291-4bd1-b334-d924e559687f",
        policyBoundary: {
          cwd: "/repos/app",
          workspaceRoot: "/repos/app",
          cwdReal: "/repos/app",
          workspaceRootReal: "/repos/app",
        },
      },
      ...over,
    }),
  );
}

beforeEach(async () => {
  now = start;
  const db = openDb(":memory:");
  migrate(db);
  store = new Store(db, new EventHub(), () => new Date(now));
  store.hosts.upsert(
    {
      id: "hst_test",
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
  store.projects.upsert({
    id: "prj_test",
    name: "Test",
    repoIdentity: "https://github.com/test/test",
    defaultProfileId: profile.id,
    defaultHostId: "hst_test",
    maxConcurrentRuns: 1,
    automationEnabled: false,
    setupCommand: null,
    checks: [],
    workspaceSharing: "single_writer",
    worktreeDir: ".worktrees",
    createdAt: store.nowIso(),
    updatedAt: store.nowIso(),
  });
  store.profiles.upsert(profile);
  const caller: Session = {
    id: "ses_caller",
    title: "Caller",
    subtitle: null,
    hostId: "hst_test",
    projectId: "prj_test",
    workspaceId: null,
    cwd: "/repos/app",
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
  store.putSession({ ...caller, id: "ses_target" });
  options = {
    store,
    scheduleDispatch: vi.fn(),
    negotiatedFeatures: () => new Set(["agentRequests.v1", "policies.v1"]),
    bindPolicyBoundary: vi.fn(),
    authorize: vi.fn(async () => ({ verdict: "ALLOW" })),
    assertAuthorization: vi.fn(),
    messages: {
      recordContext: vi.fn(),
      send: vi.fn(),
      readInbox: vi.fn(() => ({ messages: [], nextAfter: 0, hasMore: false })),
      wake: vi.fn(),
    },
  };
  service = new AgentService(options);
  expect(await bind()).toMatchObject({ ok: true });
  vi.mocked(options.messages!.recordContext).mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  store.db.close();
});

function expectNoAction() {
  expect(store.tasks.count()).toBe(0);
  expect(receipts()).toEqual([]);
  expect(options.messages!.recordContext).not.toHaveBeenCalled();
  expect(options.messages!.send).not.toHaveBeenCalled();
  expect(options.messages!.readInbox).not.toHaveBeenCalled();
  expect(options.messages!.wake).not.toHaveBeenCalled();
  expect(options.scheduleDispatch).not.toHaveBeenCalled();
}

const toolCases = [
  { method: "task.create", args: { objective: "Create a child" } },
  {
    method: "message.send",
    args: { sessionId: "ses_target", body: "hello", mode: "queue" },
  },
  { method: "inbox.read", args: {} },
] satisfies Partial<AgentRequestFrame>[];

describe("immediate request ASK and explicit resumption", () => {
  it.each(toolCases)(
    "returns a strict nonfinal wait for $method with no action or receipt",
    async (input) => {
      options.authorize = vi.fn(async () => ask);
      const finish = vi.spyOn(store, "savepoint");
      const result = await service.handle("hst_test", frame(input));
      expect(result).toEqual({
        type: "agent.result",
        requestId: "req_test",
        runtimeId: "runtime-1",
        ok: true,
        result: {
          type: "policy.required",
          decisionId: ask.decisionId,
          interactionId: ask.interactionId,
          interactionUrl: ask.interactionUrl,
        },
      });
      if (!result.ok) throw new Error("Expected wait");
      expect(AgentToolPolicyWait.safeParse(result.result).success).toBe(true);
      expect(finish).not.toHaveBeenCalled();
      expect(options.assertAuthorization).not.toHaveBeenCalled();
      expectNoAction();
    },
  );

  it("waits healthily for more than 30 seconds without an orphan, then requires a fresh explicit retry", async () => {
    let allowed = false;
    options.authorize = vi.fn(async () => (allowed ? { verdict: "ALLOW" } : ask));
    options.policyRequest = vi.fn(async () => ({ state: allowed ? "allowed" : "pending" }));
    const original = frame();
    expect(await service.handle("hst_test", original)).toMatchObject({
      ok: true,
      result: { type: "policy.required" },
    });
    for (let i = 0; i < 2; i++) {
      now += 25_000;
      expect(
        await service.handle(
          "hst_test",
          frame({ method: "policy.status", args: { decisionId: ask.decisionId } }),
        ),
      ).toMatchObject({ ok: true, result: { state: "pending" } });
      expectNoAction();
    }
    allowed = true;
    expect(
      await service.handle(
        "hst_test",
        frame({ method: "policy.status", args: { decisionId: ask.decisionId } }),
      ),
    ).toMatchObject({ ok: true, result: { state: "allowed" } });
    expectNoAction();
    // Approval/status cannot awaken the expired original RPC or create a task on its own.
    expect(await service.handle("hst_test", original)).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    expectNoAction();
    expect(await service.handle("hst_test", frame({ requestId: "req-resume" }))).toMatchObject({
      ok: true,
      result: { task: { state: "ready" } },
    });
    expect(store.tasks.count()).toBe(1);
    expect(receipts()).toHaveLength(1);
    expect(options.scheduleDispatch).toHaveBeenCalledTimes(1);
    expect(options.authorize).toHaveBeenCalledTimes(2);
  });

  it("cannot resume a captured action after cancellation and a late approval", async () => {
    options.authorize = vi.fn(async () => ask);
    await service.handle("hst_test", frame());
    options.policyRequest = vi.fn(async (_context, request) =>
      request.method === "policy.cancel" ? { state: "canceled" } : { state: "allowed" },
    );
    await service.handle(
      "hst_test",
      frame({ method: "policy.cancel", args: { decisionId: ask.decisionId } }),
    );
    now += 90_000;
    await service.handle(
      "hst_test",
      frame({ method: "policy.status", args: { decisionId: ask.decisionId } }),
    );
    expectNoAction();
    expect(options.authorize).toHaveBeenCalledTimes(1);
  });

  it("records DENY permanently and replays it without reauthorizing after expiry", async () => {
    options.authorize = vi.fn(async () => ({ verdict: "DENY", reason: "Denied by policy" }));
    const request = frame();
    const first = await service.handle("hst_test", request);
    expect(first).toMatchObject({
      ok: false,
      error: { code: "forbidden", message: "Denied by policy" },
    });
    expect(receipts()).toHaveLength(1);
    now += 60_000;
    expect(await service.handle("hst_test", request)).toEqual(first);
    expect(options.authorize).toHaveBeenCalledTimes(1);
    expect(options.assertAuthorization).not.toHaveBeenCalled();
    expect(store.tasks.count()).toBe(0);
  });
});

describe("fixed tool request deadline", () => {
  it.each(toolCases)("requires a deadline for $method", async (input) => {
    expect(
      await service.handle("hst_test", frame({ ...input, deadlineAt: undefined })),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(options.authorize).not.toHaveBeenCalled();
    expectNoAction();
  });

  it.each(toolCases)(
    "rejects expired $method before authorization without finalizing",
    async (input) => {
      expect(
        await service.handle("hst_test", frame({ ...input, deadlineAt: store.nowIso() })),
      ).toMatchObject({ ok: false, error: { code: "timeout" } });
      expect(options.authorize).not.toHaveBeenCalled();
      expectNoAction();
    },
  );

  it.each(["ALLOW", "ASK", "DENY"] as const)(
    "cannot mutate or finalize an expired %s after the worker await",
    async (verdict) => {
      let release!: (evaluation: PolicyEvaluation) => void;
      options.authorize = vi.fn(
        () =>
          new Promise<PolicyEvaluation>((resolve) => {
            release = resolve;
          }),
      );
      const request = frame({ deadlineAt: new Date(now + 1000).toISOString() });
      const pending = service.handle("hst_test", request);
      expect(store.inTransaction).toBe(false);
      now += 1000;
      release(
        verdict === "ASK" ? ask : verdict === "DENY" ? { verdict, reason: "Denied" } : { verdict },
      );
      expect(await pending).toMatchObject({ ok: false, error: { code: "timeout" } });
      expectNoAction();
      options.authorize = vi.fn(async () => ({ verdict: "ALLOW" }));
      expect(await service.handle("hst_test", frame())).toMatchObject({ ok: true });
      expect(store.tasks.count()).toBe(1);
      expect(receipts()).toHaveLength(1);
    },
  );

  it("caps a distant supplied deadline at ingress plus 30 seconds", async () => {
    options.authorize = vi.fn(async () => {
      now += 30_000;
      return { verdict: "ALLOW" };
    });
    expect(
      await service.handle(
        "hst_test",
        frame({ deadlineAt: new Date(now + 3_600_000).toISOString() }),
      ),
    ).toMatchObject({ ok: false, error: { code: "timeout" } });
    expectNoAction();
  });

  it("checks expiry inside the final action savepoint even after an unexpired authorization", async () => {
    const savepoint = store.savepoint.bind(store);
    vi.spyOn(store, "savepoint").mockImplementation((action) => {
      expect(store.inTransaction).toBe(true);
      now += 30_000;
      return savepoint(action);
    });
    expect(await service.handle("hst_test", frame())).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    expect(options.authorize).toHaveBeenCalledTimes(1);
    expect(options.assertAuthorization).not.toHaveBeenCalled();
    expectNoAction();
  });

  it.each([
    new SwitchyardError("timeout", "Policy signal timed out"),
    new DOMException("Signal timed out", "TimeoutError"),
    new DOMException("Signal aborted", "AbortError"),
  ])(
    "leaves authorization signal failures transient so the same tool call can retry: %s",
    async (error) => {
      options.authorize = vi.fn(async () => {
        throw error;
      });
      expect(await service.handle("hst_test", frame())).toMatchObject({
        ok: false,
        error: { code: "timeout" },
      });
      expectNoAction();
      options.authorize = vi.fn(async () => ({ verdict: "ALLOW" }));
      expect(await service.handle("hst_test", frame())).toMatchObject({ ok: true });
      expect(store.tasks.count()).toBe(1);
      expect(receipts()).toHaveLength(1);
    },
  );
});

describe("final synchronous authorization and idempotence", () => {
  it("fences a root change after async ALLOW inside the action savepoint before causal accounting", async () => {
    const parent = createTask(
      { store },
      { projectId: "prj_test", title: "Root" },
      { kind: "manual" },
    );
    store.putSession({ ...store.sessions.require("ses_caller"), taskId: parent.id });
    let inSavepoint = false;
    const savepoint = store.savepoint.bind(store);
    vi.spyOn(store, "savepoint").mockImplementation((action) =>
      savepoint(() => {
        inSavepoint = true;
        try {
          return action();
        } finally {
          inSavepoint = false;
        }
      }),
    );
    options.authorize = vi.fn(async () => {
      expect(store.inTransaction).toBe(false);
      store.putTask({ ...parent, state: "done" });
      return { verdict: "ALLOW" };
    });
    options.assertAuthorization = vi.fn((context, request) => {
      expect(store.inTransaction).toBe(true);
      expect(inSavepoint).toBe(true);
      expect(context.caller.taskId).toBe(parent.id);
      expect(request.args).toMatchObject({
        acceptance: [],
        dependencies: [],
        notifyOnFinish: true,
      });
      expect(options.messages!.recordContext).not.toHaveBeenCalled();
      if (store.tasks.require(parent.id).state === "done") {
        throw new SwitchyardError("stale_control", "Root authority changed");
      }
    });
    expect(await service.handle("hst_test", frame())).toMatchObject({
      ok: false,
      error: { code: "stale_control" },
    });
    expect(options.assertAuthorization).toHaveBeenCalledTimes(1);
    expect(store.tasks.count()).toBe(1);
    expect(receipts()).toEqual([]);
    expect(options.messages!.recordContext).not.toHaveBeenCalled();
    expect(options.scheduleDispatch).not.toHaveBeenCalled();
  });

  it("replays a committed result past deadline and changed authority without executing the fence again", async () => {
    const request = frame();
    const first = await service.handle("hst_test", request);
    expect(first).toMatchObject({ ok: true, result: { task: { state: "ready" } } });
    now += 60_000;
    options.assertAuthorization = vi.fn(() => {
      throw new SwitchyardError("forbidden", "Root ended");
    });
    expect(await service.handle("hst_test", { ...request, requestId: "req-replay" })).toEqual({
      ...first,
      requestId: "req-replay",
    });
    expect(options.authorize).toHaveBeenCalledTimes(1);
    expect(options.assertAuthorization).not.toHaveBeenCalled();
    expect(options.messages!.recordContext).toHaveBeenCalledTimes(1);
    expect(options.scheduleDispatch).toHaveBeenCalledTimes(1);
    expect(store.tasks.count()).toBe(1);
    expect(receipts()).toHaveLength(1);
    expect(
      await service.handle(
        "hst_test",
        frame({ args: { objective: "Different" }, deadlineAt: request.deadlineAt }),
      ),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("concurrent same-call retries recheck the committed receipt before the final fence", async () => {
    const [a, b] = await Promise.all([
      service.handle("hst_test", frame()),
      service.handle("hst_test", frame()),
    ]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toEqual(a);
    expect(options.authorize).toHaveBeenCalledTimes(2);
    expect(options.assertAuthorization).toHaveBeenCalledTimes(1);
    expect(options.messages!.recordContext).toHaveBeenCalledTimes(1);
    expect(options.scheduleDispatch).toHaveBeenCalledTimes(1);
    expect(store.tasks.count()).toBe(1);
    expect(receipts()).toHaveLength(1);
  });

  it("does not self-invalidate on file/display activity but still fences a replaced runtime", async () => {
    store.putSession({
      ...store.sessions.require("ses_caller"),
      nativeHandle: { sessionId: "native-caller", sessionFile: "/old.jsonl" },
    });
    options.authorize = vi.fn(async () => {
      const caller = store.sessions.require("ses_caller");
      store.putSession({
        ...caller,
        runtime: "waiting_input",
        lastActivityAt: new Date(now + 1000).toISOString(),
        nativeHandle: { sessionId: "native-caller", sessionFile: "/new.jsonl" },
      });
      return { verdict: "ALLOW" };
    });
    expect(await service.handle("hst_test", frame())).toMatchObject({ ok: true });
    options.authorize = vi.fn(async () => {
      await bind({ runtimeId: "runtime-2" });
      return { verdict: "ALLOW" };
    });
    expect(await service.handle("hst_test", frame({ toolCallId: "call-2" }))).toMatchObject({
      ok: false,
      error: { code: "stale_control" },
    });
    expect(store.tasks.count()).toBe(1);
    expect(receipts()).toHaveLength(1);
  });
});
