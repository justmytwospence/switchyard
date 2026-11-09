import { createHash } from "node:crypto";
import {
  canonicalPolicyJson,
  type HostPolicyBoundary,
  type PolicyEvaluation,
  type Profile,
  type Run,
  type Session,
  type Task,
} from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate, openDb } from "../src/db/index.js";
import { EventHub } from "../src/event-hub.js";
import type { PolicyAuthorizeInput, PolicyOwner } from "../src/policies/contracts.js";
import { PolicyService, type PolicyServiceOptions } from "../src/policies/service.js";
import { Store } from "../src/store.js";
import { createTask } from "../src/tasks/service.js";

const owner: PolicyOwner = {
  authenticatedHostId: "hst_lifecycle",
  sessionId: "ses_lifecycle",
  nativeSessionId: "native-lifecycle",
  runtimeId: "runtime-lifecycle",
};
const boundary: HostPolicyBoundary = {
  cwd: "/repo",
  cwdReal: "/real/repo",
  workspaceRoot: "/repo",
  workspaceRootReal: "/real/repo",
};
const safety = {
  destructiveDelete: false,
  forcePush: false,
  defaultBranchPush: false,
  uncertain: false,
  reasons: [],
};
const profile: Profile = {
  id: "prf_lifecycle",
  name: "Lifecycle",
  provider: null,
  model: null,
  thinking: null,
  projectTrust: "ask",
  extraArgs: [],
};
const ended = "The root task has ended; reopen it before starting more agent work.";
let now: number;
let store: Store;
let service: PolicyService;
let evaluator: NonNullable<PolicyServiceOptions["evaluator"]>;
let ask: boolean;
let root: Task;
let child: Task;

function restartService() {
  service = new PolicyService({
    store,
    publicUrl: "https://switchyard.test",
    reconcileInputAttention: vi.fn(),
    evaluator,
    hostPolicyConnection: () => ({
      connected: true,
      features: new Set(["agentRequests.v1", "policies.v1"]),
    }),
    classifySample: async (request) => ({
      sessionId: request.sessionId,
      nativeSessionId: request.nativeSessionId,
      runtimeId: request.runtimeId,
      sampleId: request.sampleId,
      toolHash: createHash("sha256").update(canonicalPolicyJson(request.tool)).digest("hex"),
      boundary,
      safety,
      defaultBranch: "main",
    }),
  });
  service.start();
}
function input(
  kind: "tool" | "agent_request" = "tool",
  toolCallId = "call-1",
): PolicyAuthorizeInput {
  const frame = {
    type: "agent.request" as const,
    requestId: "transport-1",
    sessionId: owner.sessionId,
    nativeSessionId: owner.nativeSessionId,
    runtimeId: owner.runtimeId,
    context: { humanInputId: "human-1", causalMessageId: null },
    toolCallId,
  };
  if (kind === "agent_request")
    return {
      kind,
      owner,
      frame: {
        ...frame,
        method: "task.create",
        args: { objective: "Child objective" },
      },
    };
  const tool = { name: "bash", args: { command: "echo safe" } };
  return {
    kind,
    owner,
    frame: {
      ...frame,
      method: "policy.evaluate",
      args: {
        evaluationId: `pol_${createHash("sha256")
          .update(JSON.stringify([owner.sessionId, owner.nativeSessionId, "tool_call", toolCallId]))
          .digest("hex")}`,
        toolCallId,
        tool,
      },
    },
    hostContext: {
      version: 1,
      toolCallId,
      toolHash: createHash("sha256").update(canonicalPolicyJson(tool)).digest("hex"),
      boundary,
      defaultBranch: "main",
      safety,
    },
  };
}
function question(result: PolicyEvaluation) {
  if (result.verdict !== "ASK") throw new Error(`Expected ASK, received ${result.verdict}`);
  return result;
}
function row(decisionId: string) {
  return store.db
    .prepare("SELECT * FROM policy_evaluations WHERE decision_id=?")
    .get(decisionId) as {
    verdict: string;
    canceled: number;
    revisions_json: string;
    wait_lease_until: string | null;
  };
}
async function approve(result: PolicyEvaluation) {
  const q = question(result);
  return service.answer(
    q.decisionId,
    store.interactions.require(q.interactionId).revision,
    true,
    "dev_owner",
  );
}
function updateSession(patch: Partial<Session>) {
  store.putSession({ ...store.sessions.require(owner.sessionId), ...patch });
}
function transition(state: Task["state"]) {
  root = store.putTask({ ...store.tasks.require(root.id), state });
}
function status(decisionId: string) {
  return service.status(owner, { decisionId, waitMs: 25000 });
}
function grants() {
  return store.db.prepare("SELECT * FROM policy_grants").all();
}
function changes() {
  return (store.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
}
function continuation(): Extract<PolicyAuthorizeInput, { kind: "continuation" }> {
  const run: Run = {
    id: "run_lifecycle",
    taskId: child.id,
    sessionId: owner.sessionId,
    hostId: owner.authenticatedHostId,
    dispatchKey: "dispatch-lifecycle",
    attempt: 1,
    state: "running",
    controlMode: "automation",
    controlRevision: 1,
    continuationsUsed: 0,
    infraRetries: 0,
    nextAttemptAt: null,
    startedAt: store.nowIso(),
    endedAt: null,
    outcome: null,
    limits: {
      enabled: true,
      objective: "Finish",
      maxContinuations: 5,
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
    createdAt: store.nowIso(),
    updatedAt: store.nowIso(),
  };
  store.putRun(run);
  store.putTask({ ...child, currentRunId: run.id, sessionId: owner.sessionId });
  updateSession({ runId: run.id });
  store.noteRunSettle(run.id);
  return {
    kind: "continuation",
    runId: run.id,
    expectedControlRevision: 1,
    nextContinuationNumber: 1,
    expectedSettleCount: 1,
    expectedWatermark: null,
  };
}

beforeEach(async () => {
  vi.useFakeTimers();
  now = Date.parse("2026-11-08T00:00:00.000Z");
  store = new Store(openDb(":memory:"), new EventHub(), () => new Date(now));
  migrate(store.db);
  store.hosts.upsert(
    {
      id: owner.authenticatedHostId,
      name: "Host",
      platform: "darwin",
      agentVersion: "test",
      piVersion: "1.5.0",
      piCompatible: true,
      capabilities: null,
      connectivity: "connected",
      lastSeenAt: store.nowIso(),
      revokedAt: null,
      createdAt: store.nowIso(),
    },
    { credential_hash: "hash" },
  );
  store.projects.upsert({
    id: "prj_lifecycle",
    name: "Lifecycle",
    repoIdentity: "https://github.com/example/lifecycle",
    defaultProfileId: profile.id,
    defaultHostId: owner.authenticatedHostId,
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
  root = createTask({ store }, { projectId: "prj_lifecycle", title: "Root" }, { kind: "manual" });
  child = createTask(
    { store },
    { projectId: "prj_lifecycle", title: "Child", parentTaskId: root.id },
    { kind: "manual" },
  );
  store.putSession({
    id: owner.sessionId,
    hostId: owner.authenticatedHostId,
    title: "Fileless session",
    subtitle: null,
    projectId: root.projectId,
    workspaceId: null,
    cwd: boundary.cwd,
    nativeHandle: null,
    profileSnapshot: profile,
    runtime: "idle",
    runtimeDetail: null,
    connectivity: "connected",
    runId: null,
    taskId: child.id,
    provenance: "created",
    readOnly: false,
    archivedAt: null,
    lastActivityAt: store.nowIso(),
    createdAt: store.nowIso(),
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
  ask = true;
  evaluator = {
    validateRule: vi.fn(async () => ({ valid: true, returnType: "dyn" })),
    evaluateRules: vi.fn(async (rules) =>
      rules.map((r) => ({
        ruleId: r.id,
        ruleRevision: r.revision,
        result:
          r.name === "Lifecycle ASK" && ask ? { verdict: "ASK" as const, reason: "Confirm" } : null,
        error: null,
      })),
    ),
  };
  restartService();
  service.bindBoundary(owner, boundary);
  await service.createRule({
    scope: "server",
    scopeId: null,
    priority: 0,
    enabled: true,
    phases: ["tool_call", "request"],
    name: "Lifecycle ASK",
    expression: "lifecycle",
  });
});
afterEach(async () => {
  await service.stop();
  store.db.close();
  vi.useRealTimers();
});

describe("root lifecycle authority", () => {
  it.each(["done", "canceled"] as const)(
    "cancels a child ASK on root %s and rejects late approval",
    async (state) => {
      const q = question(await service.authorize(input()));
      const revision = store.interactions.require(q.interactionId).revision;
      transition(state);
      expect(await status(q.decisionId)).toMatchObject({ state: "canceled" });
      expect(store.interactions.require(q.interactionId).state).toBe("canceled");
      await expect(service.answer(q.decisionId, revision, true, "dev_owner")).rejects.toMatchObject(
        { code: "conflict" },
      );
      expect(grants()).toHaveLength(0);
    },
  );

  it.each(["done", "canceled"] as const)(
    "revokes already-ALLOW child authority and shared grants on root %s",
    async (state) => {
      const original = input("agent_request");
      const q = question(await service.authorize(original));
      await approve(q);
      expect(await status(q.decisionId)).toEqual({ state: "allowed" });
      expect(grants()).toHaveLength(1);
      transition(state);
      expect(row(q.decisionId).canceled).toBe(1);
      expect(grants()).toHaveLength(0);
      expect(() => service.assertAuthorized(original)).toThrow(ended);
      expect(await service.authorize(input("agent_request", "fresh"))).toEqual({
        verdict: "DENY",
        reason: ended,
      });
    },
  );

  it.each(["tool", "agent_request"] as const)(
    "epoch fences %s authority through done -> reopen even with identical timestamps and missed events",
    async (kind) => {
      const original = input(kind);
      const q = question(await service.authorize(original));
      await approve(q);
      store.hub.removeAllListeners("task.changed");
      store.hub.removeAllListeners("event");
      transition("done");
      transition("ready");
      expect(root.updatedAt).toBe(JSON.parse(row(q.decisionId).revisions_json).rootStamp.updatedAt);
      expect(store.getSetting(`policyRootEpoch:${root.id}`, 0)).toBe(2);
      expect(() => service.assertAuthorized(original)).toThrow();
      expect(await status(q.decisionId)).toMatchObject({ state: "canceled" });
      expect(grants()).toHaveLength(0);
      await expect(service.authorize(original)).rejects.toMatchObject({
        code: "stale_control",
      });
      const fresh = question(await service.authorize(input(kind, "fresh")));
      await approve(fresh);
      expect(await service.authorize(input(kind, "fresh"))).toEqual({
        verdict: "ALLOW",
      });
    },
  );

  it("independently checks stale pending status, answers and authorize without task events", async () => {
    const first = question(await service.authorize(input("tool", "first")));
    const second = question(await service.authorize(input("agent_request", "second")));
    const thirdInput = input("agent_request", "third");
    const third = question(await service.authorize(thirdInput));
    store.hub.removeAllListeners("task.changed");
    store.hub.removeAllListeners("event");
    transition("done");
    transition("ready");
    await expect(approve(first)).rejects.toMatchObject({ code: "conflict" });
    expect(await status(second.decisionId)).toMatchObject({
      state: "canceled",
    });
    await expect(service.authorize(thirdInput)).rejects.toMatchObject({
      code: "stale_control",
    });
    expect(row(third.decisionId).canceled).toBe(1);
    expect(grants()).toHaveLength(0);
  });

  it("final synchronous fence catches an uncommitted root change after async ALLOW without making writes", async () => {
    ask = false;
    const original = input("agent_request");
    expect(await service.authorize(original)).toEqual({ verdict: "ALLOW" });
    const before = changes();
    store.tx(() => service.assertAuthorized(original));
    expect(changes()).toBe(before);
    store.tx(() => {
      transition("done");
      const afterTransition = changes();
      // No task.changed listener has run inside this outer mutation transaction.
      expect(() => service.assertAuthorized(original)).toThrow(ended);
      expect(changes()).toBe(afterTransition);
    });
  });

  it("an already-canceled historical ALLOW cannot lend its grant to a reopened root", async () => {
    const original = input("agent_request");
    const q = question(await service.authorize(original));
    await approve(q);
    service.cancel(owner, { decisionId: q.decisionId });
    expect(grants()).toHaveLength(1);
    store.hub.removeAllListeners("task.changed");
    store.hub.removeAllListeners("event");
    transition("done");
    transition("ready");
    expect((await service.authorize(input("agent_request", "fresh"))).verdict).toBe("ASK");
  });

  it("a root lifecycle change during the worker await cannot publish ALLOW", async () => {
    ask = false;
    const evaluate = evaluator.evaluateRules;
    let changed = false;
    evaluator.evaluateRules = async (...args) => {
      if (!changed) {
        changed = true;
        transition("done");
      }
      return evaluate(...args);
    };
    expect(await service.authorize(input("agent_request"))).toEqual({
      verdict: "DENY",
      reason: ended,
    });
    expect(store.db.prepare("SELECT * FROM policy_evaluations").all()).toHaveLength(0);
    expect(grants()).toHaveLength(0);
  });

  it("snapshots standalone scope with a null root stamp", async () => {
    updateSession({ taskId: null });
    const q = question(await service.authorize(input()));
    expect(JSON.parse(row(q.decisionId).revisions_json).rootStamp).toBeNull();
    await approve(q);
    expect(() => service.assertAuthorized(input())).not.toThrow();
  });

  it("rejects changed trusted human or causal input at final resumption", async () => {
    const original = input("agent_request");
    const q = question(await service.authorize(original));
    await approve(q);
    if (original.kind !== "agent_request") throw new Error("Expected request");
    for (const context of [
      { humanInputId: "new-human", causalMessageId: null },
      { humanInputId: "human-1", causalMessageId: "new-message" },
    ]) {
      expect(() =>
        service.assertAuthorized({
          ...original,
          frame: { ...original.frame, context },
        }),
      ).toThrow();
    }
  });

  it("rejects ASK, canceled, missing and hash-reused rows at the final fence", async () => {
    const original = input("agent_request");
    expect(() => service.assertAuthorized(original)).toThrow();
    const q = question(await service.authorize(original));
    expect(() => service.assertAuthorized(original)).toThrow();
    await approve(q);
    expect(() => service.assertAuthorized(original)).not.toThrow();
    if (original.kind !== "agent_request") throw new Error("Expected request");
    expect(() =>
      service.assertAuthorized({
        ...original,
        frame: { ...original.frame, args: { objective: "Different" } },
      }),
    ).toThrow();
    service.cancel(owner, { decisionId: q.decisionId });
    expect(() => service.assertAuthorized(original)).toThrow();
  });

  it("does not self-invalidate on dialog runtime, last activity or optional file metadata", async () => {
    const original = input();
    const q = question(await service.authorize(original));
    updateSession({
      runtime: "waiting_input",
      lastActivityAt: new Date(now + 1).toISOString(),
      stats: {
        tokens: null,
        costUsd: null,
        context: { tokens: 200, window: 1000, percent: 20 },
      },
    });
    updateSession({
      runtime: "running",
      nativeHandle: {
        sessionId: owner.nativeSessionId,
        sessionFile: "/new/optional/file",
      },
    });
    expect(await service.authorize(original)).toEqual(q);
    await approve(q);
    updateSession({
      nativeHandle: null,
      lastActivityAt: new Date(now + 2).toISOString(),
    });
    expect(await status(q.decisionId)).toEqual({ state: "allowed" });
    expect(() => service.assertAuthorized(original)).not.toThrow();
  });

  it("blocks fresh continuations under a terminal root", async () => {
    const original = continuation();
    transition("canceled");
    expect(await service.authorize(original)).toEqual({
      verdict: "DENY",
      reason: ended,
    });
  });
});

describe("healthy interactive approval leases", () => {
  async function poll(decisionId: string) {
    const pending = status(decisionId);
    await vi.advanceTimersByTimeAsync(25000);
    expect(await pending).toEqual({ state: "pending" });
  }

  it("renews request ASK beyond 30 seconds without creating tasks, messages or final receipts", async () => {
    const original = input("agent_request");
    const q = question(await service.authorize(original));
    expect(row(q.decisionId).wait_lease_until).toBe(new Date(now + 60000).toISOString());
    for (let i = 0; i < 3; i++) {
      now += 20000;
      await poll(q.decisionId);
      expect(row(q.decisionId).wait_lease_until).toBe(new Date(now + 60000).toISOString());
    }
    expect(store.tasks.list()).toHaveLength(2);
    expect(store.db.prepare("SELECT * FROM agent_call_receipts").all()).toHaveLength(0);
    expect(store.db.prepare("SELECT * FROM agent_messages").all()).toHaveLength(0);
    await approve(q);
    expect(await status(q.decisionId)).toEqual({ state: "allowed" });
    expect(store.tasks.list()).toHaveLength(2);
    expect(row(q.decisionId).wait_lease_until).toBeNull();
    // Only explicit resubmission can hand an ALLOW back to the tool executor.
    expect(await service.authorize(original)).toEqual({ verdict: "ALLOW" });
  });

  it.each(["status", "answer", "authorize", "sweeper"] as const)(
    "expires an abandoned wait via %s, never granting late approval",
    async (via) => {
      const original = input();
      const q = question(await service.authorize(original));
      now += 60000;
      if (via === "status") expect(await status(q.decisionId)).toMatchObject({ state: "canceled" });
      if (via === "answer") await expect(approve(q)).rejects.toMatchObject({ code: "conflict" });
      if (via === "authorize")
        await expect(service.authorize(original)).rejects.toMatchObject({
          code: "stale_control",
        });
      if (via === "sweeper") await vi.advanceTimersByTimeAsync(5000);
      expect(row(q.decisionId).canceled).toBe(1);
      expect(store.interactions.require(q.interactionId).state).toBe("canceled");
      await expect(approve(q)).rejects.toMatchObject({ code: "conflict" });
      expect(grants()).toHaveLength(0);
      expect(store.tasks.list()).toHaveLength(2);
    },
  );

  it.each(["legacy", "expired", "healthy"] as const)(
    "recovers %s interactive waits on restart",
    async (state) => {
      const original = input("agent_request");
      const q = question(await service.authorize(original));
      await service.stop();
      if (state === "legacy")
        store.db.prepare("UPDATE policy_evaluations SET wait_lease_until=NULL").run();
      if (state === "expired") now += 60000;
      restartService();
      if (state === "healthy") {
        expect(await service.authorize(original)).toEqual(q);
        await approve(q);
        expect(await status(q.decisionId)).toEqual({ state: "allowed" });
      } else {
        expect(await status(q.decisionId)).toMatchObject({ state: "canceled" });
        await expect(approve(q)).rejects.toMatchObject({ code: "conflict" });
        expect(grants()).toHaveLength(0);
      }
      expect(store.interactions.list()).toHaveLength(1);
      expect(store.tasks.list()).toHaveLength(2);
    },
  );

  it("keeps continuation ASK durable with a null tool lease but still fences idle/settlement", async () => {
    const original = continuation();
    const q = question(await service.authorize(original));
    expect(row(q.decisionId).wait_lease_until).toBeNull();
    now += 600000;
    await vi.advanceTimersByTimeAsync(5000);
    await service.stop();
    restartService();
    expect(await service.authorize(original)).toEqual(q);
    expect(row(q.decisionId).wait_lease_until).toBeNull();
    await approve(q);
    expect(() => service.assertAuthorized(original)).not.toThrow();
    updateSession({ runtime: "running" });
    expect(() => service.assertAuthorized(original)).toThrow();
  });

  it("stops an aborted long poll and does not silently report pending or renew an already-aborted request", async () => {
    const q = question(await service.authorize(input()));
    const controller = new AbortController();
    const pending = service.status(
      owner,
      { decisionId: q.decisionId, waitMs: 25000 },
      controller.signal,
    );
    controller.abort(new Error("Disconnected"));
    await expect(pending).rejects.toThrow("Disconnected");
    const lease = row(q.decisionId).wait_lease_until;
    now += 1000;
    await expect(
      service.status(owner, { decisionId: q.decisionId, waitMs: 25000 }, controller.signal),
    ).rejects.toThrow("Disconnected");
    expect(row(q.decisionId).wait_lease_until).toBe(lease);
    service.cancel(owner, { decisionId: q.decisionId });
    await expect(approve(q)).rejects.toMatchObject({ code: "conflict" });
    expect(grants()).toHaveLength(0);
  });

  it("checks lease expiry again after a resumed policy worker await", async () => {
    const q = question(await service.authorize(input()));
    const evaluate = evaluator.evaluateRules;
    evaluator.evaluateRules = async (...args) => {
      now += 60000;
      return evaluate(...args);
    };
    await expect(approve(q)).rejects.toMatchObject({ code: "stale_control" });
    expect(row(q.decisionId).canceled).toBe(1);
    expect(store.tasks.list()).toHaveLength(2);
  });

  it.each(["cancel", "unbind"] as const)(
    "%s is durable and cannot create a grant from late approval",
    async (via) => {
      const original = input("agent_request");
      const q = question(await service.authorize(original));
      if (via === "cancel") {
        expect(service.cancel(owner, { decisionId: q.decisionId })).toEqual({
          state: "canceled",
        });
        expect(service.cancel(owner, { decisionId: q.decisionId })).toEqual({
          state: "already_resolved",
        });
      } else service.cancelForSession(owner.sessionId, owner.runtimeId);
      await expect(approve(q)).rejects.toMatchObject({ code: "conflict" });
      await expect(service.authorize(original)).rejects.toMatchObject({
        code: "stale_control",
      });
      expect(grants()).toHaveLength(0);
    },
  );
});

describe("fileless native identity", () => {
  it("authorizes, tests, answers, polls and cancels a fileless bound session", async () => {
    const original = input();
    const q = question(await service.authorize(original));
    expect(
      await service.test({
        sessionId: owner.sessionId,
        phase: "tool_call",
        tool: { name: "bash", args: { command: "echo sample" } },
        request: null,
      }),
    ).toMatchObject({ verdict: "ASK" });
    await approve(q);
    expect(await status(q.decisionId)).toEqual({ state: "allowed" });
    expect(() => service.assertAuthorized(original)).not.toThrow();
    expect(service.cancel(owner, { decisionId: q.decisionId })).toEqual({
      state: "canceled",
    });
  });

  it.each([
    "conflicting-handle",
    "missing-bridge",
    "stale-native",
    "stale-runtime",
    "missing-boundary",
  ] as const)("rejects %s despite any existing file/ALLOW", async (change) => {
    const original = input();
    const q = question(await service.authorize(original));
    await approve(q);
    const bridge = store.sessions.require(owner.sessionId).bridge!;
    if (change === "conflicting-handle")
      updateSession({
        nativeHandle: { sessionId: "other", sessionFile: "/same/file" },
      });
    if (change === "missing-bridge") updateSession({ bridge: undefined });
    if (change === "stale-native")
      updateSession({ bridge: { ...bridge, nativeSessionId: "other" } });
    if (change === "stale-runtime") updateSession({ bridge: { ...bridge, runtimeId: "other" } });
    if (change === "missing-boundary")
      store.db.prepare("DELETE FROM policy_runtime_boundaries").run();
    expect(() => service.assertAuthorized(original)).toThrow();
    await expect(service.authorize(original)).rejects.toThrow();
    await expect(status(q.decisionId)).rejects.toThrow();
    expect(() => service.cancel(owner, { decisionId: q.decisionId })).toThrow();
    await expect(
      service.test({
        sessionId: owner.sessionId,
        phase: "request",
        tool: null,
        request: { method: "inbox.read", args: {} },
      }),
    ).rejects.toThrow();
  });
});
