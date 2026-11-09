import {
  CAPABILITY_KEYS,
  type HostPolicyBoundary,
  type PolicyEvaluation,
  type PolicyRule,
  type Profile,
  RuntimeCapabilities,
} from "@switchyard/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate, openDb } from "../src/db/index.js";
import { EventHub } from "../src/event-hub.js";
import type { EvaluatedRule, PolicyOwner } from "../src/policies/contracts.js";
import { PolicyService, type PolicyServiceOptions } from "../src/policies/service.js";
import { Store } from "../src/store.js";
import type { ContinuationAuthorization } from "../src/tasks/continuations.js";
import { createTask } from "../src/tasks/service.js";

const now = "2026-11-08T00:00:00.000Z";
const reason = "A newer settlement superseded this authorization.";
const owner: PolicyOwner = {
  authenticatedHostId: "hst_d8",
  sessionId: "ses_d8",
  nativeSessionId: "native-d8",
  runtimeId: "runtime-d8",
};
const boundary: HostPolicyBoundary = {
  cwd: "/repo",
  cwdReal: "/real/repo",
  workspaceRoot: "/repo",
  workspaceRootReal: "/real/repo",
};
const profile: Profile = {
  id: "prf_d8",
  name: "D.8",
  provider: null,
  model: null,
  thinking: null,
  projectTrust: "ask",
  extraArgs: [],
};
const input: ContinuationAuthorization = {
  kind: "continuation",
  runId: "run_d8",
  expectedControlRevision: 1,
  nextContinuationNumber: 1,
  expectedSettleCount: 1,
  expectedWatermark: null,
};
let store: Store;
let service: PolicyService;
let evaluator: NonNullable<PolicyServiceOptions["evaluator"]>;
const attention = vi.fn();
const fenceKey = (value = input) =>
  `runContinuationAuthorizationCanceled:${value.runId}:${value.nextContinuationNumber}:${value.expectedControlRevision}:${value.expectedSettleCount}`;
const run = () => store.runs.require(input.runId);
const session = () => store.sessions.require(owner.sessionId);
const rows = () =>
  store.db.prepare("SELECT * FROM policy_evaluations ORDER BY created_at, rowid").all() as {
    decision_id: string;
    canceled: number;
    cancellation_reason: string | null;
    wait_lease_until: string | null;
    input_json: string;
  }[];
const counters = () => store.db.prepare("SELECT * FROM policy_counters").all();
const grants = () => store.db.prepare("SELECT * FROM policy_grants").all();
const settings = () => store.db.prepare("SELECT * FROM settings ORDER BY key").all();
const ask = (reply: PolicyEvaluation) => {
  if (reply.verdict !== "ASK") throw new Error("Expected ASK");
  return reply;
};
const results = (rules: PolicyRule[], verdict: "ASK" | "ALLOW" = "ASK"): EvaluatedRule[] =>
  rules.map((rule) => ({
    ruleId: rule.id,
    ruleRevision: rule.revision,
    result: { verdict, reason: "D.8 approval", state_updates: { attempts: 1 } },
    error: null,
  }));
async function startService() {
  service = new PolicyService({
    store,
    publicUrl: "https://switchyard.test",
    reconcileInputAttention: attention,
    hostPolicyConnection: () => ({
      connected: true,
      features: new Set(["agentRequests.v1", "policies.v1"]),
    }),
    evaluator,
  });
  await service.initialize();
}
/** Simulate only the fence/cancellation portion owned by RunsService's discard transaction. */
function discard(value = input) {
  store.tx(() => {
    service.cancelContinuationAuthorization(value, reason);
    store.setSetting(fenceKey(value), { reason, at: store.nowIso() });
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(async () => {
  attention.mockClear();
  const db = openDb(":memory:");
  migrate(db);
  store = new Store(db, new EventHub(), () => new Date(now));
  store.hosts.upsert(
    {
      id: owner.authenticatedHostId,
      name: "D.8 host",
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
    id: "prj_d8",
    name: "D.8",
    repoIdentity: "https://github.com/example/d8",
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
  const task = createTask({ store }, { projectId: "prj_d8", title: "Root" }, { kind: "manual" });
  store.putRun({
    id: input.runId,
    taskId: task.id,
    sessionId: owner.sessionId,
    hostId: owner.authenticatedHostId,
    dispatchKey: "dispatch-d8",
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
  store.putTask({ ...task, currentRunId: input.runId, sessionId: owner.sessionId });
  store.putSession({
    id: owner.sessionId,
    hostId: owner.authenticatedHostId,
    title: "D.8 authorization",
    subtitle: null,
    projectId: task.projectId,
    workspaceId: null,
    cwd: boundary.cwd,
    nativeHandle: null,
    profileSnapshot: profile,
    runtime: "idle",
    runtimeDetail: null,
    connectivity: "connected",
    runId: input.runId,
    taskId: task.id,
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
      controllerEpoch: "controller-d8",
      agentTools: true,
      messageDelivery: true,
      policyState: "active",
      policyPhases: ["tool_call", "request"],
    },
  });
  store.noteRunSettle(input.runId);
  evaluator = {
    validateRule: vi.fn(async () => ({ valid: true as const, returnType: "dyn" })),
    evaluateRules: vi.fn(async (rules: PolicyRule[]) => results(rules)),
  };
  await startService();
  service.bindBoundary(owner, boundary);
});
afterEach(async () => {
  await service.stop();
  store.db.close();
});

describe("D.8 obsolete continuation authorization cancellation", () => {
  it("synchronously cancels the original persisted decision after its source changes, without blanket revocation", async () => {
    const original = ask(await service.authorize(input));
    store.db
      .prepare(`INSERT INTO policy_grants
        (id,scope_kind,scope_id,rule_id,rule_revision,fingerprint,approved_by_device_id,approved_at)
        VALUES (?,?,?,?,?,?,?,?)`)
      .run(
        "pgr_independent",
        "task",
        run().taskId,
        "destructive-shell",
        1,
        "narrow",
        "dev_owner",
        now,
      );
    // Skip lifecycle events: cancellation must not need a reconstructable current actor.
    store.sessions.upsert({
      ...session(),
      bridge: {
        ...session().bridge!,
        runtimeId: "replacement-runtime",
        nativeSessionId: "new-native",
      },
    });
    const before = {
      run: run(),
      session: session(),
      task: store.tasks.require(run().taskId),
      grants: grants(),
      counters: counters(),
      settings: settings(),
    };
    attention.mockClear();
    expect(
      service.cancelContinuationAuthorization(
        { ...input, signal: new AbortController().signal },
        reason,
      ),
    ).toBeUndefined();
    expect(rows()[0]).toMatchObject({
      canceled: 1,
      cancellation_reason: reason,
      wait_lease_until: null,
    });
    const interaction = store.interactions.require(original.interactionId);
    expect(interaction).toMatchObject({
      state: "canceled",
      resolution: { by: "coordinator", summary: reason },
    });
    expect(attention).toHaveBeenCalledExactlyOnceWith(interaction);
    expect({
      run: run(),
      session: session(),
      task: store.tasks.require(run().taskId),
      grants: grants(),
      counters: counters(),
      settings: settings(),
    }).toEqual(before);
    // Idempotent; PolicyService does not itself write RunsService's fence or any tombstone.
    service.cancelContinuationAuthorization(input, reason);
    expect(attention).toHaveBeenCalledTimes(1);
    expect(settings()).toEqual(before.settings);
    await expect(service.answer(original.decisionId, 1, true, "dev_owner")).rejects.toMatchObject({
      code: "conflict",
    });
    expect(grants()).toEqual(before.grants);
  });

  it.each<Partial<ContinuationAuthorization>>([
    { runId: "different-run" },
    { expectedControlRevision: 2 },
    { nextContinuationNumber: 2 },
    { expectedSettleCount: 2 },
    { expectedWatermark: { runtimeId: "accounting", settleSeq: 1 } },
  ])("matches every original input component rather than the current actor: %j", async (patch) => {
    const original = ask(await service.authorize(input));
    attention.mockClear();
    service.cancelContinuationAuthorization({ ...input, ...patch }, reason);
    expect(rows()[0]!.canceled).toBe(0);
    expect(store.interactions.require(original.interactionId).state).toBe("pending");
    expect(attention).not.toHaveBeenCalled();
  });

  it("matches non-null original watermarks structurally without canceling a different accounting settlement", async () => {
    const marked = { ...input, expectedWatermark: { runtimeId: "accounting", settleSeq: 1 } };
    const original = ask(await service.authorize(marked));
    service.cancelContinuationAuthorization(
      { ...marked, expectedWatermark: { runtimeId: "accounting", settleSeq: 2 } },
      reason,
    );
    expect(rows()[0]!.canceled).toBe(0);
    service.cancelContinuationAuthorization(
      { ...marked, expectedWatermark: { settleSeq: 1, runtimeId: "accounting" } },
      reason,
    );
    expect(rows()[0]!.canceled).toBe(1);
    expect(store.interactions.require(original.interactionId).state).toBe("canceled");
  });

  it("preserves a newer settlement's decision and its attention on repeated old cancellation", async () => {
    const original = ask(await service.authorize(input));
    discard();
    store.noteRunSettle(input.runId);
    const newer = { ...input, expectedSettleCount: 2 };
    const current = ask(await service.authorize(newer));
    expect(current.decisionId).not.toBe(original.decisionId);
    attention.mockClear();
    service.cancelContinuationAuthorization(input, reason);
    expect(rows().find((row) => row.decision_id === current.decisionId)?.canceled).toBe(0);
    expect(store.interactions.require(current.interactionId).state).toBe("pending");
    expect(attention).not.toHaveBeenCalled();
    expect(run()).toMatchObject({
      controlMode: "automation",
      controlRevision: 1,
      continuationsUsed: 0,
    });
  });

  it("checks the exact settings fence before any evaluation and preserves it across restart", async () => {
    discard();
    await expect(service.authorize(input)).rejects.toMatchObject({
      code: "stale_control",
      message: reason,
    });
    expect(evaluator.evaluateRules).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    await service.stop();
    await startService();
    await expect(service.authorize(input)).rejects.toMatchObject({
      code: "stale_control",
      message: reason,
    });
    expect(evaluator.evaluateRules).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    expect(store.getSetting(fenceKey(), null)).toEqual({ reason, at: now });
  });

  it.each(["ASK", "ALLOW", "failure"] as const)(
    "fences a delayed %s worker without recreating a row, interaction or counters",
    async (outcome) => {
      const entered = deferred<PolicyRule[]>();
      const work = deferred<EvaluatedRule[]>();
      vi.mocked(evaluator.evaluateRules).mockImplementationOnce((rules) => {
        entered.resolve(rules);
        return work.promise;
      });
      const authorization = service.authorize(input);
      const rules = await entered.promise;
      // Also queue the same logical authorization behind the in-flight scope lock.
      const queued = service.authorize(input);
      const rejected = Promise.all([
        expect(authorization).rejects.toMatchObject({ code: "stale_control", message: reason }),
        expect(queued).rejects.toMatchObject({ code: "stale_control", message: reason }),
      ]);
      discard();
      if (outcome === "failure") work.reject(new Error("Worker failed after discard"));
      else work.resolve(results(rules, outcome));
      await rejected;
      expect(evaluator.evaluateRules).toHaveBeenCalledTimes(1);
      expect(rows()).toEqual([]);
      expect(store.interactions.list()).toEqual([]);
      expect(counters()).toEqual([]);
      expect(grants()).toEqual([]);
    },
  );

  it("blocks completed ALLOW replay and final reservation validation once its authorization is discarded", async () => {
    vi.mocked(evaluator.evaluateRules).mockImplementation(async (rules) => results(rules, "ALLOW"));
    expect(await service.authorize(input)).toEqual({ verdict: "ALLOW" });
    const before = counters();
    expect(before.length).toBeGreaterThan(0);
    discard();
    expect(rows()[0]!.canceled).toBe(1);
    expect(() => service.assertAuthorized(input)).toThrow(
      expect.objectContaining({ code: "stale_control", message: reason }),
    );
    await expect(service.authorize(input)).rejects.toMatchObject({
      code: "stale_control",
      message: reason,
    });
    expect(counters()).toEqual(before);
    expect(run().continuationsUsed).toBe(0);
  });

  it("fences a delayed approval reevaluation without applying its provisional counter patches", async () => {
    const original = ask(await service.authorize(input));
    const entered = deferred<PolicyRule[]>();
    const work = deferred<EvaluatedRule[]>();
    vi.mocked(evaluator.evaluateRules).mockImplementationOnce((rules) => {
      entered.resolve(rules);
      return work.promise;
    });
    const answer = service.answer(original.decisionId, 1, true, "dev_owner");
    const rules = await entered.promise;
    // The valid answer already created its independent narrow grant before this worker await.
    const approved = grants();
    expect(approved).toHaveLength(1);
    const rejected = expect(answer).rejects.toMatchObject({
      code: "stale_control",
      message: reason,
    });
    discard();
    work.resolve(results(rules, "ALLOW"));
    await rejected;
    expect(rows()[0]!.canceled).toBe(1);
    expect(counters()).toEqual([]);
    expect(grants()).toEqual(approved);
  });

  it("does not confuse another tuple's cancellation fence with this authorization", async () => {
    for (const changed of [
      { ...input, runId: "other-run" },
      { ...input, expectedControlRevision: 2 },
      { ...input, nextContinuationNumber: 2 },
      { ...input, expectedSettleCount: 2 },
    ])
      store.setSetting(fenceKey(changed), { reason, at: now });
    expect((await service.authorize(input)).verdict).toBe("ASK");
    expect(rows()[0]!.canceled).toBe(0);
  });
});
