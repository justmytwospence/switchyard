import type { AgentRequestFrame, PolicyEvaluation, Profile, Session } from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageService } from "../src/agents/messages.js";
import { AgentService, type AgentServiceOptions } from "../src/agents/service.js";
import { migrate, openDb } from "../src/db/index.js";
import { EventHub } from "../src/event-hub.js";
import { Store } from "../src/store.js";
import { fullCapabilities } from "./task-helpers.js";

const now = "2026-01-01T00:00:00.000Z";
const profile: Profile = {
  id: "prf_test",
  name: "Test",
  provider: null,
  model: null,
  thinking: null,
  projectTrust: "ask",
  extraArgs: [],
};
let store: Store;
let service: AgentService;
let messages: MessageService;
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
    deadlineAt: new Date(Date.parse(now) + 30_000).toISOString(),
    method: "task.create",
    args: { objective: "Create a child" },
    ...over,
  };
}

function updateSession(id: string, patch: Partial<Session>) {
  store.putSession({ ...store.sessions.require(id), ...patch });
}

function handle(sessionFile: string, sessionId = "native-caller"): Session["nativeHandle"] {
  return { sessionId, sessionFile };
}

function receipts() {
  return store.db.prepare("SELECT * FROM agent_call_receipts").all();
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
      capabilities: fullCapabilities(),
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
    lastActivityAt: now,
    archivedAt: null,
    queue: { steering: [], followUp: [] },
    stats: null,
    lastAssistantText: null,
    createdAt: now,
  };
  store.putSession(caller);
  messages = new MessageService(store, {
    isConnected: () => false,
    accept: vi.fn(),
    status: vi.fn(),
  });
  options = {
    store,
    messages,
    scheduleDispatch: vi.fn(),
    negotiatedFeatures: () => new Set(["agentRequests.v1", "policies.v1"]),
    bindPolicyBoundary: vi.fn(),
    authorize: vi.fn(async () => ({ verdict: "ALLOW" })),
    assertAuthorization: vi.fn(() => {
      expect(store.inTransaction).toBe(true);
    }),
  };
  service = new AgentService(options);
  expect(
    await service.handle(
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
      }),
    ),
  ).toMatchObject({ ok: true });
  const bridge = store.sessions.require(caller.id).bridge!;
  store.putSession({
    ...caller,
    id: "ses_target",
    bridge: { ...bridge, runtimeId: "runtime-target", nativeSessionId: "native-target" },
  });
  vi.spyOn(messages, "recordContext");
  vi.spyOn(messages, "wake").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  store.db.close();
});

async function duringAuthorization(change: () => void, request = frame()) {
  let release!: (evaluation: PolicyEvaluation) => void;
  options.authorize = vi.fn(
    () =>
      new Promise<PolicyEvaluation>((resolve) => {
        release = resolve;
      }),
  );
  const pending = service.handle("hst_test", request);
  expect(options.authorize).toHaveBeenCalledTimes(1);
  expect(store.inTransaction).toBe(false);
  change();
  release({ verdict: "ALLOW" });
  return pending;
}

function expectNoAction() {
  expect(store.tasks.count()).toBe(0);
  expect(store.db.prepare("SELECT * FROM agent_messages").all()).toEqual([]);
  expect(receipts()).toEqual([]);
  expect(options.assertAuthorization).not.toHaveBeenCalled();
  expect(messages.recordContext).not.toHaveBeenCalled();
  expect(messages.wake).not.toHaveBeenCalled();
  expect(options.scheduleDispatch).not.toHaveBeenCalled();
}

const metadataChanges = [
  { name: "file discovery", before: null, after: handle("/sessions/discovered.jsonl") },
  {
    name: "file path change",
    before: handle("/sessions/old.jsonl"),
    after: handle("/sessions/new.jsonl"),
  },
  { name: "file metadata removal", before: handle("/sessions/old.jsonl"), after: null },
];

describe("bridge-owned agent authorization context identity", () => {
  it.each(metadataChanges)("allows caller $name across the authorization await", async (change) => {
    updateSession("ses_caller", { nativeHandle: change.before });
    expect(
      await duringAuthorization(() => {
        updateSession("ses_caller", { nativeHandle: change.after });
      }),
    ).toMatchObject({ ok: true, result: { task: { state: "ready" } } });
    expect(options.assertAuthorization).toHaveBeenCalledTimes(1);
    expect(messages.recordContext).toHaveBeenCalledTimes(1);
    expect(options.scheduleDispatch).toHaveBeenCalledTimes(1);
    expect(store.tasks.count()).toBe(1);
    expect(receipts()).toHaveLength(1);
    // A lost response still replays exactly once after the optional file metadata changes.
    expect(await service.handle("hst_test", frame({ requestId: "req-replay" }))).toMatchObject({
      ok: true,
    });
    expect(options.authorize).toHaveBeenCalledTimes(1);
    expect(options.assertAuthorization).toHaveBeenCalledTimes(1);
    expect(store.tasks.count()).toBe(1);
    expect(receipts()).toHaveLength(1);
  });

  it.each(metadataChanges)("allows target $name across the authorization await", async (change) => {
    const targetHandle = (value: Session["nativeHandle"]) =>
      value && { ...value, sessionId: "native-target" };
    updateSession("ses_target", { nativeHandle: targetHandle(change.before) });
    expect(
      await duringAuthorization(
        () => {
          updateSession("ses_target", { nativeHandle: targetHandle(change.after) });
        },
        frame({
          method: "message.send",
          args: { sessionId: "ses_target", body: "hello", mode: "queue" },
        }),
      ),
    ).toMatchObject({ ok: true, result: { message: { recipientSessionId: "ses_target" } } });
    expect(options.assertAuthorization).toHaveBeenCalledTimes(1);
    expect(messages.recordContext).toHaveBeenCalledTimes(1);
    expect(messages.wake).toHaveBeenCalledTimes(1);
    expect(store.db.prepare("SELECT * FROM agent_messages").all()).toHaveLength(1);
    expect(receipts()).toHaveLength(1);
  });

  it.each(["before", "during"] as const)(
    "rejects a conflicting caller handle %s authorization without a final receipt",
    async (when) => {
      const change = () =>
        updateSession("ses_caller", { nativeHandle: handle("/sessions/caller.jsonl", "other") });
      if (when === "before") change();
      const result =
        when === "before"
          ? await service.handle("hst_test", frame())
          : await duringAuthorization(change);
      expect(result).toMatchObject({ ok: false, error: { code: "stale_control" } });
      expectNoAction();
      // The stale attempt is transient: repairing metadata permits this same logical call.
      updateSession("ses_caller", { nativeHandle: handle("/sessions/caller.jsonl") });
      options.authorize = vi.fn(async () => ({ verdict: "ALLOW" }));
      expect(await service.handle("hst_test", frame())).toMatchObject({ ok: true });
      expect(receipts()).toHaveLength(1);
    },
  );

  it.each(["before", "during"] as const)(
    "does not infer a missing bridge from an existing native handle %s authorization",
    async (when) => {
      updateSession("ses_caller", { nativeHandle: handle("/sessions/caller.jsonl") });
      const change = () => updateSession("ses_caller", { bridge: undefined });
      if (when === "before") change();
      const result =
        when === "before"
          ? await service.handle("hst_test", frame())
          : await duringAuthorization(change);
      expect(result).toMatchObject({ ok: false, error: { code: "stale_control" } });
      expectNoAction();
    },
  );

  it.each(["runtimeId", "nativeSessionId"] as const)(
    "rejects caller bridge %s replacement even with an unchanged file path",
    async (field) => {
      updateSession("ses_caller", { nativeHandle: handle("/sessions/caller.jsonl") });
      expect(
        await duringAuthorization(() => {
          const bridge = store.sessions.require("ses_caller").bridge!;
          updateSession("ses_caller", { bridge: { ...bridge, [field]: "replacement" } });
        }),
      ).toMatchObject({ ok: false, error: { code: "stale_control" } });
      expectNoAction();
    },
  );

  it.each(["runtimeId", "nativeSessionId"] as const)(
    "fences target bridge %s replacement while fileless",
    async (field) => {
      expect(
        await duringAuthorization(
          () => {
            const bridge = store.sessions.require("ses_target").bridge!;
            updateSession("ses_target", { bridge: { ...bridge, [field]: "replacement" } });
          },
          frame({
            method: "message.send",
            args: { sessionId: "ses_target", body: "hello", mode: "queue" },
          }),
        ),
      ).toMatchObject({ ok: false, error: { code: "stale_control" } });
      expectNoAction();
    },
  );
});
