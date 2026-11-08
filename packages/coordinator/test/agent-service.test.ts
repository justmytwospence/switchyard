import {
  type AgentMessage,
  type AgentRequestFrame,
  DEFAULT_TASK_POLICY,
  type Profile,
  type Run,
  type Session,
  SwitchyardError,
} from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageService } from "../src/agents/messages.js";
import { AgentService, type AgentServiceOptions } from "../src/agents/service.js";
import { migrate, openDb } from "../src/db/index.js";
import { EventHub } from "../src/event-hub.js";
import { Store } from "../src/store.js";
import { createTask } from "../src/tasks/service.js";

let store: Store;
let service: AgentService;
let options: AgentServiceOptions;
const profile: Profile = {
  id: "prf_test",
  name: "Test",
  provider: null,
  model: null,
  thinking: null,
  projectTrust: "ask",
  extraArgs: [],
};
const now = "2026-01-01T00:00:00.000Z";

function session(over: Partial<Session> = {}): Session {
  return {
    id: "ses_caller",
    title: "Caller",
    subtitle: null,
    hostId: "hst_test",
    projectId: "prj_test",
    workspaceId: null,
    cwd: "/repos/app",
    nativeHandle: { sessionId: "native-caller", sessionFile: "/sessions/caller.jsonl" },
    profileSnapshot: profile,
    runtime: "idle",
    runtimeDetail: null,
    connectivity: "connected",
    runId: null,
    taskId: null,
    provenance: "created",
    readOnly: false,
    lastActivityAt: now,
    archivedAt: null,
    queue: { steering: [], followUp: [] },
    stats: null,
    lastAssistantText: null,
    createdAt: now,
    ...over,
  };
}

function frame(over: Partial<AgentRequestFrame> = {}): AgentRequestFrame {
  return {
    type: "agent.request",
    requestId: "req_test",
    sessionId: "ses_caller",
    nativeSessionId: "native-caller",
    runtimeId: "runtime-1",
    context: { humanInputId: null, causalMessageId: null },
    toolCallId: "call-1",
    method: "task.create",
    args: { objective: "Implement the feature\nDetails" },
    ...over,
  };
}

async function bind(over: Partial<AgentRequestFrame> = {}) {
  return service.handle(
    "hst_test",
    frame({
      method: "session.bind",
      args: {
        version: 1,
        sessionFile: "/sessions/caller.jsonl",
        mode: "rpc",
        capabilities: {
          agentTools: true,
          messageDelivery: true,
          editorDraftGuard: true,
          toolPolicy: false,
        },
        policyRequired: false,
      },
      toolCallId: undefined,
      ...over,
    }),
  );
}

function parentTask() {
  return createTask({ store }, { projectId: "prj_test", title: "Parent" }, { kind: "manual" });
}

function controllingRun(taskId: string): Run {
  return {
    id: "run_test",
    taskId,
    sessionId: "ses_caller",
    hostId: "hst_test",
    dispatchKey: "run_test",
    attempt: 1,
    state: "running",
    controlMode: "human",
    controlRevision: 1,
    continuationsUsed: 0,
    infraRetries: 0,
    nextAttemptAt: null,
    startedAt: now,
    endedAt: null,
    outcome: null,
    limits: { enabled: false },
    usage: { tokens: null, costUsd: null, accounting: "unavailable", note: null },
    checks: [],
    createdAt: now,
    updatedAt: now,
  };
}

beforeEach(async () => {
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
      capabilities: null,
      connectivity: "connected",
      lastSeenAt: now,
      revokedAt: null,
      createdAt: now,
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
    createdAt: now,
    updatedAt: now,
  });
  store.profiles.upsert(profile);
  store.putSession(session());
  options = {
    store,
    scheduleDispatch: vi.fn(() => {
      expect(store.inTransaction).toBe(false);
      expect(store.db.prepare("SELECT * FROM agent_call_receipts").all()).toHaveLength(1);
    }),
    negotiatedFeatures: () => new Set(["agentRequests.v1", "policies.v1"]),
    onUnbind: vi.fn(),
  };
  service = new AgentService(options);
  expect(await bind()).toMatchObject({ ok: true });
});

afterEach(() => store.db.close());

describe("authenticated agent binding", () => {
  it("rejects foreign hosts, missing bindings and substituted native/runtime identities", async () => {
    store.hosts.upsert(
      { ...store.hosts.require("hst_test"), id: "hst_other" },
      { credential_hash: "other-hash" },
    );
    expect(await service.handle("hst_other", frame())).toMatchObject({
      ok: false,
      error: { code: "forbidden" },
    });
    expect(await service.handle("hst_test", frame({ nativeSessionId: "forged" }))).toMatchObject({
      ok: false,
      error: { code: "stale_control" },
    });
    expect(await service.handle("hst_test", frame({ runtimeId: "forged" }))).toMatchObject({
      ok: false,
      error: { code: "stale_control" },
    });
    service = new AgentService(options);
    expect(await service.handle("hst_test", frame())).toMatchObject({
      ok: false,
      error: { code: "stale_control" },
    });
    expect(store.tasks.count()).toBe(0);
  });

  it("initializes a starting session without waiting for a host projection and invalidates old runtimes", async () => {
    store.putSession({ ...session(), runtime: "starting", nativeHandle: null, bridge: undefined });
    expect(await bind()).toMatchObject({ ok: true });
    expect(store.sessions.require("ses_caller")).toMatchObject({
      nativeHandle: { sessionId: "native-caller" },
      bridge: { runtimeId: "runtime-1", policyState: "initializing" },
    });
    expect(await bind({ nativeSessionId: "native-next", runtimeId: "runtime-2" })).toMatchObject({
      ok: true,
    });
    expect(options.onUnbind).toHaveBeenCalledWith("ses_caller", "runtime-1");
    expect(await service.handle("hst_test", frame())).toMatchObject({
      ok: false,
      error: { code: "stale_control" },
    });
  });

  it("returns the exact A.1 result without a coordinator binding ID or unimplemented policies", async () => {
    expect(await bind()).toEqual({
      type: "agent.result",
      requestId: "req_test",
      runtimeId: "runtime-1",
      ok: true,
      result: {
        version: 1,
        sessionId: "ses_caller",
        runtimeId: "runtime-1",
        nativeSessionId: "native-caller",
        features: ["agentRequests.v1"],
        policyRequired: false,
        sessionUrl: null,
      },
    });
    expect(store.sessions.require("ses_caller").bridge).toMatchObject({
      nativeSessionId: "native-caller",
      agentTools: false,
      messageDelivery: false,
      policyState: "initializing",
      policyPhases: [],
    });
  });

  it("persists native identity without a session file and permits subsequent bound calls", async () => {
    store.putSession({ ...session(), runtime: "starting", nativeHandle: null, bridge: undefined });
    expect(
      await bind({
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
        },
      }),
    ).toMatchObject({
      ok: true,
      result: {
        nativeSessionId: "native-caller",
        features: ["agentRequests.v1"],
        policyRequired: true,
        sessionUrl: null,
      },
    });
    expect(store.sessions.require("ses_caller")).toMatchObject({
      nativeHandle: null,
      bridge: { nativeSessionId: "native-caller" },
    });
    expect(await service.handle("hst_test", frame())).toMatchObject({ ok: true });
    await bind({
      nativeSessionId: "new-branch",
      args: {
        version: 1,
        sessionFile: null,
        mode: "terminal",
        capabilities: {
          agentTools: true,
          messageDelivery: false,
          editorDraftGuard: false,
          toolPolicy: false,
        },
        policyRequired: false,
      },
    });
    expect(store.sessions.require("ses_caller")).toMatchObject({
      nativeHandle: null,
      bridge: { nativeSessionId: "new-branch" },
    });
    expect(await service.handle("hst_test", frame())).toMatchObject({
      ok: false,
      error: { code: "stale_control" },
    });
  });

  it("intersects actual capabilities and refuses tools from disabled bridges", async () => {
    expect(
      await bind({
        args: {
          version: 1,
          sessionFile: null,
          mode: "terminal",
          capabilities: {
            agentTools: false,
            messageDelivery: true,
            editorDraftGuard: false,
            toolPolicy: true,
          },
          policyRequired: true,
        },
      }),
    ).toMatchObject({ ok: true, result: { features: [], policyRequired: true } });
    expect(await service.handle("hst_test", frame())).toMatchObject({
      ok: false,
      error: { code: "unsupported_capability" },
    });
  });

  it("validates broker binding args and causality before changing stored identity", async () => {
    expect(await bind({ args: { version: 1 } })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    options.messages = new MessageService(store, {
      isConnected: () => false,
      accept: async () => ({ state: "accepted" }),
      status: async () => null,
    });
    expect(
      await bind({
        runtimeId: "forged-runtime",
        context: {
          humanInputId: null,
          causalMessageId: "not-addressed-to-caller",
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(store.sessions.require("ses_caller").bridge?.runtimeId).toBe("runtime-1");
    expect(await service.handle("hst_test", frame())).toMatchObject({ ok: true });
  });

  it("fences old requests when native-handle projection changes before rebinding", async () => {
    store.putSession({
      ...store.sessions.require("ses_caller"),
      nativeHandle: {
        sessionId: "native-next",
        sessionFile: "/sessions/next.jsonl",
      },
    });
    expect(await service.handle("hst_test", frame())).toMatchObject({
      ok: false,
      error: { code: "stale_control" },
    });
    expect(store.tasks.count()).toBe(0);
  });

  it("allows a same-runtime native branch switch but cancels its obsolete decisions", async () => {
    expect(await bind({ nativeSessionId: "new-branch" })).toMatchObject({ ok: true });
    expect(options.onUnbind).toHaveBeenCalledWith("ses_caller", "runtime-1");
    expect(await service.handle("hst_test", frame())).toMatchObject({
      ok: false,
      error: { code: "stale_control" },
    });
  });

  it.each([{ readOnly: true }, { archivedAt: now }, { runtime: "stopped" as const }])(
    "rejects an ineligible caller %j",
    async (change) => {
      store.putSession({ ...store.sessions.require("ses_caller"), ...change });
      expect(await service.handle("hst_test", frame())).toMatchObject({ ok: false });
      expect(store.tasks.count()).toBe(0);
    },
  );

  it("requires negotiated support and rejects tool-origin binding", async () => {
    expect(await bind({ toolCallId: "forged-tool" })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    options.negotiatedFeatures = undefined;
    expect(await bind()).toMatchObject({ ok: false, error: { code: "unsupported_capability" } });
  });

  it("rejects revoked hosts, oversized frames, unknown methods and missing tool identities", async () => {
    expect(
      await service.handle("hst_test", frame({ args: { objective: "a".repeat(128 * 1024) } })),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await service.handle("hst_test", frame({ method: "unknown" as never }))).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(await service.handle("hst_test", frame({ toolCallId: undefined }))).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    store.hosts.upsert({ ...store.hosts.require("hst_test"), revokedAt: now });
    expect(await bind()).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});

describe("Ready child tasks and durable receipts", () => {
  it("creates a Ready task with default policy, inherited parent and a fixed creator subscription", async () => {
    const parent = parentTask();
    store.putSession({ ...store.sessions.require("ses_caller"), taskId: parent.id });
    const response = await service.handle("hst_test", frame());
    expect(response).toMatchObject({
      ok: true,
      result: {
        task: {
          title: "Implement the feature",
          objective: "Implement the feature\nDetails",
          parentTaskId: parent.id,
          state: "ready",
          policy: DEFAULT_TASK_POLICY,
          origin: { kind: "manual" },
          agentOrigin: { sessionId: "ses_caller", toolCallId: "call-1" },
        },
      },
    });
    const child = store.tasks.list().find((task) => task.id !== parent.id)!;
    expect(store.db.prepare("SELECT * FROM task_subscriptions").all()).toMatchObject([
      {
        child_task_id: child.id,
        subscriber_session_id: "ses_caller",
        parent_task_id: parent.id,
      },
    ]);
    expect(options.scheduleDispatch).toHaveBeenCalledTimes(1);
    expect(store.runs.count()).toBe(0);
  });

  it("permits taskless project callers, explicit roots, and notifyOnFinish false", async () => {
    const parent = parentTask();
    store.putSession({ ...store.sessions.require("ses_caller"), taskId: parent.id });
    expect(
      await service.handle(
        "hst_test",
        frame({ args: { objective: "Root", parentTaskId: null, notifyOnFinish: false } }),
      ),
    ).toMatchObject({
      ok: true,
      result: { task: { parentTaskId: null } },
    });
    expect(store.db.prepare("SELECT * FROM task_subscriptions").all()).toEqual([]);
    store.putSession({ ...store.sessions.require("ses_caller"), taskId: null });
    expect(await service.handle("hst_test", frame({ toolCallId: "call-2" }))).toMatchObject({
      ok: true,
      result: { task: { parentTaskId: null } },
    });
  });

  it("replays normalized defaults after a service restart without rescheduling or duplicating creation", async () => {
    const first = await service.handle("hst_test", frame());
    service = new AgentService(options);
    await bind();
    const replay = await service.handle(
      "hst_test",
      frame({
        requestId: "req-retry",
        args: {
          notifyOnFinish: true,
          acceptance: [],
          dependencies: [],
          objective: "Implement the feature\nDetails",
        },
      }),
    );
    expect(replay).toEqual({ ...first, requestId: "req-retry" });
    expect(store.tasks.count()).toBe(1);
    expect(options.scheduleDispatch).toHaveBeenCalledTimes(1);
    expect(
      await service.handle("hst_test", frame({ args: { objective: "Different" } })),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("stores permanent errors and replays them even after the underlying context is repaired", async () => {
    store.putSession({ ...store.sessions.require("ses_caller"), projectId: null });
    const first = await service.handle("hst_test", frame());
    expect(first).toMatchObject({
      ok: false,
      error: { message: "Start this session in a project before creating a task." },
    });
    store.putSession({ ...store.sessions.require("ses_caller"), projectId: "prj_test" });
    expect(await service.handle("hst_test", frame())).toEqual(first);
    expect(store.tasks.count()).toBe(0);
  });

  it("persists invalid-argument receipts and preserves argument identity conflicts", async () => {
    expect(
      await service.handle("hst_test", frame({ args: undefined, toolCallId: "missing-args" })),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const bad = frame({ args: { objective: "" } });
    const first = await service.handle("hst_test", bad);
    expect(first).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(await service.handle("hst_test", bad)).toEqual(first);
    expect(await service.handle("hst_test", frame())).toMatchObject({
      ok: false,
      error: { code: "conflict" },
    });
  });

  it("rolls task and subscription writes back if storing the result fails", async () => {
    store.db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON agent_call_receipts
      BEGIN SELECT RAISE(ABORT, 'receipt failure'); END;`);
    expect(await service.handle("hst_test", frame())).toMatchObject({
      ok: false,
      error: { code: "internal" },
    });
    expect(store.tasks.count()).toBe(0);
    expect(store.db.prepare("SELECT * FROM task_subscriptions").all()).toEqual([]);
    expect(options.scheduleDispatch).not.toHaveBeenCalled();
  });

  it("maps validated host/profile hints without changing task policy defaults", async () => {
    store.checkouts.upsert({
      id: "chk_test",
      hostId: "hst_test",
      projectId: "prj_test",
      path: "/repos/app",
      commonDir: "/repos/app/.git",
      defaultBranch: "main",
      createdAt: now,
    });
    expect(
      await service.handle(
        "hst_test",
        frame({
          args: {
            objective: "Hinted",
            hostId: "hst_test",
            profileId: profile.id,
            acceptance: ["Works"],
          },
        }),
      ),
    ).toMatchObject({
      ok: true,
      result: {
        task: {
          policy: { ...DEFAULT_TASK_POLICY, hostId: "hst_test", profileId: profile.id },
          acceptanceCriteria: ["Works"],
        },
      },
    });
  });
});

describe("policy integration boundary", () => {
  it("persists terminal policy denials without mutating and replays them before authorization", async () => {
    options.authorize = vi.fn(async () => {
      throw new SwitchyardError("forbidden", "Denied by policy");
    });
    const first = await service.handle("hst_test", frame());
    expect(first).toMatchObject({
      ok: false,
      error: { code: "forbidden", message: "Denied by policy" },
    });
    expect(await service.handle("hst_test", frame())).toEqual(first);
    expect(options.authorize).toHaveBeenCalledTimes(1);
    expect(store.tasks.count()).toBe(0);
    expect(options.scheduleDispatch).not.toHaveBeenCalled();
  });

  it("loads human control authoritatively and revalidates an awaited authorization", async () => {
    const parent = parentTask();
    const run = controllingRun(parent.id);
    store.putRun(run);
    store.putSession({ ...store.sessions.require("ses_caller"), taskId: parent.id, runId: run.id });
    let release!: () => void;
    options.authorize = vi.fn(async (context) => {
      expect(store.inTransaction).toBe(false);
      expect(context).toMatchObject({ controlMode: "human", controlRevision: 1 });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const pending = service.handle("hst_test", frame());
    store.putRun({ ...run, controlRevision: 2 });
    release();
    expect(await pending).toMatchObject({ ok: false, error: { code: "stale_control" } });
    expect(store.tasks.count()).toBe(1);
    expect(store.db.prepare("SELECT * FROM agent_call_receipts").all()).toHaveLength(0);
  });

  it("rechecks the receipt in the commit transaction when duplicate calls await policy concurrently", async () => {
    options.authorize = vi.fn(async () => undefined);
    const [a, b] = await Promise.all([
      service.handle("hst_test", frame()),
      service.handle("hst_test", frame()),
    ]);
    expect(a).toEqual(b);
    expect(store.tasks.count()).toBe(1);
    expect(options.scheduleDispatch).toHaveBeenCalledTimes(1);
  });

  it("does not finalize transient communication failures, and cannot advertise policies without an adapter", async () => {
    options.authorize = vi.fn(async () => {
      throw new SwitchyardError("timeout", "Policy unavailable");
    });
    expect(await service.handle("hst_test", frame())).toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
    expect(store.db.prepare("SELECT * FROM agent_call_receipts").all()).toHaveLength(0);
    expect(
      await service.handle(
        "hst_test",
        frame({ method: "policy.status", args: { decisionId: "other" } }),
      ),
    ).toMatchObject({ ok: false, error: { code: "unsupported_capability" } });
  });
});

describe("message and inbox integration", () => {
  const message: AgentMessage = {
    id: "msg_test",
    seq: 1,
    kind: "message",
    senderSessionId: "ses_caller",
    recipientSessionId: "ses_target",
    replyTo: null,
    chainId: "msg_test",
    depth: 0,
    body: "hello",
    requestedMode: "queue",
    deliveryState: "pending",
    holdUntil: now,
    readAt: null,
    createdAt: now,
  };

  function installMessages() {
    store.putSession(
      session({
        id: "ses_target",
        runtime: "stopped",
        nativeHandle: { sessionId: "native-target", sessionFile: "/sessions/target.jsonl" },
      }),
    );
    options.messages = {
      recordContext: vi.fn(() => {
        expect(store.inTransaction).toBe(true);
      }),
      send: vi.fn(() => {
        expect(store.inTransaction).toBe(true);
        return message;
      }),
      readInbox: vi.fn(() => ({ messages: [message], nextAfter: 1, hasMore: false })),
      wake: vi.fn(() => {
        expect(store.inTransaction).toBe(false);
      }),
    };
  }

  it("authorizes messaging with authoritative caller and target control modes", async () => {
    installMessages();
    const parent = parentTask();
    const run = {
      ...controllingRun(parent.id),
      sessionId: "ses_target",
      controlMode: "automation" as const,
      controlRevision: 4,
    };
    store.putRun(run);
    store.putSession({ ...store.sessions.require("ses_target"), runId: run.id, taskId: parent.id });
    options.authorize = vi.fn(async (context, request) => {
      expect(request.method).toBe("message.send");
      expect(context).toMatchObject({
        caller: { id: "ses_caller" },
        target: { id: "ses_target" },
        controlMode: "human",
        controlRevision: 1,
        targetControlMode: "automation",
        targetControlRevision: 4,
      });
    });
    expect(
      await service.handle(
        "hst_test",
        frame({
          method: "message.send",
          args: { sessionId: "ses_target", body: "hello", mode: "queue" },
        }),
      ),
    ).toMatchObject({ ok: true });
    expect(options.authorize).toHaveBeenCalledTimes(1);
  });

  it("answers from durable capture without waiting for delivery; replays before message rate accounting", async () => {
    installMessages();
    const request = frame({
      method: "message.send",
      args: { sessionId: "ses_target", body: "hello", mode: "queue" },
    });
    const first = await service.handle("hst_test", request);
    expect(first).toMatchObject({ ok: true, result: { message } });
    expect(await service.handle("hst_test", { ...request, requestId: "retry" })).toEqual({
      ...first,
      requestId: "retry",
    });
    expect(options.messages!.send).toHaveBeenCalledTimes(1);
    expect(options.messages!.recordContext).toHaveBeenCalledTimes(1);
    expect(options.messages!.wake).toHaveBeenCalledTimes(1);
  });

  it("captures a real message exactly once and rolls back message writes with a failed receipt", async () => {
    installMessages();
    options.messages = new MessageService(store, {
      isConnected: () => false,
      accept: async () => {
        throw new Error("must not deliver");
      },
      status: async () => null,
    });
    const request = frame({
      method: "message.send",
      args: { sessionId: "ses_target", body: "hello", mode: "queue" },
    });
    const first = await service.handle("hst_test", request);
    expect(first.ok).toBe(true);
    expect(await service.handle("hst_test", request)).toEqual(first);
    expect(store.db.prepare("SELECT * FROM agent_messages").all()).toHaveLength(1);
    store.db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON agent_call_receipts
      BEGIN SELECT RAISE(ABORT, 'receipt failure'); END;`);
    expect(
      await service.handle("hst_test", { ...request, toolCallId: "call-fails" }),
    ).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(store.db.prepare("SELECT * FROM agent_messages").all()).toHaveLength(1);
  });

  it("atomically marks a real bounded inbox page read and replays its immutable snapshot", async () => {
    installMessages();
    const messages = new MessageService(store, {
      isConnected: () => false,
      accept: async () => {
        throw new Error("must not deliver");
      },
      status: async () => null,
    });
    options.messages = messages;
    for (let i = 0; i < 9; i++) {
      messages.send("ses_target", {
        sessionId: "ses_caller",
        body: "x".repeat(16000),
        mode: "queue",
      });
    }
    const request = frame({ method: "inbox.read", args: { limit: 100 } });
    const first = await service.handle("hst_test", request);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const page = first.result as { messages: AgentMessage[]; nextAfter: number; hasMore: boolean };
    expect(page.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(120 * 1024);
    expect(page.nextAfter).toBe(page.messages.at(-1)!.seq);
    expect(page.messages.every((item) => item.readAt === now)).toBe(true);
    expect(
      store.db.prepare("SELECT * FROM agent_messages WHERE read_at IS NOT NULL").all(),
    ).toHaveLength(page.messages.length);
    store.db.exec("UPDATE agent_messages SET delivery_state = 'appended'");
    expect(await service.handle("hst_test", request)).toEqual(first);
    store.db.exec("UPDATE agent_messages SET read_at = NULL");
    store.db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON agent_call_receipts
      BEGIN SELECT RAISE(ABORT, 'receipt failure'); END;`);
    expect(await service.handle("hst_test", { ...request, toolCallId: "new-read" })).toMatchObject({
      ok: false,
      error: { code: "internal" },
    });
    expect(
      store.db.prepare("SELECT * FROM agent_messages WHERE read_at IS NOT NULL").all(),
    ).toHaveLength(0);
  });

  it("passes only the caller identity for inbox reads and replays the original page", async () => {
    installMessages();
    const request = frame({ method: "inbox.read", args: {} });
    const first = await service.handle("hst_test", request);
    expect(await service.handle("hst_test", request)).toEqual(first);
    expect(options.messages!.readInbox).toHaveBeenCalledExactlyOnceWith("ses_caller", {
      after: 0,
      limit: 20,
    });
  });

  it.each([
    { sessionId: "ses_caller" },
    { sessionId: "ses_target", target: { projectId: null } },
    { sessionId: "ses_target", target: { projectId: "prj_other" } },
    { sessionId: "ses_target", target: { readOnly: true } },
    { sessionId: "ses_target", target: { archivedAt: now } },
    { sessionId: "ses_target", target: { nativeHandle: null } },
  ])("rejects invalid message targets before capture %j", async ({ sessionId, target }) => {
    installMessages();
    if (target) {
      // No FK is involved in the JSON-only project identity check.
      store.putSession({ ...store.sessions.require("ses_target"), ...target });
    }
    expect(
      await service.handle(
        "hst_test",
        frame({ method: "message.send", args: { sessionId, body: "hello", mode: "steer" } }),
      ),
    ).toMatchObject({ ok: false });
    expect(options.messages!.send).not.toHaveBeenCalled();
  });
});
