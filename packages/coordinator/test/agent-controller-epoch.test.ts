import { randomUUID } from "node:crypto";
import { type AgentRequestFrame, type Profile, Session } from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentService, type AgentServiceOptions } from "../src/agents/service.js";
import { migrate, openDb } from "../src/db/index.js";
import { EventHub } from "../src/event-hub.js";
import { PolicyService } from "../src/policies/service.js";
import { Store } from "../src/store.js";
import { fullCapabilities } from "./task-helpers.js";

const now = "2026-01-01T00:00:00.000Z";
const profile: Profile = {
  id: "profile",
  name: "Profile",
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
let store: Store;
let service: AgentService;
let options: AgentServiceOptions;
let policies: PolicyService;

function frame(overrides: Partial<AgentRequestFrame> = {}): AgentRequestFrame {
  return {
    type: "agent.request",
    sessionId: "session",
    nativeSessionId: "native",
    runtimeId: "runtime",
    requestId: randomUUID(),
    context: { humanInputId: null, causalMessageId: null },
    method: "inbox.read",
    toolCallId: "call",
    deadlineAt: "2026-01-01T00:00:30.000Z",
    args: {},
    ...overrides,
  };
}
function bind(controllerEpoch: string | undefined, extra: Record<string, unknown> = {}) {
  return service.handle(
    "host",
    frame({
      method: "session.bind",
      toolCallId: undefined,
      args: {
        version: 1,
        controllerEpoch,
        sessionFile: null,
        mode: "rpc",
        capabilities: {
          agentTools: true,
          messageDelivery: true,
          editorDraftGuard: true,
          toolPolicy: true,
        },
        policyRequired: true,
        policyBoundary: boundary,
        ...extra,
      },
    }),
  );
}
function active() {
  const caller = store.sessions.require("session");
  store.putSession({
    ...caller,
    bridge: { ...caller.bridge!, policyState: "active", policyPhases: ["tool_call", "request"] },
  });
}

beforeEach(() => {
  const db = openDb(":memory:");
  migrate(db);
  store = new Store(db, new EventHub(), () => new Date(now));
  store.hosts.upsert(
    {
      id: "host",
      name: "Host",
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
  store.profiles.upsert(profile);
  store.putSession(
    Session.parse({
      id: "session",
      title: "Session",
      subtitle: null,
      hostId: "host",
      projectId: null,
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
      lastActivityAt: now,
      archivedAt: null,
      queue: { steering: [], followUp: [] },
      stats: null,
      lastAssistantText: null,
      createdAt: now,
    }),
  );
  policies = new PolicyService({
    store,
    publicUrl: "https://switchyard.test",
    evaluator: {
      validateRule: async () => ({ valid: true, returnType: "dyn" }),
      evaluateRules: async (rules) =>
        rules.map((rule) => ({
          ruleId: rule.id,
          ruleRevision: rule.revision,
          result: null,
          error: null,
        })),
    },
    reconcileInputAttention: vi.fn(),
  });
  policies.start();
  options = {
    store,
    scheduleDispatch: vi.fn(),
    negotiatedFeatures: () => new Set(["agentRequests.v1", "policies.v1"]),
    bindPolicyBoundary: (owner, proof) => policies.bindBoundary(owner, proof),
    onUnbind: vi.fn(),
    messages: {
      recordContext: vi.fn(),
      readInbox: vi.fn(() => ({ messages: [], nextAfter: 0, hasMore: false })),
      send: vi.fn(),
      wake: vi.fn(),
    },
  };
  service = new AgentService(options);
});
afterEach(async () => {
  await policies.stop();
  store.db.close();
});

describe("authenticated controller epoch binding", () => {
  it("requires protected controller proof without inventing one for legacy JSON", async () => {
    expect(await bind(undefined)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(store.sessions.require("session").bridge).toBeUndefined();
    const controllerEpoch = randomUUID();
    expect(await bind(controllerEpoch)).toMatchObject({ ok: true });
    const caller = store.sessions.require("session");
    expect(caller.bridge).toMatchObject({ controllerEpoch, policyState: "initializing" });
    expect(Session.parse(caller).bridge?.controllerEpoch).toBe(controllerEpoch);
    expect(await bind(undefined)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    const { controllerEpoch: _, ...legacyBridge } = caller.bridge!;
    expect(Session.parse({ ...caller, bridge: legacyBridge }).bridge).not.toHaveProperty(
      "controllerEpoch",
    );
    expect(await bind(randomUUID(), { bindingId: "private-forgery" })).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(
      await service.handle(
        "host",
        frame({ method: "session.bind", args: { controllerEpoch: randomUUID() } }),
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  it("retains legacy unprotected binding compatibility without inventing controller proof", async () => {
    expect(
      await bind(undefined, {
        policyRequired: false,
        policyBoundary: undefined,
        capabilities: {
          agentTools: true,
          messageDelivery: true,
          editorDraftGuard: true,
          toolPolicy: false,
        },
      }),
    ).toMatchObject({ ok: true });
    expect(store.sessions.require("session").bridge).not.toHaveProperty("controllerEpoch");
    expect(await service.handle("host", frame())).toMatchObject({ ok: true });
  });

  it("preserves authority on same-epoch rebind but invalidates same-runtime/native controller replacement", async () => {
    const first = randomUUID();
    expect(await bind(first)).toMatchObject({ ok: true });
    active();
    expect(await bind(first)).toMatchObject({ ok: true });
    expect(options.onUnbind).not.toHaveBeenCalled();
    const second = randomUUID();
    expect(await bind(second)).toMatchObject({ ok: true });
    expect(store.sessions.require("session").bridge).toMatchObject({
      controllerEpoch: second,
      policyState: "initializing",
    });
    expect(options.onUnbind).toHaveBeenCalledExactlyOnceWith("session", "runtime");
  });

  it("fences mutations across an authorization await when only the controller epoch changes", async () => {
    expect(await bind(randomUUID())).toMatchObject({ ok: true });
    let release!: (value: { verdict: "ALLOW" }) => void;
    options.authorize = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = service.handle("host", frame());
    expect(options.authorize).toHaveBeenCalledTimes(1);
    expect(await bind(randomUUID())).toMatchObject({ ok: true });
    release({ verdict: "ALLOW" });
    expect(await pending).toMatchObject({ ok: false, error: { code: "stale_control" } });
    expect(options.messages!.readInbox).not.toHaveBeenCalled();
    expect(store.db.prepare("SELECT * FROM agent_call_receipts").all()).toEqual([]);
  });

  it("rejects a projected epoch substitution until authenticated rebind", async () => {
    expect(await bind(randomUUID())).toMatchObject({ ok: true });
    const caller = store.sessions.require("session");
    store.putSession({ ...caller, bridge: { ...caller.bridge!, controllerEpoch: randomUUID() } });
    expect(await service.handle("host", frame())).toMatchObject({
      ok: false,
      error: { code: "stale_control" },
    });
  });

  it("publishes replacement proof before policy event freshness checks, even while initializing", async () => {
    const first = randomUUID();
    expect(await bind(first)).toMatchObject({ ok: true });
    active();
    const owner = {
      authenticatedHostId: "host",
      sessionId: "session",
      nativeSessionId: "native",
      runtimeId: "runtime",
    };
    const input = { kind: "agent_request" as const, owner, frame: frame() };
    expect(await policies.authorize(input)).toMatchObject({ verdict: "ALLOW" });
    const row = () =>
      store.db.prepare("SELECT canceled FROM policy_evaluations").get() as {
        canceled: number;
      };
    expect(row().canceled).toBe(0);
    expect(await bind(first)).toMatchObject({ ok: true });
    expect(row().canceled).toBe(0);
    active();
    expect(await bind(randomUUID())).toMatchObject({ ok: true });
    expect(store.sessions.require("session").bridge?.policyState).toBe("initializing");
    expect(row().canceled).toBe(1);
  });
});
