import {
  CAPABILITY_KEYS,
  type Host,
  type HostPolicyBoundary,
  type PolicyRule,
  type Profile,
  type Run,
  RuntimeCapabilities,
  type Session,
  type Task,
} from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate, openDb } from "../src/db/index.js";
import { EventHub } from "../src/event-hub.js";
import type { PolicyOwner } from "../src/policies/contracts.js";
import { PolicyService, type PolicyServiceOptions } from "../src/policies/service.js";
import { Store } from "../src/store.js";
import {
  CONTINUATION_PREFIX,
  type ContinuationAuthorization,
  continuationContext,
  continuationSource,
  type PendingContinuation,
} from "../src/tasks/continuations.js";
import { createTask } from "../src/tasks/service.js";

const now = "2026-11-08T00:00:00.000Z";
const owner: PolicyOwner = {
  authenticatedHostId: "hst_reserved",
  sessionId: "ses_reserved",
  nativeSessionId: "native-reserved",
  runtimeId: "runtime-reserved",
};
const boundary: HostPolicyBoundary = {
  cwd: "/repo",
  cwdReal: "/real/repo",
  workspaceRoot: "/repo",
  workspaceRootReal: "/real/repo",
};
const profile: Profile = {
  id: "prf_reserved",
  name: "Reserved",
  provider: null,
  model: null,
  thinking: null,
  projectTrust: "ask",
  extraArgs: [],
};
let store: Store;
let service: PolicyService;
let evaluator: NonNullable<PolicyServiceOptions["evaluator"]>;
let connected: boolean;
let root: Task;
let child: Task;
const runId = "run_reserved";
const key = CONTINUATION_PREFIX + runId;
const run = () => store.runs.require(runId);
const session = () => store.sessions.require(owner.sessionId);
const pending = () => store.getSetting<PendingContinuation>(key, undefined!);
const input = (): ContinuationAuthorization => ({
  kind: "continuation",
  runId,
  expectedControlRevision: 1,
  nextContinuationNumber: 1,
  expectedSettleCount: 1,
  expectedWatermark: null,
});
function startService() {
  service = new PolicyService({
    store,
    publicUrl: "https://switchyard.test",
    reconcileInputAttention: vi.fn(),
    evaluator,
    hostPolicyConnection: () => ({
      connected,
      features: new Set(["agentRequests.v1", "policies.v1"]),
    }),
  });
  return service.initialize();
}
function changes() {
  return (store.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
}
function evaluation() {
  return store.db.prepare("SELECT * FROM policy_evaluations").get() as {
    evaluation_key: string;
    decision_id: string;
    canceled: number;
    revisions_json: string;
    verdict: string;
  };
}
function updateSession(patch: Partial<Session>) {
  store.putSession({ ...session(), ...patch });
}
function updateRun(patch: Partial<Run>) {
  store.putRun({ ...run(), ...patch });
}
function updateHost(patch: Partial<Host>) {
  store.hosts.upsert({
    ...store.hosts.require(owner.authenticatedHostId),
    ...patch,
  });
}
function rejectsReservation(authorization = input(), context = pending().context) {
  const before = changes();
  expect(() => service.assertReservedContinuation(authorization, context)).toThrow(
    expect.objectContaining({ code: "stale_control" }),
  );
  expect(changes()).toBe(before);
}
async function reserve(authorization = input()): Promise<PendingContinuation> {
  const record: PendingContinuation = {
    version: 3,
    source: continuationSource(session())!,
    phase: "authorization",
    deliveryAttempt: "not_sent",
    input: authorization,
    context: continuationContext(store, service, run()),
    n: 1,
    text: "Continue the reserved work",
    decisionId: null,
  };
  store.setSetting(key, record);
  expect(await service.authorize(authorization)).toEqual({ verdict: "ALLOW" });
  const delivery: PendingContinuation = { ...record, phase: "delivery" };
  store.tx(() => {
    service.assertAuthorized(authorization);
    updateRun({ continuationsUsed: 1 });
    store.setSetting(key, delivery);
  });
  return delivery;
}

beforeEach(async () => {
  connected = true;
  const db = openDb(":memory:");
  migrate(db);
  store = new Store(db, new EventHub(), () => new Date(now));
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
    id: "prj_reserved",
    name: "Reserved",
    repoIdentity: "https://github.com/example/reserved",
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
  root = createTask({ store }, { projectId: "prj_reserved", title: "Root" }, { kind: "manual" });
  child = createTask(
    { store },
    { projectId: root.projectId, title: "Child", parentTaskId: root.id },
    { kind: "manual" },
  );
  store.putRun({
    id: runId,
    taskId: child.id,
    sessionId: owner.sessionId,
    hostId: owner.authenticatedHostId,
    dispatchKey: "dispatch-reserved",
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
    usage: {
      tokens: null,
      costUsd: null,
      accounting: "unavailable",
      note: null,
    },
    checks: [],
    createdAt: now,
    updatedAt: now,
  });
  store.putTask({ ...child, currentRunId: runId, sessionId: owner.sessionId });
  store.putSession({
    id: owner.sessionId,
    hostId: owner.authenticatedHostId,
    title: "Reserved continuation",
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
    taskId: child.id,
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
      nativeSessionId: owner.nativeSessionId,
      runtimeId: owner.runtimeId,
      controllerEpoch: "controller-epoch",
      agentTools: true,
      messageDelivery: true,
      policyState: "active",
      policyPhases: ["tool_call", "request"],
    },
  });
  store.noteRunSettle(runId);
  evaluator = {
    validateRule: vi.fn(async () => ({
      valid: true as const,
      returnType: "dyn",
    })),
    evaluateRules: vi.fn(async (rules: PolicyRule[]) =>
      rules.map((r) => ({
        ruleId: r.id,
        ruleRevision: r.revision,
        result:
          r.name === "Counter"
            ? {
                verdict: "ALLOW" as const,
                reason: "Count once",
                state_updates: { used: 1 },
              }
            : null,
        error: null,
      })),
    ),
  };
  await startService();
  service.bindBoundary(owner, boundary);
});
afterEach(async () => {
  await service.stop();
  store.db.close();
});

describe("D.6 shared root fence", () => {
  it("uses the exact snapshot stamp and fails closed for missing tasks/ancestors", async () => {
    expect(service.rootFence(null)).toBeNull();
    expect(service.rootFence(child.id)).toEqual({
      id: root.id,
      state: root.state,
      updatedAt: root.updatedAt,
      epoch: 0,
    });
    await service.authorize(input());
    expect(JSON.parse(evaluation().revisions_json).rootStamp).toEqual(service.rootFence(child.id));
    expect(() => service.rootFence("missing-task")).toThrow(
      expect.objectContaining({ code: "stale_control" }),
    );
    // Bypass lifecycle notifications to prove the read fence handles a broken ancestry itself.
    store.tasks.upsert({
      ...store.tasks.require(child.id),
      parentTaskId: "missing-root",
    });
    expect(() => service.rootFence(child.id)).toThrow(
      expect.objectContaining({ code: "stale_control" }),
    );
  });

  it("changes through done/reopen even when all visible root fields are restored", async () => {
    const reservation = await reserve();
    store.hub.removeAllListeners("task.changed");
    store.hub.removeAllListeners("event");
    store.putTask({ ...root, state: "done" });
    store.putTask(root);
    expect(store.tasks.require(root.id)).toEqual(root);
    expect(evaluation().canceled).toBe(0);
    expect(service.rootFence(child.id)?.epoch).toBe(2);
    expect(continuationContext(store, service, run())).not.toBe(reservation.context);
    rejectsReservation();
    expect(run().continuationsUsed).toBe(1);
  });
});

describe("D.6 reserved continuation authority", () => {
  it("validates first send and retransmission read-only, without reevaluating or spending again", async () => {
    const reservation = await reserve();
    const calls = vi.mocked(evaluator.evaluateRules).mock.calls.length;
    const before = changes();
    store.tx(() => service.assertReservedContinuation(reservation.input, reservation.context));
    expect(changes()).toBe(before);
    store.setSetting(key, { ...reservation, deliveryAttempt: "may_have_sent" });
    const beforeRetry = changes();
    service.assertReservedContinuation(reservation.input, reservation.context);
    expect(changes()).toBe(beforeRetry);
    expect(vi.mocked(evaluator.evaluateRules).mock.calls).toHaveLength(calls);
    expect(run().continuationsUsed).toBe(1);
    expect(store.db.prepare("SELECT * FROM policy_evaluations").all()).toHaveLength(1);
    expect(store.db.prepare("SELECT * FROM policy_grants").all()).toHaveLength(0);
    // Ordinary authorization deliberately does not receive the reservation normalization.
    expect(() => service.assertAuthorized(reservation.input)).toThrow();
  });

  it("preserves a valid reservation across policy service restart and post-commit counter versions", async () => {
    await service.createRule({
      scope: "server",
      scopeId: null,
      priority: 0,
      enabled: true,
      phases: ["request"],
      name: "Counter",
      expression: "counter",
    });
    const reservation = await reserve();
    expect(store.db.prepare("SELECT counters_json,version FROM policy_counters").get()).toEqual({
      counters_json: '{"used":1}',
      version: 1,
    });
    await service.stop();
    await startService();
    expect(service.ready).toBe(true);
    expect(evaluation().canceled).toBe(0);
    const before = changes();
    service.assertReservedContinuation(reservation.input, reservation.context);
    expect(changes()).toBe(before);
  });

  it("rejects a canceled ALLOW even when the durable context fingerprint still matches", async () => {
    const reservation = await reserve();
    expect(service.cancel(owner, { decisionId: evaluation().decision_id })).toEqual({
      state: "canceled",
    });
    expect(evaluation()).toMatchObject({ verdict: "ALLOW", canceled: 1 });
    expect(continuationContext(store, service, run())).toBe(reservation.context);
    rejectsReservation();
    expect(run().continuationsUsed).toBe(1);
  });

  it.each([0, 2])(
    "rejects physical count %s instead of normalizing an arbitrary run",
    async (n) => {
      await reserve();
      updateRun({ continuationsUsed: n });
      rejectsReservation();
      expect(run().continuationsUsed).toBe(n);
    },
  );

  it.each([
    ["legacy v1", (p: PendingContinuation) => ({ ...p, version: 1 })],
    ["legacy v2", (p: PendingContinuation) => ({ ...p, version: 2 })],
    ["authorization phase", (p: PendingContinuation) => ({ ...p, phase: "authorization" })],
    ["another number", (p: PendingContinuation) => ({ ...p, n: 2 })],
    [
      "another input",
      (p: PendingContinuation) => ({
        ...p,
        input: { ...p.input, expectedSettleCount: 2 },
      }),
    ],
    ["another context", (p: PendingContinuation) => ({ ...p, context: "forged" })],
    ["another decision", (p: PendingContinuation) => ({ ...p, decisionId: "pdec_other" })],
    ["missing attempt", (p: PendingContinuation) => ({ ...p, deliveryAttempt: undefined })],
  ] as const)("rejects a durable record with %s", async (_name, alter) => {
    const reservation = await reserve();
    store.setSetting(key, alter(reservation));
    rejectsReservation(reservation.input, reservation.context);
  });

  it("requires the durable record, not just a caller's in-memory copy", async () => {
    const reservation = await reserve();
    store.deleteSetting(key);
    rejectsReservation(reservation.input, reservation.context);
  });

  it.each([
    ["deleted ALLOW", "DELETE FROM policy_evaluations"],
    ["changed input hash", "UPDATE policy_evaluations SET request_hash='changed'"],
    ["changed original input", "UPDATE policy_evaluations SET input_json='{}'"],
    [
      "changed result",
      `UPDATE policy_evaluations SET result_json='{"verdict":"DENY","reason":"revoked"}'`,
    ],
    [
      "changed counter version",
      "INSERT INTO policy_counters(scope_kind,scope_id,rule_id,counters_json,version) SELECT scope_kind,scope_id,'continuation-hard-budget','{}',1 FROM policy_evaluations",
    ],
    ["changed root epoch", "UPDATE settings SET value='2' WHERE key LIKE 'policyRootEpoch:%'"],
  ] as const)("rejects %s independently of lifecycle listeners", async (name, sql) => {
    await reserve();
    if (name === "changed root epoch") store.setSetting(`policyRootEpoch:${root.id}`, 0);
    store.db.exec(sql);
    rejectsReservation();
  });

  it.each([
    ["control revision", () => updateRun({ controlRevision: 2 })],
    ["human takeover", () => updateRun({ controlMode: "human" })],
    ["run attempt", () => updateRun({ attempt: 2 })],
    ["run state", () => updateRun({ state: "interrupted" })],
    ["run host", () => updateRun({ hostId: "hst_other" })],
    ["settlement", () => store.noteRunSettle(runId)],
    ["busy source", () => updateSession({ runtime: "running" })],
    ["compacting source", () => updateSession({ compacting: true })],
    ["read-only source", () => updateSession({ readOnly: true })],
    ["archived source", () => updateSession({ archivedAt: now })],
    [
      "model",
      () =>
        updateSession({
          model: {
            provider: "other",
            id: "model",
            name: null,
            contextWindow: null,
            reasoning: false,
            thinkingLevels: ["off"],
          },
        }),
    ],
    [
      "runtime binding",
      () => updateSession({ bridge: { ...session().bridge!, runtimeId: "other" } }),
    ],
    [
      "conflicting handle",
      () =>
        updateSession({
          nativeHandle: { sessionId: "other", sessionFile: "/other/file" },
        }),
    ],
    ["revoked host", () => updateHost({ revokedAt: now })],
    [
      "task no longer current",
      () => store.putTask({ ...store.tasks.require(child.id), currentRunId: null }),
    ],
    ["workspace boundary", () => store.db.exec("DELETE FROM policy_runtime_boundaries")],
    ["rule revision", () => store.db.exec("UPDATE policy_rules SET revision=revision+1")],
    ["missing settings", () => store.deleteSetting("policySettings")],
    [
      "settings revision",
      () =>
        store.setSetting("policySettings", {
          ...service.settings(),
          revision: 2,
        }),
    ],
  ] as const)("rechecks %s at the send boundary", async (_name, change) => {
    await reserve();
    change();
    rejectsReservation();
    expect(run().continuationsUsed).toBe(1);
  });

  it.each([
    [
      "lost protection",
      () =>
        updateSession({
          bridge: { ...session().bridge!, policyState: "lost" },
        }),
      "host_unreachable",
    ],
    [
      "missing request enforcement",
      () =>
        updateSession({
          bridge: { ...session().bridge!, policyPhases: ["tool_call"] },
        }),
      "unsupported_capability",
    ],
    [
      "missing tool enforcement",
      () =>
        updateSession({
          bridge: { ...session().bridge!, policyPhases: ["request"] },
        }),
      "unsupported_capability",
    ],
    ["incompatible host", () => updateHost({ piCompatible: false }), "unsupported_capability"],
    [
      "missing host capabilities",
      () => updateHost({ capabilities: null }),
      "unsupported_capability",
    ],
  ] as const)("checks readiness for %s at the send boundary", async (_name, change, code) => {
    await reserve();
    change();
    const before = changes();
    expect(() => service.assertReservedContinuation(input(), pending().context)).toThrow(
      expect.objectContaining({ code }),
    );
    expect(changes()).toBe(before);
    expect(run().continuationsUsed).toBe(1);
  });

  it.each(["tokens", "costUsd", "watermark", "unavailable"] as const)(
    "requires unchanged completed usage (%s) for a capped reserved continuation",
    async (changed) => {
      const watermark = { runtimeId: "accounting-epoch", settleSeq: 1 };
      const limits = run().limits;
      if (!limits.enabled) throw new Error("Expected enabled continuation limits");
      updateRun({ limits: { ...limits, maxTokens: 1000, maxCostUsd: 5 } });
      updateSession({ stats: { tokens: 100, costUsd: 0.5, watermark } });
      const reservation = await reserve({
        ...input(),
        expectedWatermark: watermark,
      });
      service.assertReservedContinuation(reservation.input, reservation.context);
      updateSession({
        stats:
          changed === "unavailable"
            ? null
            : {
                tokens: changed === "tokens" ? 200 : 100,
                costUsd: changed === "costUsd" ? 0.75 : 0.5,
                watermark: changed === "watermark" ? { ...watermark, settleSeq: 2 } : watermark,
              },
      });
      rejectsReservation(reservation.input, reservation.context);
      expect(run().continuationsUsed).toBe(1);
    },
  );

  it("keeps same-ID handle discovery/path metadata out of reserved authority", async () => {
    const reservation = await reserve();
    updateSession({
      nativeHandle: {
        sessionId: owner.nativeSessionId,
        sessionFile: "/new/file",
      },
    });
    service.assertReservedContinuation(reservation.input, reservation.context);
    updateSession({
      nativeHandle: {
        sessionId: owner.nativeSessionId,
        sessionFile: "/different/file",
      },
    });
    service.assertReservedContinuation(reservation.input, reservation.context);
    expect(evaluation().canceled).toBe(0);
  });

  it("preserves disconnected durable authority until an actually live retry", async () => {
    const reservation = await reserve();
    updateHost({ connectivity: "reconnecting" });
    updateSession({ connectivity: "reconnecting" });
    connected = false;
    expect(evaluation().canceled).toBe(0);
    expect(service.checkReservedContinuation(reservation.input, reservation.context)).toMatchObject(
      { state: "defer" },
    );
    await service.stop();
    await startService();
    expect(evaluation().canceled).toBe(0);
    updateHost({ connectivity: "connected" });
    updateSession({ connectivity: "connected" });
    connected = true;
    service.assertReservedContinuation(reservation.input, reservation.context);
  });
});
