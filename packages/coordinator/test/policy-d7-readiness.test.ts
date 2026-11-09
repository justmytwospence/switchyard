import {
  CAPABILITY_KEYS,
  type Host,
  type HostPolicyBoundary,
  type PolicyRule,
  type Profile,
  RuntimeCapabilities,
  type Session,
  type Task,
} from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate, openDb } from "../src/db/index.js";
import { EventHub } from "../src/event-hub.js";
import type { PolicyAuthorizeInput, PolicyOwner } from "../src/policies/contracts.js";
import { PolicyService, type PolicyServiceOptions } from "../src/policies/service.js";
import { Store } from "../src/store.js";
import {
  CONTINUATION_PREFIX,
  type ContinuationAuthorization,
  continuationContext,
  type PendingContinuation,
} from "../src/tasks/continuations.js";
import { createTask } from "../src/tasks/service.js";

const now = "2026-11-08T00:00:00.000Z";
const owner: PolicyOwner = {
  authenticatedHostId: "hst_readiness",
  sessionId: "ses_readiness",
  nativeSessionId: "native-readiness",
  runtimeId: "runtime-readiness",
};
const source = {
  runtimeId: owner.runtimeId,
  nativeSessionId: owner.nativeSessionId,
  controllerEpoch: "controller-original",
};
const boundary: HostPolicyBoundary = {
  cwd: "/repo",
  cwdReal: "/real/repo",
  workspaceRoot: "/repo",
  workspaceRootReal: "/real/repo",
};
const profile: Profile = {
  id: "prf_readiness",
  name: "Readiness",
  provider: null,
  model: null,
  thinking: null,
  projectTrust: "ask",
  extraArgs: [],
};
const runId = "run_readiness";
const key = CONTINUATION_PREFIX + runId;
const input: ContinuationAuthorization = {
  kind: "continuation",
  runId,
  expectedControlRevision: 1,
  nextContinuationNumber: 1,
  expectedSettleCount: 1,
  expectedWatermark: null,
};
let store: Store;
let clock: number;
let service: PolicyService;
let root: Task;
let evaluator: NonNullable<PolicyServiceOptions["evaluator"]>;
let connection: { connected: boolean; features: ReadonlySet<string> };
let hostPolicyConnection: NonNullable<PolicyServiceOptions["hostPolicyConnection"]>;
const run = () => store.runs.require(runId);
const session = () => store.sessions.require(owner.sessionId);
const host = () => store.hosts.require(owner.authenticatedHostId);
const pending = () => store.getSetting<PendingContinuation>(key, undefined!);
const row = () =>
  store.db.prepare("SELECT * FROM policy_evaluations").get() as {
    canceled: number;
    decision_id: string;
    revisions_json: string;
    wait_lease_until: string | null;
  };
function requestInput(): PolicyAuthorizeInput {
  return {
    kind: "agent_request",
    owner,
    frame: {
      type: "agent.request",
      requestId: "request-interactive",
      sessionId: owner.sessionId,
      nativeSessionId: owner.nativeSessionId,
      runtimeId: owner.runtimeId,
      context: { humanInputId: null, causalMessageId: null },
      method: "task.create",
      toolCallId: "create-child",
      args: { objective: "Interactive child" },
    },
  };
}
function updateSession(patch: Partial<Session>) {
  store.putSession({ ...session(), ...patch });
}
function updateBridge(patch: Partial<NonNullable<Session["bridge"]>>) {
  updateSession({ bridge: { ...session().bridge!, ...patch } });
}
function updateHost(patch: Partial<Host>) {
  store.hosts.upsert({ ...host(), ...patch });
}
function startService(
  callback: PolicyServiceOptions["hostPolicyConnection"] = hostPolicyConnection,
) {
  service = new PolicyService({
    store,
    publicUrl: "https://switchyard.test",
    reconcileInputAttention: vi.fn(),
    evaluator,
    hostPolicyConnection: callback,
  });
  return service.initialize();
}
async function reserve() {
  const record: PendingContinuation = {
    version: 3,
    source: { ...source },
    phase: "authorization",
    deliveryAttempt: "not_sent",
    input,
    context: continuationContext(store, service, run()),
    n: 1,
    text: "Continue the original work",
    decisionId: null,
  };
  store.setSetting(key, record);
  expect(await service.authorize(input)).toEqual({ verdict: "ALLOW" });
  store.tx(() => {
    service.assertAuthorized(input);
    store.putRun({ ...run(), continuationsUsed: 1 });
    store.setSetting(key, { ...record, phase: "delivery" });
  });
  return pending();
}
const check = () => service.checkReservedContinuation(input, pending().context);
function expectIntact(record: PendingContinuation) {
  expect(row().canceled).toBe(0);
  expect(pending()).toEqual(record);
  expect(run().continuationsUsed).toBe(1);
  expect(store.db.prepare("SELECT * FROM policy_evaluations").all()).toHaveLength(1);
  expect(evaluator.evaluateRules).toHaveBeenCalledTimes(1);
}
function expectStale() {
  expect(check).toThrow(expect.objectContaining({ code: "stale_control" }));
  expect(run().continuationsUsed).toBe(1);
}

beforeEach(async () => {
  const db = openDb(":memory:");
  migrate(db);
  clock = Date.parse(now);
  store = new Store(db, new EventHub(), () => new Date(clock));
  store.hosts.upsert(
    {
      id: owner.authenticatedHostId,
      name: "Host",
      platform: "darwin",
      agentVersion: "test",
      piVersion: "1.5.0",
      piCompatible: true,
      capabilities: RuntimeCapabilities.parse({
        ...Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, true])),
        agentRequests: true,
        policies: true,
        unsupported: [],
      }),
      connectivity: "connected",
      lastSeenAt: now,
      revokedAt: null,
      createdAt: now,
    },
    { credential_hash: "hash" },
  );
  store.profiles.upsert(profile);
  store.projects.upsert({
    id: "prj_readiness",
    name: "Readiness",
    repoIdentity: "https://github.com/example/readiness",
    defaultProfileId: profile.id,
    defaultHostId: owner.authenticatedHostId,
    maxConcurrentRuns: 1,
    automationEnabled: false,
    setupCommand: null,
    checks: [],
    workspaceSharing: "single_writer",
    worktreeDir: ".worktrees",
    createdAt: now,
    updatedAt: now,
  });
  root = createTask({ store }, { projectId: "prj_readiness", title: "Root" }, { kind: "manual" });
  store.putRun({
    id: runId,
    taskId: root.id,
    sessionId: owner.sessionId,
    hostId: owner.authenticatedHostId,
    dispatchKey: "dispatch-readiness",
    attempt: 1,
    state: "running",
    controlMode: "automation",
    controlRevision: 1,
    continuationsUsed: 0,
    infraRetries: 0,
    nextAttemptAt: null,
    startedAt: now,
    endedAt: null,
    outcome: null,
    limits: {
      enabled: true,
      objective: "Finish",
      maxContinuations: 3,
      maxElapsedMinutes: 60,
      maxTokens: null,
      maxCostUsd: null,
    },
    usage: { tokens: null, costUsd: null, accounting: "unavailable", note: null },
    checks: [],
    createdAt: now,
    updatedAt: now,
  });
  store.putTask({ ...root, currentRunId: runId, sessionId: owner.sessionId });
  store.putSession({
    id: owner.sessionId,
    hostId: owner.authenticatedHostId,
    title: "Continuation readiness",
    subtitle: null,
    projectId: root.projectId,
    workspaceId: null,
    cwd: boundary.cwd,
    nativeHandle: null,
    profileSnapshot: profile,
    runtime: "idle",
    runtimeDetail: null,
    connectivity: "connected",
    runId,
    taskId: root.id,
    provenance: "created",
    readOnly: false,
    archivedAt: null,
    lastActivityAt: now,
    createdAt: now,
    queue: { steering: [], followUp: [] },
    stats: null,
    lastAssistantText: null,
    bridge: {
      version: 1,
      ...source,
      agentTools: true,
      messageDelivery: true,
      policyState: "active",
      policyPhases: ["tool_call", "request"],
    },
  });
  store.noteRunSettle(runId);
  evaluator = {
    validateRule: vi.fn(async () => ({ valid: true as const, returnType: "dyn" })),
    evaluateRules: vi.fn(async (rules: PolicyRule[]) =>
      rules.map((r) => ({
        ruleId: r.id,
        ruleRevision: r.revision,
        result: null,
        error: null,
      })),
    ),
  };
  connection = { connected: true, features: new Set(["agentRequests.v1", "policies.v1"]) };
  hostPolicyConnection = vi.fn(() => connection);
  await startService();
  service.bindBoundary(owner, boundary);
});
afterEach(async () => {
  await service.stop();
  store.db.close();
});

describe("D.11 shared unspent continuation availability", () => {
  it.each([
    ["offline before welcome", false, [], "lost", [], "defer"],
    [
      "initializing after welcome",
      true,
      ["agentRequests.v1", "policies.v1"],
      "initializing",
      [],
      "defer",
    ],
    ["lost after welcome", true, ["agentRequests.v1", "policies.v1"], "lost", [], "defer"],
    ["no agent requests", true, ["policies.v1"], "lost", [], "unsupported_capability"],
    ["no policies", true, ["agentRequests.v1"], "initializing", [], "unsupported_capability"],
    [
      "unsupported bridge",
      true,
      ["agentRequests.v1", "policies.v1"],
      "unsupported",
      [],
      "unsupported_capability",
    ],
    [
      "active missing request",
      true,
      ["agentRequests.v1", "policies.v1"],
      "active",
      ["tool_call"],
      "unsupported_capability",
    ],
    [
      "active missing tool",
      true,
      ["agentRequests.v1", "policies.v1"],
      "active",
      ["request"],
      "unsupported_capability",
    ],
    [
      "active",
      true,
      ["agentRequests.v1", "policies.v1"],
      "active",
      ["tool_call", "request"],
      "ready",
    ],
  ] as const)(
    "uses the D.7 matrix before reservation: %s",
    (_name, connected, features, policyState, policyPhases, result) => {
      connection = { connected, features: new Set(features) };
      updateBridge({ policyState, policyPhases: [...policyPhases] });
      const before = store.db.prepare("SELECT total_changes() AS n").get();
      const available = () => service.checkContinuationAvailability(runId, source);
      if (result === "unsupported_capability")
        expect(available).toThrow(expect.objectContaining({ code: result }));
      else expect(available()).toMatchObject({ state: result });
      expect(store.db.prepare("SELECT total_changes() AS n").get()).toEqual(before);
      expect(run().continuationsUsed).toBe(0);
      expect(store.getSetting(key, null)).toBeNull();
      expect(evaluator.evaluateRules).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["revoked host", () => updateHost({ revokedAt: now })],
    ["changed epoch", () => updateBridge({ controllerEpoch: "replacement" })],
    ["missing epoch", () => updateBridge({ controllerEpoch: undefined })],
    ["changed runtime", () => updateBridge({ runtimeId: "replacement" })],
    ["changed native", () => updateBridge({ nativeSessionId: "replacement" })],
    ["missing bridge", () => updateSession({ bridge: undefined })],
    [
      "conflicting handle",
      () => updateSession({ nativeHandle: { sessionId: "other", sessionFile: "/other" } }),
    ],
  ] as const)("rejects stable %s before considering offline deferral", (_name, change) => {
    connection = { connected: false, features: new Set() };
    updateBridge({ policyState: "lost", policyPhases: [] });
    change();
    expect(() => service.checkContinuationAvailability(runId, source)).toThrow(
      expect.objectContaining({ code: "stale_control" }),
    );
    expect(hostPolicyConnection).not.toHaveBeenCalled();
    expect(run().continuationsUsed).toBe(0);
  });

  it("ignores stale cached potential while disconnected but rejects confirmed missing potential", () => {
    updateHost({ capabilities: null });
    connection = { connected: false, features: new Set() };
    expect(service.checkContinuationAvailability(runId, source)).toEqual({
      state: "defer",
      reason: "Waiting for the host to reconnect.",
    });
    connection = { connected: true, features: new Set(["agentRequests.v1", "policies.v1"]) };
    expect(() => service.checkContinuationAvailability(runId, source)).toThrow(
      expect.objectContaining({ code: "unsupported_capability" }),
    );
  });
});

describe("D.7 durable authority and transient readiness", () => {
  it("preserves ALLOW, original delivery and count through offline/lost/restart/active", async () => {
    const record = await reserve();
    const revisions = row().revisions_json;
    const calls = vi.mocked(evaluator.evaluateRules).mock.calls.length;
    connection = { connected: false, features: new Set() };
    updateBridge({ policyState: "lost", policyPhases: [] });
    updateHost({ connectivity: "reconnecting", capabilities: null });
    updateSession({ connectivity: "reconnecting" });
    expect(check()).toEqual({ state: "defer", reason: "Waiting for the host to reconnect." });
    expect(() => service.assertReservedContinuation(input, record.context)).toThrow(
      expect.objectContaining({ code: "host_unreachable", details: { deferred: true } }),
    );
    expectIntact(record);
    expect(row().revisions_json).toBe(revisions);
    expect(continuationContext(store, service, run())).toBe(record.context);
    await service.stop();
    await startService();
    expectIntact(record);
    updateHost({
      capabilities: RuntimeCapabilities.parse({
        ...Object.fromEntries(CAPABILITY_KEYS.map((key) => [key, true])),
        agentRequests: true,
        policies: true,
        unsupported: [],
      }),
    });
    connection = { connected: true, features: new Set(["agentRequests.v1", "policies.v1"]) };
    expect(check()).toEqual({
      state: "defer",
      reason: "Waiting for policy enforcement to reconnect.",
    });
    updateBridge({ policyState: "active", policyPhases: ["tool_call", "request"] });
    // Cached session/host connectivity projections are intentionally still reconnecting.
    expect(check()).toEqual({ state: "ready" });
    expect(() => service.assertReservedContinuation(input, record.context)).not.toThrow();
    expectIntact(record);
    expect(evaluator.evaluateRules).toHaveBeenCalledTimes(calls);
  });

  it.each(["initializing", "lost"] as const)(
    "defers %s with an empty phase projection without rewriting stable proof",
    async (policyState) => {
      const record = await reserve();
      const revisions = row().revisions_json;
      updateBridge({ policyState, policyPhases: [] });
      expect(check()).toEqual({
        state: "defer",
        reason: "Waiting for policy enforcement to reconnect.",
      });
      expect(row().revisions_json).toBe(revisions);
      expectIntact(record);
    },
  );

  it.each(["agentRequests.v1", "policies.v1"])(
    "rejects connected welcome missing %s even when cached potential is true",
    async (missing) => {
      const record = await reserve();
      connection.features = new Set(
        ["agentRequests.v1", "policies.v1"].filter((f) => f !== missing),
      );
      updateBridge({ policyState: "lost", policyPhases: [] });
      expect(check).toThrow(expect.objectContaining({ code: "unsupported_capability" }));
      expectIntact(record);
    },
  );

  it.each(["missing", "unknown"])("defers a %s connection callback, never sends", async (mode) => {
    const record = await reserve();
    await service.stop();
    if (mode === "missing") {
      service = new PolicyService({
        store,
        publicUrl: "https://switchyard.test",
        reconcileInputAttention: vi.fn(),
        evaluator,
      });
      await service.initialize();
    } else {
      await startService(() => {
        throw new Error("No current welcome");
      });
    }
    expect(check()).toEqual({ state: "defer", reason: "Waiting for the host to reconnect." });
    expectIntact(record);
  });

  it.each([
    ["missing potential", () => updateHost({ capabilities: null })],
    ["incompatible Pi", () => updateHost({ piCompatible: false })],
    ["unsupported bridge", () => updateBridge({ policyState: "unsupported" })],
    ["missing request phase", () => updateBridge({ policyPhases: ["tool_call"] })],
    ["missing tool phase", () => updateBridge({ policyPhases: ["request"] })],
  ] as const)("pauses confirmed %s, rather than deferring forever", async (_name, change) => {
    const record = await reserve();
    change();
    expect(check).toThrow(expect.objectContaining({ code: "unsupported_capability" }));
    expectIntact(record);
  });

  it("always requires request but only requires tool_call for a protected launch", async () => {
    for (const rule of service.listRules())
      await service.updateRule(rule.id, { expectedRevision: rule.revision, enabled: false });
    await reserve();
    updateBridge({ policyPhases: ["request"] });
    expect(check()).toEqual({ state: "ready" });
    updateBridge({ policyPhases: [] });
    expect(check).toThrow(expect.objectContaining({ code: "unsupported_capability" }));
  });

  it.each([
    ["controller epoch", () => updateBridge({ controllerEpoch: "controller-replaced" })],
    ["missing controller epoch", () => updateBridge({ controllerEpoch: undefined })],
    ["runtime id", () => updateBridge({ runtimeId: "runtime-replaced" })],
    ["native id", () => updateBridge({ nativeSessionId: "native-replaced" })],
    ["missing bridge", () => updateSession({ bridge: undefined })],
    ["revoked host", () => updateHost({ revokedAt: now })],
    ["control revision", () => store.putRun({ ...run(), controlRevision: 2 })],
    ["settlement", () => store.noteRunSettle(runId)],
    ["boundary", () => store.db.exec("DELETE FROM policy_runtime_boundaries")],
    ["rules", () => store.db.exec("UPDATE policy_rules SET revision=revision+1")],
    [
      "conflicting handle",
      () => updateSession({ nativeHandle: { sessionId: "other", sessionFile: "/other" } }),
    ],
    ["canceled ALLOW", () => service.cancel(owner, { decisionId: row().decision_id })],
    [
      "root terminal/reopen",
      () => {
        const original = store.tasks.require(root.id);
        store.putTask({ ...original, state: "done" });
        store.putTask(original);
      },
    ],
  ] as const)("checks durable %s before offline readiness", async (_name, change) => {
    await reserve();
    connection = { connected: false, features: new Set() };
    updateBridge({ policyState: "lost", policyPhases: [] });
    change();
    expectStale();
  });

  it.each([1, 2])(
    "rejects legacy v%s rather than inventing captured authority",
    async (version) => {
      const record = await reserve();
      store.setSetting(key, { ...record, version, source: undefined });
      expectStale();
    },
  );

  it.each(["runtimeId", "nativeSessionId", "controllerEpoch"] as const)(
    "rejects a missing or substituted captured source %s",
    async (field) => {
      const record = await reserve();
      store.setSetting(key, { ...record, source: { ...record.source, [field]: undefined } });
      expectStale();
      store.setSetting(key, { ...record, source: { ...record.source, [field]: "forged" } });
      expectStale();
    },
  );

  it("keeps controller epochs in policy revisions, but not readiness or file metadata", async () => {
    const record = await reserve();
    const revisions = JSON.parse(row().revisions_json);
    expect(revisions.bridgeIdentity).toEqual({ version: 1, ...source });
    updateSession({
      nativeHandle: { sessionId: source.nativeSessionId, sessionFile: "/new/discovery" },
      lastActivityAt: "2026-11-08T00:10:00.000Z",
    });
    expect(check()).toEqual({ state: "ready" });
    expectIntact(record);
    updateBridge({ controllerEpoch: "replacement", policyState: "initializing", policyPhases: [] });
    expect(row().canceled).toBe(1);
    expectStale();
  });

  it("keeps a reserved background ALLOW beyond the D.5 interactive wait lease", async () => {
    const record = await reserve();
    expect(row().wait_lease_until).toBeNull();
    connection = { connected: false, features: new Set() };
    updateBridge({ policyState: "lost", policyPhases: [] });
    clock += 3_600_000;
    await service.stop();
    await startService();
    expect(check().state).toBe("defer");
    expectIntact(record);
  });

  it("fences ordinary request ALLOWs on controller identity, not readiness projections", async () => {
    const request = requestInput();
    expect(await service.authorize(request)).toEqual({ verdict: "ALLOW" });
    const revisions = row().revisions_json;
    updateBridge({ policyState: "lost", policyPhases: [] });
    updateBridge({ policyState: "initializing", policyPhases: [] });
    expect(row().canceled).toBe(0);
    expect(row().revisions_json).toBe(revisions);
    expect(() => service.assertAuthorized(request)).not.toThrow();
    updateBridge({ controllerEpoch: "new-controller" });
    expect(row().canceled).toBe(1);
    expect(() => service.assertAuthorized(request)).toThrow(
      expect.objectContaining({ code: "stale_control" }),
    );
  });

  it("still expires D.5 interactive ASK leases instead of turning them into durable waits", async () => {
    vi.mocked(evaluator.evaluateRules).mockImplementation(async (rules) =>
      rules.map((rule) => ({
        ruleId: rule.id,
        ruleRevision: rule.revision,
        result: { verdict: "ASK", reason: "Interactive approval" },
        error: null,
      })),
    );
    const result = await service.authorize(requestInput());
    expect(result.verdict).toBe("ASK");
    if (result.verdict !== "ASK") throw new Error("Expected ASK");
    expect(row().wait_lease_until).toBe("2026-11-08T00:01:00.000Z");
    clock += 60_001;
    updateBridge({ policyState: "lost", policyPhases: [] });
    expect(await service.status(owner, { decisionId: result.decisionId, waitMs: 25_000 })).toEqual({
      state: "canceled",
      reason: "The policy approval wait expired. Retry the action.",
    });
    expect(row().canceled).toBe(1);
    expect(run().continuationsUsed).toBe(0);
  });

  it("requires the connection callback when initializing the production evaluator", async () => {
    await service.stop();
    service = new PolicyService({
      store,
      publicUrl: "https://switchyard.test",
      reconcileInputAttention: vi.fn(),
    });
    await expect(service.initialize()).rejects.toMatchObject({
      code: "internal",
      message: "Policy host connection callback is required.",
    });
    expect(service.ready).toBe(false);
  });

  it("checks readiness without writes, CEL evaluation or spending another count", async () => {
    const record = await reserve();
    const total = () => (store.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const before = total();
    expect(check()).toEqual({ state: "ready" });
    connection = { connected: false, features: new Set() };
    expect(check().state).toBe("defer");
    expect(total()).toBe(before);
    expectIntact(record);
  });
});
